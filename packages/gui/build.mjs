// GUI build (WP-102 placeholder): copy static/ into dist/, the directory the
// daemon serves (CAM-CORE-01). The real bundler pipeline replaces this build
// script in WP-122+ without changing the daemon-facing contract: "dist/ is
// the servable GUI". OUT_DIR override lets tests build into a scratch dir.
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const source = here("./static");

// OUT_DIR is emptied with a recursive rm, so guard it against turning a build
// into a destructive wipe (round 3 finding 6, round 4 finding 1). Two traps the
// naive guard missed: a RELATIVE value like "." resolves to the current working
// directory (from the repo root that is the worktree), and a SYMLINK alias
// resolves past a lexical "== $HOME" comparison. So: require an absolute path,
// resolve every symlink in it (including a not-yet-existing tail via its nearest
// existing ancestor), then refuse the filesystem root, the home directory, or
// anything less than two levels deep. The default (./dist) is trusted.
function resolveOutDir() {
  const override = process.env.OUT_DIR;
  if (!override) return here("./dist");
  if (!isAbsolute(override)) {
    throw new Error(
      `Refusing to build: OUT_DIR must be an absolute path, got ${JSON.stringify(override)}.`,
    );
  }
  const real = realpathResolvingTail(override);
  const root = parse(real).root;
  const home = realpathResolvingTail(homedir());
  const depth = real.split(sep).filter(Boolean).length;
  if (real === root || real === home || depth < 2) {
    throw new Error(
      `Refusing to build into OUT_DIR=${JSON.stringify(real)}: it must resolve to an absolute path ` +
        `at least two levels deep, and not the filesystem root or your home directory.`,
    );
  }
  return real;
}

// realpathSync fails on a path that does not exist yet; resolve the nearest
// existing ancestor (following its symlinks) and re-append the missing tail, so
// a symlinked parent cannot alias the destination past the guard.
function realpathResolvingTail(abs) {
  const tail = [];
  let cursor = abs;
  while (!existsSync(cursor)) {
    tail.unshift(basename(cursor));
    const parent = dirname(cursor);
    if (parent === cursor) return abs; // reached the root without an existing node
    cursor = parent;
  }
  return join(realpathSync(cursor), ...tail);
}

const out = resolveOutDir();
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(source, out, { recursive: true });
console.log(`gui build: ${source} -> ${out}`);
