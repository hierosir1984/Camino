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
  // Round-trip identity, not just shape: the regex alone admits
  // impossible dates JavaScript silently normalizes — 2026-02-30 parses
  // as March 2nd (review round 1, finding 12).
  const parsed = Date.parse(value);
  if (
    !ISO_UTC_PATTERN.test(value) ||
    Number.isNaN(parsed) ||
    new Date(parsed).toISOString() !== value
  ) {
    throw new Error(
      `${field} must be a real ISO-8601 UTC instant (toISOString form), got ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Line-ending normalization: canon files may pass through editors or
 * checkouts that rewrite line endings; comparing or parsing without
 * normalizing would turn a byte-level CRLF conversion into a spurious
 * full divergence (review round 1, finding 11).
 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
 * Extract the rendered-at marker from canon text (line endings
 * normalized first). Returns null when the text carries no marker or
 * more than one — an ambiguous or absent marker means freshness CANNOT
 * be proven, and the divergence functions treat that conservatively
 * (full divergence, fold due). A marker-shaped line inside a code fence
 * is not special-cased here: an edited file that smuggles one fails the
 * body-faithfulness comparison instead (`computeCanonDivergence`), and
 * the renderer itself never emits fences or multi-line statements (the
 * ledger enforces single-line text fields).
 */
export function parseCanonMarker(text: string): CanonMarker | null {
  const matches: CanonMarker[] = [];
  for (const line of normalizeLineEndings(text).split("\n")) {
    const match = MARKER_LINE_PATTERN.exec(line);
    if (match !== null) {
      const renderedAt = match[1] as string;
      const parsed = Date.parse(renderedAt);
      if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== renderedAt) continue;
      matches.push({ renderedAt, ledgerSeq: Number(match[2]) });
    }
  }
  return matches.length === 1 ? (matches[0] as CanonMarker) : null;
}

/** Why freshness could not be proven from the file itself. */
export type FreshnessDefect =
  | "no-marker" // absent, duplicated, or malformed marker
  | "foreign-marker" // the marker names a seq this ledger has not reached
  | "body-mismatch"; // the body is not the faithful rendering of ledger@marker

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
  /**
   * Null when the file proved its own freshness lineage (single valid
   * marker, reachable seq, byte-faithful body). Otherwise the reason the
   * comparison fell back to conservative full divergence.
   */
  readonly freshnessDefect: FreshnessDefect | null;
}

/**
 * Compare the ledger against the ACTUAL canon file text (review round
 * 1, finding 3: a marker alone proves nothing — an edited or truncated
 * body behind a current marker must not read as fresh). `records` is
 * the FULL ledger log in seq order (the store's adoption verification
 * already vouched for it).
 *
 * The file proves its lineage only if: it carries exactly one valid
 * marker; the marker's seq is within this ledger; and the whole text
 * (line endings normalized) is BYTE-IDENTICAL to `renderCanon` of the
 * ledger folded to that seq with the marker's own timestamp — rendering
 * is deterministic, so any edit, truncation, or foreign content fails.
 * A file that cannot prove its lineage is fully divergent since each
 * requirement's first record: freshness that cannot be proven is not
 * assumed (fail toward folding).
 */
export function computeCanonDivergence(
  records: readonly LedgerEventRecord[],
  canonText: string,
): CanonDivergence {
  const marker = parseCanonMarker(canonText);
  const lastSeq = records.at(-1)?.seq ?? 0;
  const conservative = (defect: FreshnessDefect): CanonDivergence => {
    const firstRecordAt = new Map<string, string>();
    for (const record of records) {
      if (!firstRecordAt.has(record.requirementId)) {
        firstRecordAt.set(record.requirementId, record.recordedAt);
      }
    }
    const diverged = [...firstRecordAt.keys()].sort();
    const oldest = diverged.length === 0 ? null : ([...firstRecordAt.values()].sort()[0] as string);
    return {
      divergedRequirementIds: diverged,
      oldestDivergenceAt: oldest,
      freshnessDefect: defect,
    };
  };
  if (marker === null) return conservative("no-marker");
  if (marker.ledgerSeq > lastSeq) return conservative("foreign-marker");

  const markerView = foldLedgerView(records.filter((r) => r.seq <= marker.ledgerSeq));
  const expectedText = renderCanon(markerView, {
    ledgerSeq: marker.ledgerSeq,
    renderedAt: marker.renderedAt,
  });
  if (normalizeLineEndings(canonText) !== expectedText) {
    return conservative("body-mismatch");
  }

  const markerFragments = new Map<string, string>();
  for (const [id, entry] of markerView) markerFragments.set(id, canonFragment(entry));

  // Walk forward from the marker, tracking when each requirement's
  // rendering DEPARTED from its marker-time rendering and has not
  // returned. A change that changes back (accepted → disputed →
  // resolved-accepted with the same text) is not a divergence: the file
  // is still an accurate rendering of current intent.
  const view = markerView;
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
  return { divergedRequirementIds: diverged, oldestDivergenceAt: oldest, freshnessDefect: null };
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
