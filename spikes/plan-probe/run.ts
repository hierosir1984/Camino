// WP-002 PRD-to-plan probe — orchestration.
//
//   node --run spike:plan-probe                # REAL: claude-code plans, codex-cli reviews (quota)
//   node --run spike:plan-probe -- --mock      # zero-quota pipeline dry-run (mock adapters)
//   node --run spike:plan-probe -- --planner=claude-code --reviewer=grok-build
//   node --run spike:plan-probe -- --fixture=path/to/other-prd.md   # reused by WP-004
//
// Stages: fixture PRD → family-A planner (writes plan.json) → validation →
// family-B falsification reviewer (writes review.json) → validation → rating
// packet for David. Committed evidence: transcripts/{plan,review}.json +
// REPORT.md + summary.json + ../RATING-PACKET.md; raw *.jsonl streams are
// gitignored. Cross-family is asserted BEFORE any quota is spent.
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { dispatch } from "../dispatch/lifecycle.js";
import { buildRegistry } from "../dispatch/registry.js";
import type { AdapterSpec, DispatchRecord, StreamEvent } from "../dispatch/types.js";
import { plannerPrompt, reviewerPrompt } from "./prompts.js";
import { adapterFamily, assertCrossFamily, parseSegments } from "./types.js";
import type { PlanDocument, ReviewDocument } from "./types.js";
import {
  flaggedNonRequirements,
  parsePlan,
  parseReview,
  uncoveredRequirements,
} from "./validate.js";
import { checkPacket, describeCheck, renderPacket } from "./packet.js";
import { mockProbeAdapter } from "./mock.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..");
const OUT = join(here, "transcripts");
const DEFAULT_FIXTURE = join(here, "fixture", "evidence-viewer-v0.md");
const DEFAULT_PACKET = join(here, "RATING-PACKET.md");

/** Real planning/review calls are long-form work; cap generously, never trust. */
const REAL_TIMEOUT_MS = 20 * 60_000;

const HOME = homedir();
function scrub(text: string): string {
  return HOME ? text.split(HOME).join("~") : text;
}

function sampleEvents(events: StreamEvent[]): StreamEvent[] {
  const picked = events.length <= 6 ? events : [...events.slice(0, 3), ...events.slice(-3)];
  return picked.map((e) => ({ ...e, text: scrub(e.text) }));
}

export interface StageEvidence {
  role: "planner" | "reviewer";
  adapter: string;
  family: string;
  outcome: DispatchRecord["outcome"];
  exitCode: number | null;
  streamedEvents: number;
  durationMs: number;
  /** Files the worker left in its workspace beyond what the stage expects. */
  unexpectedFiles: string[];
  /** Structural validation errors for the stage's deliverable ([] = valid). */
  validationErrors: string[];
  /** Repo-relative path of the committed deliverable copy, if it was written. */
  artifact: string | null;
  sampleEvents: StreamEvent[];
}

export interface ProbeEvidence {
  fixture: string;
  segments: string[];
  crossFamily: { plannerFamily: string; reviewerFamily: string };
  planner: StageEvidence;
  reviewer: StageEvidence | null;
  plan: {
    issueCount: number;
    questionCount: number;
    blockingQuestions: number;
    uncoveredRequirements: string[];
    flaggedNonRequirements: string[];
  } | null;
  review: { verdict: string; blocker: number; major: number; minor: number } | null;
  packet: string | null;
  ok: boolean;
}

interface StageRun {
  evidence: StageEvidence;
  /** Raw deliverable text as the worker wrote it (null if never written). */
  deliverableRaw: string | null;
}

/** A throwaway workspace holding exactly the files a stage may read. */
function makeStageWorkspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-plan-probe-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

