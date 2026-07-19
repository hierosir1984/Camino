/**
 * Atomic file-backed state for the WP-104 fakes.
 *
 * The fakes play the EXTERNAL system in the kill-point suite, so their
 * state must survive the death of the process that mutated it and must
 * never be observed torn. Writes go to a temp file then rename — the
 * POSIX atomic-replace pattern — so a SIGKILL at any instant leaves
 * either the previous state (request never reached the external system)
 * or the new one (effect applied), never a mix. That binary outcome is
 * exactly the ambiguity the idempotency contract exists to handle.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export function loadJsonState<T>(path: string, init: () => T): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return init();
    throw error;
  }
  return JSON.parse(raw) as T;
}

export function saveJsonState(path: string, state: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, path);
}
