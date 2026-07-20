/**
 * Canon rendering + freshness tests (WP-109, CAM-CANON-02 acceptance):
 * the rendered file carries a parseable rendered-at marker; freshness is
 * bound to the ACTUAL file body, not the marker alone (review round 1,
 * finding 3); the standalone intent-only fold triggers when
 * ledger-vs-text divergence exceeds 5 requirements or 7 days — strict
 * inequalities, boundary-walked both sides.
 */
import { describe, expect, it } from "vitest";
import type { LedgerEventName, LedgerEventRecord } from "@camino/shared";
import { foldLedgerView } from "./canon-intent.js";
import {
  STANDALONE_FOLD_AGE_DAYS,
  STANDALONE_FOLD_REQUIREMENT_THRESHOLD,
  canonFragment,
  computeCanonDivergence,
  parseCanonMarker,
  renderCanon,
  standaloneFoldRequired,
} from "./canon-render.js";
import { DAVID_ACTOR } from "./intent-lifecycle.js";

const T0 = "2026-07-01T00:00:00.000Z";

function rec(
  seq: number,
  requirementId: string,
  event: LedgerEventName,
  payload: Record<string, unknown>,
  recordedAt = T0,
): LedgerEventRecord {
  return { seq, requirementId, event, actor: DAVID_ACTOR, payload, recordedAt };
}

function proposeAndAccept(
  startSeq: number,
  id: string,
  statement: string,
  at = T0,
): LedgerEventRecord[] {
  return [
    rec(startSeq, id, "requirement-proposed", { statement, sourceMissionId: "m1" }, at),
    rec(startSeq + 1, id, "requirement-accepted", {}, at),
  ];
}

/** The faithful canon file for a ledger prefix — what a fold would have committed. */
function faithfulText(records: LedgerEventRecord[], ledgerSeq: number, renderedAt = T0): string {
  return renderCanon(foldLedgerView(records.filter((r) => r.seq <= ledgerSeq)), {
    ledgerSeq,
    renderedAt,
  });
}

const plusMs = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

describe("renderCanon (CAM-CANON-02: canon text = rendered projection of accepted intent)", () => {
  it("renders accepted intent with a parseable rendered-at marker", () => {
    const view = foldLedgerView([
      ...proposeAndAccept(1, "CAM-DEMO-02", "second"),
      ...proposeAndAccept(3, "CAM-DEMO-01", "first"),
    ]);
    const text = renderCanon(view, { ledgerSeq: 4, renderedAt: T0 });
    const marker = parseCanonMarker(text);
    expect(marker).toEqual({ ledgerSeq: 4, renderedAt: T0 });
    // Sorted by requirement id, statements verbatim.
    const first = text.indexOf("CAM-DEMO-01");
    const second = text.indexOf("CAM-DEMO-02");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(text).toContain("- **CAM-DEMO-01** — first");
  });

  it("is deterministic and independent of view insertion order", () => {
    const a = foldLedgerView([
      ...proposeAndAccept(1, "CAM-DEMO-01", "first"),
      ...proposeAndAccept(3, "CAM-DEMO-02", "second"),
    ]);
    const b = foldLedgerView([
      ...proposeAndAccept(1, "CAM-DEMO-02", "second"),
      ...proposeAndAccept(3, "CAM-DEMO-01", "first"),
    ]);
    const opts = { ledgerSeq: 4, renderedAt: T0 };
    expect(renderCanon(a, opts)).toBe(renderCanon(b, opts));
  });

  it("renders only accepted intent: proposed, never-accepted disputes, and descoped render nothing", () => {
    const view = foldLedgerView([
      rec(1, "CAM-DEMO-01", "requirement-proposed", { statement: "p", sourceMissionId: "m1" }),
      rec(2, "CAM-DEMO-02", "requirement-proposed", { statement: "d", sourceMissionId: "m1" }),
      rec(3, "CAM-DEMO-02", "requirement-disputed", { reason: "r", conflictWith: null }),
      ...proposeAndAccept(4, "CAM-DEMO-03", "gone"),
      rec(6, "CAM-DEMO-03", "requirement-descoped", { reason: "dropped" }),
    ]);
    const text = renderCanon(view, { ledgerSeq: 6, renderedAt: T0 });
    expect(text).not.toContain("CAM-DEMO-01");
    expect(text).not.toContain("CAM-DEMO-02");
    expect(text).not.toContain("CAM-DEMO-03");
    expect(text).toContain("_No accepted intent yet._");
  });

  it("renders assumed requirements with the signed-off assumption", () => {
    const view = foldLedgerView([
      rec(1, "CAM-DEMO-01", "requirement-proposed", { statement: "s", sourceMissionId: "m1" }),
      rec(2, "CAM-DEMO-01", "requirement-disputed", { reason: "unknowable", conflictWith: null }),
      rec(3, "CAM-DEMO-01", "dispute-assumed", { assumption: "legacy behavior intended" }),
    ]);
    const text = renderCanon(view, { ledgerSeq: 3, renderedAt: T0 });
    expect(text).toContain("- **CAM-DEMO-01** — s");
    expect(text).toContain("assumption (signed off): legacy behavior intended");
  });

  it("keeps a disputed-but-previously-accepted requirement visible as its last accepted text", () => {
    const view = foldLedgerView([
      ...proposeAndAccept(1, "CAM-DEMO-01", "the accepted text"),
      rec(3, "CAM-DEMO-01", "requirement-disputed", {
        reason: "new PRD conflicts",
        conflictWith: null,
      }),
    ]);
    const text = renderCanon(view, { ledgerSeq: 3, renderedAt: T0 });
    expect(text).toContain("- **CAM-DEMO-01** — the accepted text");
    expect(text).toContain("disputed — resolution pending");
  });

  it("renders a dispute answer's revised statement", () => {
    const view = foldLedgerView([
      ...proposeAndAccept(1, "CAM-DEMO-01", "old text"),
      rec(3, "CAM-DEMO-01", "requirement-disputed", { reason: "r", conflictWith: null }),
      rec(4, "CAM-DEMO-01", "dispute-resolved-accepted", {
        resolution: "revise",
        statement: "new text",
      }),
    ]);
    const text = renderCanon(view, { ledgerSeq: 4, renderedAt: T0 });
    expect(text).toContain("- **CAM-DEMO-01** — new text");
    expect(text).not.toContain("old text");
  });

  it("refuses caller bugs: bad timestamps (incl. impossible dates) and bad seqs", () => {
    const view = foldLedgerView([]);
    expect(() => renderCanon(view, { ledgerSeq: 0, renderedAt: "yesterday" })).toThrow(/ISO-8601/);
    expect(() =>
      renderCanon(view, { ledgerSeq: 0, renderedAt: "2026-02-30T00:00:00.000Z" }),
    ).toThrow(/ISO-8601/);
    expect(() => renderCanon(view, { ledgerSeq: -1, renderedAt: T0 })).toThrow(/non-negative/);
    expect(() => renderCanon(view, { ledgerSeq: 1.5, renderedAt: T0 })).toThrow(
      /non-negative integer/,
    );
  });
});

