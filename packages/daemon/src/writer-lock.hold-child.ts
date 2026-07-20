/**
 * Test helper child (WP-104): acquires the writer lock at the path given
 * in CAMINO_LOCK_PATH, prints LOCK-HELD, then idles until killed. The
 * writer-lock test SIGKILLs it to prove the kernel releases the lock on
 * process death with no cleanup code running.
 */
import { WriterLock } from "./writer-lock.js";

const path = process.env["CAMINO_LOCK_PATH"];
if (path === undefined || path.length === 0) {
  throw new Error("CAMINO_LOCK_PATH must be set");
}
const lock = WriterLock.acquire(path);
console.log("LOCK-HELD");
// Keep the process (and the lock) alive until the parent kills it.
setInterval(() => {
  lock.assertHeld("hold-child idle");
}, 1000);
