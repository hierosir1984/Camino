/**
 * `.camino/knowledge.md` rendering (WP-113, CAM-CANON-09) — the repo-file
 * projection of the knowledge base, same relationship canon.md has to the
 * intent ledger: the control-plane store is authoritative; editing the
 * rendered file never changes knowledge state.
 *
 * The projection renders APPROVED entries ONLY — a deliberate visibility
 * boundary, not an omission. The rendered file lives in the repo, so every
 * worker clone in every mission can read it; rendering candidates into it
 * would hand unvetted sibling observations to other missions through the
 * repo channel and void the CAM-CANON-09 pack-visibility guarantee.
 * Candidates reach exactly one audience — same-issue repair attempts —
 * through context packs, never through this file. Entries past their
 * expiry at render time are likewise omitted.
 *
 * When a worker reads this file back it is REPO CONTENT — untrusted text
 * (CAM-EXEC-09 class): a worker may have edited it on its branch. Packs
 * render knowledge from the store, never by re-reading this projection.
 */
import type { KnowledgeEntrySnapshot, KnowledgeView } from "./knowledge.js";

export interface RenderKnowledgeOptions {
  /** ISO-8601 UTC render instant; also the expiry-filter clock. */
  readonly renderedAt: string;
}

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function assertIsoUtc(field: string, value: string): void {
  if (
    !ISO_INSTANT_RE.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new Error(`${field} must be an ISO-8601 UTC instant (toISOString form), got ${value}`);
  }
}

function scopeLabel(snapshot: KnowledgeEntrySnapshot): string {
  const scope = snapshot.entry.scope;
  return scope.kind === "global" ? "global" : `area: ${scope.area}`;
}

function authorityLabel(snapshot: KnowledgeEntrySnapshot): string {
  const promotion = snapshot.promotion;
  if (promotion === null) return "unknown"; // unreachable for approved entries; stated for totality
  switch (promotion.authority.kind) {
    case "human-batch":
      return `human curation batch ${promotion.authority.batchId}`;
    case "rule-command-success":
      return "deterministic rule: command succeeded across missions";
    case "rule-quarantine-flaky":
      return "deterministic rule: quarantine-confirmed flaky test";
  }
}

/** One approved entry as a markdown fragment (deterministic). */
export function knowledgeFragment(snapshot: KnowledgeEntrySnapshot): string {
  const entry = snapshot.entry;
  const lines = [`- **${entry.entryId}** (${entry.entryClass}) — ${entry.text}`];
  if (entry.subjectKey !== null) {
    lines.push(`  - subject: \`${entry.subjectKey}\` — claim: ${entry.claim}`);
  }
  lines.push(
    `  - scope: ${scopeLabel(snapshot)}; expires: ${entry.expiresAt}`,
    `  - provenance: attempt ${entry.provenance.attemptId} (issue ${entry.provenance.issueId}, ` +
      `mission ${entry.provenance.missionId}); validity: commit ${entry.validity.commitSha} ` +
      `on base ${entry.validity.baseSha}`,
    `  - approved via ${authorityLabel(snapshot)}`,
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Render the knowledge file content for a view. Deterministic; throws only
 * on caller bugs (bad clock / seq), never on view content.
 */
export function renderKnowledge(view: KnowledgeView, options: RenderKnowledgeOptions): string {
  assertIsoUtc("renderedAt", options.renderedAt);
  // The freshness seq is the view's OWN lastSeq, never a caller-supplied
  // number (r1 finding 12): a projection cannot claim a sequence it was not
  // rendered from. The fold guarantees lastSeq is a non-negative safe integer
  // (its append gate refuses anything else), so it round-trips a `\d+` parser.
  const knowledgeSeq = view.lastSeq;
  const header =
    `# Operational knowledge\n\n` +
    `<!-- camino:knowledge rendered-at=${options.renderedAt} knowledge-seq=${knowledgeSeq} -->\n\n` +
    `This file is the rendered projection of APPROVED operational knowledge\n` +
    `(CAM-CANON-09). The knowledge store in the control plane is authoritative;\n` +
    `editing this file never changes knowledge state. Candidate entries are\n` +
    `deliberately absent: they are visible only to same-issue repair attempts\n` +
    `through context packs, never through the repo.\n\n` +
    `## Approved entries\n\n`;
  const approved = [...view.entries.values()]
    .filter(
      (snapshot) => snapshot.state === "approved" && snapshot.entry.expiresAt > options.renderedAt,
    )
    .sort((a, b) =>
      a.entry.entryId < b.entry.entryId ? -1 : a.entry.entryId > b.entry.entryId ? 1 : 0,
    );
  if (approved.length === 0) {
    return `${header}_No approved entries yet._\n`;
  }
  return header + approved.map(knowledgeFragment).join("");
}
