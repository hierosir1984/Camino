// WP-105: the v1 adapter registry (CAM-EXEC-01). Enablement is a DECISION the
// registry makes and records — an adapter whose CLI is absent, or whose
// provider's sanctioned-path verification is not recorded accepted, is
// installable-but-DISABLED with the reason recorded, and the lifecycle
// refuses to dispatch it (the negative path is enforced, not advisory).
//
// EVERY provider is gated on a RECORDED, failure-capable sanctioned-path
// decision (round-1 review finding 8) — not just xAI. The decisions are
// recorded here as source-linked constants, and a provider whose recorded
// status is not "accepted" is disabled with a precise reason, so flipping a
// record disables an adapter without a code change:
//   - anthropic / claude-code, openai / codex-cli: the vendor's own official
//     CLI on the user's own subscription is the sanctioned headless path
//     (PRD §9; design doc 05 research record). Recorded accepted here.
//   - xai / grok-build: contractual confirmation is a RECORDED DISPOSITION
//     (docs/plan/xai-sanctioned-path-research.md, accepted by David
//     2026-07-17), consumed at runtime from the WP-000 attestations file so a
//     future retraction (editing that record) disables the adapter, AND an
//     unreadable / malformed / not-accepted record each yields its own precise
//     reason.
// The full time-varying capability registry lands in WP-106; until then these
// records live here, source-linked, with the same failure-capable shape.
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { AdapterSpec } from "@camino/shared";
import { claudeAdapter } from "./adapters/claude.js";
import { codexAdapter } from "./adapters/codex.js";
import { grokAdapter } from "./adapters/grok.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Repo-root attestations record (David-edited; WP-000 gate artifact). */
export const DEFAULT_ATTESTATIONS_PATH = join(
  here,
  "..",
  "..",
  "..",
  "..",
  "docs",
  "plan",
  "phase-0-prereq-attestations.json",
);

/**
 * Recorded sanctioned-path decision for the CLI-native (subscription)
 * providers. Source-linked, failure-capable: set `accepted: false` (with a
 * reason) to disable an adapter without touching dispatch code. xAI is NOT
 * here — its decision is consumed from the attestations file at runtime.
 */
const RECORDED_SANCTIONED_PATHS: Record<
  string,
  { accepted: boolean; reason?: string; source: string }
> = {
  "claude-code": {
    accepted: true,
    source: "PRD §9 (official CLI on the user's own subscription is the sanctioned headless path)",
  },
  "codex-cli": {
    accepted: true,
    source:
      "PRD §9 + design doc 05 (subscription use of the official CLI in third-party harnesses is endorsed)",
  },
};

/**
 * Is a CLI resolvable on PATH as an executable regular file? A direct PATH
 * scan (no shell): deterministic, injectable via RegistryOptions, and free of
 * shell quoting concerns.
 *
 * DELIBERATE hardening (round-1 review finding 9): empty PATH components and
 * relative PATH entries are IGNORED. POSIX `execvp` treats an empty PATH slot
 * as the current directory and would resolve a relative entry against the
 * process cwd — both are footguns (a CLI "found" only because of a cwd-relative
 * PATH entry is not a stable install). The registry recognizes a CLI only via
 * ABSOLUTE PATH directories; this can under-report a CLI reachable solely
 * through an empty/relative entry, which is the safe direction. Installation
 * probe only — auth is proven by dispatch, never inspected (CAM-SEC-06).
 */
export function cliOnPath(bin: string, pathValue: string | undefined): boolean {
  if (!pathValue || bin.length === 0 || bin.includes("/")) return false;
  for (const dir of pathValue.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue; // ignore empty (=cwd) and relative entries
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return true; // follows symlinks
    } catch {
      /* keep scanning */
    }
  }
  return false;
}

