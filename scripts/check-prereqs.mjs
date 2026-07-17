#!/usr/bin/env node
// Phase-0 entry gate (WP-000): verifies and records the BUILD.md
// "before Phase 0" prerequisites. Exit 0 only when every item is green;
// WP-001..005 stay blocked until then.
//
// Machine-checkable items are probed directly. Human items (funded fallback
// accounts, xAI sanctioned-path disposition) are read from the committed
// attestation file docs/plan/phase-0-prereq-attestations.json — the three
// attestation checks are ALWAYS emitted: a missing, unparsable, null, or
// wrongly-shaped file fails them rather than silently dropping them
// (hardened per the WP-000 cross-provider review).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function probe(cmd, args) {
  try {
    const out = execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 15000 })
      .toString()
      .trim()
      .split("\n")[0];
    return { ok: true, detail: out };
  } catch (error) {
    return {
      ok: false,
      detail: error.code === "ENOENT" ? "not found" : String(error.message).slice(0, 120),
    };
  }
}

function fileExists(p, label) {
  return existsSync(p)
    ? { ok: true, detail: `${label} present` }
    : { ok: false, detail: `${label} missing` };
}

/** Auth probe that prefers a real CLI status command and falls back to the credential artifact. */
function authProbe(statusCmd, statusArgs, artifactPath, artifactLabel) {
  const status = probe(statusCmd, statusArgs);
  if (status.ok) return { ok: true, detail: status.detail };
  return fileExists(artifactPath, artifactLabel);
}

const checks = [];
const add = (name, result, note = "") => checks.push({ name, ...result, note });

// --- machine-checkable (BUILD.md "before Phase 0") ---
add(
  "GitHub repository (origin remote)",
  probe("git", ["-C", repoRoot, "remote", "get-url", "origin"]),
);

const nodeMajor = Number(process.versions.node.split(".")[0]);
add("Node 22+", { ok: nodeMajor >= 22, detail: `node ${process.versions.node}` });

add(
  "Docker Desktop (daemon reachable)",
  probe("docker", ["version", "--format", "{{.Server.Version}}"]),
);
add("Playwright", probe("npx", ["--no-install", "playwright", "--version"]), "no-install probe");

add("Claude Code CLI", probe("claude", ["--version"]));
add(
  "Claude Code auth",
  fileExists(join(homedir(), ".claude.json"), "~/.claude.json"),
  "artifact check only — proven by a real invocation in the WP-001 dispatch spike",
);
add("Codex CLI", probe("codex", ["--version"]));
add(
  "Codex auth",
  authProbe(
    "codex",
    ["login", "status"],
    join(homedir(), ".codex", "auth.json"),
    "~/.codex/auth.json",
  ),
  "status command preferred, artifact fallback — proven in WP-001",
);
add("Grok Build CLI", probe("grok", ["--version"]), "disabled-with-reason path applies if absent");
add(
  "Grok Build auth",
  fileExists(join(homedir(), ".grok"), "~/.grok"),
  "artifact check only — proven by a real invocation in the WP-001 dispatch spike",
);

// --- human attestations (committed; always emitted, never skipped) ---
const attestationPath = join(repoRoot, "docs", "plan", "phase-0-prereq-attestations.json");
let attestations = null;
let attestationProblem = "";
try {
  const parsed = JSON.parse(readFileSync(attestationPath, "utf8"));
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    attestations = parsed;
  } else {
    attestationProblem = `attestation file is ${parsed === null ? "null" : "not an object"}`;
  }
} catch (error) {
  attestationProblem = `attestation file missing/unparsable: ${String(error.message).slice(0, 80)}`;
}

const funded =
  attestations && typeof attestations.fundedFallbackAccounts === "object"
    ? (attestations.fundedFallbackAccounts ?? {})
    : {};
const xai =
  attestations && typeof attestations.xaiSanctionedPath === "object"
    ? (attestations.xaiSanctionedPath ?? {})
    : {};

add(
  "Funded API fallback — Anthropic (CAM-ROUTE-08)",
  {
    ok: funded.anthropic === true,
    detail: attestationProblem || String(funded.anthropic),
  },
  "David attests in docs/plan/phase-0-prereq-attestations.json",
);
add(
  "Funded API fallback — OpenAI (CAM-ROUTE-08)",
  {
    ok: funded.openai === true,
    detail: attestationProblem || String(funded.openai),
  },
  "David attests in docs/plan/phase-0-prereq-attestations.json",
);
add(
  "xAI sanctioned-path disposition recorded",
  {
    ok: xai.status === "accepted",
    detail:
      attestationProblem || (xai.status ? `${xai.status} by ${xai.by} ${xai.date}` : "missing"),
  },
  typeof xai.memo === "string" ? xai.memo : "",
);

// --- report + record ---
const pad = (s, n) => String(s).padEnd(n);
let allOk = true;
console.log("\nPhase-0 entry gate (BUILD.md prerequisites)\n");
for (const c of checks) {
  if (!c.ok) allOk = false;
  console.log(
    `  ${c.ok ? "PASS" : "FAIL"}  ${pad(c.name, 46)} ${c.detail}${c.note ? `  (${c.note})` : ""}`,
  );
}
console.log(
  `\nGate: ${allOk ? "GREEN — Phase 0 may start (WP-001 unblocks)" : "RED — WP-001..005 remain blocked"}\n`,
);

const recordDir = join(repoRoot, ".camino");
mkdirSync(recordDir, { recursive: true });
const record = {
  checkedAt: new Date().toISOString(),
  gate: allOk ? "green" : "red",
  checks,
};
writeFileSync(join(recordDir, "gate-record.json"), JSON.stringify(record, null, 2));
console.log(`Recorded: .camino/gate-record.json (local; attestations live in docs/plan/)`);

process.exit(allOk ? 0 : 1);
