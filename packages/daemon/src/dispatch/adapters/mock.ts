import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AdapterSpec, SpawnPlan, StreamEvent } from "@camino/shared";
import { classifyErrorTextForQuota } from "../quota.js";

const here = dirname(fileURLToPath(import.meta.url));
const MOCK_CLI = join(here, "mock-cli.mjs");

/**
 * Adapter for the fake CLI — the zero-quota stand-in every conformance
 * mechanic runs against in CI (the WP-001 pattern). Its stream is
 * line-delimited JSON `{type, text}`; a rate-limit is signalled by an error
 * event whose text carries a quota marker (recognized by the shared quota
 * classifier). Never returned by the product registry: tests and the
 * conformance suite construct it directly.
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
      if (!trimmed.startsWith("{")) {
        // A bare non-JSON line (the "quota-raw" mode) is diagnostic/error
        // output — catch a rate-limit / exhaustion signal here in the PARSER
        // (the lifecycle no longer raw-scans, round-3 finding 2).
        if (trimmed.length > 0 && classifyErrorTextForQuota(trimmed)) {
          return { kind: "error", text: trimmed.slice(0, 400), quotaSignal: true };
        }
        return null;
      }
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
        // Quota is trusted only in an ERROR event (round-3 finding 2).
        const eq = kind === "error" && classifyErrorTextForQuota(text) ? { quotaSignal: true } : {};
        // The mock's `result` event stands in for a success terminal (round-11).
        const term = kind === "result" ? { terminalSuccess: true as const } : {};
        return { kind, text, ...eq, ...term };
      } catch {
        return null;
      }
    },
  };
}
