/**
 * Canon text rendering and freshness (WP-109, CAM-CANON-02): canon text
 * in the repo is the RENDERED PROJECTION of accepted intent — a pure
 * function of the ledger view, carrying a rendered-at marker naming the
 * ledger seq it rendered. Folds riding mission PRs call `renderCanon`
 * and commit the output; the divergence functions decide when a
 * STANDALONE intent-only fold must happen instead of waiting for the
 * next mission (registry item 17: >5 requirements or >7 days).
 *
 * BY CONSTRUCTION (CAM-CANON-01 leg): `renderCanon` takes ONLY the
 * ledger view — there is no parameter through which a merge, revert, or
 * abandonment could influence the rendered intent. Reverting a fold
 * commit deletes a RENDERING; the next fold re-renders the same intent
 * from the ledger (design §3.1: accepted-but-unbuilt requirements cannot
 * be stranded or silently deleted).
 *
 * The renderer is deterministic byte-for-byte for a given (view,
 * renderedAt, ledgerSeq): requirements sort by id, timestamps are
 * caller-supplied (core stays clock-free), and the marker is a single
 * machine-parseable line.
 */
import type { LedgerEventRecord } from "@camino/shared";
import { ACCEPTED_FAMILY } from "@camino/shared";
import { applyLedgerRecord, foldLedgerView } from "./canon-intent.js";
import type { LedgerView, LedgerViewEntry } from "./canon-intent.js";

/** CAM-CANON-02 verbatim: divergence exceeding five requirements triggers a standalone fold. */
export const STANDALONE_FOLD_REQUIREMENT_THRESHOLD = 5;
/** CAM-CANON-02 verbatim: divergence older than seven days triggers a standalone fold. */
export const STANDALONE_FOLD_AGE_DAYS = 7;

/** Exactly the form `Date.prototype.toISOString` produces — the only timestamp form stores write. */
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const MARKER_LINE_PATTERN =
  /^<!-- camino:canon rendered-at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) ledger-seq=(0|[1-9]\d*) -->$/;

export interface CanonMarker {
  /** The highest ledger seq the rendering reflects. */
  readonly ledgerSeq: number;
  /** When the rendering was produced (ISO-8601 UTC). */
  readonly renderedAt: string;
}

export interface RenderCanonOptions {
  readonly ledgerSeq: number;
  readonly renderedAt: string;
}

function assertIsoUtc(field: string, value: string): void {
  if (!ISO_UTC_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(
      `${field} must be an ISO-8601 UTC timestamp (toISOString form), got ${JSON.stringify(value)}`,
    );
  }
}

/**
 * The per-requirement rendered fragment — the unit of divergence
 * comparison. Empty string = the requirement does not appear in canon
 * text. Renders:
 *  - accepted-family dispositions: the statement (plus the signed-off
 *    assumption for `assumed`);
 *  - `disputed` with a previously accepted statement: the LAST ACCEPTED
 *    text, marked as disputed — the pending question has not changed
 *    intent yet (CAM-CANON-01), so canon carries what the user last
 *    accepted rather than silently dropping it;
 *  - everything else (proposed, never-accepted disputed, descoped):
 *    nothing.
 */
export function canonFragment(entry: LedgerViewEntry): string {
  if ((ACCEPTED_FAMILY as readonly string[]).includes(entry.disposition)) {
    const lines = [`- **${entry.requirementId}** — ${entry.statement}`];
    if (entry.disposition === "assumed" && entry.assumption !== null) {
      lines.push(`  - assumption (signed off): ${entry.assumption}`);
    }
    return `${lines.join("\n")}\n`;
  }
  if (entry.disposition === "disputed" && entry.acceptedStatement !== null) {
    return (
      `- **${entry.requirementId}** — ${entry.acceptedStatement}\n` +
      `  - disputed — resolution pending; this is the last user-accepted text\n`
    );
  }
  return "";
}

/** Render the canon file content for a ledger view. Deterministic; throws only on caller bugs. */
export function renderCanon(view: LedgerView, options: RenderCanonOptions): string {
  assertIsoUtc("renderedAt", options.renderedAt);
  if (!Number.isInteger(options.ledgerSeq) || options.ledgerSeq < 0) {
    throw new Error(
      `ledgerSeq must be a non-negative integer, got ${JSON.stringify(options.ledgerSeq)}`,
    );
  }
  const header =
    `# Living Canon\n\n` +
    `<!-- camino:canon rendered-at=${options.renderedAt} ledger-seq=${options.ledgerSeq} -->\n\n` +
    `This file is the rendered projection of accepted intent (CAM-CANON-02).\n` +
    `The intent ledger in the control plane is authoritative; editing this\n` +
    `file never changes intent (CAM-CANON-01).\n\n` +
    `## Accepted intent\n\n`;
  const fragments = [...view.keys()]
    .sort()
    .map((id) => canonFragment(view.get(id) as LedgerViewEntry))
    .filter((fragment) => fragment !== "");
  if (fragments.length === 0) {
    return `${header}_No accepted intent yet._\n`;
  }
  return header + fragments.join("");
}

