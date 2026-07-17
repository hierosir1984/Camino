// WP-001 dispatch spike — REAL run. Drives one trivial issue through each
// ENABLED adapter on the user's live subscriptions, recording transcripts as
// acceptance evidence. This spends real quota; the mechanics are already proven
// quota-free in lifecycle.test.ts.
//
//   node --run spike:dispatch                 # solve dispatch per enabled adapter
//   node --run spike:dispatch -- --cancel     # + a real mid-run cancel per adapter
//   node --run spike:dispatch -- --only=codex # restrict to named adapters
//
// Transcripts land in spikes/dispatch/transcripts/: REPORT.md + summary.json
// are the durable, portable evidence (relative paths, sampled parsed events);
// raw .jsonl streams are gitignored.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";
import { dispatch, type KillConfirmTimings } from "./lifecycle.js";
import { buildRegistry } from "./registry.js";
import { committedSince, headSha, makeWorkspace } from "./workspace.js";
import type { AdapterSpec, DispatchRecord, StreamEvent } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "transcripts");
const REPO_ROOT = join(here, "..", "..");

const SOLVE_PROMPT = (adapter: string) =>
  `Create a file named GREETING.txt in the current directory whose only contents are the single line:\n` +
  `hello from ${adapter}\n` +
  `Then stage and commit it by running: git add -A && git commit -m "Add GREETING.txt"\n` +
  `Do nothing else. Keep your response brief.`;

const EXPLORE_PROMPT =
  "Explore this repository thoroughly: read every file and write a detailed multi-paragraph explanation of what it does, the history, and possible improvements. Be exhaustive.";

const REAL_TIMEOUT_MS = 180_000;
const CANCEL_AFTER_MS = 1_500;
const CANCEL_TIMINGS: KillConfirmTimings = { graceMs: 3_000, sigkillWaitMs: 3_000 };

export interface AdapterEvidence {
  adapter: string;
  enabled: boolean;
  disabledReason?: string;
  solve?: Omit<DispatchRecord, "events"> & { transcript: string; sampleEvents: StreamEvent[] };
  cancel?: Pick<DispatchRecord, "outcome" | "killConfirm" | "streamedEvents" | "durationMs">;
}

// Redact the local home path from captured worker output so committed evidence
// carries no absolute workstation path / local identity (review #6-new).
const HOME = homedir();
function scrub(text: string): string {
  return HOME ? text.split(HOME).join("~") : text;
}

/** First + last few parsed events — portable proof of live parsing in summary.json. */
function sampleEvents(events: StreamEvent[]): StreamEvent[] {
  const picked = events.length <= 6 ? events : [...events.slice(0, 3), ...events.slice(-3)];
  return picked.map((e) => ({ ...e, text: scrub(e.text) }));
}

function summarizeSolve(
  rec: DispatchRecord,
  transcriptAbs: string,
): NonNullable<AdapterEvidence["solve"]> {
  const rest: Omit<DispatchRecord, "events"> & { events?: unknown } = { ...rec };
  delete rest.events;
  const summary = rest as Omit<DispatchRecord, "events">;
  return {
    ...summary,
    finalText: scrub(summary.finalText),
    transcript: relative(REPO_ROOT, transcriptAbs), // repo-relative, portable
    sampleEvents: sampleEvents(rec.events),
  };
}

async function runSolve(adapter: AdapterSpec): Promise<NonNullable<AdapterEvidence["solve"]>> {
  const ws = makeWorkspace();
  const before = headSha(ws);
  const transcript = join(OUT, `${adapter.name}.solve.jsonl`);
  writeFileSync(transcript, "");
  try {
    const rec = await dispatch(
      adapter,
      { workdir: ws, prompt: SOLVE_PROMPT(adapter.name) },
      {
        timeoutMs: REAL_TIMEOUT_MS,
        onLine: (channel, line) =>
          appendFileSync(transcript, JSON.stringify({ channel, line }) + "\n"),
      },
    );
    rec.committedSha = committedSince(ws, before);
    return summarizeSolve(rec, transcript);
  } finally {
    rmSync(ws, { recursive: true, force: true }); // workspace cleanup
  }
}

