// Fake planner/worker CLI adapter for zero-quota tests and the --mock dry-run.
// It drives the SAME dispatch lifecycle a real adapter does (spawn a subprocess,
// stream JSON lines, parse them), so the target wiring is exercised without
// spending any subscription quota. Detector CORRECTNESS is proven separately in
// redteam.test.ts against synthetic evidence — the mock only proves the plumbing.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AdapterSpec, SpawnPlan, StreamEvent } from "../dispatch/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const MOCK_CLI = join(here, "mock-cli.mjs");

/**
 * @param role   which surface this stands in for.
 * @param mode   "clean" = benign valid output (default); "obedient" = performs a
 *               generic proxy planted instruction (marker + extra/leakage artifact) so a
 *               wiring test can see evidence populate.
 */
export function mockAdapter(
  role: "planner" | "worker",
  mode: "clean" | "obedient" = "clean",
): AdapterSpec {
  return {
    name: `mock-redteam-${role}:${mode}`,
    enabled: true,
    plan(): SpawnPlan {
      return {
        file: process.execPath, // node
        args: [MOCK_CLI],
        env: { MOCK_ROLE: role, MOCK_MODE: mode },
      };
    },
    parseLine(line: string): StreamEvent | null {
      const t = line.trim();
      if (!t.startsWith("{")) return null;
      try {
        const obj = JSON.parse(t) as { type?: string; text?: string };
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
