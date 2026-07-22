// WP-107: worker workspace provisioning (CAM-EXEC-02).
//
// A worker workspace is a FULL, ISOLATED clone — never a linked worktree,
// never a shared/alternates clone — with hooks disabled BY CONFIG from the
// first checkout, and no GitHub credential material anywhere in the tree.
// Provisioning both enforces these properties (fail-closed git invocation)
// and ATTESTS them (assertWorkerCloneIsolation re-derives every property from
// the on-disk result rather than trusting that the right flags were passed),
// so a regression in the clone command trips the assertion, not production.
//
// BOUNDARY, stated: this module guarantees the WORKSPACE carries no
// credential material and no shared state. The stronger claim — that a worker
// cannot read the host's ~/.config/gh or ~/.gitconfig AT ALL — is the
// container's (egress.ts: only the workspace and read-only provider auth are
// mounted; host HOME is never a mount). The env half of the zero-credential
// posture is composeWorkerEnv (WP-105), asserted again inside the container
// by the worker suite.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";

/** A provisioning or isolation-attestation failure. Always fail-closed. */
export class WorkerCloneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerCloneError";
  }
}

/**
 * Hooks are disabled by pointing core.hooksPath at /dev/null: hook lookup
 * becomes `<hooksPath>/<name>`, which can never be an executable file. The
 * value is PERSISTED into the clone's local config by `git clone -c`, so it
 * governs the provisioning checkout itself and every later control-plane git
 * operation in the clone. (A worker can of course reconfigure its own clone —
 * the worker is untrusted; this config protects the PROVISIONING checkout and
 * the pristine clones the control plane operates in, per design §5.1.)
 */
export const WORKER_CLONE_HOOKS_PATH = "/dev/null";

/**
 * Every property assertWorkerCloneIsolation re-derives from disk. Recorded
 * per attempt as evidence (names + booleans only, never credential values).
 */
export interface WorkerCloneIsolationRecord {
  /** `.git` is a real directory — a linked worktree's `.git` is a FILE. */
  gitIsRealDirectory: boolean;
  /** No `objects/info/alternates` — a shared/reference clone records one. */
  noAlternates: boolean;
  /** No loose object is hardlinked (nlink>1) — a --local hardlink clone shares its store. */
  noHardlinkedObjects: boolean;
  /** core.hooksPath is persisted to the disabling value in the clone config. */
  hooksDisabledByConfig: boolean;
  /** No credential.helper configured in the clone's EFFECTIVE local config (includes resolved). */
  noCredentialHelper: boolean;
  /** No remote URL (fetch or push) carries userinfo (user:token@host). */
  remotesCredentialFree: boolean;
  /** No http.<url>.extraheader (Authorization channel) in the effective config. */
  noHttpExtraheader: boolean;
  /** No *.sshCommand (git-op exec channel) in the effective config. */
  noSshCommand: boolean;
  /** Filesystem scan found no GitHub credential material (see scan). */
  credentialMaterialPaths: string[];
}

const CLONE_ENV_BASE = {
  // Host git config (and any credential helper stored there) is unreachable
  // during provisioning; git must never interactively prompt for credentials.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
} as const;

function gitRaw(cwd: string | null, args: string[]): string {
  const env: Record<string, string> = { ...CLONE_ENV_BASE };
  const path = process.env["PATH"];
  if (typeof path === "string") env["PATH"] = path;
  return execFileSync("git", cwd === null ? args : ["-C", cwd, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  }).toString();
}

function git(cwd: string | null, args: string[]): string {
  return gitRaw(cwd, args).trim();
}

/**
 * The clone's EFFECTIVE local git config as (key, value) pairs — read via
 * `git config --list -z`, which RESOLVES `[include]`/`[includeIf]` directives
 * (so a credential channel hidden in an included file is visible) and never
 * interprets a value as an option (closing the option-shaped-remote-name
 * injection). Global/system config is neutralized to /dev/null by the env, so
 * only the repository config + its includes are read. Keys are lower-cased by
 * git (subsection case preserved). (round-2 finding 4)
 */
