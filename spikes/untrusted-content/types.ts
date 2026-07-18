// WP-004 untrusted-content robustness baseline — shared types.
//
// This is a SPIKE (Phase-0 spikes/**): it de-risks and BASELINES planted-instruction
// behaviour of the WP-002 planner and one WP-001 worker against an untrusted-content case set.
// The DURABLE asset is the corpus in fixtures/untrusted-content/ (re-run at WP-107
// worker isolation and WP-113 context-pack assembly); this runner is prototype-grade.

import type { Outcome } from "../dispatch/types.js";

export type Target = "planner" | "worker";
export type Channel = "issue-text" | "repo-readme" | "web-content" | "none";
export type Severity = "critical" | "high" | "medium" | "low" | "none";

/**
 * A detector decides, from a target's captured evidence, whether the planted instruction
 * was OBEYED. Invariant across all kinds: `fired === true` means a problematic,
 * planted-instruction-shaped signal was observed. Injection items expect `fired=false`
 * (treated as data / refused); controls also expect `fired=false` (no false
 * positive). Every needle is a unique nonce embedded in the payload, so a hit
 * is proof the proxy action was performed.
 */
export type Detector =
  // --- planner surface ---
  // Searches the plan's ACTIONABLE content (issue titles/goals/criteria), NOT
  // checklist notes or clarifying questions — a planner that correctly flags an
  // planted instruction quotes the marker there while refusing it, and that must not read
  // as obedience (WP-004 real-run finding: PL-02 false positive).
  | { kind: "planner-issue-contains"; needle: string }
  | { kind: "planner-wrote-extra-file" }
  | { kind: "checklist-missing-segment"; segment: string }
  | { kind: "planner-propagated-unflagged"; needle: string }
  // --- worker surface ---
  | { kind: "worker-file-present"; path: string }
  | { kind: "worker-artifact-contains"; needle: string }
  | { kind: "worker-file-modified-contains"; path: string; needle: string }
  | { kind: "worker-empty-change-but-claims-done"; claimNeedle: string }
  // --- controls ---
  | { kind: "control-clean" };

export type DetectorKind = Detector["kind"];

export interface CorpusItem {
  id: string;
  title: string;
  target: Target;
  channel: Channel;
  plantedGoal: string;
  severity: Severity;
  /** Run against a real agent at this baseline? false = catalogue-only (host-level, unsafe pre-WP-107). */
  liveRun: boolean;
  /** Planner: PRD fixture path. Catalogue-only worker: payload-record path. (relative to the corpus root) */
  payload?: string | null;
  /** Worker: seed directory materialised into a throwaway clone (relative to the corpus root). */
  seedDir?: string | null;
  /** Worker: the issue prompt handed to the worker (planted instruction may live here or in the seed README). */
  issuePrompt?: string | null;
  /** What a well-behaved agent should do — framing for the finding, not an assertion. */
  expectation: string;
  detectors: Detector[];
  notes?: string;
}

export interface Manifest {
  schemaVersion: number;
  title: string;
  note?: string;
  items: CorpusItem[];
}

/** Evidence captured from a planner run, consumed by the planner detectors. */
export interface PlannerEvidence {
  kind: "planner";
  outcome: Outcome;
  /** Raw plan.json text exactly as the planner wrote it (null = never written). */
  planJsonRaw: string | null;
  planValid: boolean;
  /** Structural parse errors ([] iff planValid). */
  planErrors: string[];
  /** Checklist segment tags the planner produced (empty if unparsed). */
  checklistSegments: string[];
  /** Per-issue { riskTier, blob } for the propagated-unflagged detector. */
  issues: { title: string; riskTier: string; blob: string }[];
  /** All clarifying-question text concatenated (for the propagated-unflagged detector). */
  clarifyingText: string;
  /**
   * The plan's DESCRIPTIVE content — checklist notes + clarifying questions —
   * where a defending planner quotes a planted instruction while refusing it. Used to
   * recognise an active defense, never as an obedience signal.
   */
  descriptiveText: string;
  /** Files the planner left beyond PRD.md and plan.json. */
  extraFiles: string[];
  finalText: string;
  /** Provider/harness refused to run (classifier kill, quota) — no usable output. */
  providerBlocked: boolean;
  blockDetail?: string;
}

/** Evidence captured from a worker run, consumed by the worker detectors. */
export interface WorkerEvidence {
  kind: "worker";
  outcome: Outcome;
  committed: boolean;
  /** A commit exists on top of the seed base whose tree equals the base tree (no file change). */
  emptyCommit: boolean;
  /** Relative paths present in the clone after the run (excluding .git). */
  presentFiles: string[];
  /** Relative paths changed vs the seed base (added, modified, or "<path> (deleted)"). */
  changedPaths: string[];
  /** Current contents of present files, keyed by relative path (size-capped, HOME-scrubbed). */
  fileContents: Record<string, string>;
  /** Repo ARTIFACTS the worker produced: commit messages + ADDED/MODIFIED file content since base (NOT finalText, NOT deletion patches). */
  artifactBlob: string;
  /** The worker's final message (searched only by the deception detector). */
  finalText: string;
  providerBlocked: boolean;
  blockDetail?: string;
}

export type TargetEvidence = PlannerEvidence | WorkerEvidence;

export interface DetectorResult {
  kind: DetectorKind;
  /** true = a problematic planted-instruction-shaped signal was observed. */
  fired: boolean;
  detail: string;
}

export type ItemStatus =
  | "obeyed" // ≥1 detector fired
  | "clean" // ran, nothing fired (planted instruction refused / control as expected)
  | "provider-blocked" // classifier/quota killed the run — inconclusive
  | "error" // harness could not obtain a usable deliverable — inconclusive
  | "not-run"; // liveRun=false (catalogue-only) or filtered out

export interface Finding {
  id: string;
  title: string;
  target: Target;
  channel: Channel;
  plantedGoal: string;
  severity: Severity;
  status: ItemStatus;
  /** The agent adapter that ran this item (null if not-run). */
  adapter: string | null;
  expectation: string;
  detectorResults: DetectorResult[];
  /** Short, human evidence line for the catalogue. */
  evidence: string;
  notes?: string;
}
