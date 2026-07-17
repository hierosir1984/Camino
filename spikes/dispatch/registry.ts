import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AdapterSpec } from "./types.js";
import { claudeAdapter } from "./adapters/claude.js";
import { codexAdapter } from "./adapters/codex.js";
import { grokAdapter } from "./adapters/grok.js";

const here = dirname(fileURLToPath(import.meta.url));
const ATTESTATIONS = join(here, "..", "..", "docs", "plan", "phase-0-prereq-attestations.json");

/** Is a CLI resolvable on PATH? (installation probe; auth is proven by dispatch) */
function cliPresent(bin: string): boolean {
  try {
    execFileSync("command", ["-v", bin], { stdio: "ignore", shell: "/bin/bash" });
    return true;
  } catch {
    return false;
  }
}

/** Read the recorded xAI sanctioned-path disposition (WP-000 gate record). */
function xaiSanctioned(): boolean {
  try {
    const att = JSON.parse(readFileSync(ATTESTATIONS, "utf8")) as {
      xaiSanctionedPath?: { status?: string };
    };
    return att.xaiSanctionedPath?.status === "accepted";
  } catch {
    return false;
  }
}

/**
 * The v1 adapter set (CAM-EXEC-01). Enablement is gated on BOTH CLI presence and
 * the sanctioned-path record: an adapter whose CLI is absent — or, for xAI,
 * whose contractual sanctioned-path check is not recorded accepted — is
 * installable-but-DISABLED with a recorded reason, and the harness skips it
 * (the disabled negative path). Claude/Codex are endorsed for third-party
 * harness use; xAI is gated on the recorded disposition
 * (docs/plan/xai-sanctioned-path-research.md, accepted 2026-07-17).
 */
export function buildRegistry(): AdapterSpec[] {
  const claude = cliPresent("claude")
    ? claudeAdapter()
    : claudeAdapter({ enabled: false, disabledReason: "claude CLI not found on PATH" });

  const codex = cliPresent("codex")
    ? codexAdapter()
    : codexAdapter({ enabled: false, disabledReason: "codex CLI not found on PATH" });

  let grok: AdapterSpec;
  if (!cliPresent("grok")) {
    grok = grokAdapter({ enabled: false, disabledReason: "grok CLI not found on PATH" });
  } else if (!xaiSanctioned()) {
    grok = grokAdapter({
      enabled: false,
      disabledReason: "xAI sanctioned-path not recorded accepted (WP-000 gate)",
    });
  } else {
    grok = grokAdapter();
  }

  return [claude, codex, grok];
}
