// WP-003 attack #13 — candidate-ref workflow-trigger posture (CAM-SEC-03).
//
// This is the one attack that is NOT about the worker's tree: it is a repo CI
// posture check. A workflow already in the repo that fires on a Camino-managed
// namespace (camino/**, mission/*, issue branches) while carrying secrets or
// write permissions would hand a privileged token to worker-derived refs. The
// analyzer statically flags such workflows, naming the file (CAM-SEC-03 accept).
//
// Safety bias: when a branch pattern's exact semantics are ambiguous, the
// matcher errs toward "fires" — a false flag is harmless, a missed hostile
// workflow is not.
import yaml from "js-yaml";

export interface WorkflowFinding {
  file: string;
  /** Human reasons the workflow would fire on a candidate namespace. */
  fires: string[];
  /** Human reasons the workflow is privileged (secrets / write token). */
  privileged: string[];
}

/**
 * Translate a GitHub branch **filter pattern** to a RegExp (a leading `!` is
 * stripped — the caller evaluates patterns in order, last match wins). Precise
 * for the security-relevant forms (`**`, `*`, `/`, literals); the exotic
 * quantifiers (`?`, `+`, `[]`) are approximated permissively (toward matching).
 */
function filterPatternToRegExp(pattern: string): RegExp {
  const p = pattern.startsWith("!") ? pattern.slice(1) : pattern;
  let re = "^";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        re += ".*"; // ** spans '/'
        i += 1;
      } else {
        re += "[^/]*"; // * stops at '/'
      }
    } else if (c === "?" || c === "+") {
      re += ".*"; // quantifier — over-approximate to matching
    } else if (c === "[") {
      re += "."; // char class — over-approximate to a single char
      while (i + 1 < p.length && p[i + 1] !== "]") i++;
      if (i + 1 < p.length) i++; // consume ']'
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(re + "$");
}

