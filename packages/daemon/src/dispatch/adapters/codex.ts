import type { AdapterContext, AdapterSpec, SpawnPlan, StreamEvent } from "@camino/shared";
import { classifyErrorTextForQuota } from "../quota.js";

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
  opts: { enabled?: boolean; disabledReason?: string } = {},
): AdapterSpec {
  return {
    name: "codex-cli",
    enabled: opts.enabled ?? true,
    ...(opts.disabledReason ? { disabledReason: opts.disabledReason } : {}),
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
      return { file: "codex", args };
    },
    parseLine(line: string, channel): StreamEvent | null {
      const trimmed = line.trim();
      // Quota is only trusted in an ERROR CONTEXT (round-2/3 finding 2/5):
      // stderr, error items, and error events — never assistant/agent output.
      const errText = (text: string): { quotaSignal: true } | Record<string, never> =>
        classifyErrorTextForQuota(text) ? { quotaSignal: true } : {};
      if (!trimmed.startsWith("{")) {
        // Codex prints non-JSON progress/errors, esp. on stderr — an error
        // channel, so a rate-limit / exhaustion signal here is a quota signal.
        if (channel === "stderr" && trimmed.length > 0) {
          const eq = classifyErrorTextForQuota(trimmed);
          return {
            kind: eq ? "error" : "other",
            text: trimmed.slice(0, 400),
            ...(eq ? { quotaSignal: true as const } : {}),
          };
        }
        return null;
      }
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return null;
      }
      // Observed codex 0.144 JSONL: {type:"thread.started"|"item.completed"|
      // "turn.completed", item?:{type:"agent_message"|"error"|"command_execution"
      // |"file_change"|…, text?|message?}}.
      const type = String(obj["type"] ?? "");
      if (type === "item.completed" || type === "item.started") {
        const item = (obj["item"] ?? {}) as Record<string, unknown>;
        const itemType = String(item["type"] ?? "");
        const text = String(item["text"] ?? item["message"] ?? itemType).slice(0, 400);
        if (itemType === "agent_message") return { kind: "result", text }; // the answer, not an error
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
      if (type === "turn.completed" || type === "thread.started") {
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
