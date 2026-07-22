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
import { readFileSync } from "node:fs";
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
      `${REPO_CONFIG_PATH} is not valid YAML: ${(err as Error).message.slice(0, 300)}`,
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
  let text: string | null;
  try {
    text = readFileSync(join(repoDir, REPO_CONFIG_PATH), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      text = null; // absent file = deny-all baseline
    } else {
      throw new RepoConfigError(
        `${REPO_CONFIG_PATH} exists but cannot be read: ${(err as Error).message.slice(0, 200)}`,
      );
    }
  }
  return parseRepoEgressConfig(text);
}
