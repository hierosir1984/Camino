// GUI build (WP-102 placeholder): copy static/ into dist/, the directory the
// daemon serves (CAM-CORE-01). The real bundler pipeline replaces this build
// script in WP-122+ without changing the daemon-facing contract: "dist/ is
// the servable GUI". OUT_DIR override lets tests build into a scratch dir.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const source = here("./static");

// OUT_DIR is emptied with a recursive rm, so guard it: a mistaken value (a
// filesystem root, the home directory, or a shallow path) must not turn a build
// into a destructive wipe (round 3, finding 6). Require an absolute path at
// least two levels deep that is neither root nor $HOME. The default (./dist)
// is trusted by construction.
function resolveOutDir() {
  const override = process.env.OUT_DIR;
  if (!override) return here("./dist");
  const out = resolve(override);
  const segments = out.split(sep).filter(Boolean);
  const forbidden = out === parse(out).root || out === resolve(homedir()) || segments.length < 2;
  if (forbidden) {
    throw new Error(
      `Refusing to build into OUT_DIR=${JSON.stringify(out)}: it must be an absolute path at ` +
        `least two levels deep, and not the filesystem root or your home directory.`,
    );
  }
  return out;
}

const out = resolveOutDir();
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(source, out, { recursive: true });
console.log(`gui build: ${source} -> ${out}`);
