// Load + strictly validate the untrusted-content corpus manifest. Fail-closed:
// any malformed item, unknown detector kind, missing payload/seed, missing
// live-run file, empty/cross-target detector list, or path that escapes the
// corpus root is a loud error, never a silent skip — a corpus that quietly
// dropped a case (or scored one vacuously clean) would understate coverage.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Channel, Detector, Manifest, Severity, Target } from "./types.js";

const TARGETS: Target[] = ["planner", "worker"];
const CHANNELS: Channel[] = ["issue-text", "repo-readme", "web-content", "none"];
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "none"];

/** Required non-`kind` fields per detector kind — the closed detector schema. */
const DETECTOR_FIELDS: Record<Detector["kind"], string[]> = {
  "planner-issue-contains": ["needle"],
  "planner-wrote-extra-file": [],
  "checklist-missing-segment": ["segment"],
  "planner-propagated-unflagged": ["needle"],
  "worker-file-present": ["path"],
  "worker-artifact-contains": ["needle"],
  "worker-file-modified-contains": ["path", "needle"],
  "worker-empty-change-but-claims-done": ["claimNeedle"],
  "control-clean": [],
};

/** Which target each detector can score (control-clean adapts to either). */
const DETECTOR_TARGET: Record<Detector["kind"], Target | "any"> = {
  "planner-issue-contains": "planner",
  "planner-wrote-extra-file": "planner",
  "checklist-missing-segment": "planner",
  "planner-propagated-unflagged": "planner",
  "worker-file-present": "worker",
  "worker-artifact-contains": "worker",
  "worker-file-modified-contains": "worker",
  "worker-empty-change-but-claims-done": "worker",
  "control-clean": "any",
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateDetector(raw: unknown, where: string, errs: string[]): void {
  if (!isPlainObject(raw)) {
    errs.push(`${where}: detector must be an object`);
    return;
  }
  const kind = raw["kind"];
  if (typeof kind !== "string" || !(kind in DETECTOR_FIELDS)) {
    errs.push(`${where}: unknown detector kind ${JSON.stringify(kind)}`);
    return;
  }
  const required = DETECTOR_FIELDS[kind as Detector["kind"]];
  for (const f of required) {
    if (typeof raw[f] !== "string" || (raw[f] as string).length === 0) {
      errs.push(`${where}: detector ${kind} needs a non-empty string "${f}"`);
    }
  }
  const allowed = new Set(["kind", ...required]);
  for (const k of Object.keys(raw)) {
    if (!allowed.has(k)) errs.push(`${where}: detector ${kind} has unexpected field "${k}"`);
  }
}

function validateItem(raw: unknown, idx: number, errs: string[], seenIds: Set<string>): void {
  const where = `items[${idx}]`;
  if (!isPlainObject(raw)) {
    errs.push(`${where}: item must be an object`);
    return;
  }
  const id = raw["id"];
  if (typeof id !== "string" || !/^(PL|WK|CTL)-\d+$/.test(id)) {
    errs.push(`${where}: id must match (PL|WK|CTL)-<n>, got ${JSON.stringify(id)}`);
  } else if (seenIds.has(id)) {
    errs.push(`${where}: duplicate id ${id}`);
  } else {
    seenIds.add(id);
  }
  for (const f of ["title", "plantedGoal", "expectation"] as const) {
    if (typeof raw[f] !== "string" || (raw[f] as string).length === 0) {
      errs.push(`${where} (${id}): "${f}" must be a non-empty string`);
    }
  }
  if (!TARGETS.includes(raw["target"] as Target)) errs.push(`${where} (${id}): bad target`);
  if (!CHANNELS.includes(raw["channel"] as Channel)) errs.push(`${where} (${id}): bad channel`);
  if (!SEVERITIES.includes(raw["severity"] as Severity))
    errs.push(`${where} (${id}): bad severity`);
  if (typeof raw["liveRun"] !== "boolean") errs.push(`${where} (${id}): liveRun must be boolean`);

  const liveRun = raw["liveRun"] === true;
  const target = raw["target"];
  const detectors = raw["detectors"];
  if (!Array.isArray(detectors)) {
    errs.push(`${where} (${id}): detectors must be an array`);
  } else {
    detectors.forEach((d, i) => validateDetector(d, `${where} (${id}).detectors[${i}]`, errs));
    // A LIVE case with no detector — or a detector for the wrong target — always
    // scores vacuously clean (review r1 major 11). Reject both.
    if (liveRun && detectors.length === 0) {
      errs.push(
        `${where} (${id}): a live case must have at least one detector (else it always scores clean)`,
      );
    }
    for (const d of detectors) {
      if (isPlainObject(d) && typeof d["kind"] === "string" && d["kind"] in DETECTOR_TARGET) {
        const dt = DETECTOR_TARGET[d["kind"] as Detector["kind"]];
        if (dt !== "any" && dt !== target) {
          errs.push(
            `${where} (${id}): detector ${d["kind"]} scores "${dt}" but the case target is "${target}"`,
          );
        }
      }
    }
  }

  // Target-specific requirements for LIVE items (catalogue-only items only need a payload record).
  if (liveRun && raw["target"] === "planner") {
    if (typeof raw["payload"] !== "string")
      errs.push(`${where} (${id}): live planner item needs "payload"`);
  }
  if (liveRun && raw["target"] === "worker") {
    if (typeof raw["seedDir"] !== "string")
      errs.push(`${where} (${id}): live worker item needs "seedDir"`);
    if (typeof raw["issuePrompt"] !== "string")
      errs.push(`${where} (${id}): live worker item needs "issuePrompt"`);
  }
  if (!liveRun && typeof raw["payload"] !== "string") {
    errs.push(`${where} (${id}): catalogue-only item needs a "payload" record path`);
  }
}

export interface LoadedCorpus {
  root: string;
  manifest: Manifest;
}

/** Parse, validate, and existence-check the corpus rooted at `rootDir`. Throws on any defect. */
export function loadCorpus(rootDir: string): LoadedCorpus {
  const manifestPath = join(rootDir, "manifest.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new Error(`cannot read/parse ${manifestPath}: ${(e as Error).message}`);
  }
  const errs: string[] = [];
  if (!isPlainObject(parsed)) throw new Error(`${manifestPath}: top level must be an object`);
  if (parsed["schemaVersion"] !== 1) errs.push(`schemaVersion must be 1`);
  if (typeof parsed["title"] !== "string") errs.push(`title must be a string`);
  const items = parsed["items"];
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`${manifestPath}: "items" must be a non-empty array`);
  }
  const seen = new Set<string>();
  items.forEach((it, i) => validateItem(it, i, errs, seen));

  if (errs.length > 0) {
    throw new Error(`invalid corpus manifest:\n` + errs.map((e) => `  - ${e}`).join("\n"));
  }

  const manifest = parsed as unknown as Manifest;

  // Existence + CONTAINMENT checks: a payload/seed path that is absolute,
  // traverses out, or symlinks outside the corpus root is rejected (review r1
  // major 12) — otherwise a manifest could copy/expose an arbitrary host file.
  const badPaths: string[] = [];
  for (const item of manifest.items) {
    const rel = item.target === "worker" && item.liveRun ? item.seedDir : item.payload;
    if (typeof rel !== "string") continue;
    try {
      const abs = itemPath(rootDir, rel);
      if (!existsSync(abs)) badPaths.push(`${item.id}: missing ${rel}`);
    } catch (e) {
      badPaths.push(`${item.id}: ${(e as Error).message}`);
    }
  }
  if (badPaths.length > 0) {
    throw new Error(`corpus path problems:\n` + badPaths.map((m) => `  - ${m}`).join("\n"));
  }

  return { root: rootDir, manifest };
}

/**
 * Resolve an item's payload/seed path to absolute, CONFINED to the corpus root:
 * rejects absolute paths, `..` traversal, and symlink escapes (review r1
 * major 12). Throws on any escape.
 */
export function itemPath(root: string, rel: string): string {
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
    throw new Error(`path must be corpus-relative with no ".." (got ${JSON.stringify(rel)})`);
  }
  // Resolve against the REAL root so a symlinked tmp root (macOS /var → /private/var)
  // doesn't look like an escape. realpath the target if it exists to catch a
  // symlinked component that escapes.
  const realRoot = realpathSync(root);
  const abs = resolve(realRoot, rel);
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    /* may not exist yet — the caller's existence check handles that */
  }
  const within = relative(realRoot, real);
  if (within.startsWith("..") || isAbsolute(within)) {
    throw new Error(`path escapes the corpus root (${rel})`);
  }
  return abs;
}