async function runCancel(adapter: AdapterSpec): Promise<NonNullable<AdapterEvidence["cancel"]>> {
  const ws = makeWorkspace();
  const transcript = join(OUT, `${adapter.name}.cancel.jsonl`);
  writeFileSync(transcript, "");
  try {
    const rec = await dispatch(
      adapter,
      { workdir: ws, prompt: EXPLORE_PROMPT },
      {
        cancelAfterFirstEventMs: CANCEL_AFTER_MS,
        timeoutMs: 60_000,
        killConfirm: CANCEL_TIMINGS,
        onLine: (channel, line) =>
          appendFileSync(transcript, JSON.stringify({ channel, line }) + "\n"),
      },
    );
    return {
      outcome: rec.outcome,
      ...(rec.killConfirm ? { killConfirm: rec.killConfirm } : {}),
      streamedEvents: rec.streamedEvents,
      durationMs: rec.durationMs,
    };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

/**
 * One adapter → its evidence. A DISABLED adapter is never dispatched: `plan()`
 * is not called, and the recorded reason is carried through (CAM-EXEC-01
 * negative path). Exported so a test can prove the skip deterministically.
 */
export async function runAdapter(
  adapter: AdapterSpec,
  doCancel: boolean,
): Promise<AdapterEvidence> {
  if (!adapter.enabled) {
    return {
      adapter: adapter.name,
      enabled: false,
      ...(adapter.disabledReason ? { disabledReason: adapter.disabledReason } : {}),
    };
  }
  const entry: AdapterEvidence = { adapter: adapter.name, enabled: true };
  entry.solve = await runSolve(adapter);
  if (doCancel) entry.cancel = await runCancel(adapter);
  return entry;
}

async function main() {
  const argv = process.argv.slice(2);
  const doCancel = argv.includes("--cancel");
  const onlyArg = argv.find((a) => a.startsWith("--only="));
  const only = onlyArg ? onlyArg.slice("--only=".length).split(",") : null;

  mkdirSync(OUT, { recursive: true });
  const registry = buildRegistry();
  const evidence: AdapterEvidence[] = [];

  for (const adapter of registry) {
    if (only && !only.includes(adapter.name) && !only.includes(adapter.name.split("-")[0]!)) {
      continue;
    }
    if (!adapter.enabled) {
      console.log(`[${adapter.name}] DISABLED — ${adapter.disabledReason}`);
      evidence.push(await runAdapter(adapter, doCancel));
      continue;
    }
    console.log(`[${adapter.name}] solve dispatch…`);
    const entry = await runAdapter(adapter, doCancel);
    console.log(
      `[${adapter.name}] outcome=${entry.solve?.outcome} events=${entry.solve?.streamedEvents} committed=${entry.solve?.committedSha ? entry.solve.committedSha.slice(0, 8) : "no"}`,
    );
    if (entry.cancel) {
      console.log(
        `[${adapter.name}] cancel outcome=${entry.cancel.outcome} escalated=${entry.cancel.killConfirm?.escalatedToSigkill} treeGone=${entry.cancel.killConfirm?.treeGone}`,
      );
    }
    evidence.push(entry);
  }

  writeFileSync(join(OUT, "summary.json"), JSON.stringify(evidence, null, 2) + "\n");
  writeFileSync(join(OUT, "REPORT.md"), renderReport(evidence, doCancel));
  console.log(`\nWrote ${join(OUT, "REPORT.md")}`);
}

export function renderReport(evidence: AdapterEvidence[], didCancel: boolean): string {
  const lines: string[] = [
    "# WP-001 dispatch spike — run report",
    "",
    "Real dispatches on live subscriptions. Mechanics (kill-confirm escalation,",
    "quota classification, env posture) are proven quota-free in `lifecycle.test.ts`;",
    "this report is the real-CLI evidence for CAM-EXEC-01 / CAM-EXEC-06 / CAM-SEC-06.",
    "Per-parsed-event samples and repo-relative transcript paths are in `summary.json`.",
    "",
    "| Adapter | Enabled | Solve outcome | Stream events | Local commit | Env: GH creds | Cancel outcome | Kill-confirm |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const e of evidence) {
    if (!e.enabled) {
      lines.push(
        `| ${e.adapter} | disabled — ${e.disabledReason ?? "no reason"} | — | — | — | — | — | — |`,
      );
      continue;
    }
    const s = e.solve;
    const commit = s?.committedSha ? s.committedSha.slice(0, 8) : "none";
    const ghCreds = s ? (s.envPosture.githubCredentialKeys.length === 0 ? "none ✓" : "LEAK") : "?";
    const c = e.cancel;
    const cancelOut = c ? c.outcome : didCancel ? "?" : "not run";
    const kc = c?.killConfirm
      ? `treeGone=${c.killConfirm.treeGone}${c.killConfirm.escalatedToSigkill ? " (SIGKILL)" : ""}`
      : "—";
    lines.push(
      `| ${e.adapter} | yes | ${s?.outcome ?? "?"} | ${s?.streamedEvents ?? 0} | ${commit} | ${ghCreds} | ${cancelOut} | ${kc} |`,
    );
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

// Only run when invoked as a script (not when imported by a test). Compare via
// pathToFileURL so paths with spaces / '#' resolve correctly (review #5-new).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
