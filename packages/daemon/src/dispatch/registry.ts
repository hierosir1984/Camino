// WP-105: the v1 adapter registry (CAM-EXEC-01). Enablement is a DECISION the
// registry makes and records — an adapter whose CLI is absent, or whose
// provider's sanctioned-path verification is not recorded accepted, is
// installable-but-DISABLED with the reason recorded, and the lifecycle
// refuses to dispatch it (the negative path is enforced, not advisory).
//
// Sanctioned-path records, per provider (CAM-EXEC-01: "recorded like every
// registry attribute"; the full time-varying capability registry lands in
// WP-106 — until then the records live here, source-linked):
//   - anthropic / claude-code: official CLI on the user's own subscription is
//     the vendor's supported headless path (PRD §9; design §9 records the
//     posture that ONLY the official harness may exercise subscription auth —
//     which is exactly what the composition does).
//   - openai / codex-cli: subscription use of the official CLI in third-party
//     harnesses is publicly endorsed (PRD §9, design doc 05 research record).
//   - xai / grok-build: contractual confirmation is a RECORDED DISPOSITION
//     (docs/plan/xai-sanctioned-path-research.md, accepted by David
//     2026-07-17), consumed at runtime from the WP-000 attestations file so a
//     future retraction (editing that record) disables the adapter without a
//     code change.
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { delimiter, dirname, join } from "node:path";
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
 * Is a CLI resolvable on PATH as an executable regular file? A direct PATH
 * scan (no shell): deterministic, injectable via RegistryOptions, and free of
 * shell quoting concerns. Installation probe only — auth is proven by
 * dispatch, never inspected (CAM-SEC-06).
 */
export function cliOnPath(bin: string, pathValue: string | undefined): boolean {
  if (!pathValue || bin.length === 0 || bin.includes("/")) return false;
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
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

/** The xAI sanctioned-path gate decision, with the recorded reason on refusal. */
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
  try {
    const att = JSON.parse(raw) as { xaiSanctionedPath?: { status?: unknown } };
    if (att.xaiSanctionedPath?.status === "accepted") return { accepted: true };
  } catch {
    /* malformed record → not accepted */
  }
  return {
    accepted: false,
    reason: "xAI sanctioned-path not recorded accepted (WP-000 gate)",
  };
}

export interface RegistryOptions {
  /** Override the attestations record location (tests). */
  attestationsPath?: string;
  /** Override the CLI presence probe (tests). */
  cliPresent?: (bin: string) => boolean;
}

/**
 * The v1 adapter set (CAM-EXEC-01): every adapter is returned — enabled, or
 * disabled with its recorded reason. The first failed gate names the reason
 * (CLI presence, then sanctioned path).
 */
export function buildRegistry(opts: RegistryOptions = {}): AdapterSpec[] {
  const present = opts.cliPresent ?? ((bin: string) => cliOnPath(bin, process.env["PATH"]));
  const attestationsPath = opts.attestationsPath ?? DEFAULT_ATTESTATIONS_PATH;

  const claude = present("claude")
    ? claudeAdapter()
    : claudeAdapter({ enabled: false, disabledReason: "claude CLI not found on PATH" });

  const codex = present("codex")
    ? codexAdapter()
    : codexAdapter({ enabled: false, disabledReason: "codex CLI not found on PATH" });

  let grok: AdapterSpec;
  if (!present("grok")) {
    grok = grokAdapter({ enabled: false, disabledReason: "grok CLI not found on PATH" });
  } else {
    const sanctioned = xaiSanctioned(attestationsPath);
    grok = sanctioned.accepted
      ? grokAdapter()
      : grokAdapter({ enabled: false, disabledReason: sanctioned.reason! });
  }

  return [claude, codex, grok];
}
