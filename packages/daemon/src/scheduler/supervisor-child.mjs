// WP-114: the OUT-OF-PROCESS wall-clock supervisor child (CAM-EXEC-03
// authoritative half). Spawned DETACHED per worker container; sleeps to the
// deadline and then REMOVES the container — `docker rm -f` kills a running
// container (the PID namespace collapses and the kernel reaps every pid —
// WP-107, CAM-EXEC-02) and deletes a created-but-not-started one, so a
// worker cannot outlive its wall-clock budget REGARDLESS of daemon-loop
// scheduling: this process shares no event loop with the daemon and
// survives a daemon crash (an orphan still fires at the deadline).
//
// The enforcement LOOP (falsification round 1, finding 2 — one
// fire-and-forget kill was defeated by a slow container start and reported
// success it never confirmed): at the deadline the child retries
// remove-then-confirm every RETRY_MS until the container is CONFIRMED gone
// ("No such container/object" on inspect), and exits 0 ONLY on that
// confirmation. If confirmation cannot be reached within CONFIRM_WINDOW_MS
// past the deadline (Docker daemon unreachable, permissions), it exits 1 —
// failure evidence, never silent success. The container-existence RACE is
// closed at the protocol level: the runner `docker create`s the container
// BEFORE arming this child (provisionAndArm), so the deadline always has a
// referent — created, running, or already removed after a clean finish.
//
// Deliberately dependency-free plain ESM (no tsx/loader): the supervisor is
// the last line of the budget guarantee and must not inherit the daemon's
// toolchain to run.
//
// argv: <containerName> <deadlineEpochMs> <dockerPath>
import { execFile } from "node:child_process";

const RETRY_MS = 2000;
const CONFIRM_WINDOW_MS = 10 * 60_000;

const [, , containerName, deadlineRaw, dockerPath] = process.argv;
const deadline = Number(deadlineRaw);
if (
  typeof containerName !== "string" ||
  containerName.length === 0 ||
  !Number.isFinite(deadline) ||
  typeof dockerPath !== "string" ||
  !dockerPath.startsWith("/")
) {
  // A malformed arm is a daemon bug; exiting non-zero surfaces it in the
  // spawn's exit event. Never guess a target to kill.
  process.exit(2);
}

function run(args) {
  return new Promise((resolve) => {
    execFile(dockerPath, args, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function enforce() {
  // setTimeout caps at 2^31-1 ms; budgets are validated finite positive
  // well below that, but clamp defensively rather than firing immediately.
  const remaining = Math.max(0, Math.min(deadline - Date.now(), 2 ** 31 - 1));
  await sleep(remaining);
  const confirmBy = Date.now() + CONFIRM_WINDOW_MS;
  for (;;) {
    // rm -f: kills a running container (SIGKILL to pid 1 → namespace
    // collapse → every descendant reaped) and removes a created one.
    // Errors are expected when the container already finished (--rm) —
    // the CONFIRM below is the authority, not this call's exit code.
    await run(["rm", "-f", containerName]);
    const inspect = await run(["inspect", "--format", "{{.State.Running}}", containerName]);
    if (inspect.code !== 0 && /no such (object|container)/i.test(inspect.stderr)) {
      process.exit(0); // CONFIRMED gone
    }
    if (Date.now() > confirmBy) {
      process.exit(1); // could not confirm — failure evidence, never silent
    }
    await sleep(RETRY_MS);
  }
}

void enforce();
