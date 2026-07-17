import type { AdapterContext, AdapterSpec, Outcome, SpawnPlan, StreamEvent } from "../types.js";
import { classifyByQuotaSignal } from "../quota.js";

/**
 * Claude Code (official CLI), headless.
 *   claude -p "<prompt>" --output-format stream-json --verbose \
 *          --dangerously-skip-permissions [--model <m>]
 * cwd = the isolated worker clone. stream-json emits line-delimited events;
 * --verbose is required for the streaming event feed. Permissions are skipped
 * because the worker runs in a throwaway clone (the WP-107 container is the
 * real isolation; here the clone is the boundary).
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
      if (!trimmed.startsWith("{")) return null;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return null;
      }
      const type = String(obj["type"] ?? "");
      const quota = classifyByQuotaSignal(trimmed);
      const q = quota ? { quotaSignal: true as const } : {};
      switch (type) {
        case "assistant": {
          const msg = obj["message"] as
            { content?: Array<{ type?: string; text?: string }> } | undefined;
          const text = msg?.content?.find((c) => c.type === "text")?.text ?? "(assistant turn)";
          return { kind: "assistant", text: text.slice(0, 400), ...q };
        }
        case "result": {
          const text = String(obj["result"] ?? obj["subtype"] ?? "result");
          const isError = obj["is_error"] === true || obj["subtype"] === "error_max_turns";
          return { kind: isError ? "error" : "result", text: text.slice(0, 400), ...q };
        }
        case "system":
          return { kind: "other", text: `system:${String(obj["subtype"] ?? "")}`, ...q };
        default:
          return { kind: "other", text: type || "event", ...q };
      }
    },
    classifyFailure(events: readonly StreamEvent[], exitCode: number | null): Outcome {
      if (events.some((e) => e.quotaSignal)) return "quota-blocked";
      return exitCode === null ? "requirement-failed" : "requirement-failed";
    },
  };
}
