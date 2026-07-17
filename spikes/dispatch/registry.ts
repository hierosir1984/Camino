import { execFileSync } from "node:child_process";
import type { AdapterSpec } from "./types.js";
import { claudeAdapter } from "./adapters/claude.js";
import { codexAdapter } from "./adapters/codex.js";
import { grokAdapter } from "./adapters/grok.js";

/** Is a CLI resolvable on PATH? (installation probe; auth is proven by dispatch) */
function cliPresent(bin: string): boolean {
  try {
    execFileSync("command", ["-v", bin], { stdio: "ignore", shell: "/bin/bash" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The v1 adapter set (CAM-EXEC-01). Enablement is gated on the sanctioned-path
 * verification recorded at onboarding: an adapter whose CLI is absent — or, for
 * xAI, whose contractual check had failed — is installable-but-DISABLED with a
 * recorded reason, and the dispatch spike must exercise that negative path.
 *
 * xAI's contractual sanctioned-path check is confirmed
 * (docs/plan/xai-sanctioned-path-research.md, accepted 2026-07-17), so Grok is
 * enabled here whenever its CLI is present.
 */
export function buildRegistry(): AdapterSpec[] {
  const claude = cliPresent("claude")
    ? claudeAdapter()
    : claudeAdapter({ enabled: false, disabledReason: "claude CLI not found on PATH" });
  const codex = cliPresent("codex")
    ? codexAdapter()
    : codexAdapter({ enabled: false, disabledReason: "codex CLI not found on PATH" });
  const grok = cliPresent("grok")
    ? grokAdapter()
    : grokAdapter({ enabled: false, disabledReason: "grok CLI not found on PATH" });
  return [claude, codex, grok];
}
