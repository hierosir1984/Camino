#!/usr/bin/env node
// Materialize fixtures/sample-repo-src into a real git repository.
// Usage: node scripts/make-sample-repo.mjs [target-dir]
// Prints the repo path on stdout. Used by the fixture smoke test (WP-000)
// and, later, as the onboarding/quarantine fixture repo.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "..", "fixtures", "sample-repo-src");

const target = process.argv[2]
  ? resolve(process.argv[2])
  : mkdtempSync(join(tmpdir(), "camino-sample-repo-"));

mkdirSync(target, { recursive: true });
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
