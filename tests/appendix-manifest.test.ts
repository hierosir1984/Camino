/**
 * Independent coverage anchor (WP-101 review round 1, finding 12): the
 * machines' row refs are checked against the PRD's own Appendix A tables,
 * parsed from docs/PRD.md at test time — not against a second hand-authored
 * list living next to the code. Deleting a row from a machine (or adding an
 * invented one) now breaks against the PRD text itself, closing the
 * both-sides-drift loophole in the core coverage harness.
 *
 * Encoding conventions this test understands (audit doc §1):
 * - "A.1#3a"/"A.1#3b" are guard-splits of appendix row A.1#3 — refs map to
 *   appendix rows by stripping the letter suffix.
 * - The quick machine carries its inherited A.1 rows under their A.1 refs;
 *   the exact inherited set is pinned here (A.1b preamble list).
 * - A.2#18 (the mission-level fast-subset row) is not a transition of an
 *   existing issue; it is encoded as creation row A.2#1c. It is the single
 *   allowed gap, asserted explicitly.
 * - A.3 has 8 table rows; the archival row is A.3#8 (also A.4#5).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attemptMachine,
  issueMachine,
  missionIntegrationMachine,
  missionQuickTaskMachine,
} from "@camino/core";

const PRD = readFileSync(join("docs", "PRD.md"), "utf8");

/** Count the data rows of the markdown table inside one appendix section. */
function appendixTableRowCount(sectionStart: string, sectionEnd: string): number {
  const start = PRD.indexOf(sectionStart);
  const end = PRD.indexOf(sectionEnd);
  expect(start, `PRD section ${JSON.stringify(sectionStart)} must exist`).toBeGreaterThan(-1);
  expect(end, `PRD section ${JSON.stringify(sectionEnd)} must exist`).toBeGreaterThan(start);
  const section = PRD.slice(start, end);
  const tableLines = section.split("\n").filter((line) => line.trimStart().startsWith("|"));
  // Drop the header row and the |---| separator row.
  expect(tableLines.length, "section must contain a table with header + separator").toBeGreaterThan(
    2,
  );
  return tableLines.length - 2;
}

/** Distinct appendix row numbers a machine encodes for one exact table name. */
function encodedRowNumbers(
  machine: { rows: readonly { ref: string }[] },
  table: string,
): Set<number> {
  // Anchored per table so "A.1" never swallows "A.1b" refs.
  const pattern = new RegExp(`^${table.replaceAll(".", "\\.")}#(\\d+)[a-z]?$`);
  const numbers = new Set<number>();
  for (const row of machine.rows) {
    const match = pattern.exec(row.ref);
    if (match) numbers.add(Number(match[1]));
  }
  return numbers;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

describe("Appendix A manifest (parsed from docs/PRD.md)", () => {
  it("A.1: the integration machine encodes exactly the 24 parsed table rows", () => {
    const parsed = appendixTableRowCount("### A.1 Mission", "### A.1b Quick task");
    expect(parsed).toBe(24);
    const encoded = encodedRowNumbers(missionIntegrationMachine, "A.1");
    expect([...encoded].sort((a, b) => a - b)).toEqual(range(1, parsed));
  });

  it("A.1b: the quick machine encodes the 12 parsed rows plus exactly the inherited A.1 set", () => {
    const parsed = appendixTableRowCount("### A.1b Quick task", "### A.2 Issue");
    expect(parsed).toBe(12);
    const own = encodedRowNumbers(missionQuickTaskMachine, "A.1b");
    expect([...own].sort((a, b) => a - b)).toEqual(range(1, parsed));
    // The A.1b preamble inherits: plan rejection (#4), queued (#5), manual
    // pause/resume (#16/#17), escalated/blocked entries and recovery
    // (#18/#19/#21), and abandonment (#24).
    const inherited = encodedRowNumbers(missionQuickTaskMachine, "A.1");
    expect([...inherited].sort((a, b) => a - b)).toEqual([4, 5, 16, 17, 18, 19, 21, 24]);
  });

  it("A.2: the issue machine encodes the 24 parsed rows except the mission-level #18 (encoded as creation #1c)", () => {
    const parsed = appendixTableRowCount("### A.2 Issue", "### A.3 Attempt");
    expect(parsed).toBe(24);
    const encoded = encodedRowNumbers(issueMachine, "A.2");
    const expected = range(1, parsed).filter((n) => n !== 18);
    expect([...encoded].sort((a, b) => a - b)).toEqual(expected);
    // The #18 encoding lives on the repair-creation split of row #1.
    expect(issueMachine.rows.some((row) => row.ref === "A.2#1c")).toBe(true);
  });

  it("A.3: the attempt machine encodes exactly the 8 parsed rows", () => {
    const parsed = appendixTableRowCount("### A.3 Attempt", "### A.4 Ordering");
    expect(parsed).toBe(8);
    const encoded = encodedRowNumbers(attemptMachine, "A.3");
    expect([...encoded].sort((a, b) => a - b)).toEqual(range(1, parsed));
  });
});