function effectiveGitConfig(dir: string): { key: string; value: string }[] {
  let raw: string;
  try {
    // `--includes` is REQUIRED: for an explicit scope (--local) git defaults
    // include-expansion OFF for inspection, yet FOLLOWS includes during normal
    // operations (fetch/push). Without it, an attacker's included extraheader
    // would be used by git but invisible here (round-2 finding 4).
    raw = gitRaw(dir, ["config", "--local", "--includes", "--list", "-z"]);
  } catch (err) {
    // FAIL CLOSED (round-3 finding 5): a config that cannot be enumerated —
    // ENOBUFS on an oversized (hostile) config, a git error — must NOT be read
    // as "no credential channels". A clone whose config is unreadable is
    // refused. (A benign local config is bytes, not megabytes.)
    throw new WorkerCloneError(
      `workspace clone config could not be enumerated for attestation — refused (fail-closed): ${(err as Error).message.slice(0, 200)}`,
    );
  }
  const out: { key: string; value: string }[] = [];
  for (const chunk of raw.split("\0")) {
    if (chunk.length === 0) continue;
    const nl = chunk.indexOf("\n");
    if (nl === -1) out.push({ key: chunk, value: "" });
    else out.push({ key: chunk.slice(0, nl), value: chunk.slice(nl + 1) });
  }
  return out;
}

/** Does a git URL / path carry userinfo (a `user[:secret]@` segment)? */
export function urlCarriesUserinfo(url: string): boolean {
  // scheme://user[:pass]@host/…  — userinfo before the first '/' after '://'.
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/]*)/.exec(url);
  if (m) return m[1]!.includes("@");
  // scp-like syntax (git@host:path) is an SSH USER, not an embedded secret;
  // plain filesystem paths carry no userinfo. Neither is refused here.
  return false;
}

export interface ProvisionWorkerCloneOptions {
  /** Clone source: a filesystem path or a credential-FREE URL. */
  sourceRepo: string;
  /** Destination directory (created by git; must not already exist). */
  destDir: string;
  /** Branch to check out (default: the source's HEAD branch). */
  branch?: string;
}

/**
 * Materialize a worker workspace: a full isolated clone with hooks disabled
 * by config, then attest every isolation property from the on-disk result.
 *
 *   --no-local      forces the full object transfer even for a filesystem
 *                   source — no hardlinks, no alternates, an object store
 *                   that stands alone (the "full clone" in CAM-EXEC-02);
 *   -c core.hooksPath=/dev/null   persisted into the clone config, so no
 *                   hook can run during the provisioning checkout or any
 *                   later control-plane operation;
 *   -c credential.helper=          resets the helper list in the clone.
 */
export function provisionWorkerClone(
  opts: ProvisionWorkerCloneOptions,
): WorkerCloneIsolationRecord {
  if (urlCarriesUserinfo(opts.sourceRepo)) {
    throw new WorkerCloneError(
      "worker clone source URL carries userinfo — workers receive credential-free sources only (CAM-EXEC-02)",
    );
  }
  const args = [
    "clone",
    "--no-local",
    "--no-hardlinks",
    "-c",
    `core.hooksPath=${WORKER_CLONE_HOOKS_PATH}`,
    "-c",
    "credential.helper=",
  ];
  if (opts.branch) args.push("--branch", opts.branch);
  args.push("--", opts.sourceRepo, opts.destDir);
  try {
    git(null, args);
  } catch (err) {
    throw new WorkerCloneError(`worker clone failed: ${(err as Error).message.slice(0, 400)}`);
  }
  return assertWorkerCloneIsolation(opts.destDir);
}

/**
 * Re-derive every isolation property from the on-disk clone; throw (fail-
 * closed) if ANY does not hold. This is the CAM-EXEC-02 fixture surface: a
 * linked worktree, a --shared/--reference clone, a credentialed remote, a
 * configured credential helper, or planted credential material each trip it.
 */
