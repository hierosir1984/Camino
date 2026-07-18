import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AdapterSpec, SpawnPlan, StreamEvent } from "../dispatch/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const MOCK_CLI = join(here, "mock-probe-cli.mjs");

/**
 * Fake planner/reviewer CLI adapter for zero-quota tests of the whole probe
 * pipeline. The role is baked into the adapter NAME so the cross-family
 * assertion runs the same code path as real runs: mock-planner:* and
 * mock-reviewer:* resolve to distinct pseudo-families (see adapterFamily).
 */
export function mockProbeAdapter(role: "planner" | "reviewer", mode: string): AdapterSpec {
  return {
    name: `mock-${role}:${mode}`,
    enabled: true,
    plan(): SpawnPlan {
      return {
        file: process.execPath, // node
        args: [MOCK_CLI],
        env: { MOCK_PROBE_MODE: mode },
      };
    },
    parseLine(line: string): StreamEvent | null {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return null;
      try {
        const obj = JSON.parse(trimmed) as { type?: string; text?: string };
        const kind: StreamEvent["kind"] =
          obj.type === "assistant" ||
          obj.type === "tool" ||
          obj.type === "result" ||
          obj.type === "error"
            ? obj.type
            : "other";
        return { kind, text: String(obj.text ?? "").slice(0, 400) };
      } catch {
        return null;
      }
    },
  };
}
