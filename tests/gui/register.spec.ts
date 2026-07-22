/**
 * Gap-register GUI suite (WP-122 acceptance, Playwright over a REAL
 * composed daemon: real SQLite stores in a scratch state dir, the real
 * loopback listener, the real static GUI — nothing mocked).
 *
 * What this suite pins, per the issue's verbatim accept criteria:
 *
 *  - CAM-CORE-09 / registry item 9 — the register renders as a table,
 *    the FILTERS actually filter (asserted against independently
 *    computed expectations, not just rendered), and the disposition
 *    actions work; all three asserted here.
 *  - CAM-CANON-05 — waiver controls exist only on detector-backed rows,
 *    the daemon refuses a waiver anywhere else, and a real unmet
 *    requirement leaves the register only via user descope.
 *  - CAM-CORE-10 — ledger and GUI never disagree: after every render
 *    and every mutation, the DOM table is compared field-by-field
 *    against `projectGapRegister` recomputed DIRECTLY from the stores
 *    (the same pure projection the daemon serves). The GUI has no other
 *    data path to diverge through — and this suite proves the one it
 *    has agrees.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

// COMPILED-ARTIFACT IMPORTS, deliberately: the suite composes the daemon
// from `tsc -b` output (test:gui builds first), so the browser exercises
// the same compiled code a packaged daemon would run — and the Playwright
// TS loader never rewrites the fastify/better-sqlite3 dependency graph
// (its transform trips Node's CJS/ESM interop on fastify's cyclic semver
// requires; compiled ESM loads through Node's own machinery instead).
import { projectGapRegister } from "../../packages/core/dist/index.js";
import type { GapRegisterRow } from "../../packages/core/dist/index.js";
import { DETECTOR_ACTOR_PREFIX } from "../../packages/shared/dist/index.js";
import type { StatusContext } from "../../packages/shared/dist/index.js";
import {
  CanonFactsStore,
  CanonLedgerStore,
  GapDispositionsStore,
  RegisterService,
  generateToken,
  startDaemonServer,
} from "../../packages/daemon/dist/index.js";
import type { RunningDaemon } from "../../packages/daemon/dist/index.js";

const GUI_ROOT = fileURLToPath(new URL("../../packages/gui/static", import.meta.url));
const HEAD = "d".repeat(40);
const OLD_HEAD = "e".repeat(40);
const MAIN: StatusContext = { kind: "main", headSha: HEAD };
const DETECTOR = `${DETECTOR_ACTOR_PREFIX}todo-scan`;
const TOKEN = generateToken();

// The seeded scenario (register rows in requirement-id order):
//   CAM-DEMO-01  accepted, no facts            → absent/unverified (a REAL unmet requirement)
//   CAM-DEMO-02  accepted, detector suspicion  → suspected-absent/unverified (waivable)
//   CAM-DEMO-03  accepted, landed, no verdict  → on-main/unverified (evidence gap)
//   CAM-DEMO-04  accepted, landed + live pass  → delivered, NOT in the register
//   CAM-VERIF-01 accepted, landed + old pass   → on-main/stale (evidence gap)
//   CAM-ZONE-01  assumed (documented assumption) → absent/unverified, carries an assumption line
//   CAM-DEMO-05  proposed only                 → not accepted intent, NOT in the register
const R_REAL = "CAM-DEMO-01";
const R_DETECTED = "CAM-DEMO-02";
const R_UNVERIFIED = "CAM-DEMO-03";
const R_DELIVERED = "CAM-DEMO-04";
const R_STALE = "CAM-VERIF-01";
const R_ASSUMED = "CAM-ZONE-01";
const R_PROPOSED = "CAM-DEMO-05";

let daemon: RunningDaemon;
let ledger: CanonLedgerStore;
let facts: CanonFactsStore;
let dispositions: GapDispositionsStore;

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "camino-gui-register-"));
  ledger = new CanonLedgerStore(join(dir, "canon-ledger.sqlite"));
  facts = new CanonFactsStore(join(dir, "canon-facts.sqlite"));
  dispositions = new GapDispositionsStore(join(dir, "gap-dispositions.sqlite"));

  const accept = (id: string, statement: string): void => {
    ledger.proposeRequirement(id, { statement, sourceMissionId: "m1" });
    ledger.acceptRequirement(id);
  };
  accept(R_REAL, "the intake form validates addresses");
  accept(R_DETECTED, "exports include the audit column");
  accept(R_UNVERIFIED, "sessions expire after inactivity");
  accept(R_DELIVERED, "login rejects malformed identifiers");
  accept(R_STALE, "reports render the fiscal-year summary");
  // An accepted-family requirement carrying a documented assumption, so the
  // register row renders an assumption line (round 4, finding 4).
  ledger.proposeRequirement(R_ASSUMED, {
    statement: "timestamps display in the viewer's local timezone",
    sourceMissionId: "m1",
  });
  ledger.disputeRequirement(R_ASSUMED, {
    reason: "the source repo has no timezone handling to confirm this against",
    conflictWith: null,
  });
  ledger.resolveDisputeAssumed(R_ASSUMED, {
    assumption: "assume UTC until a locale requirement is confirmed",
  });
  ledger.proposeRequirement(R_PROPOSED, {
    statement: "still awaiting intake confirmation",
    sourceMissionId: "m1",
  });

  facts.recordFact({
    requirementId: R_DETECTED,
    kind: "absence-suspected",
    actor: DETECTOR,
    payload: { contextKind: "main", reason: "todo-scan: stub at src/export.ts:12" },
  });
  facts.recordFact({
    requirementId: R_UNVERIFIED,
    kind: "landed-on-main",
    actor: "camino:merge",
    payload: { sha: HEAD },
  });
  facts.recordFact({
    requirementId: R_DELIVERED,
    kind: "landed-on-main",
    actor: "camino:merge",
    payload: { sha: HEAD },
  });
  facts.recordFact({
    requirementId: R_DELIVERED,
    kind: "verification-verdict",
    actor: "camino:validation",
    payload: { contextKind: "main", headSha: HEAD, baseSha: OLD_HEAD, outcome: "pass" },
  });
  facts.recordFact({
    requirementId: R_STALE,
    kind: "landed-on-main",
    actor: "camino:merge",
    payload: { sha: OLD_HEAD },
  });
  facts.recordFact({
    requirementId: R_STALE,
    kind: "verification-verdict",
    actor: "camino:validation",
    payload: { contextKind: "main", headSha: OLD_HEAD, baseSha: OLD_HEAD, outcome: "pass" },
  });

  const register = new RegisterService({
    canonLedger: ledger,
    canonFacts: facts,
    gapDispositions: dispositions,
    contextSource: { current: () => MAIN },
  });
  daemon = await startDaemonServer({ token: TOKEN, port: 0, guiRoot: GUI_ROOT, register });
});

test.afterAll(async () => {
  await daemon.app.close();
  dispositions.close();
  facts.close();
  ledger.close();
});

/** The independent expectation: the projection recomputed straight from the stores. */
function projected(): GapRegisterRow[] {
  return projectGapRegister(ledger.currentView(), facts.read(), dispositions.read(), MAIN);
}

