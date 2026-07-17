#!/usr/bin/env node
// Materialize fixtures/sample-repo-src into a real git repository.
// Usage: node scripts/make-sample-repo.mjs [target-dir]
// Prints the repo path on stdout. Used by the fixture smoke test (WP-000)
// and, later, as the onboarding/quarantine fixture repo.
//
// Safety (per the WP-000 cross-provider review): an explicit target must be
// a new or empty directory — this script never adds, re-identifies, or
// commits over existing content.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "..", "fixtures", "sample-repo-src");

let target;
if (process.argv[2]) {
  target = resolve(process.argv[2]);
  if (existsSync(target) && readdirSync(target).length > 0) {
    console.error(`refusing to materialize into non-empty directory: ${target}`);
    process.exit(1);
  }
  mkdirSync(target, { recursive: true });
} else {
  target = mkdtempSync(join(tmpdir(), "camino-sample-repo-"));
}

cpSync(srcDir, target, { recursive: true });

const git = (...args) =>
  execFileSync("git", ["-C", target, ...args], { stdio: ["ignore", "pipe", "inherit"] })
    .toString()
    .trim();

git("init", "--quiet", "--initial-branch=main");
git("config", "user.email", "fixture@camino.invalid");
git("config", "user.name", "Camino Fixture");
git("add", "-A");
git("commit", "--quiet", "-m", "Seed sample repo (WP-000 fixture)");

process.stdout.write(`${target}\n`);