async function runStage(
  role: "planner" | "reviewer",
  adapter: AdapterSpec,
  workspaceFiles: Record<string, string>,
  deliverable: string,
  prompt: string,
  outDir: string,
  timeoutMs: number,
): Promise<StageRun> {
  const ws = makeStageWorkspace(workspaceFiles);
  const transcript = join(outDir, `${role}.${adapter.name}.jsonl`);
  writeFileSync(transcript, "");
  try {
    const record = await dispatch(
      adapter,
      { workdir: ws, prompt },
      {
        timeoutMs,
        onLine: (channel, line) =>
          appendFileSync(transcript, JSON.stringify({ channel, line }) + "\n"),
      },
    );
    let deliverableRaw: string | null = null;
    try {
      deliverableRaw = readFileSync(join(ws, deliverable), "utf8");
    } catch {
      deliverableRaw = null;
    }
    const expected = new Set([...Object.keys(workspaceFiles), deliverable]);
    const unexpectedFiles = readdirSync(ws).filter((f) => !expected.has(f));
    return {
      evidence: {
        role,
        adapter: adapter.name,
        family: adapterFamily(adapter.name),
        outcome: record.outcome,
        exitCode: record.exitCode,
        streamedEvents: record.streamedEvents,
        durationMs: record.durationMs,
        unexpectedFiles,
        validationErrors: [], // filled by the caller after parsing
        artifact: null, // filled by the caller after committing the copy
        sampleEvents: sampleEvents(record.events),
      },
      deliverableRaw,
    };
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

export interface ProbeOptions {
  outDir?: string;
  packetPath?: string;
  timeoutMs?: number;
  /** Timestamp injected for deterministic tests. */
  now?: () => string;
}

/**
 * The whole probe. Returns evidence and writes: <outDir>/{plan.json,
 * review.json, REPORT.md, summary.json, *.jsonl} and the rating packet.
 * Throws only on harness misuse (same-family pairing, unreadable fixture);
 * worker failures come back as evidence with ok=false.
 */
export async function runProbe(
  planner: AdapterSpec,
  reviewer: AdapterSpec,
  fixturePath: string,
  opts: ProbeOptions = {},
): Promise<ProbeEvidence> {
  // Fail BEFORE spending quota if the pairing violates CAM-PLAN-03.
  assertCrossFamily(planner.name, reviewer.name);

  const outDir = opts.outDir ?? OUT;
  const packetPath = opts.packetPath ?? DEFAULT_PACKET;
  const timeoutMs = opts.timeoutMs ?? REAL_TIMEOUT_MS;
  const now = opts.now ?? (() => new Date().toISOString());
  mkdirSync(outDir, { recursive: true });

  const fixtureAbs = resolve(fixturePath);
  const fixtureText = readFileSync(fixtureAbs, "utf8");
  const segments = parseSegments(fixtureText);
  if (segments.length === 0) {
    throw new Error(`fixture ${fixturePath} has no [S*] segment tags — nothing to map`);
  }

  const evidence: ProbeEvidence = {
    fixture: relative(REPO_ROOT, fixtureAbs),
    segments,
    crossFamily: {
      plannerFamily: adapterFamily(planner.name),
      reviewerFamily: adapterFamily(reviewer.name),
    },
    planner: null as unknown as StageEvidence,
    reviewer: null,
    plan: null,
    review: null,
    packet: null,
    ok: false,
  };

  // --- stage 1: planner ---
  const plannerRun = await runStage(
    "planner",
    planner,
    { "PRD.md": fixtureText },
    "plan.json",
    plannerPrompt(),
    outDir,
    timeoutMs,
  );
  evidence.planner = plannerRun.evidence;

  let plan: PlanDocument | null = null;
  if (plannerRun.deliverableRaw === null) {
    evidence.planner.validationErrors = ["worker did not write plan.json"];
  } else {
    writeFileSync(join(outDir, "plan.json"), plannerRun.deliverableRaw);
    evidence.planner.artifact = relative(REPO_ROOT, join(outDir, "plan.json"));
    const parsed = parsePlan(plannerRun.deliverableRaw, segments);
    evidence.planner.validationErrors = parsed.errors;
    plan = parsed.plan;
  }

  if (!plan) {
    finish(outDir, evidence, null);
    return evidence;
  }
  evidence.plan = {
    issueCount: plan.issues.length,
    questionCount: plan.clarifyingQuestions.length,
    blockingQuestions: plan.clarifyingQuestions.filter((q) => q.blocking).length,
    uncoveredRequirements: uncoveredRequirements(plan).map((c) => c.segment),
    flaggedNonRequirements: flaggedNonRequirements(plan).map((c) => c.segment),
  };

  // --- stage 2: cross-family falsification review (CAM-PLAN-03) ---
  const reviewerRun = await runStage(
    "reviewer",
    reviewer,
    { "PRD.md": fixtureText, "plan.json": JSON.stringify(plan, null, 2) + "\n" },
    "review.json",
    reviewerPrompt(),
    outDir,
    timeoutMs,
  );
  evidence.reviewer = reviewerRun.evidence;

  let review: ReviewDocument | null = null;
  if (reviewerRun.deliverableRaw === null) {
    evidence.reviewer.validationErrors = ["worker did not write review.json"];
  } else {
    writeFileSync(join(outDir, "review.json"), reviewerRun.deliverableRaw);
    evidence.reviewer.artifact = relative(REPO_ROOT, join(outDir, "review.json"));
    const parsed = parseReview(reviewerRun.deliverableRaw);
    evidence.reviewer.validationErrors = parsed.errors;
    review = parsed.review;
  }

  if (!review) {
    finish(outDir, evidence, null);
    return evidence;
  }
  evidence.review = {
    verdict: review.verdict,
    blocker: review.findings.filter((f) => f.severity === "blocker").length,
    major: review.findings.filter((f) => f.severity === "major").length,
    minor: review.findings.filter((f) => f.severity === "minor").length,
  };

  // --- stage 3: the rating packet (only renderable WITH the review attached) ---
  const packet = renderPacket({
    plan,
    review,
    plannerName: planner.name,
    plannerFamily: evidence.crossFamily.plannerFamily,
    reviewerName: reviewer.name,
    reviewerFamily: evidence.crossFamily.reviewerFamily,
    fixtureRel: evidence.fixture,
    generatedAt: now(),
  });
  writeFileSync(packetPath, packet);
  evidence.packet = relative(REPO_ROOT, packetPath);
  evidence.ok = true;

  finish(outDir, evidence, packet);
  return evidence;
}

function finish(outDir: string, evidence: ProbeEvidence, packet: string | null): void {
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(evidence, null, 2) + "\n");
  writeFileSync(join(outDir, "REPORT.md"), renderReport(evidence, packet));
}

export function renderReport(evidence: ProbeEvidence, packet: string | null): string {
  const lines: string[] = [
    "# WP-002 PRD-to-plan probe — run report",
    "",
    "Prototype evidence toward CAM-PLAN-01/-02/-03 (product-grade acceptance lands in Phase 1).",
    `Fixture: \`${evidence.fixture}\` (${evidence.segments.length} segments).`,
    "",
    `Cross-family (CAM-PLAN-03): planner family **${evidence.crossFamily.plannerFamily}** ≠ ` +
      `reviewer family **${evidence.crossFamily.reviewerFamily}** — asserted before dispatch.`,
    "",
    "| Stage | Adapter | Family | Outcome | Events | Duration | Deliverable | Valid |",
    "|---|---|---|---|---|---|---|---|",
  ];
  const row = (s: StageEvidence | null, label: string) => {
    if (!s) {
      lines.push(`| ${label} | — | — | not dispatched | — | — | — | — |`);
      return;
    }
    const valid = s.validationErrors.length === 0 ? "yes ✓" : `NO (${s.validationErrors.length})`;
    lines.push(
      `| ${label} | ${s.adapter} | ${s.family} | ${s.outcome} | ${s.streamedEvents} | ` +
        `${Math.round(s.durationMs / 1000)}s | ${s.artifact ?? "not written"} | ${valid} |`,
    );
  };
  row(evidence.planner, "planner");
  row(evidence.reviewer, "reviewer");
  lines.push("");

  for (const stage of [evidence.planner, evidence.reviewer]) {
    if (stage && stage.validationErrors.length > 0) {
      lines.push(`## ${stage.role} validation errors`, "");
      for (const e of stage.validationErrors) lines.push(`- ${e}`);
      lines.push("");
    }
    if (stage && stage.unexpectedFiles.length > 0) {
      lines.push(
        `Note: ${stage.role} left unexpected files in its workspace: ` +
          `${stage.unexpectedFiles.join(", ")} (recorded, not fatal).`,
        "",
      );
    }
  }

  if (evidence.plan) {
    lines.push(
      "## Plan shape",
      "",
      `- Issues: ${evidence.plan.issueCount}`,
      `- Clarifying questions: ${evidence.plan.questionCount} (${evidence.plan.blockingQuestions} blocking)`,
      `- Non-requirement segments visibly flagged (CAM-PLAN-02): ` +
        `${evidence.plan.flaggedNonRequirements.join(", ") || "none"}`,
      `- Requirement segments with NO implementing issue: ` +
        `${evidence.plan.uncoveredRequirements.join(", ") || "none"}`,
      "",
    );
  }
  if (evidence.review) {
    lines.push(
      "## Attached adversarial review",
      "",
      `- Verdict: ${evidence.review.verdict}`,
      `- Findings: ${evidence.review.blocker} blocker / ${evidence.review.major} major / ` +
        `${evidence.review.minor} minor`,
      "",
    );
  }
  if (packet && evidence.packet) {
    const check = checkPacket(packet);
    lines.push(
      "## Rating packet",
      "",
      `Written to \`${evidence.packet}\` — awaiting David's ratings.`,
      "",
      "```",
      describeCheck(check),
      "```",
      "",
    );
  } else {
    lines.push(
      "## Rating packet",
      "",
      "NOT rendered — a packet requires a validated plan AND its attached cross-family review",
      "(CAM-PLAN-03). Fix the failed stage above and re-run.",
      "",
    );
  }
  return lines.join("\n") + "\n";
}

function pickAdapter(name: string): AdapterSpec {
  if (name.startsWith("mock-")) {
    throw new Error("mock adapters are only available via --mock");
  }
  const adapter = buildRegistry().find((a) => a.name === name);
  if (!adapter) {
    throw new Error(`unknown adapter "${name}" (want claude-code | codex-cli | grok-build)`);
  }
  if (!adapter.enabled) {
    throw new Error(`adapter "${name}" is disabled: ${adapter.disabledReason ?? "no reason"}`);
  }
  return adapter;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  const mock = argv.includes("--mock");
  const fixture = flag("fixture") ?? DEFAULT_FIXTURE;

  let planner: AdapterSpec;
  let reviewer: AdapterSpec;
  let opts: ProbeOptions = {};
  if (mock) {
    planner = mockProbeAdapter("planner", "plan");
    reviewer = mockProbeAdapter("reviewer", "review");
    const outDir = mkdtempSync(join(tmpdir(), "camino-plan-probe-mock-out-"));
    opts = { outDir, packetPath: join(outDir, "RATING-PACKET.md"), timeoutMs: 30_000 };
    console.log(`[mock] writing evidence to ${outDir}`);
  } else {
    planner = pickAdapter(flag("planner") ?? "claude-code");
    reviewer = pickAdapter(flag("reviewer") ?? "codex-cli");
  }

  console.log(
    `planner=${planner.name} (${adapterFamily(planner.name)}) → ` +
      `reviewer=${reviewer.name} (${adapterFamily(reviewer.name)}) on ${fixture}`,
  );
  const evidence = await runProbe(planner, reviewer, fixture, opts);
  console.log(
    `planner: ${evidence.planner.outcome}, ${evidence.planner.streamedEvents} events, ` +
      `valid=${evidence.planner.validationErrors.length === 0}`,
  );
  if (evidence.reviewer) {
    console.log(
      `reviewer: ${evidence.reviewer.outcome}, ${evidence.reviewer.streamedEvents} events, ` +
        `valid=${evidence.reviewer.validationErrors.length === 0}`,
    );
  }
  console.log(evidence.ok ? `packet: ${evidence.packet}` : "probe FAILED — see REPORT.md");
  process.exitCode = evidence.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
