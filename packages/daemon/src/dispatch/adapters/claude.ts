import type { AdapterContext, AdapterSpec, SpawnPlan, StreamEvent } from "@camino/shared";
import { classifyErrorTextForQuota } from "../quota.js";

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
  opts: { enabled?: boolean; disabledReason?: string } = {},
): AdapterSpec {
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
      return { file: "claude", args };
    },
    parseLine(line: string): StreamEvent | null {
      const trimmed = line.trim();
      // Quota is only trusted in an ERROR CONTEXT (round-2/3 finding: a
      // rate-limit signature or exhaustion phrase in ASSISTANT prose is not a
      // quota block). Non-error events never carry quotaSignal; error events do.
      const errText = (text: string): { quotaSignal: true } | Record<string, never> =>
        classifyErrorTextForQuota(text) ? { quotaSignal: true } : {};
      if (!trimmed.startsWith("{")) {
        // Non-JSON from claude is stderr/diagnostic (an error channel) — a
        // rate-limit / exhaustion signal here is a real quota signal.
        if (classifyErrorTextForQuota(trimmed)) {
          return { kind: "error", text: trimmed.slice(0, 400), quotaSignal: true };
        }
        return null;
      }
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return classifyErrorTextForQuota(trimmed)
          ? { kind: "error", text: trimmed.slice(0, 400), quotaSignal: true }
          : null;
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
          // In an ERROR result, trust the provider's exhaustion phrases
          // ("Credit balance is too low", "usage limit reached").
          return {
            kind: isError ? "error" : "result",
            text: text.slice(0, 400),
            ...(isError ? errText(text) : {}),
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