describe("parseCanonMarker", () => {
  it("returns null for text with no marker", () => {
    expect(parseCanonMarker("# Living Canon\n\nno marker here\n")).toBeNull();
  });

  it("returns null for text with two markers (ambiguous)", () => {
    const line = `<!-- camino:canon rendered-at=${T0} ledger-seq=1 -->`;
    expect(parseCanonMarker(`${line}\n${line}\n`)).toBeNull();
  });

  it("ignores malformed markers (bad date, impossible date, bad seq, wrong shape)", () => {
    for (const badLine of [
      "<!-- camino:canon rendered-at=2026-07-01 ledger-seq=1 -->",
      `<!-- camino:canon rendered-at=${T0} ledger-seq=01 -->`,
      `<!-- camino:canon rendered-at=${T0} ledger-seq=-1 -->`,
      `<!-- camino:canon rendered-at=2026-02-30T00:00:00.000Z ledger-seq=1 -->`,
      `<!--camino:canon rendered-at=${T0} ledger-seq=1-->`,
    ]) {
      expect(parseCanonMarker(`${badLine}\n`), badLine).toBeNull();
    }
  });

  it("parses CRLF text (line endings normalized, finding 11)", () => {
    const text = renderCanon(foldLedgerView([]), { ledgerSeq: 3, renderedAt: T0 });
    const crlf = text.replace(/\n/g, "\r\n");
    expect(parseCanonMarker(crlf)).toEqual({ ledgerSeq: 3, renderedAt: T0 });
  });

  it("round-trips through renderCanon output", () => {
    const text = renderCanon(foldLedgerView([]), { ledgerSeq: 42, renderedAt: T0 });
    expect(parseCanonMarker(text)).toEqual({ ledgerSeq: 42, renderedAt: T0 });
  });
});

