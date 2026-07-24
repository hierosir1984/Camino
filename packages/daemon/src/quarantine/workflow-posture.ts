// WP-108 quarantine — candidate-ref workflow-trigger posture (CAM-SEC-03).
//
// This is the one WP-003-corpus case (case 13) that is NOT about the worker's
// tree: it is a repo CI posture check. A workflow already in the repo that
// fires on a Camino-managed namespace (camino/**, mission/*, issue branches)
// while carrying secrets or write permissions would hand a privileged token to
// worker-derived refs. The analyzer statically flags such workflows, naming the
// file (CAM-SEC-03 accept).
//
// SCOPE, stated: the analyzer is carried forward VERBATIM from the WP-003 spike
// (3 falsification rounds), so the entire WP-003 corpus runs green against this
// product module. Its onboarding-time ENFORCEMENT home — running these checks
// at repo-onboarding and gating on them — is WP-118 (CAM-SEC-03). A truly
// COMPLETE symbolic glob∩namespace / GitHub-Actions-semantics analyzer is that
// onboarding check; this remains the heuristic, over-approximating (toward
// flagging) analyzer the spike established, with its boundary named below.
//
// Safety bias: when a branch pattern's exact semantics are ambiguous, the
// matcher errs toward "fires" — a false flag is harmless, a missed privileged
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
function firesOnBranches(patterns: string[], candidateRefs: readonly string[]): string[] {
  // GitHub applies patterns IN ORDER, last match wins — a later positive can
  // re-include what an earlier `!` excluded (WP-003 r1). Partitioning loses
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

/** Extra probe refs spanning candidate-namespace shapes (WP-003 r2 / r3). */
const NAMESPACE_PROBES = [
  "camino/candidate/issue-99/1",
  "camino/candidate/issue-99/deep/nested/x",
  "camino/tmp/validate/zzz",
  "mission/99",
];

/** Which push-family triggers would fire on a candidate ref, and why. */
function analyzeTriggers(on: unknown, candidateRefs: readonly string[]): string[] {
  const reasons: string[] = [];
  // Events that run with the base repo's secrets/write token regardless of the
  // ref they key on — presence alone is the "fires" reason (WP-003 r1/r2/r3):
  // pull_request(_target) on same-repo candidate branches, and workflow_run
  // (chained off another workflow, privileged).
  const PRIVILEGED_EVENTS = ["pull_request_target", "pull_request", "workflow_run"];
  // A richer probe set than the three concrete samples, so ordered evaluation
  // catches exact sub-namespace patterns the samples miss (WP-003 r2). Full
  // symbolic glob∩namespace analysis is WP-118/CAM-SEC-03 onboarding.
  const probes = [...candidateRefs, ...NAMESPACE_PROBES];

  const shorthand = typeof on === "string" ? [on] : Array.isArray(on) ? on : null;
  if (shorthand) {
    if (shorthand.includes("push")) {
      reasons.push(`on: push (all branches) fires on ${candidateRefs.join(", ")}`);
    }
    for (const ev of PRIVILEGED_EVENTS) {
      if (shorthand.includes(ev)) reasons.push(`on: ${ev} runs with base-repo secrets`);
    }
    return reasons;
  }
  const onObj = asRecord(on);
  if (!onObj) return reasons;

  for (const ev of PRIVILEGED_EVENTS) {
    if (ev in onObj) reasons.push(`${ev} runs with base-repo secrets / privileged context`);
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
        const tagsOnly =
          branches.length === 0 &&
          ignore.length === 0 &&
          (specObj["tags"] !== undefined || specObj["tags-ignore"] !== undefined);
        if (tagsOnly) {
          // A push filter with ONLY tags does not run on branch events, so it
          // never fires on a candidate branch ref (WP-003 r2).
        } else if (branches.length === 0 && ignore.length === 0) {
          reasons.push(
            `push: (no branches filter ⇒ all branches) fires on ${candidateRefs.join(", ")}`,
          );
        } else if (branches.length > 0) {
          // Ordered last-match-wins over the probe set — respects `!` re-exclusion
          // (WP-003 r3) and covers sub-namespaces the samples miss (r2).
          for (const h of firesOnBranches(branches, probes)) {
            reasons.push(`push.branches ${JSON.stringify(branches)} fires on ${h}`);
          }
        } else if (ignore.length > 0) {
          const ignored = new Set(firesOnBranches(ignore, probes));
          for (const ref of probes) {
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
  // index form `secrets['NAME']` / `secrets["NAME"]` (WP-003 r1).
  const secretRefs = new Set<string>();
  const secretRe = /\$\{\{\s*secrets(?:\.([A-Za-z0-9_]+)|\[\s*['"]([^'"]+)['"]\s*\])/g;
  for (const m of rawText.matchAll(secretRe)) {
    const name = m[1] ?? m[2] ?? "";
    if (name && name !== "GITHUB_TOKEN") secretRefs.add(name);
  }
  if (secretRefs.size > 0) reasons.push(`references secrets: ${[...secretRefs].join(", ")}`);
  // The whole `secrets` object used as a value — `toJSON(secrets)` or a bare
  // `${{ secrets }}` — exposes EVERY secret at once and names none (WP-003 r3).
  if (/\$\{\{[^}]*\bsecrets\b(?!\s*[.[])[^}]*\}\}/.test(rawText)) {
    reasons.push("references the whole `secrets` object (e.g. toJSON(secrets)) — all secrets");
  }

  // Token permissions: explicit all-read is safe; write (or absent) is not —
  // checked at the top level AND per-job (`jobs.<id>.permissions`, WP-003 r1).
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
      if (!jobObj) continue;
      if ("permissions" in jobObj) {
        const w = writeScopes(jobObj["permissions"]);
        if (w.length > 0) reasons.push(`job "${jobId}" permissions grant write: ${w.join(", ")}`);
      }
      // A reusable-workflow call with `secrets: inherit` passes ALL of the
      // caller's secrets to the called workflow — invisible to a literal
      // `secrets.X` scan (WP-003 r2).
      const secrets = jobObj["secrets"];
      if (secrets === "inherit") {
        reasons.push(`job "${jobId}" passes secrets: inherit to a reusable workflow`);
      } else if (asRecord(secrets)) {
        reasons.push(`job "${jobId}" forwards named secrets to a reusable workflow`);
      }
    }
  }
  return reasons;
}

/** Analyze one workflow file. Returns a finding iff it is privileged-on-candidate. */
export function analyzeWorkflow(
  file: string,
  content: string,
  candidateRefs: readonly string[],
): WorkflowFinding | null {
  let doc: Record<string, unknown> | null = null;
  try {
    doc = asRecord(yaml.load(content));
  } catch {
    // An unparseable workflow is treated as privileged (fail-closed): we cannot
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

/** Scan a set of workflow files; return one finding per privileged-on-candidate workflow. */
export function scanWorkflowPosture(
  files: ReadonlyArray<{ path: string; content: string }>,
  candidateRefs: readonly string[],
): WorkflowFinding[] {
  const out: WorkflowFinding[] = [];
  for (const f of files) {
    const finding = analyzeWorkflow(f.path, f.content, candidateRefs);
    if (finding) out.push(finding);
  }
  return out;
}

/** The Camino-managed namespaces a candidate ref can live under (design §5.5). */
export const CANDIDATE_REFS: readonly string[] = Object.freeze([
  "camino/candidate/issue-42/1",
  "mission/7",
  "camino/tmp/validate/abc123",
]);
