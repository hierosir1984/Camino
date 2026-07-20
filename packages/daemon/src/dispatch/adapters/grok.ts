import type { AdapterContext, AdapterSpec, SpawnPlan, StreamEvent } from "@camino/shared";
import { classifyErrorTextForQuota } from "../quota.js";

/**
 * Grok Build CLI (official), headless — enablement gated on the recorded
 * sanctioned-path verification (CAM-EXEC-01; accepted 2026-07-17, see
 * docs/plan/xai-sanctioned-path-research.md, consumed by the registry from
 * docs/plan/phase-0-prereq-attestations.json).
 *   grok -p "<prompt>" --output-format streaming-json --cwd <workdir> \
 *        --always-approve [-m <model>]
 * -p/--single is single-turn headless; --always-approve auto-approves tool
 * execution so the turn can edit files; streaming-json emits JSONL events.
 *
 * Subscription auth is the CLI's own, cached under HOME by `grok login`
 * (sanctioned path — CAM-SEC-06); the adapter passes no credential-shaped env.
 */
export function grokAdapter(
  opts: { enabled?: boolean; disabledReason?: string } = {},
): AdapterSpec {
  return {
    name: "grok-build",
    enabled: opts.enabled ?? true,
    ...(opts.disabledReason ? { disabledReason: opts.disabledReason } : {}),
    plan(ctx: AdapterContext): SpawnPlan {
      const args = [
        "-p",
        ctx.prompt,
        "--output-format",
        "streaming-json",
        "--cwd",
        ctx.workdir,
        "--always-approve",
      ];
      if (ctx.model) args.push("-m", ctx.model);
      return { file: "grok", args };
    },
    parseLine(line: string, channel): StreamEvent | null {
      const trimmed = line.trim();
      // Quota is only trusted in an ERROR CONTEXT (round-2/3 finding 2/5):
      // stderr and error events — never the token-streamed assistant answer.
      if (!trimmed.startsWith("{")) {
        if (channel === "stderr" && trimmed.length > 0) {
          const eq = classifyErrorTextForQuota(trimmed); // stderr = error context
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
      // Observed grok 0.2 streaming-json: {type:"thought"|"text"|"end", data?}.
      // Assistant answer arrives token-fragmented as many {type:"text",data}
      // events; reasoning as {type:"thought",data}; the turn closes with
      // {type:"end"}. (finalText reassembly of the fragments is in the
      // lifecycle's assembleFinalText.)
      const type = String(obj["type"] ?? obj["event"] ?? "");
      // An error event may carry its text under data/text/content OR message
      // (round-3 finding 2).
      const data = String(obj["data"] ?? obj["text"] ?? obj["content"] ?? obj["message"] ?? "");
      if (type === "text" || type.includes("assistant") || type.includes("message")) {
        return { kind: "assistant", text: data.slice(0, 400) }; // the answer, not an error
      }
      if (type === "thought") {
        return { kind: "other", text: "thought" };
      }
      if (type === "end" || type.includes("result") || type.includes("done")) {
        return { kind: "result", text: data.slice(0, 400) }; // the final answer
      }
      if (type.includes("error")) {
        const text = (data || type).slice(0, 400);
        return {
          kind: "error",
          text,
          ...(classifyErrorTextForQuota(text) ? { quotaSignal: true as const } : {}),
        };
      }
      if (type.includes("tool") || type.includes("edit") || type.includes("exec")) {
        return { kind: "tool", text: type };
      }
      return { kind: "other", text: type || "event" };
    },
  };
}