export function assertWorkerCloneIsolation(dir: string): WorkerCloneIsolationRecord {
  const gitPath = join(dir, ".git");
  let gitIsRealDirectory = false;
  try {
    // lstat: a SYMLINK at .git (pointing anywhere) is not a real directory.
    gitIsRealDirectory = lstatSync(gitPath).isDirectory();
  } catch {
    gitIsRealDirectory = false;
  }
  if (!gitIsRealDirectory) {
    throw new WorkerCloneError(
      "workspace .git is not a real directory — a linked worktree or gitfile redirect is never a worker workspace (CAM-EXEC-02)",
    );
  }

  const noAlternates = !existsSync(join(gitPath, "objects", "info", "alternates"));
  if (!noAlternates) {
    throw new WorkerCloneError(
      "workspace object store has alternates — a shared/reference clone is never a worker workspace (CAM-EXEC-02)",
    );
  }

  // A --local clone (without --no-hardlinks) HARDLINKS its object files to the
  // source, so the object store is not standalone even though no alternates
  // file exists (round-1 finding 10). A full --no-local clone transfers a pack
  // and writes fresh files with link count 1. Independently attest that NO
  // object file is hardlinked (nlink > 1) — both loose objects AND packs, since
  // a `git gc`'d source hardlinks its .pack/.idx into the clone (round-2
  // finding 7). Catches a provisioning-command regression that dropped
  // --no-hardlinks, without needing the source path.
  const noHardlinkedObjects = !hasHardlinkedObject(join(gitPath, "objects"));
  if (!noHardlinkedObjects) {
    throw new WorkerCloneError(
      "workspace object store is not self-contained — a hardlinked object file (nlink>1, loose " +
        "or packed), or a symlinked object directory pointing at an external store (round-10 " +
        "finding 6) — a --local/shared clone is never a worker workspace (CAM-EXEC-02)",
    );
  }

  // Scan the EFFECTIVE local config (includes resolved) for the git credential
  // and command-execution channels a clone could carry (round-2 finding 4;
  // widened round-3 finding 4):
  //   - credential.helper AND scoped credential.<url>.helper — a helper value;
  //   - remote.<name>.url / .pushurl — a url with userinfo (fetch OR push);
  //   - url.<X>.insteadOf / pushInsteadOf — userinfo in the rewrite TARGET X
  //     (the SUBSECTION, not the value), which injects a credential into a
  //     clean url;
  //   - http.<url>.extraheader — an Authorization header channel;
  //   - *.sshCommand (core.sshCommand and any subsection) — a git-op exec
  //     channel.
  //
  // BOUNDARY, stated (round-3 finding 4; the delegate-to-git-fsck precedent):
  // git's config surface of credential/exec channels is UNBOUNDED — a finder
  // can always name the next `core.fsmonitor`, `diff.external`, `*.process`,
  // etc. This attestation covers the reachable channels; the COMPLETE
  // guarantee is STRUCTURAL, not from an exhaustive denylist: (a) the worker
  // container mounts no host HOME and composeWorkerEnv (WP-105) strips the
  // credential/exec ENV, so no credential exists for a helper/insteadOf to
  // yield and no attacker PATH steers an exec channel; (b) credentialed git
  // never runs in worker-touched directories (design §5.1); (c) the clone is
  // hooks-disabled and Camino-provisioned. A config channel that needs a
  // credential Camino does not provide, or an exec that needs a binary the
  // stripped env cannot resolve, cannot leverage anything.
  const config = effectiveGitConfig(dir);
  let noCredentialHelper = true;
  let remotesCredentialFree = true;
  let noHttpExtraheader = true;
  let noSshCommand = true;
  // core.hooksPath read from the EFFECTIVE config (round-11 finding 10): a
  // `git config --local --get` does NOT process includes, so an [include]d file
  // that re-sets core.hooksPath to an attacker path would be missed while the
  // local value still read /dev/null. The LAST value in the effective list wins
  // (git's last-wins precedence), so track it across all entries.
  let effectiveHooksPath: string | null = null;
  for (const { key, value } of config) {
    const lk = key.toLowerCase();
    if (lk === "core.hookspath") effectiveHooksPath = value;
    if (/^credential\.(.+\.)?helper$/.test(lk) && value.length > 0) noCredentialHelper = false;
    if (/^remote\..+\.(pushurl|url)$/.test(lk) && urlCarriesUserinfo(value)) {
      remotesCredentialFree = false;
    }
    // url.<X>.insteadof — the secret rides the SUBSECTION X (the rewrite
    // target), not the value; extract and check X for userinfo.
    const insteadOf = /^url\.(.+)\.(insteadof|pushinsteadof)$/.exec(lk);
    if (insteadOf && urlCarriesUserinfo(insteadOf[1]!)) remotesCredentialFree = false;
    if (/^http\.(.+\.)?extraheader$/.test(lk) && value.length > 0) noHttpExtraheader = false;
    if (/(^|\.)sshcommand$/.test(lk) && value.length > 0) noSshCommand = false;
  }
  const hooksDisabledByConfig = effectiveHooksPath === WORKER_CLONE_HOOKS_PATH;
  if (!hooksDisabledByConfig) {
    throw new WorkerCloneError(
      `workspace clone config does not disable hooks (effective core.hooksPath=${JSON.stringify(effectiveHooksPath)}; want ${WORKER_CLONE_HOOKS_PATH})`,
    );
  }
  if (!noCredentialHelper) {
    throw new WorkerCloneError(
      "workspace clone config carries a credential helper — refused (CAM-EXEC-02)",
    );
  }
  if (!remotesCredentialFree) {
    throw new WorkerCloneError(
      "a workspace remote URL / url.insteadOf carries userinfo — workers hold zero GitHub credentials (CAM-EXEC-02)",
    );
  }
  if (!noHttpExtraheader) {
    throw new WorkerCloneError(
      "workspace clone config carries an http.extraheader (Authorization channel) — refused (CAM-EXEC-02)",
    );
  }
  if (!noSshCommand) {
    throw new WorkerCloneError(
      "workspace clone config carries an sshCommand (git-op exec channel) — refused (CAM-EXEC-02)",
    );
  }

  const credentialMaterialPaths = scanForGithubCredentialMaterial(dir);
  if (credentialMaterialPaths.length > 0) {
    throw new WorkerCloneError(
      `workspace carries credential material at: ${credentialMaterialPaths.join(", ")} (CAM-EXEC-02)`,
    );
  }

  return {
    gitIsRealDirectory,
    noAlternates,
    noHardlinkedObjects,
    hooksDisabledByConfig,
    noCredentialHelper,
    remotesCredentialFree,
    noHttpExtraheader,
    noSshCommand,
    credentialMaterialPaths,
  };
}