async function openRegister(page: Page): Promise<void> {
  await page.goto(`${daemon.url}/#token=${TOKEN}`);
  await expect(page.locator("#register-controls")).toBeVisible();
}

function tableRows(page: Page): Locator {
  return page.locator("#register-rows tr");
}

function rowFor(page: Page, requirementId: string): Locator {
  return page.locator(`#register-rows tr[data-requirement-id="${requirementId}"]`);
}

/**
 * THE CAM-CORE-10 assertion: the rendered table equals the ledger
 * projection recomputed independently from the stores — every row, every
 * register-relevant field, in order.
 */
async function expectTableMatchesLedger(
  page: Page,
  rows: readonly GapRegisterRow[] = projected(),
): Promise<void> {
  const trs = tableRows(page);
  await expect(trs).toHaveCount(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const tr = trs.nth(i);
    // The full tuple, exactly (round 1, finding 11: previously the
    // implementation branch, exact waivable seq, provenance contents, and the
    // disposition record's seq/event were not asserted).
    await expect(tr).toHaveAttribute("data-requirement-id", row.requirementId);
    await expect(tr).toHaveAttribute("data-disposition", row.disposition);
    await expect(tr).toHaveAttribute("data-implementation", row.tuple.implementation.kind);
    await expect(tr).toHaveAttribute("data-evidence", row.tuple.evidence);
    await expect(tr).toHaveAttribute("data-intent-disposition", row.tuple.disposition);
    await expect(tr).toHaveAttribute(
      "data-waivable",
      row.waivableThroughSeq === null ? "false" : "true",
    );
    await expect(tr).toHaveAttribute(
      "data-waivable-through-seq",
      row.waivableThroughSeq === null ? "" : String(row.waivableThroughSeq),
    );
    if (row.tuple.implementation.kind === "present-on") {
      await expect(tr).toHaveAttribute(
        "data-implementation-branch",
        row.tuple.implementation.branch,
      );
      await expect(tr.locator(".tuple-implementation")).toHaveText(
        `present-on(${row.tuple.implementation.branch})`,
      );
    } else {
      // No stray branch attribute on a non-present-on row (round 3, finding 8).
      await expect(tr).not.toHaveAttribute("data-implementation-branch", /.*/);
      await expect(tr.locator(".tuple-implementation")).toHaveText(row.tuple.implementation.kind);
    }
    // The visible requirement id, not just the data attribute (round 3, finding 8).
    await expect(tr.locator(".requirement-id")).toHaveText(row.requirementId);
    await expect(tr.locator(".requirement-statement")).toHaveText(row.statement);
    if (row.assumption !== null) {
      await expect(tr.locator(".requirement-assumption")).toHaveText(
        `assumption: ${row.assumption}`,
      );
    } else {
      await expect(tr.locator(".requirement-assumption")).toHaveCount(0);
    }
    await expect(tr.locator(".tuple-intent")).toHaveText(row.tuple.disposition);
    await expect(tr.locator(".tuple-evidence")).toHaveText(row.tuple.evidence);
    // Provenance content, not just count: every fact's seq, kind, and actor.
    await expect(tr).toHaveAttribute(
      "data-provenance-seqs",
      row.provenance.map((f) => f.seq).join(","),
    );
    await expect(tr).toHaveAttribute(
      "data-detector-seqs",
      row.detectorFindings.map((f) => f.seq).join(","),
    );
    const factLines = tr.locator(".provenance-fact");
    await expect(factLines).toHaveCount(row.provenance.length);
    if (row.provenance.length === 0) {
      // The empty-provenance placeholder, exactly (round 3, finding 8).
      await expect(tr.locator(".provenance-empty")).toHaveText("no recorded facts in this context");
    } else {
      await expect(tr.locator(".provenance-empty")).toHaveCount(0);
    }
    for (let f = 0; f < row.provenance.length; f += 1) {
      // The WHOLE rendered line, exactly (round 2, finding 9: asserting only
      // seq/kind/actor let a corrupted reason/outcome pass). Mirrors app.js's
      // provenanceLine — the reason/outcome detail is part of the agreement.
      await expect(factLines.nth(f)).toHaveText(provenanceLineText(row.provenance[f]!));
    }
    await expect(tr.locator(".disposition-value")).toHaveText(row.disposition);
    if (row.dispositionRecord !== null) {
      await expect(tr).toHaveAttribute(
        "data-disposition-record-seq",
        String(row.dispositionRecord.seq),
      );
      await expect(tr).toHaveAttribute(
        "data-disposition-record-event",
        row.dispositionRecord.event,
      );
      await expect(tr.locator(".disposition-reason")).toHaveText(row.dispositionRecord.reason);
    } else {
      // No stray record attributes/lines when the row is open (round 2).
      await expect(tr).not.toHaveAttribute("data-disposition-record-seq", /.*/);
      await expect(tr).not.toHaveAttribute("data-disposition-record-event", /.*/);
      await expect(tr.locator(".disposition-reason")).toHaveCount(0);
    }
  }
}

