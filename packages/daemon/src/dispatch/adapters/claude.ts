import type { AdapterContext, AdapterSpec, SpawnPlan, StreamEvent } from "@camino/shared";
import { classifyErrorTextForQuota, sumUsageTokens } from "../quota.js";

/**
 * Claude Code (official CLI), headless.
 *   claude -p "<prompt>" --output-format stream-json --verbose \
 *          --dangerously-skip-permissions [--model <m>]
 * cwd = the isolated worker clone. stream-json emits line-delimited events;
 * --verbose is required for the streaming event feed. Permissions are skipped
 * because the worker runs in a throwaway clone (the WP-107 container is the
 * real isolation; here the clone is the boundary).
 *
 * Subscription auth is the CLI's own, read from under HOME (sanctioned path —
 * CAM-SEC-06); the adapter passes no credential-shaped env.
 */
export function claudeAdapter(
  opts: { enabled?: boolean; disabledReason?: string; resolvedPath?: string } = {},
): AdapterSpec {
  // Spawn the ABSOLUTE executable the registry resolved at gate time, never the
  // bare name re-resolved against the worker's untrusted cwd (round-8 finding
  // 1). A raw factory call (no resolvedPath) keeps the bare name, but such a
  // spec has no registry provenance and dispatch refuses it.
  const file = opts.resolvedPath ?? "claude";
  return {
    name: "claude-code",
    enabled: opts.enabled ?? true,
    ...(opts.disabledReason ? { disabledReason: opts.disabledReason } : {}),
    plan(ctx: AdapterContext): SpawnPlan {
      const args = [
        "-p",
        ctx.prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ];
      if (ctx.model) args.push("--model", ctx.model);
      return { file, args };
    },
    parseLine(line: string, channel: "stdout" | "stderr"): StreamEvent | null {
      const trimmed = line.trim();
      // Quota is only trusted in an ERROR CONTEXT (round-2/3 finding: a
      // rate-limit signature or exhaustion phrase in ASSISTANT prose is not a
      // quota block). Non-error events never carry quotaSignal; error events do.
      const errText = (text: string): { quotaSignal: true } | Record<string, never> =>
        classifyErrorTextForQuota(text) ? { quotaSignal: true } : {};
      // A non-JSON OR malformed-JSON line on STDERR is diagnostic/error output.
      // claude emits its stream-json on STDOUT, so non-JSON on stdout is NOT an
      // error context — flagging quota-looking stdout prose was a false positive
      // (round-4 finding 2). Only stderr diagnostics carry a quota signal here.
      const stderrErr = (): StreamEvent | null => {
        if (channel === "stderr" && classifyErrorTextForQuota(trimmed)) {
          return { kind: "error", text: trimmed.slice(0, 400), quotaSignal: true };
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
      const type = String(obj["type"] ?? "");
      switch (type) {
        case "assistant": {
          const message = obj["message"] as { content?: unknown } | undefined;
          const content = message?.content;
          // content may be a string, a non-array, or an array with null items —
          // guard every shape (WP-001 review finding #5). No quotaSignal on
          // assistant text — it is the answer, not an error.
          if (Array.isArray(content)) {
            const textPart = content.find(
              (c): c is { type: string; text: string } =>
                !!c && typeof c === "object" && (c as { type?: unknown }).type === "text",
            );
            const toolPart = content.find(
              (c) => !!c && typeof c === "object" && (c as { type?: unknown }).type === "tool_use",
            );
            if (textPart) return { kind: "assistant", text: String(textPart.text).slice(0, 400) };
            if (toolPart) return { kind: "tool", text: "tool_use" };
            return { kind: "other", text: "assistant" };
          }
          if (typeof content === "string") {
            return { kind: "assistant", text: content.slice(0, 400) };
          }
          return { kind: "other", text: "assistant" };
        }
        case "result": {
          const text = String(obj["result"] ?? obj["subtype"] ?? "result");
          const isError = obj["is_error"] === true || obj["subtype"] === "error_max_turns";
          // The result event's usage is RUN-CUMULATIVE (claude emits it once,
          // last) — the "tokens where reportable" seam (WP-107, CAM-EXEC-03).
          // Per-message assistant usage is NOT reported: summing it would
          // double-count against this figure.
          const tokens = sumUsageTokens(obj["usage"]);
          // In an ERROR result, trust the provider's exhaustion phrases
          // ("Credit balance is too low", "usage limit reached"). A non-error
          // result IS the success terminal (claude emits it once, last).
          return {
            kind: isError ? "error" : "result",
            text: text.slice(0, 400),
            ...(isError ? errText(text) : { terminalSuccess: true as const }),
            ...(tokens !== undefined ? { tokensTotal: tokens } : {}),
          };
        }
        case "error": {
          // A top-level error event — exhaustion phrases are reliable here
          // (round-3 finding 2).
          const text = String(obj["result"] ?? obj["message"] ?? "error");
          return { kind: "error", text: text.slice(0, 400), ...errText(text) };
        }
        case "user":
          return { kind: "tool", text: "tool_result" };
        case "system":
          return { kind: "other", text: `system:${String(obj["subtype"] ?? "")}` };
        default:
          return { kind: "other", text: type || "event" };
      }
    },
  };
}
