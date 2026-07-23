// WP-114: the OUT-OF-PROCESS wall-clock supervisor child (CAM-EXEC-03
// authoritative half). Spawned DETACHED per worker container; sleeps to the
// deadline and then kills the container — `docker kill` reaps every pid in
// the container's PID namespace (WP-107, CAM-EXEC-02), so a worker cannot
// outlive its wall-clock budget REGARDLESS of daemon-loop scheduling: this
// process shares no event loop with the daemon, and it survives a daemon
// crash (an orphaned supervisor still fires at the deadline, then exits —
// bounded, self-terminating).
//
// Deliberately dependency-free plain ESM (no tsx/loader): the supervisor is
// the last line of the budget guarantee and must not inherit the daemon's
// toolchain to run.
//
// argv: <containerName> <deadlineEpochMs> <dockerPath>
import { execFile } from "node:child_process";

const [, , containerName, deadlineRaw, dockerPath] = process.argv;
const deadline = Number(deadlineRaw);
if (
  typeof containerName !== "string" ||
  containerName.length === 0 ||
  !Number.isFinite(deadline) ||
  typeof dockerPath !== "string" ||
  dockerPath.length === 0
) {
  // A malformed arm is a daemon bug; exiting non-zero surfaces it in the
  // spawn's exit event. Never guess a target to kill.
  process.exit(2);
}

const remaining = Math.max(0, deadline - Date.now());

// setTimeout caps at 2^31-1 ms; budgets are validated finite positive well
// below that, but clamp defensively rather than firing immediately on
// overflow.
const delay = Math.min(remaining, 2 ** 31 - 1);

setTimeout(() => {
  // SIGKILL the container: Tini (pid 1) dies, the PID namespace collapses,
  // every descendant is reaped by the kernel — the WP-107 containment
  // guarantee this supervisor completes. Errors are tolerated: a container
  // already gone (clean finish, disarm raced the deadline) is success.
  execFile(dockerPath, ["kill", "--signal=KILL", containerName], () => {
    process.exit(0);
  });
}, delay);

// Nothing else keeps the loop alive; the timeout above is the sole task.
