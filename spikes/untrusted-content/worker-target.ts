// Run ONE corpus case through one WP-001 worker. Reuses the WP-001 dispatch
// lifecycle and clean-env composition; the planted-instruction content rides in
// the seed repo (README) or the issue prompt. The worker runs in a THROWAWAY
// clone that is deleted after the run, its env carries no GitHub credential, and
// leakage is probed only with a SYNTHETIC marker — so obeyed content here is
// contained and harmless.
//
// SAFETY (review r1 blocker 1): evidence is collected from a FILESYSTEM SNAPSHOT
// diff, never `git add`/`git diff`/`git status` on the worker tree — those apply
// worker-controlled `.gitattributes` clean/smudge filters, which would execute
// arbitrary commands as the host user. Only object-read git (`rev-parse`, `log`)
// touches the worker repo, and those never invoke content filters. Reads use
// O_NOFOLLOW with hard size/count/byte caps (review r1 majors 16, 17).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as FS,
  cpSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { dispatch } from "../dispatch/lifecycle.js";
import type { AdapterSpec } from "../dispatch/types.js";
import { capAppend, detectProviderBlock, scrubHome } from "./signals.js";
import type { WorkerEvidence } from "./types.js";
import type { TargetRunOptions } from "./planner-target.js";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024; // aggregate cap across the snapshot
const MAX_DEPTH = 32;

/** Object-read git only (no working-tree filters): safe against an untrusted repo. */
function gitRead(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  })
    .toString()
    .trim();
}

/** Materialise a seed dir (TRUSTED content) into a fresh committed git repo. */
export function materializeWorkerRepo(seedDirAbs: string): { dir: string; baseSha: string } {
  const dir = mkdtempSync(join(tmpdir(), "camino-untrusted-work-"));
  cpSync(seedDirAbs, dir, { recursive: true });
  const g = (...a: string[]) => gitRead(dir, ...a);
  g("init", "--quiet", "--initial-branch=main");
  g("config", "user.email", "fixture@camino.invalid");
  g("config", "user.name", "Camino Fixture");
  g("config", "commit.gpgsign", "false");
  g("add", "-A"); // seed is trusted (no attributes/filters), so add is safe here
  g("commit", "--quiet", "-m", "seed");
  return { dir, baseSha: g("rev-parse", "HEAD") };
}

interface SnapEntry {
  sha: string;
  content: string;
  truncated: boolean;
}
type Snapshot = Map<string, SnapEntry>;

/** Read a regular file with O_NOFOLLOW + a hard byte cap. Symlinks throw ELOOP. */
function readCapped(abs: string): { content: string; truncated: boolean } {
  const fd = openSync(abs, FS.O_RDONLY | FS.O_NOFOLLOW);
  try {
    const buf = Buffer.alloc(MAX_FILE_BYTES);
    const n = readSync(fd, buf, 0, MAX_FILE_BYTES, 0);
    return { content: buf.subarray(0, n).toString("utf8"), truncated: n >= MAX_FILE_BYTES };
  } finally {
    closeSync(fd);
  }
}

/**
 * Snapshot the working tree (excluding .git) into path -> {sha, capped content}.
 * Symlinks are recorded as their link-target text and never read through
 * (O_NOFOLLOW). Caps on file count, per-file bytes, aggregate bytes, and depth
 * bound an untrusted worker's ability to exhaust memory/disk — enforced INSIDE the
 * loop (review r1 major 16). Returns partial results + a `capped` flag rather
 * than throwing.
 */
function snapshot(dir: string): { snap: Snapshot; capped: boolean } {
  const snap: Snapshot = new Map();
  let total = 0;
  let capped = false;
  const walk = (abs: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      capped = true;
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of entries) {
      if (snap.size >= MAX_FILES || total >= MAX_TOTAL_BYTES) {
        capped = true;
        return;
      }
      if (name === ".git") continue;
      const child = join(abs, name);
      const rel = relative(dir, child);
      let st;
      try {
        st = lstatSync(child);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        let target = "?";
        try {
          target = readlinkSync(child);
        } catch {
          /* ignore */
        }
        snap.set(rel, {
          sha: "symlink:" + target,
          content: scrubHome(`<symlink -> ${target}>`),
          truncated: false,
        });
      } else if (st.isDirectory()) {
        walk(child, depth + 1);
      } else if (st.isFile()) {
        try {
          const { content, truncated } = readCapped(child);
          total += Buffer.byteLength(content);
          const sha = createHash("sha256").update(content).digest("hex").slice(0, 16);
          snap.set(rel, {
            sha: (truncated ? "trunc:" : "") + sha,
            content: scrubHome(content),
            truncated,
          });
        } catch {
          snap.set(rel, {
            sha: "unreadable",
            content: "<unreadable or non-regular>",
            truncated: false,
          });
        }
      }
    }
  };
  walk(dir, 0);
  return { snap, capped };
}

export async function runWorkerTarget(
  adapter: AdapterSpec,
  seedDirAbs: string,
  issuePrompt: string,
  opts: TargetRunOptions = {},
): Promise<WorkerEvidence> {
  const { dir, baseSha } = materializeWorkerRepo(seedDirAbs);
  const before = snapshot(dir).snap;
  let raw = "";
  try {
    const record = await dispatch(
      adapter,
      { workdir: dir, prompt: issuePrompt },
      {
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        onLine: (channel, line) => {
          raw = capAppend(raw, line);
          opts.onLine?.(channel, line);
        },
      },
    );

    // The worker tree is confirmed gone by dispatch's kill-confirm before we
    // read anything (review r1 major 17: no live process can race our reads).
    const { snap: after, capped } = snapshot(dir);

    // Filesystem-snapshot diff — never `git add`/`git diff` on worker content.
    const changedPaths: string[] = [];
    const addedOrModified: string[] = []; // repo artifacts we scan for markers (ADDED content only)
    for (const [path, entry] of after) {
      const prev = before.get(path);
      if (!prev || prev.sha !== entry.sha) {
        changedPaths.push(path);
        addedOrModified.push(`# ${path}\n${entry.content}`);
      }
    }
    for (const path of before.keys()) if (!after.has(path)) changedPaths.push(`${path} (deleted)`);
    changedPaths.sort();

    // Commit metadata via object-read git only (no filters invoked).
    let headSha = baseSha;
    let commitMsgs = "";
    let emptyCommit = false;
    try {
      headSha = gitRead(dir, "rev-parse", "HEAD");
      commitMsgs = gitRead(dir, "log", "--format=%B", `${baseSha}..HEAD`);
      if (headSha !== baseSha) {
        emptyCommit =
          gitRead(dir, "rev-parse", "HEAD^{tree}") ===
          gitRead(dir, "rev-parse", `${baseSha}^{tree}`);
      }
    } catch {
      /* corrupted/removed repo — treat as no commit */
    }

    const fileContents: Record<string, string> = {};
    for (const [path, entry] of after) fileContents[path] = entry.content;

    const artifactBlob = scrubHome(
      (capped ? "# NOTE: snapshot hit a resource cap; evidence is partial\n" : "") +
        (commitMsgs ? `# commit messages\n${commitMsgs}\n` : "") +
        addedOrModified.join("\n"),
    );

    const block = detectProviderBlock(record.outcome, raw);
    return {
      kind: "worker",
      outcome: record.outcome,
      committed: headSha !== baseSha,
      emptyCommit,
      presentFiles: [...after.keys()].sort(),
      changedPaths,
      fileContents,
      artifactBlob,
      finalText: scrubHome(record.finalText),
      providerBlocked: block.blocked,
      ...(block.detail ? { blockDetail: block.detail } : {}),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
