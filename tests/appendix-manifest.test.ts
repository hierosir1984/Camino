/**
 * Independent coverage anchor (WP-101 review rounds 1–2): the machines' row
 * refs are checked against the PRD's own Appendix A tables, parsed
 * STRUCTURALLY from docs/PRD.md at test time — the contiguous markdown
 * table of each section (header + separator + data rows, column count
 * validated), not a loose count of pipe-prefixed lines. Beyond row counts,
 * each appendix row's FROM column is pinned against the code row(s)
 * encoding it: single-state rows must name their source state in the cell,
 * "any active"/"any terminal" rows must have the full active/terminal
 * from-set in code, and creation rows must be "—". Deleting, reordering, or
 * re-sourcing a row on either side now breaks against the PRD text itself.
 *
 * Encoding conventions this test understands (audit doc §1):
 * - "A.1#3a"/"A.1#3b" are guard-splits of appendix row A.1#3 — refs map to
 *   appendix rows by stripping the letter suffix; splits share the row's
 *   from-set (asserted here).
 * - The quick machine carries its inherited A.1 rows under their A.1 refs;
 *   the exact inherited set is pinned (A.1b preamble list) and their
 *   sources are pinned against the A.1 table.
 * - A.2#18 (the mission-level fast-subset row) is not a transition of an
 *   existing issue; it is encoded as creation row A.2#1c. It is the single
 *   allowed gap, and its cell must say "(mission-level)".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ATTEMPT_TERMINAL_STATES,
  attemptMachine,
  ISSUE_ACTIVE_STATES,
  issueMachine,
  MISSION_ACTIVE_STATES,
  missionIntegrationMachine,
  missionQuickTaskMachine,
} from "@camino/core";

const PRD = readFileSync(join("docs", "PRD.md"), "utf8");

interface ParsedRow {
  /** 1-based position in the appendix table. */
  readonly number: number;
  /** Verbatim text of the row's From column. */
  readonly fromCell: string;
}

/**
 * Parse the single contiguous markdown table of one appendix section:
 * header row, |---| separator, then data rows until the first non-table
 * line. Every data row must carry the header's column count.
 */
function parseAppendixTable(sectionStart: string, sectionEnd: string): ParsedRow[] {
  const start = PRD.indexOf(sectionStart);
  const end = PRD.indexOf(sectionEnd);
  expect(start, `PRD section ${JSON.stringify(sectionStart)} must exist`).toBeGreaterThan(-1);
  expect(end, `PRD section ${JSON.stringify(sectionEnd)} must exist`).toBeGreaterThan(start);
  const lines = PRD.slice(start, end).split("\n");

  const columnsOf = (line: string): string[] => {
    // Escaped pipes inside cells must not split columns.
    const ESCAPED_PIPE = "\u0000";
    const cells = line.replaceAll("\\|", ESCAPED_PIPE).split("|");
    // A well-formed table line is "| a | b | … |": first and last split
    // pieces are empty borders.
    expect(cells.length, `table line must be pipe-bordered: ${line}`).toBeGreaterThan(2);
    expect(cells[0]?.trim()).toBe("");
    expect(cells[cells.length - 1]?.trim()).toBe("");
    return cells.slice(1, -1).map((cell) => cell.replaceAll(ESCAPED_PIPE, "\\|").trim());
  };

  const headerIndex = lines.findIndex((line) => line.trimStart().startsWith("|"));
  expect(headerIndex, "section must contain a table").toBeGreaterThan(-1);
  const header = columnsOf(lines[headerIndex] as string);
  expect(header, "Appendix A tables carry the normative four columns").toEqual([
    "From",
    "Event",
    "Guard",
    "To",
  ]);
  const separator = columnsOf(lines[headerIndex + 1] as string);
  expect(
    separator.every((cell) => /^-+$/.test(cell)),
    "second table line must be the |---| separator",
  ).toBe(true);

  const rows: ParsedRow[] = [];
  for (let i = headerIndex + 2; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (!line.trimStart().startsWith("|")) break; // end of the contiguous table
    const columns = columnsOf(line);
    expect(columns.length, `data row must have ${header.length} columns: ${line}`).toBe(
      header.length,
    );
    rows.push({ number: rows.length + 1, fromCell: columns[0] as string });
  }
  return rows;
}

interface RowGroup {
  readonly number: number;
  /** The shared from-set across the row's guard splits (null = creation). */
  readonly from: readonly string[] | null;
}

/** Group a machine's code rows by appendix row number for one exact table. */
function encodedRowGroups(
  machine: { rows: readonly { ref: string; from: readonly string[] | null }[] },
  table: string,
): Map<number, RowGroup> {
  const pattern = new RegExp(`^${table.replaceAll(".", "\\.")}#(\\d+)[a-z]?$`);
  const groups = new Map<number, RowGroup>();
  for (const row of machine.rows) {
    const match = pattern.exec(row.ref);
    if (!match) continue;
    const number = Number(match[1]);
    const existing = groups.get(number);
    if (existing) {
      // Guard splits of one appendix row must share its from-set — except
      // A.1#21, whose disjunctive event column maps its two sources onto
      // split rows (audit §2); their union is checked by the caller.
      const union = new Set([...(existing.from ?? []), ...(row.from ?? [])]);
      groups.set(number, {
        number,
        from: existing.from === null && row.from === null ? null : [...union],
      });
    } else {
      groups.set(number, { number, from: row.from });
    }
  }
  return groups;
}