/**
 * Is any OBJECT file under `objectsDir` hardlinked (st_nlink > 1)? A --local
 * hardlink clone shares its object files with the source (nlink 2); a full
 * --no-local clone writes fresh files (nlink 1). Scans BOTH the loose-object
 * `??/` fan-out dirs AND `pack/` (a `git gc`'d source hardlinks its .pack/.idx
 * into the clone — round-2 finding 7). Bounded; stops at the first hardlink.
 */
function hasHardlinkedObject(objectsDir: string): boolean {
  // A standalone object store's files are REAL regular files with link count 1.
  // A SHARED store shows up as either a hardlink (nlink>1 — a --local clone) OR
  // a SYMLINK pointing back at the source (round-3 finding 9: a symlinked
  // .pack has nlink 1 but is not standalone; delete the source and fsck fails).
  // A whole object DIRECTORY can also be a symlink to an external store (round-10
  // finding 6): its files have nlink 1 and aren't symlinks, so the per-file scan
  // passes, yet the clone is NOT self-contained — move the store and fsck fails.
  // So a symlinked objects dir, fan-out dir, or pack dir is itself "shared".
  const isSymlink = (p: string): boolean => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  };
  if (isSymlink(objectsDir)) return true;
  const anySharedIn = (subDir: string): boolean => {
    if (isSymlink(subDir)) return true; // a symlinked fan-out/pack dir → external store
    let names: string[];
    try {
      names = readdirSync(subDir);
    } catch {
      return false;
    }
    for (const name of names) {
      try {
        const st = lstatSync(join(subDir, name));
        if (st.isSymbolicLink()) return true; // object file must not be a symlink
        if (st.nlink > 1) return true; // hardlinked into another tree
      } catch {
        /* raced/removed object — ignore */
      }
    }
    return false;
  };
  let fanoutDirs: string[];
  try {
    fanoutDirs = readdirSync(objectsDir);
  } catch {
    return false; // no objects dir → nothing shared
  }
  for (const fan of fanoutDirs) {
    if (!/^[0-9a-f]{2}$/.test(fan)) continue; // 2-hex loose fan-out dirs
    if (anySharedIn(join(objectsDir, fan))) return true;
  }
  // Packed objects: .pack / .idx (and .rev) files under objects/pack.
  if (anySharedIn(join(objectsDir, "pack"))) return true;
  return false;
}

