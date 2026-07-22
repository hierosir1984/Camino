/**
 * Planner-runner tests (WP-110): the adapter-driven compile path streams
 * records into the plan store WHILE the worker runs (CAM-PLAN-01), and
 * refuses malformed worker output by name without crashing (worker output
 * is data, CAM-EXEC-09). Uses the mock planner CLI — a real spawned
 * process through the real WP-105 dispatch lifecycle, zero model quota.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterSpec, MissionRecord } from "@camino/shared";
import { CanonLedgerStore } from "./canon-ledger.js";
import { SqliteDomainStore } from "./domain-store.js";
import { SqliteEventStore } from "./event-store.js";
import { MissionIntake } from "./intake.js";
import { PlanStore } from "./plan-store.js";
import { runPlannerCompile, plannerPrompt } from "./plan-runner.js";
import { PlanningService } from "./planning.js";
import { SerializationScheduler } from "./serialization-scheduler.js";
import { TransitionRecorder } from "./transition-recorder.js";

const here = dirname(fileURLToPath(import.meta.url));
const MOCK_PLANNER_CLI = join(here, "plan-mock-planner-cli.mjs");

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function mockPlannerAdapter(mode?: string): AdapterSpec {
  return {
    name: "mock-planner",
    enabled: true,
    plan: () => ({
      file: process.execPath,
      args: [MOCK_PLANNER_CLI],
      ...(mode !== undefined ? { env: { MOCK_PLANNER_MODE: mode } } : {}),
    }),
    parseLine: () => null,
  };
}

interface Harness {
  service: PlanningService;
  mission: MissionRecord;
  sessionId: string;
  workdirRoot: string;
}

function newHarness(): Harness {
  const domain = new SqliteDomainStore(":memory:");
  const events = new SqliteEventStore(":memory:");
  const ledger = new CanonLedgerStore(":memory:");
  const planStore = new PlanStore(":memory:");
  cleanups.push(() => {
    domain.close();
    events.close();
    ledger.close();
    planStore.close();
  });
  const recorder = new TransitionRecorder(events);
  const intake = new MissionIntake(domain, recorder, events);
  const scheduler = new SerializationScheduler(domain, recorder, events);
  const service = new PlanningService(planStore, domain, recorder, events, ledger, scheduler);
  const project = domain.createProject("demo");
  const repo = domain.createRepo(project.id, "demo");
  const result = intake.createFromText({
    repoId: repo.id,
    title: "Streaming compile",
    content: "Add an export button. Users asked for it.",
    actor: "david",
  });
  if (!result.ok) throw new Error(result.reason);
  const session = service.startSession(result.mission.id, "feature");
  const workdirRoot = mkdtempSync(join(tmpdir(), "camino-plan-runner-"));
  cleanups.push(() => rmSync(workdirRoot, { recursive: true, force: true }));
  return { service, mission: result.mission, sessionId: session.sessionId, workdirRoot };
}

/** Wait (bounded) for a condition the mock signals through the filesystem/view. */
async function until(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function workspaceIn(root: string): string {
  const entries = readdirSync(root).filter((name) => name.startsWith("camino-plan-"));
  if (entries.length !== 1) throw new Error(`expected one workspace, saw ${entries.length}`);
  return join(root, entries[0] as string);
}

describe("runPlannerCompile", () => {
  it("streams records into the view WHILE the worker runs, then completes", async () => {
    const h = newHarness();
    const run = runPlannerCompile({
      adapter: mockPlannerAdapter(),
      service: h.service,
      sessionId: h.sessionId,
      workdirRoot: h.workdirRoot,
      pollMs: 25,
      timeoutMs: 60_000,
    });
    // The mock blocks after its first record until we ack. The record must
    // already be visible in the plan view — the dispatch is still running.
    await until(
      () => h.service.planView(h.sessionId).issues.length === 1,
      "the first issue to appear mid-run",
    );
    const midRun = h.service.planView(h.sessionId);
    expect(midRun.status).toBe("constructing");
    expect(midRun.issues[0]?.planIssueId).toBe("I1");
    const workspace = workspaceIn(h.workdirRoot);
    await until(() => existsSync(join(workspace, "waiting-for-ack")), "the mock's handshake");
    writeFileSync(join(workspace, "ack"), "");
    const record = await run;
    expect(record.outcome).toBe("succeeded");
    expect(record.refused).toEqual([]);
    expect(record.constructionComplete).toBe(true);
    const view = h.service.planView(h.sessionId);
    expect(view.status).toBe("constructed");
    expect(view.clarifications.map((c) => c.clarificationId)).toEqual(["Q1"]);
    expect(view.checklist.length).toBe(view.segments.length);
    // The workspace is cleaned up after the run.
    expect(readdirSync(h.workdirRoot)).toEqual([]);
  });

  it("refuses malformed worker lines by name without crashing the run", async () => {
    const h = newHarness();
    const run = runPlannerCompile({
      adapter: mockPlannerAdapter("malformed"),
      service: h.service,
      sessionId: h.sessionId,
      workdirRoot: h.workdirRoot,
      pollMs: 25,
      timeoutMs: 60_000,
    });
    await until(() => h.service.planView(h.sessionId).issues.length === 1, "first issue");
    const workspace = workspaceIn(h.workdirRoot);
    await until(() => existsSync(join(workspace, "waiting-for-ack")), "handshake");
    writeFileSync(join(workspace, "ack"), "");
    const record = await run;
    expect(record.outcome).toBe("succeeded");
    expect(record.refused).toHaveLength(2);
    expect(record.refused[0]?.problem).toBe("not valid JSON");
    expect(record.refused[1]?.problem).toMatch(/planIssueId/);
    // The well-formed remainder of the stream still landed.
    expect(record.constructionComplete).toBe(true);
    expect(h.service.planView(h.sessionId).issues).toHaveLength(1);
  });

  it("writes the PRD and segments into the worker's plan-input directory", async () => {
    const h = newHarness();
    const run = runPlannerCompile({
      adapter: mockPlannerAdapter(),
      service: h.service,
      sessionId: h.sessionId,
      workdirRoot: h.workdirRoot,
      pollMs: 25,
      timeoutMs: 60_000,
      keepWorkspace: true,
    });
    await until(() => h.service.planView(h.sessionId).issues.length === 1, "first issue");
    const workspace = workspaceIn(h.workdirRoot);
    // The mock read segments.json successfully (it emitted I1), and the PRD
    // rides along verbatim.
    expect(existsSync(join(workspace, "plan-input", "prd.md"))).toBe(true);
    expect(existsSync(join(workspace, "plan-input", "segments.json"))).toBe(true);
    writeFileSync(join(workspace, "ack"), "");
    await run;
    expect(existsSync(workspace)).toBe(true); // keepWorkspace honored
  });
});

describe("plannerPrompt", () => {
  it("names the stream file, the record shapes, and the no-silent-guess mandate", () => {
    const prompt = plannerPrompt({ missionTitle: "Exports", template: "feature" });
    expect(prompt).toContain("plan-stream.jsonl");
    expect(prompt).toContain('"kind":"construction-complete"');
    expect(prompt).toContain("Do not silently guess");
    expect(prompt).toContain("plan-input/segments.json");
  });
});

describe("stream-tail robustness (r1 finding 10)", () => {
  it("ingests a final record that ends at EOF without a trailing newline", async () => {
    const h = newHarness();
    const run = runPlannerCompile({
      adapter: mockPlannerAdapter("no-trailing-newline"),
      service: h.service,
      sessionId: h.sessionId,
      workdirRoot: h.workdirRoot,
      pollMs: 25,
      timeoutMs: 60_000,
    });
    await until(() => h.service.planView(h.sessionId).issues.length === 1, "first issue");
    const workspace = workspaceIn(h.workdirRoot);
    await until(() => existsSync(join(workspace, "waiting-for-ack")), "handshake");
    writeFileSync(join(workspace, "ack"), "");
    const record = await run;
    expect(record.outcome).toBe("succeeded");
    expect(record.refused).toEqual([]);
    // The unterminated construction-complete at EOF still landed.
    expect(record.constructionComplete).toBe(true);
    expect(h.service.planView(h.sessionId).status).toBe("constructed");
  });
});
