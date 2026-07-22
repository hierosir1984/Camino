// WP-107: per-repo worker egress configuration (CAM-EXEC-03).
//
// The egress allowlist — package registries and docs endpoints the worker may
// reach — comes from the repo's `.camino/config.yml`. Parsing is FAIL-CLOSED
// in both directions:
//
//   - an ABSENT file or absent `egress:` section is the deny-all baseline
//     (empty allowlist) — a repo that configures nothing gets no egress;
//   - a PRESENT-but-malformed config REFUSES the worker run with a reason
//     (RepoConfigError) rather than silently denying — a typo'd allowlist
//     must surface as a configuration error, never as a mystery network
//     failure inside an attempt.
//
// `.camino/config.yml` is a quarantine-protected path (CAM-EXEC-04): workers
// cannot land changes to it, so this file is user-authored configuration.
// It is still parsed defensively (schema refusal on unknown keys, entry
// caps, safe host/port shapes) because a config error must fail loudly.
import { closeSync, constants as fsConstants, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { type EgressAllowlistEntry, isValidAllowlistHost, isValidAllowlistPort } from "./egress.js";

export class RepoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoConfigError";
  }
}

/** Repo-relative location of the per-repo config file. */
export const REPO_CONFIG_PATH = ".camino/config.yml";

/** Bound on allowlist size so a config cannot install an unbounded rule set. */
export const MAX_EGRESS_ALLOWLIST_ENTRIES = 64;

export interface WorkerEgressConfig {
  /** Deduplicated host:port entries; empty = deny-all baseline. */
  allow: EgressAllowlistEntry[];
}

/**
 * Parse the `egress:` section of a `.camino/config.yml` document.
 * `text === null` means the file does not exist (deny-all baseline).
 */