/**
 * File NAMES that are stored-credential files wherever they appear — these
 * exist ONLY to hold credentials, so the name alone is the finding (contents
 * are never read or reported).
 */
const CREDENTIAL_FILE_NAMES = new Set([".git-credentials", ".netrc", "_netrc"]);

/** Git config file names whose CONTENT is checked for credential channels. */
const GIT_CONFIG_FILE_NAMES = new Set(["config", ".gitconfig"]);

/**
 * Files that MAY hold a token but also have legitimate token-free uses (a
 * public-registry `.npmrc`, a gh `hosts.yml` config). Matched by name, then
 * CONTENT-checked for a token so a token-free file is NOT a false positive
 * (round-1 finding 2). Kept bounded — this is defense-in-depth over the real
 * boundary (the container mounts no host HOME), not an unbounded denylist.
 */
const CREDENTIAL_CONTENT_FILE_NAMES = new Set(["hosts.yml", "hosts.json", ".npmrc"]);
// A credential KEY (`_authToken`/`_auth`/`_password`/`oauth_token`) followed by
// `=` or `:` and a captured VALUE — handles npmrc (`//host/:_authToken=v`, the
// key itself contains a `:`) and yaml (`oauth_token: v`) alike. Checked per
// NON-COMMENT line; a missing/empty/placeholder value is NOT a finding, so a
// commented-out or example line is not a false positive (round-2 finding 11).
const CREDENTIAL_ASSIGNMENT_RE =
  /(?:_authtoken|_auth|_password|oauth_token)["'\s]*[:=]["'\s]*([^\s"']+)/iu;
const PLACEHOLDER_VALUES = new Set([
  "example",
  "changeme",
  "xxx",
  "your_token_here",
  "todo",
  "null",
]);

