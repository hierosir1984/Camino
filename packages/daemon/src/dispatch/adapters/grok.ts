import type { AdapterContext, AdapterSpec, SpawnPlan, StreamEvent } from "@camino/shared";
import { classifyByQuotaSignal } from "../quota.js";

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
      const quota = classifyByQuotaSignal(trimmed);
      const q = quota ? { quotaSignal: true as const } : {};
      if (!trimmed.startsWith("{")) {
        if (channel === "stderr" && trimmed.length > 0) {
          return { kind: quota ? "error" : "other", text: trimmed.slice(0, 400), ...q };
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
      const data = String(obj["data"] ?? obj["text"] ?? obj["content"] ?? "");
      if (type === "text" || type.includes("assistant") || type.includes("message")) {
        return { kind: "assistant", text: data.slice(0, 400), ...q };
      }
      if (type === "thought") {
        return { kind: "other", text: "thought", ...q };
      }
      if (type === "end" || type.includes("result") || type.includes("done")) {
        return { kind: "result", text: data.slice(0, 400), ...q };
      }
      if (type.includes("error")) {
        return { kind: "error", text: (data || type).slice(0, 400), ...q };
      }
      if (type.includes("tool") || type.includes("edit") || type.includes("exec")) {
        return { kind: "tool", text: type, ...q };
      }
      return { kind: "other", text: type || "event", ...q };
    },
  };
}
