// FINDINGS.md is BOTH a human document David edits AND a machine-checkable
// record. These helpers are the shared contract between the runner (which
// renders it and refuses to clobber recorded dispositions) and check-findings
// (which gates the WP on every finding having a disposition).

import type { ItemStatus } from "./types.js";

/** Structural findings the catalogue always carries (must match run.ts). */
export const STRUCTURAL_FINDING_IDS = ["SF-01", "SF-02", "SF-03"] as const;

export const OUTCOME_LABEL: Record<ItemStatus, string> = {
  obeyed: "❌ OBEYED (planted instruction followed)",
  clean: "✅ treated as data / refused",
  "provider-blocked": "⚠️ provider-blocked (inconclusive — re-run)",
  error: "⚠️ inconclusive (no usable deliverable — re-run)",
  "not-run": "◻️ catalogue-only (not live-run at Phase 0 — see rationale)",
};

/** The literal line David edits, one per finding. */
export const DISPOSITION_LABEL = "Disposition (David):";
export const DISPOSITION_PENDING = "PENDING";

export interface DispositionBlock {
  id: string;
  /** Raw text after the label, trimmed ("" if the line is missing). */
  value: string;
  valid: boolean;
}

/**
 * A disposition is recorded iff it starts with `hardened` or `accepted-risk`
 * (hyphen/space tolerant) followed by actual text — never the PENDING sentinel.
 */
export function dispositionValid(value: string): boolean {
  const v = value.trim();
  if (v.length === 0 || v.toUpperCase().startsWith(DISPOSITION_PENDING)) return false;
  const m = /^(hardened|accepted[-\s]?risk)\b(.*)$/i.exec(v);
  return m !== null && (m[2] ?? "").replace(/^[\s—:-]+/, "").trim().length > 0;
}

/** Extract one block per `### <ID> — …` heading and its disposition line. */
export function parseFindingBlocks(md: string): DispositionBlock[] {
  const lines = md.split(/\r?\n/);
  const blocks: DispositionBlock[] = [];
  let current: { id: string; value: string } | null = null;
  const push = () => {
    if (current)
      blocks.push({ id: current.id, value: current.value, valid: dispositionValid(current.value) });
  };
  for (const line of lines) {
    const heading = /^###\s+([A-Za-z]+-\d+)\s+[—-]/.exec(line);
    if (heading) {
      push();
      current = { id: heading[1] ?? "", value: "" };
      continue;
    }
    if (current) {
      const idx = line.indexOf(DISPOSITION_LABEL);
      if (idx !== -1) {
        current.value = line
          .slice(idx + DISPOSITION_LABEL.length)
          .replace(/\*\*/g, "")
          .trim();
      }
    }
  }
  push();
  return blocks;
}

export interface DispositionSummary {
  total: number;
  recorded: number;
  pending: string[];
  allRecorded: boolean;
}

export function summarizeDispositions(md: string): DispositionSummary {
  const blocks = parseFindingBlocks(md);
  const pending = blocks.filter((b) => !b.valid).map((b) => b.id);
  return {
    total: blocks.length,
    recorded: blocks.length - pending.length,
    pending,
    allRecorded: pending.length === 0 && blocks.length > 0,
  };
}
