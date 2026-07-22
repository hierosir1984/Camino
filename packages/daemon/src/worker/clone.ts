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
  /** core.hooksPath is persisted to the disabling value in the clone config. */
  hooksDisabledByConfig: boolean;
  /** No credential.helper configured in the clone's local config. */
  noCredentialHelper: boolean;
  /** No remote URL carries userinfo (user:token@host). */
  remotesCredentialFree: boolean;
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

function git(cwd: string | null, args: string[]): string {
  const env: Record<string, string> = { ...CLONE_ENV_BASE };
  const path = process.env["PATH"];
  if (typeof path === "string") env["PATH"] = path;
  return execFileSync("git", cwd === null ? args : ["-C", cwd, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  })
    .toString()
    .trim();
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

  let hooksPath = "";
  try {
    hooksPath = git(dir, ["config", "--local", "--get", "core.hooksPath"]);
  } catch {
    hooksPath = "";
  }
  const hooksDisabledByConfig = hooksPath === WORKER_CLONE_HOOKS_PATH;
  if (!hooksDisabledByConfig) {
    throw new WorkerCloneError(
      `workspace clone config does not disable hooks (core.hooksPath=${JSON.stringify(hooksPath)}; want ${WORKER_CLONE_HOOKS_PATH})`,
    );
  }

  // credential.helper: the clone carries exactly the one EMPTY reset entry
  // written at clone time (or none at all) — any non-empty helper value is a
  // credential channel and is refused.
  let helperValues: string[] = [];
  try {
    helperValues = git(dir, ["config", "--local", "--get-all", "credential.helper"])
      .split("\n")
      .filter((v) => v.length > 0);
  } catch {
    helperValues = []; // unset entirely is fine
  }
  const noCredentialHelper = helperValues.length === 0;
  if (!noCredentialHelper) {
    throw new WorkerCloneError(
      "workspace clone config carries a credential helper — refused (CAM-EXEC-02)",
    );
  }

  let remotesCredentialFree = true;
  let remotes: string[] = [];
  try {
    remotes = git(dir, ["remote"])
      .split("\n")
      .filter((r) => r.length > 0);
  } catch {
    remotes = [];
  }
  for (const remote of remotes) {
    let url = "";
    try {
      url = git(dir, ["remote", "get-url", remote]);
    } catch {
      continue;
    }
    if (urlCarriesUserinfo(url)) remotesCredentialFree = false;
  }
  if (!remotesCredentialFree) {
    throw new WorkerCloneError(
      "a workspace remote URL carries userinfo — workers hold zero GitHub credentials (CAM-EXEC-02)",
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
    hooksDisabledByConfig,
    noCredentialHelper,
    remotesCredentialFree,
    credentialMaterialPaths,
  };
}

/** File NAMES that are stored-credential files wherever they appear. */
const CREDENTIAL_FILE_NAMES = new Set([".git-credentials", ".netrc", "_netrc"]);

/** Git config file names whose CONTENT is checked for credential channels. */
const GIT_CONFIG_FILE_NAMES = new Set(["config", ".gitconfig"]);

// Depth/entry caps so a hostile tree cannot drive an unbounded walk; a
// beyond-cap tree is itself reported (fail-closed: "not fully scanned" is a
// finding, never a silent pass).
const SCAN_MAX_DEPTH = 32;
const SCAN_MAX_ENTRIES = 200_000;

/**
 * Walk the workspace for GitHub credential MATERIAL (the CAM-EXEC-02
 * filesystem assertion): stored-credential files by name, and git config
 * files whose content opens a credential channel (a credential.helper
 * setting, a URL with userinfo, or an http extraheader carrying an
 * Authorization value). Returns the offending workspace-relative paths —
 * NEVER file contents, so the report cannot itself leak a secret.
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
      if (!stat.isFile()) continue; // symlinks/special files are not read
      if (CREDENTIAL_FILE_NAMES.has(name)) {
        findings.push(relChild);
        continue;
      }
      if (GIT_CONFIG_FILE_NAMES.has(name)) {
        let text = "";
        try {
          text = readFileSync(absChild, "utf8");
        } catch {
          findings.push(`${relChild} (unreadable git config — not scanned)`);
          continue;
        }
        if (gitConfigOpensCredentialChannel(text)) findings.push(relChild);
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