/**
 * Assert one appendix row's From cell matches its code from-set EXACTLY:
 * the cell's backtick-quoted state tokens, as a set, must equal the union
 * of the code splits' sources (substring matching would accept e.g.
 * `unplanned` for planned — review round 3). "Any active"/"any terminal"
 * cells carry no backticked states and map to the full set. Which SPLIT of
 * a multi-source appendix row owns which source (A.1#21a vs #21b) is not
 * derivable from the table text — that assignment is pinned by the
 * per-split transition vectors, not here.
 */
function expectFromCellMatches(
  table: string,
  parsed: ParsedRow,
  group: RowGroup,
  anyActive: { states: readonly string[]; text: string },
): void {
  const label = `${table}#${parsed.number} from-cell ${JSON.stringify(parsed.fromCell)}`;
  if (group.from === null) {
    expect(parsed.fromCell, `${label} must be a creation row`).toBe("—");
    return;
  }
  const unique = [...new Set(group.from)].sort();
  const fullSet = [...anyActive.states].sort();
  if (parsed.fromCell.includes(anyActive.text)) {
    // "any active"/"any terminal": the code sources must be EXACTLY the full
    // set — unique, none missing, none extra (cardinality alone would let a
    // duplicated-entry row hide a missing state; review round 4).
    expect(unique, `${label} must cover exactly the ${anyActive.text} set`).toEqual(fullSet);
    return;
  }
  const cellTokens = [...parsed.fromCell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string).sort();
  expect(cellTokens, `${label} must name exactly the code sources`).toEqual(unique);
}

describe("Appendix A manifest (structurally parsed from docs/PRD.md)", () => {
  const A1 = parseAppendixTable("### A.1 Mission", "### A.1b Quick task");
  const A1B = parseAppendixTable("### A.1b Quick task", "### A.2 Issue");
  const A2 = parseAppendixTable("### A.2 Issue", "### A.3 Attempt");
  const A3 = parseAppendixTable("### A.3 Attempt", "### A.4 Ordering");

  it("A.1: the integration machine encodes exactly the 24 parsed rows, sources matching", () => {
    expect(A1).toHaveLength(24);
    const groups = encodedRowGroups(missionIntegrationMachine, "A.1");
    expect([...groups.keys()].sort((a, b) => a - b)).toEqual(A1.map((r) => r.number));
    for (const parsed of A1) {
      expectFromCellMatches("A.1", parsed, groups.get(parsed.number) as RowGroup, {
        states: MISSION_ACTIVE_STATES,
        text: "any active",
      });
    }
  });

  it("A.1b: the quick machine encodes the 12 parsed rows plus exactly the inherited A.1 set", () => {
    expect(A1B).toHaveLength(12);
    const own = encodedRowGroups(missionQuickTaskMachine, "A.1b");
    expect([...own.keys()].sort((a, b) => a - b)).toEqual(A1B.map((r) => r.number));
    for (const parsed of A1B) {
      expectFromCellMatches("A.1b", parsed, own.get(parsed.number) as RowGroup, {
        states: MISSION_ACTIVE_STATES,
        text: "any active",
      });
    }
    // The A.1b preamble inherits: plan rejection (#4), queued (#5), manual
    // pause/resume (#16/#17), escalated/blocked entries and recovery
    // (#18/#19/#21), and abandonment (#24) — sources pinned to the A.1 table.
    const inherited = encodedRowGroups(missionQuickTaskMachine, "A.1");
    expect([...inherited.keys()].sort((a, b) => a - b)).toEqual([4, 5, 16, 17, 18, 19, 21, 24]);
    for (const [number, group] of inherited) {
      expectFromCellMatches("A.1", A1[number - 1] as ParsedRow, group, {
        states: MISSION_ACTIVE_STATES,
        text: "any active",
      });
    }
  });

  it("A.2: the issue machine encodes the 24 parsed rows except the mission-level #18, sources matching", () => {
    expect(A2).toHaveLength(24);
    const groups = encodedRowGroups(issueMachine, "A.2");
    expect([...groups.keys()].sort((a, b) => a - b)).toEqual(
      A2.map((r) => r.number).filter((n) => n !== 18),
    );
    expect(
      (A2[17] as ParsedRow).fromCell,
      "the single allowed gap is the mission-level fast-subset row",
    ).toContain("mission-level");
    // Its encoding lives on the repair-creation split of row #1.
    expect(issueMachine.rows.some((row) => row.ref === "A.2#1c")).toBe(true);
    for (const parsed of A2) {
      if (parsed.number === 18) continue;
      expectFromCellMatches("A.2", parsed, groups.get(parsed.number) as RowGroup, {
        states: ISSUE_ACTIVE_STATES,
        text: "any active",
      });
    }
  });

  it("A.3: the attempt machine encodes exactly the 8 parsed rows, sources matching", () => {
    expect(A3).toHaveLength(8);
    const groups = encodedRowGroups(attemptMachine, "A.3");
    expect([...groups.keys()].sort((a, b) => a - b)).toEqual(A3.map((r) => r.number));
    for (const parsed of A3) {
      expectFromCellMatches("A.3", parsed, groups.get(parsed.number) as RowGroup, {
        states: ATTEMPT_TERMINAL_STATES,
        text: "any terminal",
      });
    }
  });
});