/** The xAI sanctioned-path gate decision, with a precise recorded reason on refusal. */
function xaiSanctioned(attestationsPath: string): { accepted: boolean; reason?: string } {
  let raw: string;
  try {
    raw = readFileSync(attestationsPath, "utf8");
  } catch {
    return {
      accepted: false,
      reason: "xAI sanctioned-path record unreadable (docs/plan/phase-0-prereq-attestations.json)",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      accepted: false,
      reason: "xAI sanctioned-path record malformed (not valid JSON)",
    };
  }
  // JSON `null` / a non-object (array, string, number) parses fine but is not a
  // record — guard before property access (round-2 review finding 6).
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      accepted: false,
      reason: "xAI sanctioned-path record malformed (not a JSON object)",
    };
  }
  const att = parsed as { xaiSanctionedPath?: unknown };
  const record = att.xaiSanctionedPath;
  if (record === undefined) {
    return { accepted: false, reason: "xAI sanctioned-path record absent (WP-000 gate)" };
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return {
      accepted: false,
      reason: "xAI sanctionedPath field is not an object (WP-000 gate)",
    };
  }
  const status = (record as { status?: unknown }).status;
  if (status === "accepted") return { accepted: true };
  if (status === undefined) {
    return {
      accepted: false,
      reason: "xAI sanctioned-path status absent from record (WP-000 gate)",
    };
  }
  // Describe a wrong status precisely but BOUNDED: never JSON.stringify an
  // arbitrary-depth value (stack overflow, round-3 finding 4) or an arbitrarily
  // large string (log amplification, round-4 finding 5). Distinguish
  // null / array / object (all `typeof "object"`) for a precise reason.
  const shown =
    status === null
      ? "null"
      : Array.isArray(status)
        ? "an array"
        : typeof status === "object"
          ? "an object"
          : typeof status === "string"
            ? JSON.stringify(status.slice(0, 60))
            : `a ${typeof status} value`;
  return {
    accepted: false,
    reason: `xAI sanctioned-path status is ${shown}, not "accepted" (WP-000 gate)`,
  };
}

export interface RegistryOptions {
  /** Override the attestations record location (tests). */
  attestationsPath?: string;
  /** Override the CLI presence probe (tests). */
  cliPresent?: (bin: string) => boolean;
}

/**
 * Registry provenance (round-6 finding 1): every spec buildRegistry returns —
 * enabled or disabled — is registered here, and dispatch() refuses an ENABLED
 * spec bearing an official adapter name that is not. WeakSet membership cannot
 * be copied onto a forged object (unlike a symbol property), so a spread/copy
 * of a gated spec deliberately loses provenance. NAMED BOUNDARY: this defeats
 * ACCIDENTAL bypass of the sanctioned-path gate by first-party code; it is not
 * in-process capability sealing (code in this process can import the factory
 * modules by path) — that isolation is the container/process boundary
 * (WP-107, CAM-EXEC-02).
 */
const REGISTRY_GATED = new WeakSet<AdapterSpec>();

/** Did this exact spec object come out of buildRegistry()'s gate? */
export function hasRegistryProvenance(spec: AdapterSpec): boolean {
  return REGISTRY_GATED.has(spec);
}

/** Apply the CLI-presence + recorded sanctioned-path gate to one adapter factory. */
function gate(
  name: string,
  present: boolean,
  cliBin: string,
  sanctioned: { accepted: boolean; reason?: string },
  make: (opts?: { enabled?: boolean; disabledReason?: string }) => AdapterSpec,
): AdapterSpec {
  let spec: AdapterSpec;
  if (!present) {
    spec = make({ enabled: false, disabledReason: `${cliBin} CLI not found on PATH` });
  } else if (!sanctioned.accepted) {
    spec = make({
      enabled: false,
      disabledReason: sanctioned.reason ?? `${name} sanctioned-path not recorded accepted`,
    });
  } else {
    spec = make();
  }
  REGISTRY_GATED.add(spec);
  return spec;
}

/**
 * The v1 adapter set (CAM-EXEC-01): every adapter is returned — enabled, or
 * disabled with its recorded reason. Each is gated on BOTH CLI presence and a
 * recorded sanctioned-path decision; the first failed gate names the reason.
 */
export function buildRegistry(opts: RegistryOptions = {}): AdapterSpec[] {
  const present = opts.cliPresent ?? ((bin: string) => cliOnPath(bin, process.env["PATH"]));
  const attestationsPath = opts.attestationsPath ?? DEFAULT_ATTESTATIONS_PATH;

  const claude = gate(
    "claude-code",
    present("claude"),
    "claude",
    RECORDED_SANCTIONED_PATHS["claude-code"]!,
    claudeAdapter,
  );
  const codex = gate(
    "codex-cli",
    present("codex"),
    "codex",
    RECORDED_SANCTIONED_PATHS["codex-cli"]!,
    codexAdapter,
  );
  const grok = gate(
    "grok-build",
    present("grok"),
    "grok",
    xaiSanctioned(attestationsPath),
    grokAdapter,
  );

  return [claude, codex, grok];
}