/** Does any candidate ref match the branch filter list (GitHub semantics)? */
function firesOnBranches(patterns: string[], candidateRefs: string[]): string[] {
  // GitHub applies patterns IN ORDER, last match wins — a later positive can
  // re-include what an earlier `!` excluded (review r1 #4). Partitioning loses
  // that and under-flags, so evaluate sequentially per ref.
  const compiled = patterns.map((p) => ({ neg: p.startsWith("!"), rx: filterPatternToRegExp(p) }));
  const reasons: string[] = [];
  for (const ref of candidateRefs) {
    let matched = false;
    for (const { neg, rx } of compiled) if (rx.test(ref)) matched = !neg;
    if (matched) reasons.push(ref);
  }
  return reasons;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function toStringList(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/** Which push-family triggers would fire on a candidate ref, and why. */
function analyzeTriggers(on: unknown, candidateRefs: string[]): string[] {
  const reasons: string[] = [];
  // Shorthand `on: push` / `on: [push, …]` ⇒ every branch (incl. candidate refs).
  const shorthand = typeof on === "string" ? [on] : Array.isArray(on) ? on : null;
  if (shorthand) {
    if (shorthand.includes("push")) {
      reasons.push(`on: push (all branches) fires on ${candidateRefs.join(", ")}`);
    }
    if (shorthand.includes("pull_request_target")) {
      reasons.push("on: pull_request_target runs in privileged base context on pull requests");
    }
    return reasons;
  }
  const onObj = asRecord(on);
  if (!onObj) return reasons;

  // `pull_request_target` is privileged BY NATURE: it runs in the base-repo
  // context (with secrets/write) on pull requests, and its branch filters match
  // the PR's BASE branch, not any candidate head ref (review r1 #2). So it is
  // not analysed via candidate-ref matching — its mere presence is a "fires"
  // reason, which only becomes a finding when the workflow is also privileged.
  if ("pull_request_target" in onObj) {
    reasons.push(
      "pull_request_target runs in privileged base context on pull requests " +
        "(branch filters match the base branch, not the candidate ref)",
    );
  }

  // `push` DOES key on the pushed ref, so candidate-ref matching applies.
  if ("push" in onObj) {
    const spec = onObj["push"];
    if (spec === null || spec === undefined) {
      reasons.push(`push: (no branch filter ⇒ all branches) fires on ${candidateRefs.join(", ")}`);
    } else {
      const specObj = asRecord(spec);
      if (specObj) {
        const branches = toStringList(specObj["branches"]);
        const ignore = toStringList(specObj["branches-ignore"]);
        if (branches.length === 0 && ignore.length === 0) {
          reasons.push(
            `push: (no branches filter ⇒ all branches) fires on ${candidateRefs.join(", ")}`,
          );
        } else if (branches.length > 0) {
          for (const h of firesOnBranches(branches, candidateRefs)) {
            reasons.push(`push.branches ${JSON.stringify(branches)} matches ${h}`);
          }
        } else if (ignore.length > 0) {
          const ignored = new Set(firesOnBranches(ignore, candidateRefs));
          for (const ref of candidateRefs) {
            if (!ignored.has(ref)) {
              reasons.push(`push.branches-ignore ${JSON.stringify(ignore)} still fires on ${ref}`);
            }
          }
        }
      }
    }
  }
  return reasons;
}

/** Write scopes declared by a `permissions:` value (top-level or per-job). */
function writeScopes(perms: unknown): string[] {
  if (perms === "write-all") return ["write-all"];
  if (perms === "read-all" || perms === "read") return [];
  const obj = asRecord(perms);
  if (!obj) return [];
  return Object.entries(obj)
    .filter(([, v]) => v === "write")
    .map(([k]) => k);
}

/** Reasons the workflow wields a real secret or a write token. */
function analyzePrivilege(doc: Record<string, unknown>, rawText: string): string[] {
  const reasons: string[] = [];
  // Non-GITHUB_TOKEN secret references, in BOTH the `secrets.NAME` and the
  // index form `secrets['NAME']` / `secrets["NAME"]` (review r1 #3).
  const secretRefs = new Set<string>();
  const secretRe = /\$\{\{\s*secrets(?:\.([A-Za-z0-9_]+)|\[\s*['"]([^'"]+)['"]\s*\])/g;
  for (const m of rawText.matchAll(secretRe)) {
    const name = m[1] ?? m[2] ?? "";
    if (name && name !== "GITHUB_TOKEN") secretRefs.add(name);
  }
  if (secretRefs.size > 0) reasons.push(`references secrets: ${[...secretRefs].join(", ")}`);

  // Token permissions: explicit all-read is safe; write (or absent) is not —
  // checked at the top level AND per-job (`jobs.<id>.permissions`, review r1 #3).
  const perms = doc["permissions"];
  if (perms === undefined) {
    reasons.push("no explicit permissions block (default token may be write-capable)");
  } else {
    const w = writeScopes(perms);
    if (w.length > 0) reasons.push(`permissions grant write: ${w.join(", ")}`);
  }
  const jobs = asRecord(doc["jobs"]);
  if (jobs) {
    for (const [jobId, job] of Object.entries(jobs)) {
      const jobObj = asRecord(job);
      if (jobObj && "permissions" in jobObj) {
        const w = writeScopes(jobObj["permissions"]);
        if (w.length > 0) reasons.push(`job "${jobId}" permissions grant write: ${w.join(", ")}`);
      }
    }
  }
  return reasons;
}

/** Analyze one workflow file. Returns a finding iff it is hostile-on-candidate. */
export function analyzeWorkflow(
  file: string,
  content: string,
  candidateRefs: string[],
): WorkflowFinding | null {
  let doc: Record<string, unknown> | null = null;
  try {
    doc = asRecord(yaml.load(content));
  } catch {
    // An unparseable workflow is treated as hostile (fail-closed): we cannot
    // prove it safe.
    return {
      file,
      fires: ["workflow YAML did not parse — cannot prove safe"],
      privileged: ["unknown"],
    };
  }
  if (!doc) return null;
  // YAML 1.1 would coerce the `on:` key to boolean true; tolerate both.
  const on = "on" in doc ? doc["on"] : doc[String(true)];
  const fires = analyzeTriggers(on, candidateRefs);
  if (fires.length === 0) return null;
  const privileged = analyzePrivilege(doc, content);
  if (privileged.length === 0) return null; // fires but harmless (read-only, no secrets)
  return { file, fires, privileged };
}

/** Scan a set of workflow files; return one finding per hostile workflow. */
export function scanWorkflowPosture(
  files: ReadonlyArray<{ path: string; content: string }>,
  candidateRefs: string[],
): WorkflowFinding[] {
  const out: WorkflowFinding[] = [];
  for (const f of files) {
    const finding = analyzeWorkflow(f.path, f.content, candidateRefs);
    if (finding) out.push(finding);
  }
  return out;
}

/** The Camino-managed namespaces a candidate ref can live under (design §5.5). */
export const CANDIDATE_REFS = [
  "camino/candidate/issue-42/1",
  "mission/7",
  "camino/tmp/validate/abc123",
];