export function parseRepoEgressConfig(text: string | null): WorkerEgressConfig {
  if (text === null || text.trim().length === 0) return { allow: [] }; // absent/empty = deny-all
  let doc: unknown;
  try {
    doc = loadYaml(text);
  } catch (err) {
    throw new RepoConfigError(
      `${REPO_CONFIG_PATH} is not valid YAML: ${describeConfigError(err, 300)}`,
    );
  }
  if (doc === null || doc === undefined) return { allow: [] };
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new RepoConfigError(`${REPO_CONFIG_PATH} must be a YAML mapping at the top level`);
  }
  const egress = (doc as Record<string, unknown>)["egress"];
  if (egress === undefined || egress === null) return { allow: [] };
  if (typeof egress !== "object" || Array.isArray(egress)) {
    throw new RepoConfigError(`${REPO_CONFIG_PATH}: "egress" must be a mapping`);
  }
  // Unknown keys are REFUSED, not ignored: a typo like `alow:` silently
  // ignored would run the worker deny-all while the user believes the
  // allowlist is in force.
  const keys = Object.keys(egress as Record<string, unknown>);
  const unknown = keys.filter((k) => k !== "allow");
  if (unknown.length > 0) {
    throw new RepoConfigError(
      `${REPO_CONFIG_PATH}: unknown egress key(s) ${unknown.map((k) => JSON.stringify(k)).join(", ")} — only "allow" is supported (fail-closed)`,
    );
  }
  const allowRaw = (egress as Record<string, unknown>)["allow"];
  if (allowRaw === undefined || allowRaw === null) return { allow: [] };
  if (!Array.isArray(allowRaw)) {
    throw new RepoConfigError(`${REPO_CONFIG_PATH}: "egress.allow" must be a list`);
  }
  if (allowRaw.length > MAX_EGRESS_ALLOWLIST_ENTRIES) {
    throw new RepoConfigError(
      `${REPO_CONFIG_PATH}: egress.allow has ${allowRaw.length} entries (max ${MAX_EGRESS_ALLOWLIST_ENTRIES})`,
    );
  }
  const seen = new Set<string>();
  const allow: EgressAllowlistEntry[] = [];
  for (const [i, raw] of allowRaw.entries()) {
    const at = `${REPO_CONFIG_PATH}: egress.allow[${i}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new RepoConfigError(`${at} must be a mapping with "host" and "port"`);
    }
    const entry = raw as Record<string, unknown>;
    const extra = Object.keys(entry).filter((k) => k !== "host" && k !== "port");
    if (extra.length > 0) {
      throw new RepoConfigError(
        `${at}: unknown key(s) ${extra.map((k) => JSON.stringify(k)).join(", ")}`,
      );
    }
    const host = entry["host"];
    const port = entry["port"];
    if (typeof host !== "string" || !isValidAllowlistHost(host)) {
      throw new RepoConfigError(
        `${at}: host must be a DNS name or IPv4 literal (got ${JSON.stringify(host)})`,
      );
    }
    if (typeof port !== "number" || !isValidAllowlistPort(port)) {
      throw new RepoConfigError(`${at}: port must be an integer in 1-65535`);
    }
    const key = `${host.toLowerCase()}:${port}`;
    if (seen.has(key)) continue; // duplicates collapse — same semantics
    seen.add(key);
    allow.push({ host, port });
  }
  return { allow };
}

/** Load and parse the per-repo egress config from a checked-out repo dir. */
export function loadRepoEgressConfig(repoDir: string): WorkerEgressConfig {
  // The config must be a REAL file reached through REAL directories (round-10
  // finding 8). Quarantine (CAM-EXEC-04) protects the pathname `.camino/config.yml`;
  // a SYMLINK there (or a symlinked `.camino`) would let the read resolve to a
  // DIFFERENT, unprotected path the worker CAN edit — controlling effective egress
  // policy while the protected pathname appears unchanged. Refuse any symlink on
  // the path; an absent path stays the deny-all baseline.
  for (const rel of [".camino", REPO_CONFIG_PATH]) {
    let st: ReturnType<typeof lstatSync> | null;
    try {
      st = lstatSync(join(repoDir, rel));
    } catch {
      st = null; // absent — the read below yields the deny-all baseline
    }
    if (st?.isSymbolicLink()) {
      throw new RepoConfigError(
        `${rel} is a symlink — the per-repo config must be a real file reached through real directories (fail-closed): a symlink could redirect egress policy to a path outside quarantine's protection`,
      );
    }
  }
  // Read the config file with O_NOFOLLOW so the FINAL component cannot be a symlink
  // AT OPEN TIME — atomic, closing the lstat→open race for `config.yml` itself
  // (round-11 finding 13). ELOOP here means it became a symlink; refuse.
  //
  // BOUNDARY, stated: a symlinked `.camino` PARENT swapped between the lstat above
  // and this open is a check→use race that presupposes a concurrent DAEMON-SIDE
  // writer of the checked-out repo tree — the repo checkout is daemon-owned and
  // single-writer (composed before the container-confined worker runs), so that
  // race is outside the worker threat model. The lstat above closes the reachable
  // (static) symlinked-parent misconfiguration; O_NOFOLLOW closes the file itself.
  let text: string | null;
  let fd: number | undefined;
  try {
    fd = openSync(join(repoDir, REPO_CONFIG_PATH), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    text = readFileSync(fd, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      text = null; // absent file = deny-all baseline
    } else if (code === "ELOOP") {
      throw new RepoConfigError(
        `${REPO_CONFIG_PATH} is a symlink (O_NOFOLLOW) — the per-repo config must be a real file (fail-closed): a symlink could redirect egress policy outside quarantine's protection`,
      );
    } else {
      throw new RepoConfigError(
        `${REPO_CONFIG_PATH} exists but cannot be read: ${describeConfigError(err)}`,
      );
    }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort close */
      }
    }
  }
  return parseRepoEgressConfig(text);
}

/** Stringify ANY thrown value safely (parity with archive.ts describeError). */
function describeConfigError(err: unknown, max = 200): string {
  try {
    return String(err instanceof Error ? err.message : err).slice(0, max);
  } catch {
    return "unstringifiable error";
  }
}
