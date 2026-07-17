// WP-002 PRD-to-plan probe — orchestration.
//
//   node --run spike:plan-probe                # REAL: claude-code plans, codex-cli reviews (quota)
//   node --run spike:plan-probe -- --mock      # zero-quota pipeline dry-run (mock adapters)
//   node --run spike:plan-probe -- --planner=claude-code --reviewer=grok-build
//   node --run spike:plan-probe -- --fixture=path/to/other-prd.md   # reused by WP-004
//   node --run spike:plan-probe -- --rerender  # regenerate packet/report from committed
//                                              # artifacts, zero quota (refuses to clobber
//                                              # a packet that already carries ratings)
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
import { checkPacket, describeCheck, packetCarriesInput, renderPacket } from "./packet.js";
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
  /**
   * PIPELINE MECHANICS ONLY: both stages dispatched, both deliverables
   * structurally valid, packet rendered. Says nothing about whether the plan
   * is any good (that is the review verdict) or accepted (that is David's
   * packet) — review r1 finding 2.
   */
  mechanicsOk: boolean;
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
  /** Discard an existing packet that carries David's input (deliberate only). */
  force?: boolean;
}

/**
 * A run owns its evidence directory: stale deliverables and transcripts from a
 * previous run must never survive to masquerade as the new run's output
 * (review r1c finding 1 — a failed rerun left run N-1's plan.json beside a
 * REPORT saying the planner wrote nothing). The packet is guarded separately:
 * one carrying David's input is never silently discarded (finding 5).
 */
function clearStaleEvidence(outDir: string, packetPath: string, force: boolean): void {
  for (const f of readdirSync(outDir)) {
    if (/^(plan\.json|review\.json|(planner|reviewer)\..*\.jsonl)$/.test(f)) {
      rmSync(join(outDir, f), { force: true });
    }
  }
  let existingPacket = "";
  try {
    existingPacket = readFileSync(packetPath, "utf8");
  } catch {
    return; // no packet yet
  }
  if (packetCarriesInput(existingPacket) && !force) {
    throw new Error(
      `refusing to overwrite ${packetPath}: it already carries recorded input ` +
        `(rerun with --force only if discarding it is intended)`,
    );
  }
  rmSync(packetPath, { force: true });
}

/**
 * The whole probe. Returns evidence and writes: <outDir>/{plan.json,
 * review.json, REPORT.md, summary.json, *.jsonl} and the rating packet.
 * Throws only on harness misuse (same-family pairing, unreadable fixture);
 * worker failures come back as evidence with mechanicsOk=false.
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
  clearStaleEvidence(outDir, packetPath, opts.force ?? false);

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
    mechanicsOk: false,
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
  evidence.mechanicsOk = true;

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
      `- Segments the planner flagged non-requirement (CAM-PLAN-02): ` +
        `${evidence.plan.flaggedNonRequirements.join(", ") || "none"}`,
      `- Requirement segments with NO implementing issue (by the planner's OWN classification` +
        ` — the review may dispute rows): ${evidence.plan.uncoveredRequirements.join(", ") || "none"}`,
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
  lines.push(
    `Mechanics: ${evidence.mechanicsOk ? "OK" : "FAILED"} — pipeline mechanics only ` +
      `(stages dispatched, deliverables structurally valid, packet rendered). The plan's ` +
      `quality is the review verdict above; acceptance is David's completed packet.`,
    "",
  );
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

/**
 * Re-render packet/REPORT/summary from the ALREADY-COMMITTED artifacts (zero
 * quota): stage evidence is carried over from the existing summary.json;
 * plan.json/review.json are re-validated; derived fields are recomputed.
 * Refuses to overwrite a rating packet that already carries ratings unless
 * `force` — David's recorded ratings must never be silently clobbered.
 */
