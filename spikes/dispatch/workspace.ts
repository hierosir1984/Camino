import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const MAKE_SAMPLE_REPO = resolve(here, "..", "..", "scripts", "make-sample-repo.mjs");

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

/** Return the new commit SHA if the worker advanced HEAD, else null. */
export function committedSince(workdir: string, before: string | null): string | null {
  const after = headSha(workdir);
  if (after && after !== before) return after;
  return null;
}
