import type { AdapterContext, AdapterSpec, SpawnPlan, StreamEvent } from "@camino/shared";
import { classifyErrorTextForQuota, sumUsageTokens } from "../quota.js";

/**
 * Codex CLI (official), headless.
 *   codex exec "<prompt>" -C <workdir> --json --skip-git-repo-check \
 *         --dangerously-bypass-approvals-and-sandbox [-c model=<m>]
 * --json emits JSONL events to stdout. The bypass flag is the worker posture
 * (the clone is the boundary; WP-107 adds the container).
 *
 * Subscription auth is the CLI's own, read from under HOME (sanctioned path —
 * CAM-SEC-06); the adapter passes no credential-shaped env.
 */
export function codexAdapter(
  opts: {
    enabled?: boolean;
    disabledReason?: string;
    disabledCause?: "cli-absent" | "sanctioned-path";
    resolvedPath?: string;
  } = {},
): AdapterSpec {
  // Spawn the registry-resolved ABSOLUTE executable, not a bare name re-resolved
  // against the worker cwd (round-8 finding 1).
  const file = opts.resolvedPath ?? "codex";
  return {
    name: "codex-cli",
    enabled: opts.enabled ?? true,
    ...(opts.disabledReason ? { disabledReason: opts.disabledReason } : {}),
    ...(opts.disabledCause ? { disabledCause: opts.disabledCause } : {}),
    plan(ctx: AdapterContext): SpawnPlan {
      const args = [
        "exec",
        ctx.prompt,
        "-C",
        ctx.workdir,
        "--json",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
      ];
      if (ctx.model) args.push("-c", `model=${ctx.model}`);
      return { file, args };
    },
    parseLine(line: string, channel): StreamEvent | null {
      const trimmed = line.trim();
      // Quota is only trusted in an ERROR CONTEXT (round-2/3 finding 2/5):
      // stderr, error items, and error events — never assistant/agent output.
      const errText = (text: string): { quotaSignal: true } | Record<string, never> =>
        classifyErrorTextForQuota(text) ? { quotaSignal: true } : {};
      // A non-JSON OR malformed-JSON line on STDERR is diagnostic/error output:
      // catch a rate-limit / exhaustion signal here so a truncated provider
      // error is not lost (round-4 finding 2 — restores WP-001 dropped-line
      // protection, but scoped to the error channel to stay prose-resistant).
      const stderrErr = (): StreamEvent | null => {
        if (channel === "stderr" && trimmed.length > 0) {
          const eq = classifyErrorTextForQuota(trimmed);
          return {
            kind: eq ? "error" : "other",
            text: trimmed.slice(0, 400),
            ...(eq ? { quotaSignal: true as const } : {}),
          };
        }
        return null;
      };
      if (!trimmed.startsWith("{")) return stderrErr();
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return stderrErr(); // malformed JSON on stderr can still carry the signal
      }
      // Observed codex 0.144 JSONL: {type:"thread.started"|"item.completed"|
      // "turn.completed"|"turn.failed", item?:{…}, error?:{message}}.
      const type = String(obj["type"] ?? "");
      // turn.failed carries a nested {error:{message}} (official 0.144 schema)
      // and does NOT contain "error" in its type — handle it explicitly
      // (round-4 finding 2).
      if (type === "turn.failed") {
        const err = (obj["error"] ?? {}) as Record<string, unknown>;
        const text = String(err["message"] ?? "turn.failed").slice(0, 400);
        return { kind: "error", text, ...errText(text) };
      }
      if (type === "item.completed" || type === "item.started") {
        const item = (obj["item"] ?? {}) as Record<string, unknown>;
        const itemType = String(item["type"] ?? "");
        const text = String(item["text"] ?? item["message"] ?? itemType).slice(0, 400);
        // The answer TEXT (for finalText), but NOT a turn terminal: codex keeps
        // running after agent_message; only turn.completed confirms success and
        // turn.failed can still follow (round-11 finding 1). So NO
        // terminalSuccess here.
        if (itemType === "agent_message") return { kind: "result", text };
        // codex emits non-fatal warnings as "error" items; that IS an error
        // context, so trust rate-limit / exhaustion signals there.
        if (itemType === "error") {
          const eq = classifyErrorTextForQuota(text);
          return {
            kind: eq ? "error" : "other",
            text,
            ...(eq ? { quotaSignal: true as const } : {}),
          };
        }
        if (/command|exec|file|patch|tool|mcp/.test(itemType))
          return { kind: "tool", text: itemType };
        return { kind: "other", text: itemType || "item" };
      }
      if (type === "turn.completed") {
        // The genuine success TERMINAL of a codex turn (round-11 finding 1).
        // Its usage object is turn-cumulative — the "tokens where reportable"
        // seam (WP-107, CAM-EXEC-03).
        const tokens = sumUsageTokens(obj["usage"]);
        return {
          kind: "other",
          text: type,
          terminalSuccess: true,
          ...(tokens !== undefined ? { tokensTotal: tokens } : {}),
        };
      }
      if (type === "thread.started") {
        return { kind: "other", text: type };
      }
      if (type.includes("error")) {
        const text = String(obj["message"] ?? type).slice(0, 400);
        return { kind: "error", text, ...errText(text) };
      }
      return { kind: "other", text: type || "event" };
    },
  };
}