export function rerenderProbe(
  opts: { outDir?: string; fixturePath?: string; packetPath?: string; force?: boolean } = {},
): ProbeEvidence {
  const outDir = opts.outDir ?? OUT;
  const packetPath = opts.packetPath ?? DEFAULT_PACKET;
  const fixtureAbs = resolve(opts.fixturePath ?? DEFAULT_FIXTURE);

  const evidence = JSON.parse(readFileSync(join(outDir, "summary.json"), "utf8")) as ProbeEvidence;
  const fixtureText = readFileSync(fixtureAbs, "utf8");
  const segments = parseSegments(fixtureText);
  evidence.segments = segments;

  // Re-assert CAM-PLAN-03 from the recorded ADAPTER NAMES — a rerender must
  // not trust summary.json's stored family strings (review r1c finding 2).
  if (evidence.reviewer) {
    assertCrossFamily(evidence.planner.adapter, evidence.reviewer.adapter);
    evidence.crossFamily = {
      plannerFamily: adapterFamily(evidence.planner.adapter),
      reviewerFamily: adapterFamily(evidence.reviewer.adapter),
    };
  }

  const planRaw = readFileSync(join(outDir, "plan.json"), "utf8");
  const planParsed = parsePlan(planRaw, segments);
  evidence.planner.validationErrors = planParsed.errors;
  const reviewRaw = readFileSync(join(outDir, "review.json"), "utf8");
  const reviewParsed = parseReview(reviewRaw);
  if (evidence.reviewer) evidence.reviewer.validationErrors = reviewParsed.errors;

  const plan = planParsed.plan;
  const review = reviewParsed.review;
  evidence.plan = plan
    ? {
        issueCount: plan.issues.length,
        questionCount: plan.clarifyingQuestions.length,
        blockingQuestions: plan.clarifyingQuestions.filter((q) => q.blocking).length,
        uncoveredRequirements: uncoveredRequirements(plan).map((c) => c.segment),
        flaggedNonRequirements: flaggedNonRequirements(plan).map((c) => c.segment),
      }
    : null;
  evidence.review = review
    ? {
        verdict: review.verdict,
        blocker: review.findings.filter((f) => f.severity === "blocker").length,
        major: review.findings.filter((f) => f.severity === "major").length,
        minor: review.findings.filter((f) => f.severity === "minor").length,
      }
    : null;

  let packet: string | null = null;
  if (plan && review && evidence.reviewer) {
    let existing = "";
    try {
      existing = readFileSync(packetPath, "utf8");
    } catch {
      /* no packet yet */
    }
    // ANY recorded human value — valid or not, rating or timer or note —
    // blocks the overwrite (review r1c finding 5).
    if (existing && packetCarriesInput(existing) && !opts.force) {
      throw new Error(
        `refusing to overwrite ${packetPath}: it already carries recorded input ` +
          `(rerun with --force only if discarding it is intended)`,
      );
    }
    packet = renderPacket({
      plan,
      review,
      plannerName: evidence.planner.adapter,
      plannerFamily: evidence.crossFamily.plannerFamily,
      reviewerName: evidence.reviewer.adapter,
      reviewerFamily: evidence.crossFamily.reviewerFamily,
      fixtureRel: evidence.fixture,
      generatedAt: new Date().toISOString(),
    });
    writeFileSync(packetPath, packet);
    evidence.packet = relative(REPO_ROOT, packetPath);
  } else {
    evidence.packet = null;
  }
  evidence.mechanicsOk = packet !== null;

  finish(outDir, evidence, packet);
  return evidence;
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

  if (argv.includes("--rerender")) {
    const evidence = rerenderProbe({
      fixturePath: fixture,
      force: argv.includes("--force"),
    });
    console.log(
      evidence.mechanicsOk
        ? `re-rendered: ${evidence.packet}`
        : "re-render found invalid artifacts — see REPORT.md",
    );
    process.exitCode = evidence.mechanicsOk ? 0 : 1;
    return;
  }

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
    opts = { force: argv.includes("--force") };
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
  console.log(
    evidence.mechanicsOk ? `packet: ${evidence.packet}` : "probe mechanics FAILED — see REPORT.md",
  );
  process.exitCode = evidence.mechanicsOk ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