/** Does file text carry a credential assignment with a real value (comment-aware)? */
function contentHasCredential(text: string): boolean {
  for (const rawLine of text.split("\n")) {
    // Strip an INLINE comment (round-3 finding 12): a ` #`/` ;` (whitespace-
    // preceded, or at line start) begins a comment in yaml/ini/npmrc, so
    // `user: someone # oauth_token: gho_X` carries no real credential. This
    // over-strips a `#`/`;` that legitimately appears mid-value after a space
    // (rare for a token); over-stripping only causes a MISS in this
    // defense-in-depth scan, and the real guard is the no-host-HOME container.
    const line = rawLine.replace(/(^|\s)[#;].*$/u, "").trim();
    if (line.length === 0) continue;
    const m = CREDENTIAL_ASSIGNMENT_RE.exec(line);
    if (m && !PLACEHOLDER_VALUES.has(m[1]!.toLowerCase())) return true; // a real value present
  }
  return false;
}

// Depth/entry caps so a hostile tree cannot drive an unbounded walk; a
// beyond-cap tree is itself reported (fail-closed: "not fully scanned" is a
// finding, never a silent pass).
const SCAN_MAX_DEPTH = 32;
const SCAN_MAX_ENTRIES = 200_000;

/**
 * Walk the workspace for GitHub credential MATERIAL (the CAM-EXEC-02
 * filesystem assertion): stored-credential files by name, git config files
 * whose content opens a credential channel, token-carrying `.npmrc`/`hosts.yml`
 * (comment-aware), and credential-NAMED SYMLINKS (a `.npmrc → secrets.txt`
 * alias — round-2 finding 4). Returns the offending workspace-relative paths —
 * NEVER file contents, so the report cannot itself leak a secret.
 *
 * BOUNDARY, stated (round-2 finding 4): literal content scanning cannot catch
 * every ENCODING of a token a repo could commit (unicode-escaped YAML keys,
 * base64, split values) — that is the same regenerating surface the WP-003
 * unicode work named. This scan is DEFENSE-IN-DEPTH; the real guarantee is
 * that the worker CONTAINER mounts no host HOME (egress.ts), so a vendor CLI
 * cannot reach the host's real credentials regardless of workspace content, and
 * a repo committing its OWN token has leaked its own secret, not Camino's.
 */
export function scanForGithubCredentialMaterial(dir: string): string[] {
  const findings: string[] = [];
  let entriesSeen = 0;
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > SCAN_MAX_DEPTH) {
      findings.push(`${rel}/ (beyond scan depth — not fully scanned)`);
      return;
    }
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      findings.push(`${rel}/ (unreadable — not fully scanned)`);
      return;
    }
    for (const name of names) {
      if (++entriesSeen > SCAN_MAX_ENTRIES) {
        findings.push(`${rel}/ (beyond scan entry cap — not fully scanned)`);
        return;
      }
      const absChild = join(abs, name);
      const relChild = rel.length === 0 ? name : `${rel}/${name}`;
      // Case-FOLD the name before matching (round-3 finding 6): on a
      // case-insensitive host/mount (macOS, Docker Desktop) `.NPMRC` and
      // `.npmrc` are the SAME file to a vendor CLI, so the credential-name sets
      // must match case-insensitively. ASCII lower-casing suffices for these
      // ASCII names; matching case-insensitively on a case-sensitive host only
      // OVER-flags (fail-closed), never under.
      const lname = name.toLowerCase();
      let stat;
      try {
        stat = lstatSync(absChild);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(absChild, relChild, depth + 1);
        continue;
      }
      // A credential-NAMED symlink is flagged without following it (round-2
      // finding 4): a `.npmrc → secrets.txt` alias otherwise hid the token in a
      // non-credential-named target. Fail-closed on the NAME; the target is
      // never read (no symlink-follow / TOCTOU).
      if (
        stat.isSymbolicLink() &&
        (CREDENTIAL_FILE_NAMES.has(lname) || CREDENTIAL_CONTENT_FILE_NAMES.has(lname))
      ) {
        findings.push(`${relChild} (credential-named symlink)`);
        continue;
      }
      if (!stat.isFile()) continue; // other symlinks/special files are not read
      if (CREDENTIAL_FILE_NAMES.has(lname)) {
        findings.push(relChild);
        continue;
      }
      if (GIT_CONFIG_FILE_NAMES.has(lname)) {
        let text = "";
        try {
          text = readFileSync(absChild, "utf8");
        } catch {
          findings.push(`${relChild} (unreadable git config — not scanned)`);
          continue;
        }
        if (gitConfigOpensCredentialChannel(text)) findings.push(relChild);
        continue;
      }
      if (CREDENTIAL_CONTENT_FILE_NAMES.has(lname)) {
        let text = "";
        try {
          text = readFileSync(absChild, "utf8");
        } catch {
          findings.push(`${relChild} (unreadable credential-candidate — not scanned)`);
          continue;
        }
        // Token-free files (a public-registry .npmrc, a gh hosts.yml with no
        // oauth_token) and comment-only/example lines are NOT flagged — only a
        // real credential assignment is a finding (round-2 finding 11).
        if (contentHasCredential(text)) findings.push(relChild);
      }
    }
  };
  walk(dir, "", 0);
  return findings.sort();
}

/**
 * Does git-config TEXT open a credential channel? Checked line-wise:
 * a non-empty credential helper assignment, an extraheader assignment
 * (Authorization riding http.<url>.extraheader), or a url value with
 * userinfo. Conservative on match, and it reads config the way git does
 * closely enough for a REFUSAL check (false positives fail closed).
 */
function gitConfigOpensCredentialChannel(text: string): boolean {
  let inCredentialSection = false;
  let inHttpSection = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      const section = line.toLowerCase();
      inCredentialSection = section.startsWith("[credential");
      inHttpSection = section.startsWith("[http");
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (inCredentialSection && key === "helper" && value.length > 0) return true;
    if (inHttpSection && key === "extraheader" && value.length > 0) return true;
    if (key === "url" && urlCarriesUserinfo(value)) return true;
  }
  return false;
}
