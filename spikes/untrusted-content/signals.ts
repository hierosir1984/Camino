// Shared run-time signal helpers for the two live targets.

import { appendFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import type { Outcome } from "../dispatch/types.js";

const HOME = homedir();
let USERNAME = "";
try {
  USERNAME = userInfo().username;
} catch {
  USERNAME = "";
}

/** Persist raw transcript lines to a (gitignored) .jsonl as the run streams. */
export function teeTo(path: string): (channel: "stdout" | "stderr", line: string) => void {
  writeFileSync(path, "");
  return (channel, line) => appendFileSync(path, JSON.stringify({ channel, line }) + "\n");
}

/**
 * Redact the local home path AND the bare OS username. Identity hygiene only —
 * NOT a secret guarantee. The load-bearing control for real secrets is that
 * agent-produced file contents/diffs are kept OUT of git (raw evidence is
 * gitignored; committed artifacts carry only detector observations, themselves
 * passed through `redactSecrets`) — review r1 blocker 2.
 */
export function scrubHome(text: string): string {
  let out = HOME ? text.split(HOME).join("~") : text;
  if (USERNAME && USERNAME.length >= 3) out = out.split(USERNAME).join("<user>");
  return out;
}

/**
 * Best-effort secret redaction for the SHORT detail strings that reach committed
 * artifacts (findings evidence lines). Not a substitute for keeping raw evidence
 * out of git — a defence-in-depth scrub of well-known credential shapes.
 */
const SECRET_SHAPES: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /-----BEGIN[ A-Z]+PRIVATE KEY-----[\s\S]*?-----END[ A-Z]+PRIVATE KEY-----/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_SHAPES) out = out.replace(re, "<redacted-secret>");
  return out;
}

/** Cap-appending accumulator so a noisy/untrusted stream cannot grow unbounded (review r1 major 15). */
export const RAW_CAP_BYTES = 2 * 1024 * 1024;
export function capAppend(buf: string, line: string, cap = RAW_CAP_BYTES): string {
  if (buf.length >= cap) return buf;
  const room = cap - buf.length;
  return buf + (line.length + 1 > room ? line.slice(0, room) + "\n…(capped)\n" : line + "\n");
}

/**
 * A provider/harness refusal that yields no usable behaviour to score — distinct
 * from the agent running and refusing the planted instruction (that IS the signal we want).
 * The OpenAI "cyber" classifier kill is the known case (see the codex-agent-
 * failure-modes memory); quota exhaustion is treated the same (inconclusive).
 * We KEEP stderr rather than swallow it so a policy flag stays diagnosable.
 */
const CLASSIFIER_SIGNATURES = [
  /flagged for possible cybersecurity/i,
  /chatgpt\.com\/cyber/i,
  /content.{0,20}policy.{0,20}(violation|blocked)/i,
];

export function detectProviderBlock(
  outcome: Outcome,
  rawText: string,
): { blocked: boolean; detail?: string } {
  const sig = CLASSIFIER_SIGNATURES.find((r) => r.test(rawText));
  if (sig)
    return { blocked: true, detail: `provider content classifier flagged the run (${sig.source})` };
  if (outcome === "quota-blocked")
    return { blocked: true, detail: "quota / rate limit — run inconclusive" };
  return { blocked: false };
}
