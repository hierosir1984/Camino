// GUI build (WP-102 placeholder): copy static/ into dist/, the directory the
// daemon serves (CAM-CORE-01). The real bundler pipeline replaces this build
// script in WP-122+ without changing the daemon-facing contract: "dist/ is
// the servable GUI". OUT_DIR override lets tests build into a scratch dir.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const source = here("./static");
const out = process.env.OUT_DIR ?? here("./dist");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(source, out, { recursive: true });
console.log(`gui build: ${source} -> ${out}`);