/** The exact provenance line app.js renders, recomputed for agreement. */
function provenanceLineText(fact: GapRegisterRow["provenance"][number]): string {
  const payload = fact.payload as { reason?: unknown; outcome?: unknown };
  const detail =
    typeof payload.reason === "string"
      ? ` — ${payload.reason}`
      : typeof payload.outcome === "string"
        ? ` — ${payload.outcome}`
        : "";
  return `seq ${fact.seq} · ${fact.kind} · ${fact.actor}${detail}`;
}

async function act(page: Page, requirementId: string, button: string, reason: string) {
  const tr = rowFor(page, requirementId);
  await tr.locator(".action-reason").fill(reason);
  await tr.locator(`button.${button}`).click();
}

test.describe("gap register (seeded daemon)", () => {
  test("renders the CAM-CANON-05 quadruple as a table, in agreement with the ledger", async ({
    page,
  }) => {
    await openRegister(page);
    // Membership: accepted-family gaps only — delivered and merely-proposed
    // requirements are absent; the assumed requirement IS present.
    await expect(tableRows(page)).toHaveCount(5);
    await expect(rowFor(page, R_DELIVERED)).toHaveCount(0);
    await expect(rowFor(page, R_PROPOSED)).toHaveCount(0);
    // The assumed row shows its documented assumption (round 4, finding 4).
    await expect(rowFor(page, R_ASSUMED).locator(".requirement-assumption")).toHaveText(
      "assumption: assume UTC until a locale requirement is confirmed",
    );
    // Provenance is visible: the detector finding is cited on its row.
    await expect(rowFor(page, R_DETECTED).locator(".provenance-fact")).toContainText([/todo-scan/]);
    await expectTableMatchesLedger(page);
    // The count line reports the visible/total counts AND the exact asOf
    // sequences (round 3, finding 8): a stale/corrupted sequence must fail here.
    const total = projected().length;
    await expect(page.locator("#register-count")).toHaveText(
      `${total} of ${total} register rows shown (ledger seq ${ledger.lastSeq}, ` +
        `facts seq ${facts.read().at(-1)?.seq ?? 0}, dispositions seq ${dispositions.lastSeq})`,
    );
  });

  test("filters actually filter (asserted against independent expectations)", async ({ page }) => {
    await openRegister(page);
    const visibleIds = async (): Promise<string[]> =>
      tableRows(page).evaluateAll((trs) =>
        trs.map((tr) => (tr as HTMLElement).dataset["requirementId"] ?? ""),
      );

    // Implementation filter: exactly the projection's suspected-absent rows.
    await page.locator("#filter-implementation").selectOption("suspected-absent");
    expect(await visibleIds()).toEqual(
      projected()
        .filter((r) => r.tuple.implementation.kind === "suspected-absent")
        .map((r) => r.requirementId),
    );

    // Evidence filter composes with it: no row is both suspected and stale.
    await page.locator("#filter-evidence").selectOption("stale");
    expect(await visibleIds()).toEqual([]);
    await expect(page.locator("#register-empty")).toBeVisible();

    // Evidence filter alone: exactly the stale rows.
    await page.locator("#filter-implementation").selectOption("");
    expect(await visibleIds()).toEqual(
      projected()
        .filter((r) => r.tuple.evidence === "stale")
        .map((r) => r.requirementId),
    );

    // Text filter over id + statement.
    await page.locator("#filter-evidence").selectOption("");
    await page.locator("#filter-text").fill("audit column");
    expect(await visibleIds()).toEqual([R_DETECTED]);
    await page.locator("#filter-text").fill("cam-verif");
    expect(await visibleIds()).toEqual([R_STALE]);

    // Clearing restores the full projection.
    await page.locator("#filter-text").fill("");
    expect(await visibleIds()).toEqual(projected().map((r) => r.requirementId));
    await expectTableMatchesLedger(page);
  });

  test("waive controls exist ONLY on detector-backed rows (CAM-CANON-05, surface half)", async ({
    page,
  }) => {
    await openRegister(page);
    await expect(rowFor(page, R_DETECTED).locator("button.action-waive")).toHaveCount(1);
    for (const id of [R_REAL, R_UNVERIFIED, R_STALE]) {
      await expect(rowFor(page, id).locator("button.action-waive")).toHaveCount(0);
    }
  });

  test("the daemon refuses waiving a real unmet requirement even without the GUI (enforcement half)", async () => {
    const authed = { authorization: `Bearer ${TOKEN}` };
    const csrf = (
      (await (await fetch(`${daemon.url}/api/csrf`, { headers: authed })).json()) as {
        csrfToken: string;
      }
    ).csrfToken;
    const snapshot = (await (
      await fetch(`${daemon.url}/api/register`, { headers: authed })
    ).json()) as { asOf: unknown };
    const response = await fetch(`${daemon.url}/api/register/${R_REAL}/disposition`, {
      method: "POST",
      headers: { ...authed, "x-camino-csrf": csrf, "content-type": "application/json" },
      body: JSON.stringify({
        action: "false-positive-waived",
        reason: "forged waiver attempt",
        waivedThroughSeq: 1,
        asOf: snapshot.asOf,
      }),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; problem: string };
    expect(body.error).toBe("refused");
    expect(body.problem).toContain("detector false");
    expect(dispositions.read()).toHaveLength(0); // nothing recorded
  });

  test("disposition actions: queue a fix, filter by it, dispute, reopen — all recorded and re-projected", async ({
    page,
  }) => {
    await openRegister(page);

    await act(page, R_REAL, "action-fix-queued", "queueing the address-validation repair");
    await expect(rowFor(page, R_REAL)).toHaveAttribute("data-disposition", "fix-queued");
    expect(dispositions.read().at(-1)?.event).toBe("gap-fix-queued");
    await expectTableMatchesLedger(page);

    // The disposition filter works against the recorded action.
    await page.locator("#filter-disposition").selectOption("fix-queued");
    await expect(tableRows(page)).toHaveCount(1);
    await expect(tableRows(page).first()).toHaveAttribute("data-requirement-id", R_REAL);
    await page.locator("#filter-disposition").selectOption("");

    await act(page, R_UNVERIFIED, "action-disputed", "this landed; the probe is missing");
    await expect(rowFor(page, R_UNVERIFIED)).toHaveAttribute("data-disposition", "disputed");
    expect(dispositions.read().at(-1)?.event).toBe("gap-disputed");

    await act(page, R_UNVERIFIED, "action-reopened", "withdrawing the dispute");
    await expect(rowFor(page, R_UNVERIFIED)).toHaveAttribute("data-disposition", "open");
    expect(dispositions.read().at(-1)?.event).toBe("gap-reopened");
    await expectTableMatchesLedger(page);
  });

  test("waiving a detector false positive records the bound waiver", async ({ page }) => {
    await openRegister(page);
    await act(page, R_DETECTED, "action-waive", "stub is intentional scaffolding");
    await expect(rowFor(page, R_DETECTED)).toHaveAttribute(
      "data-disposition",
      "false-positive-waived",
    );
    const record = dispositions.read().at(-1)!;
    expect(record.event).toBe("gap-false-positive-waived");
    expect(record.payload["waivedThroughSeq"]).toBe(1);
    await expectTableMatchesLedger(page);
  });

  test("an action against a stale snapshot is refused, surfaced, and the table re-reads the ledger", async ({
    page,
  }) => {
    await openRegister(page);
    // The register advances AFTER the page rendered: a new detector
    // finding lands on the waived row (this also outdates the waiver —
    // basis binding — which the re-rendered table must show).
    facts.recordFact({
      requirementId: R_DETECTED,
      kind: "absence-suspected",
      actor: DETECTOR,
      payload: { contextKind: "main", reason: "todo-scan: a second, different stub" },
    });
    const before = dispositions.read().length;
    await act(page, R_REAL, "action-disputed", "acting on a stale render");
    await expect(page.locator("#message")).toContainText("advanced");
    expect(dispositions.read()).toHaveLength(before); // refused, nothing recorded
    // The GUI re-read the ledger projection — including the reopened
    // (no-longer-waived) detector row.
    await expect(rowFor(page, R_DETECTED)).toHaveAttribute("data-disposition", "open");
    await expectTableMatchesLedger(page);
  });

  test("descope is the user's path for a real unmet requirement and removes the row", async ({
    page,
  }) => {
    await openRegister(page);
    await act(page, R_REAL, "action-descope", "descoping address validation for v2");
    await expect(rowFor(page, R_REAL)).toHaveCount(0);
    expect(ledger.entry(R_REAL)?.disposition).toBe("descoped");
    await expectTableMatchesLedger(page);
  });

  test("ledger writes made outside the GUI appear on reload, still in agreement", async ({
    page,
  }) => {
    await openRegister(page);
    ledger.proposeRequirement("CAM-DEMO-06", {
      statement: "notifications respect quiet hours",
      sourceMissionId: "m2",
    });
    ledger.acceptRequirement("CAM-DEMO-06");
    await page.reload();
    await expect(page.locator("#register-controls")).toBeVisible();
    await expect(rowFor(page, "CAM-DEMO-06")).toHaveCount(1);
    await expectTableMatchesLedger(page);
  });
});

test.describe("gap register in a branch context (present-on rows)", () => {
  test("renders a present-on(branch) tuple and agrees with the ledger", async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), "camino-gui-register-branch-"));
    const bLedger = new CanonLedgerStore(join(dir, "canon-ledger.sqlite"));
    const bFacts = new CanonFactsStore(join(dir, "canon-facts.sqlite"));
    const bDispositions = new GapDispositionsStore(join(dir, "gap-dispositions.sqlite"));
    const BRANCH: StatusContext = {
      kind: "branch",
      branch: "mission/m1",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
    };
    bLedger.proposeRequirement("CAM-BR-01", { statement: "branch feature", sourceMissionId: "m1" });
    bLedger.acceptRequirement("CAM-BR-01");
    // Implementation present on the branch, not verified → present-on(branch).
    bFacts.recordFact({
      requirementId: "CAM-BR-01",
      kind: "implementation-recorded",
      actor: "camino:merge",
      payload: { branch: "mission/m1", sha: "a".repeat(40) },
    });
    const branchDaemon = await startDaemonServer({
      token: TOKEN,
      port: 0,
      guiRoot: GUI_ROOT,
      register: new RegisterService({
        canonLedger: bLedger,
        canonFacts: bFacts,
        gapDispositions: bDispositions,
        contextSource: { current: () => BRANCH },
      }),
    });
    try {
      await page.goto(`${branchDaemon.url}/#token=${TOKEN}`);
      await expect(page.locator("#register-controls")).toBeVisible();
      const row = page.locator('#register-rows tr[data-requirement-id="CAM-BR-01"]');
      await expect(row).toHaveAttribute("data-implementation", "present-on");
      await expect(row).toHaveAttribute("data-implementation-branch", "mission/m1");
      await expect(row.locator(".tuple-implementation")).toHaveText("present-on(mission/m1)");
      // Genuine full-row DOM agreement against the branch-context projection
      // (round 2, finding 9: the branch fixture previously checked only the
      // implementation tuple).
      const rows = projectGapRegister(
        bLedger.currentView(),
        bFacts.read(),
        bDispositions.read(),
        BRANCH,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tuple.implementation).toEqual({ kind: "present-on", branch: "mission/m1" });
      await expectTableMatchesLedger(page, rows);
    } finally {
      await branchDaemon.app.close();
      bDispositions.close();
      bFacts.close();
      bLedger.close();
    }
  });
});

test.describe("gap register without a repository context", () => {
  test("shows the honest unavailable state instead of an invented projection", async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), "camino-gui-register-bare-"));
    const bareLedger = new CanonLedgerStore(join(dir, "canon-ledger.sqlite"));
    const bareFacts = new CanonFactsStore(join(dir, "canon-facts.sqlite"));
    const bareDispositions = new GapDispositionsStore(join(dir, "gap-dispositions.sqlite"));
    const bare = await startDaemonServer({
      token: TOKEN,
      port: 0,
      guiRoot: GUI_ROOT,
      register: new RegisterService({
        canonLedger: bareLedger,
        canonFacts: bareFacts,
        gapDispositions: bareDispositions,
        contextSource: { current: () => null },
      }),
    });
    try {
      await page.goto(`${bare.url}/#token=${TOKEN}`);
      await expect(page.locator("#register-unavailable")).toBeVisible();
      await expect(page.locator("#register-controls")).toBeHidden();
    } finally {
      await bare.app.close();
      bareDispositions.close();
      bareFacts.close();
      bareLedger.close();
    }
  });
});