describe("computeCanonDivergence + standaloneFoldRequired (registry item 17)", () => {
  it("a faithful, current file: zero divergence, no defect, no fold at any age", () => {
    const records = proposeAndAccept(1, "CAM-DEMO-01", "s");
    const divergence = computeCanonDivergence(records, faithfulText(records, 2));
    expect(divergence).toEqual({
      divergedRequirementIds: [],
      oldestDivergenceAt: null,
      freshnessDefect: null,
    });
    expect(standaloneFoldRequired(divergence, plusMs(T0, 30 * DAY))).toEqual({
      required: false,
      reason: null,
    });
  });

  it("an edited body behind a current marker is NOT fresh (finding 3)", () => {
    const records = proposeAndAccept(1, "CAM-DEMO-01", "the real accepted text");
    const genuine = faithfulText(records, 2);
    const hostile = genuine.replace("the real accepted text", "replacement content");
    const divergence = computeCanonDivergence(records, hostile);
    expect(divergence.freshnessDefect).toBe("body-mismatch");
    expect(divergence.divergedRequirementIds).toEqual(["CAM-DEMO-01"]);
    expect(standaloneFoldRequired(divergence, plusMs(T0, 8 * DAY)).required).toBe(true);
  });

  it("a truncated body behind a current marker is NOT fresh", () => {
    const records = [
      ...proposeAndAccept(1, "CAM-DEMO-01", "one"),
      ...proposeAndAccept(3, "CAM-DEMO-02", "two"),
    ];
    const genuine = faithfulText(records, 4);
    const truncated = genuine.split("\n").slice(0, -2).join("\n");
    expect(computeCanonDivergence(records, truncated).freshnessDefect).toBe("body-mismatch");
  });

  it("CRLF conversion alone is NOT divergence (finding 11)", () => {
    const records = proposeAndAccept(1, "CAM-DEMO-01", "s");
    const crlf = faithfulText(records, 2).replace(/\n/g, "\r\n");
    const divergence = computeCanonDivergence(records, crlf);
    expect(divergence).toEqual({
      divergedRequirementIds: [],
      oldestDivergenceAt: null,
      freshnessDefect: null,
    });
  });

  it("a marker-shaped line smuggled into the body fails faithfulness, not the parser", () => {
    const records = proposeAndAccept(1, "CAM-DEMO-01", "s");
    const genuine = faithfulText(records, 2);
    // Append a fenced block containing a second marker-shaped line: the
    // parser sees two markers → no-marker defect, conservative.
    const smuggled = `${genuine}\n\`\`\`\n<!-- camino:canon rendered-at=${T0} ledger-seq=99 -->\n\`\`\`\n`;
    const divergence = computeCanonDivergence(records, smuggled);
    expect(divergence.freshnessDefect).toBe("no-marker");
    expect(divergence.divergedRequirementIds).toEqual(["CAM-DEMO-01"]);
  });

  it("proposal-only movement does not start the divergence clock (nothing renderable changed)", () => {
    const records = [
      ...proposeAndAccept(1, "CAM-DEMO-01", "s"),
      rec(
        3,
        "CAM-DEMO-02",
        "requirement-proposed",
        { statement: "p", sourceMissionId: "m1" },
        plusMs(T0, DAY),
      ),
    ];
    const divergence = computeCanonDivergence(records, faithfulText(records.slice(0, 2), 2));
    expect(divergence.freshnessDefect).toBeNull();
    expect(divergence.divergedRequirementIds).toEqual([]);
  });

  it("counts newly accepted requirements; exactly the threshold does NOT trigger, one more does", () => {
    const base = proposeAndAccept(1, "CAM-DEMO-00", "base");
    const canon = faithfulText(base, 2);
    const accepted = (n: number): LedgerEventRecord[] => {
      const out: LedgerEventRecord[] = [...base];
      for (let i = 1; i <= n; i += 1) {
        out.push(
          ...proposeAndAccept(
            1 + 2 * i,
            `CAM-DEMO-${String(i).padStart(2, "0")}`,
            `s${i}`,
            plusMs(T0, i),
          ),
        );
      }
      return out;
    };
    const atThreshold = computeCanonDivergence(
      accepted(STANDALONE_FOLD_REQUIREMENT_THRESHOLD),
      canon,
    );
    expect(atThreshold.freshnessDefect).toBeNull();
    expect(atThreshold.divergedRequirementIds).toHaveLength(5);
    expect(standaloneFoldRequired(atThreshold, plusMs(T0, DAY)).required).toBe(false);

    const overThreshold = computeCanonDivergence(
      accepted(STANDALONE_FOLD_REQUIREMENT_THRESHOLD + 1),
      canon,
    );
    expect(overThreshold.divergedRequirementIds).toHaveLength(6);
    expect(standaloneFoldRequired(overThreshold, plusMs(T0, DAY))).toEqual({
      required: true,
      reason: "requirement-count",
    });
  });

  it("age trigger: exactly 7 days does NOT trigger, 7 days + 1ms does", () => {
    const changedAt = plusMs(T0, DAY);
    const records = [
      ...proposeAndAccept(1, "CAM-DEMO-01", "s"),
      ...proposeAndAccept(3, "CAM-DEMO-02", "later", changedAt),
    ];
    const divergence = computeCanonDivergence(records, faithfulText(records.slice(0, 2), 2));
    expect(divergence.divergedRequirementIds).toEqual(["CAM-DEMO-02"]);
    expect(divergence.oldestDivergenceAt).toBe(changedAt);

    const atBoundary = plusMs(changedAt, STANDALONE_FOLD_AGE_DAYS * DAY);
    expect(standaloneFoldRequired(divergence, atBoundary).required).toBe(false);
    expect(standaloneFoldRequired(divergence, plusMs(atBoundary, 1))).toEqual({
      required: true,
      reason: "age",
    });
  });

  it("a descope of rendered text is divergence (removal must fold too)", () => {
    const records = [
      ...proposeAndAccept(1, "CAM-DEMO-01", "s"),
      rec(3, "CAM-DEMO-01", "requirement-descoped", { reason: "dropped" }, plusMs(T0, DAY)),
    ];
    const divergence = computeCanonDivergence(records, faithfulText(records.slice(0, 2), 2));
    expect(divergence.divergedRequirementIds).toEqual(["CAM-DEMO-01"]);
  });

  it("a change that changes back is NOT divergence (the file still renders current intent)", () => {
    const records = [
      ...proposeAndAccept(1, "CAM-DEMO-01", "s"),
      rec(
        3,
        "CAM-DEMO-01",
        "requirement-disputed",
        { reason: "r", conflictWith: null },
        plusMs(T0, DAY),
      ),
      rec(
        4,
        "CAM-DEMO-01",
        "dispute-resolved-accepted",
        { resolution: "as written" },
        plusMs(T0, 2 * DAY),
      ),
    ];
    const divergence = computeCanonDivergence(records, faithfulText(records.slice(0, 2), 2));
    // disputed rendered differently for a while, but the resolution
    // restored the exact accepted fragment — nothing to fold now.
    expect(divergence.divergedRequirementIds).toEqual([]);
    expect(divergence.oldestDivergenceAt).toBeNull();
  });

  it("dispute WITHOUT resolution IS divergence (the disputed marker belongs in the text)", () => {
    const records = [
      ...proposeAndAccept(1, "CAM-DEMO-01", "s"),
      rec(
        3,
        "CAM-DEMO-01",
        "requirement-disputed",
        { reason: "r", conflictWith: null },
        plusMs(T0, DAY),
      ),
    ];
    const divergence = computeCanonDivergence(records, faithfulText(records.slice(0, 2), 2));
    expect(divergence.divergedRequirementIds).toEqual(["CAM-DEMO-01"]);
  });

  it("no marker: freshness cannot be proven — full conservative divergence", () => {
    const records = proposeAndAccept(1, "CAM-DEMO-01", "s");
    const divergence = computeCanonDivergence(records, "# some hand-written canon\n");
    expect(divergence.freshnessDefect).toBe("no-marker");
    expect(divergence.divergedRequirementIds).toEqual(["CAM-DEMO-01"]);
    expect(divergence.oldestDivergenceAt).toBe(T0);
  });

  it("a marker claiming a seq this ledger has not reached is a foreign marker", () => {
    const records = proposeAndAccept(1, "CAM-DEMO-01", "s");
    const foreign = renderCanon(foldLedgerView(records), { ledgerSeq: 99, renderedAt: T0 });
    const divergence = computeCanonDivergence(records, foreign);
    expect(divergence.freshnessDefect).toBe("foreign-marker");
    expect(divergence.divergedRequirementIds).toEqual(["CAM-DEMO-01"]);
  });

  it("an empty ledger with unprovable freshness has nothing to fold", () => {
    const divergence = computeCanonDivergence([], "no marker at all\n");
    expect(divergence.divergedRequirementIds).toEqual([]);
    expect(divergence.freshnessDefect).toBe("no-marker");
    expect(standaloneFoldRequired(divergence, T0).required).toBe(false);
  });

  it("standaloneFoldRequired refuses malformed timestamps (caller bug)", () => {
    expect(() =>
      standaloneFoldRequired(
        { divergedRequirementIds: [], oldestDivergenceAt: null, freshnessDefect: null },
        "not-a-time",
      ),
    ).toThrow(/ISO-8601/);
  });
});

describe("canonFragment (the divergence comparison unit)", () => {
  it("is empty exactly for non-renderable dispositions", () => {
    const view = foldLedgerView([
      rec(1, "CAM-DEMO-01", "requirement-proposed", { statement: "p", sourceMissionId: "m1" }),
    ]);
    const entry = view.get("CAM-DEMO-01");
    expect(entry).toBeDefined();
    if (entry !== undefined) expect(canonFragment(entry)).toBe("");
  });
});
