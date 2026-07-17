import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AdapterSpec, Outcome, SpawnPlan, StreamEvent } from "../types.js";
import { classifyByQuotaSignal } from "../quota.js";

const here = dirname(fileURLToPath(import.meta.url));
const MOCK_CLI = join(here, "mock-cli.mjs");

/**
 * Adapter for the fake CLI. Its stream is line-delimited JSON
 * `{type, text}`; a rate-limit is signalled by an error event whose text
 * carries a quota marker (recognized by the shared quota classifier).
 */
export function mockAdapter(mode?: string): AdapterSpec {
  return {
    name: mode ? `mock:${mode}` : "mock",
    enabled: true,
    // The mock ignores ctx: it always runs the same fake CLI script.
    plan(): SpawnPlan {
      return {
        file: process.execPath, // node
        args: [MOCK_CLI],
        env: mode ? { MOCK_MODE: mode } : {},
      };
    },
    parseLine(line: string): StreamEvent | null {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return null;
      try {
        const obj = JSON.parse(trimmed) as { type?: string; text?: string };
        const kind = ((): StreamEvent["kind"] => {
          switch (obj.type) {
            case "assistant":
            case "tool":
            case "result":
            case "error":
              return obj.type;
            default:
              return "other";
          }
        })();
        const text = String(obj.text ?? "").slice(0, 400);
        return { kind, text, ...(classifyByQuotaSignal(text) ? { quotaSignal: true } : {}) };
      } catch {
        return null;
      }
    },
    classifyFailure(events: readonly StreamEvent[], exitCode: number | null): Outcome {
      return classifyByQuotaSignal(events.map((e) => e.text).join("\n"))
        ? "quota-blocked"
        : exitCode === null
          ? "requirement-failed"
          : "requirement-failed";
    },
  };
}
