#!/usr/bin/env node
// Phase-0 entry gate (WP-000): verifies and records the BUILD.md
// "before Phase 0" prerequisites. Exit 0 only when every item is green;
// WP-001..005 stay blocked until then.
//
// Machine-checkable items are probed directly; human items (funded fallback
// accounts, xAI sanctioned-path disposition) are read from the committed
// attestation file docs/plan/phase-0-prereq-attestations.json.
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

const checks = [];
const add = (name, result, note = "") => checks.push({ name, ...result, note });

// --- machine-checkable ---
const nodeMajor = Number(process.versions.node.split(".")[0]);
add("Node 22+", {
  ok: nodeMajor >= 22,
  detail: `node ${process.versions.node}`,
});

add("Docker Desktop", probe("docker", ["version", "--format", "{{.Client.Version}}"]));
add("Playwright", probe("npx", ["--no-install", "playwright", "--version"]), "no-install probe");

add("Claude Code CLI", probe("claude", ["--version"]));
add(
  "Claude Code auth",
  fileExists(join(homedir(), ".claude.json"), "~/.claude.json"),
  "best-effort; verify with a real invocation on first dispatch",
);
add("Codex CLI", probe("codex", ["--version"]));
add(
  "Codex auth",
  fileExists(join(homedir(), ".codex", "auth.json"), "~/.codex/auth.json"),
  "best-effort; verify with a real invocation on first dispatch",
);
add("Grok Build CLI", probe("grok", ["--version"]), "disabled-with-reason path applies if absent");
add(
  "Grok Build auth",
  fileExists(join(homedir(), ".grok"), "~/.grok"),
  "best-effort; verify with a real invocation on first dispatch",
);

// --- human attestations (committed) ---
const attestationPath = join(repoRoot, "docs", "plan", "phase-0-prereq-attestations.json");
let attestations = null;
try {
  attestations = JSON.parse(readFileSync(attestationPath, "utf8"));
} catch {
  add("Attestation file", { ok: false, detail: `${attestationPath} missing or unparsable` });
}
if (attestations) {
  const funded = attestations.fundedFallbackAccounts ?? {};
  add(
    "Funded API fallback — Anthropic (CAM-ROUTE-08)",
    { ok: funded.anthropic === true, detail: String(funded.anthropic) },
    "David attests in the attestation file",
  );
  add(
    "Funded API fallback — OpenAI (CAM-ROUTE-08)",
    { ok: funded.openai === true, detail: String(funded.openai) },
    "David attests in the attestation file",
  );
  const xai = attestations.xaiSanctionedPath ?? {};
  add(
    "xAI sanctioned-path disposition recorded",
    {
      ok: xai.status === "accepted",
      detail: xai.status ? `${xai.status} by ${xai.by} ${xai.date}` : "missing",
    },
    xai.memo ?? "",
  );
}

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
