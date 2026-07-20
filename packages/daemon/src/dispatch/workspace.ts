// WP-105: worker-workspace helpers. makeWorkspace materializes the seeded
// sample-repo fixture as an isolated clone (test/evidence harnesses; the real
// per-attempt workspace factory arrives with the container work, WP-107).
// headSha/committedSince are the progress probes the dispatch caller uses to
// decide whether a worker genuinely advanced the clone.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const MAKE_SAMPLE_REPO = resolve(here, "..", "..", "..", "..", "scripts", "make-sample-repo.mjs");

/** Materialize a fresh, isolated worker clone of the sample repo. */
export function makeWorkspace(): string {
  return execFileSync("node", [MAKE_SAMPLE_REPO]).toString().trim();
}

function git(workdir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", workdir, ...args], {
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .trim();
}

export function headSha(workdir: string): string | null {
  try {
    return git(workdir, "rev-parse", "HEAD");
  } catch {
    return null;
  }
}

/** Is `ancestor` an ancestor of `descendant`? */
function isAncestor(workdir: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync("git", ["-C", workdir, "merge-base", "--is-ancestor", ancestor, descendant], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the new commit SHA only if the worker genuinely ADVANCED HEAD — i.e.
 * the new HEAD is a descendant of the base. A reset/rollback to an older
 * commit is not a new worker commit (WP-001 review #10).
 */
export function committedSince(workdir: string, before: string | null): string | null {
  const after = headSha(workdir);
  if (!after || after === before) return null;
  if (before && !isAncestor(workdir, before, after)) return null;
  return after;
}