/**
 * Extract the rendered-at marker from canon text. Returns null when the
 * text carries no marker or more than one — an ambiguous or absent
 * marker means freshness CANNOT be proven, and the divergence functions
 * treat that conservatively (full divergence, fold due).
 */
export function parseCanonMarker(text: string): CanonMarker | null {
  const matches: CanonMarker[] = [];
  for (const line of text.split("\n")) {
    const match = MARKER_LINE_PATTERN.exec(line);
    if (match !== null) {
      const renderedAt = match[1] as string;
      if (Number.isNaN(Date.parse(renderedAt))) continue;
      matches.push({ renderedAt, ledgerSeq: Number(match[2]) });
    }
  }
  return matches.length === 1 ? (matches[0] as CanonMarker) : null;
}

export interface CanonDivergence {
  /** Requirement ids whose current rendering differs from the marker-time rendering. */
  readonly divergedRequirementIds: readonly string[];
  /**
   * When the oldest CURRENT divergence began (the recordedAt of the
   * earliest ledger record since which some still-diverged requirement's
   * rendering has continuously differed from its marker-time rendering).
   * Null when nothing diverges.
   */
  readonly oldestDivergenceAt: string | null;
}

/**
 * Compare the ledger against a canon file's marker. `records` is the
 * FULL ledger log in seq order (the store's adoption verification
 * already vouched for it). A null marker — no marker, several markers,
 * or a marker naming a seq this ledger has not reached (a foreign or
 * corrupt file) — is treated as full divergence since each
 * requirement's first record: freshness that cannot be proven is not
 * assumed (fail toward folding).
 */
export function computeCanonDivergence(
  records: readonly LedgerEventRecord[],
  marker: CanonMarker | null,
): CanonDivergence {
  const lastSeq = records.at(-1)?.seq ?? 0;
  if (marker === null || marker.ledgerSeq > lastSeq) {
    const firstRecordAt = new Map<string, string>();
    for (const record of records) {
      if (!firstRecordAt.has(record.requirementId)) {
        firstRecordAt.set(record.requirementId, record.recordedAt);
      }
    }
    const diverged = [...firstRecordAt.keys()].sort();
    const oldest = diverged.length === 0 ? null : ([...firstRecordAt.values()].sort()[0] as string);
    return { divergedRequirementIds: diverged, oldestDivergenceAt: oldest };
  }

  const markerView = foldLedgerView(records.filter((r) => r.seq <= marker.ledgerSeq));
  const markerFragments = new Map<string, string>();
  for (const [id, entry] of markerView) markerFragments.set(id, canonFragment(entry));

  // Walk forward from the marker, tracking when each requirement's
  // rendering DEPARTED from its marker-time rendering and has not
  // returned. A change that changes back (accepted → disputed →
  // resolved-accepted with the same text) is not a divergence: the file
  // is still an accurate rendering of current intent.
  const view = foldLedgerView(records.filter((r) => r.seq <= marker.ledgerSeq));
  const departedSince = new Map<string, string>();
  for (const record of records) {
    if (record.seq <= marker.ledgerSeq) continue;
    applyLedgerRecord(view, record);
    const entry = view.get(record.requirementId) as LedgerViewEntry;
    const nowFragment = canonFragment(entry);
    const markerFragment = markerFragments.get(record.requirementId) ?? "";
    if (nowFragment === markerFragment) {
      departedSince.delete(record.requirementId);
    } else if (!departedSince.has(record.requirementId)) {
      departedSince.set(record.requirementId, record.recordedAt);
    }
  }
  const diverged = [...departedSince.keys()].sort();
  const oldest = diverged.length === 0 ? null : ([...departedSince.values()].sort()[0] as string);
  return { divergedRequirementIds: diverged, oldestDivergenceAt: oldest };
}

export interface StandaloneFoldDecision {
  readonly required: boolean;
  /** Why the fold is due; null when it is not. */
  readonly reason: "requirement-count" | "age" | null;
}

/**
 * CAM-CANON-02's trigger, verbatim thresholds, strict inequalities: a
 * standalone intent-only fold is due when divergence exceeds 5
 * requirements or has stood for more than 7 days. Exactly 5 requirements
 * or exactly 7 days does NOT trigger ("exceeds"). Zero divergence never
 * triggers regardless of file age — there is nothing to fold.
 */
export function standaloneFoldRequired(
  divergence: CanonDivergence,
  nowIso: string,
): StandaloneFoldDecision {
  assertIsoUtc("nowIso", nowIso);
  const count = divergence.divergedRequirementIds.length;
  if (count > STANDALONE_FOLD_REQUIREMENT_THRESHOLD) {
    return { required: true, reason: "requirement-count" };
  }
  if (count >= 1 && divergence.oldestDivergenceAt !== null) {
    assertIsoUtc("oldestDivergenceAt", divergence.oldestDivergenceAt);
    const ageMs = Date.parse(nowIso) - Date.parse(divergence.oldestDivergenceAt);
    if (ageMs > STANDALONE_FOLD_AGE_DAYS * 24 * 60 * 60 * 1000) {
      return { required: true, reason: "age" };
    }
  }
  return { required: false, reason: null };
}
