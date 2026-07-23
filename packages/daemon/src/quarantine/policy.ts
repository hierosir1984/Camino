// WP-108 quarantine — policy checks (CAM-EXEC-04, design §5.1).
//
// Pure functions over the parsed final tree and the base↔head diff. Each
// returns Rejection[] (collect-all, never throws), so one intake run reports
// every violation a candidate carries. Product promotion of the WP-003 spike:
// the malformed-object class is delegated to `git fsck` (in git.ts / intake.ts),
// and canonical path-identity uses an ICU-backed fold (see checkPathCollisions)
// rather than the spike's hand-rolled residual list — the two hard-learned
// lessons from that spike's r1–r3 review.
import { REGISTRY_ITEM_11_QUOTAS } from "@camino/shared";
import { MAX_STORED_PATH_LENGTH } from "./types.js";
import type { Budgets, FetchBudget, Rejection, TreeEntry } from "./types.js";

// ---------------------------------------------------------------------------
// canonical path identity — case-fold + Unicode-normalization collisions
// ---------------------------------------------------------------------------

/**
 * ICU is the case-fold authority here. Each path segment/prefix is reduced to a
 * canonical fold KEY; two distinct stored paths whose keys are EQUAL would
 * resolve to one file on a case-insensitive or Unicode-normalizing filesystem.
 *
 * The fold, all ICU-backed: `\`→`/` (Windows separator equivalence), NFKC
 * (composition + compatibility: NFC⇄NFD, ligatures ﬁ→fi, long s ſ→s,
 * superscripts …), then an UPPERCASE→LOWERCASE round trip, then `ß`→`ss`.
 *
 *   - The `toUpperCase().toLowerCase()` round trip is what makes this a case
 *     FOLD rather than a mere lowercase: ICU's special casing maps the capital
 *     sharp S `ẞ`, the combining ypogegrammeni `ͅ`→`ι`, and the like — pairs a
 *     plain `toLowerCase()` (or the WP-003 spike's hand-rolled residual list)
 *     MISSED, yet which a case-insensitive APFS/HFS+ volume collapses to one
 *     inode (review r1 finding 6). Accents are PRESERVED across the round trip
 *     (`café`⇄`CAFÉ`⇄`café`), so a legitimately distinct `café.txt`/`cafe.txt`
 *     is NOT a false collision (unlike an accent-insensitive `base` collation).
 *   - `ß`→`ss` closes the one case-fold the round trip still leaves: `ẞ`→`ß` (a
 *     lowercase, not `ss`), so applying it last folds `ẞ`, `ß`, and `SS` alike.
 *
 * BOUNDARY, stated (the WP-003 "name the boundary" lesson): JavaScript exposes
 * no `u_strFoldCase`, so this is NFKC + an ICU upper/lower round trip + the `ß`
 * residual — a strong approximation of Unicode default case folding, NOT the
 * complete CaseFolding.txt table. Same- or cross-script case-fold pairs beyond
 * what NFKC and ICU's upper/lower casing collapse may still slip; the design
 * bias is to ERR TOWARD COLLAPSING (a false collision over-rejects — the safe
 * direction, e.g. the locale-dependent `I`⇄`ı`; a MISS would be a missed
 * collision, never an accept of something worse). The complete target-filesystem
 * identity oracle is deferred (a bundled fold table / WP-118 onboarding).
 */
function foldKey(path: string): string {
  return path.replace(/\\/g, "/").normalize("NFKC").toUpperCase().toLowerCase().replace(/ß/g, "ss");
}

/** Every prefix (each ancestor directory component + the full path) of a stored path. */
function pathPrefixes(path: string): string[] {
  const segs = path.split("/");
  const out: string[] = [];
  for (let i = 1; i <= segs.length; i++) out.push(segs.slice(0, i).join("/"));
  return out;
}

/**
 * Two distinct stored paths that a case-insensitive or Unicode-normalizing
 * filesystem would resolve to one file are an aliasing/overwrite hazard. Reject
 * any such collision in the final tree, labelling whether the paths differ only
 * by case or by Unicode composition/compatibility.
 *
 * EVERY path prefix is keyed, not just leaves: a root symlink `A` and a
 * directory `a/file` collide through the `A`⇄`a` component even though their
 * leaf paths differ (the WP-003 r3 ancestor-component finding). Grouping is by
 * EXACT fold-key equality (a Map) — an unambiguous equivalence relation, no sort
 * or collator ordering to reason about.
 */
export function checkPathCollisions(entries: readonly TreeEntry[]): Rejection[] {
  // De-duplicate prefixes (a shared ancestor appears under many leaves), then
  // bucket by canonical fold key.
  const seen = new Set<string>();
  const byKey = new Map<string, string[]>();
  for (const e of entries) {
    for (const prefix of pathPrefixes(e.path)) {
      if (seen.has(prefix)) continue;
      seen.add(prefix);
      const key = foldKey(prefix);
      const bucket = byKey.get(key);
      if (bucket) bucket.push(prefix);
      else byKey.set(key, [prefix]);
    }
  }
  const out: Rejection[] = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    // Case-only iff lowercasing ALONE (no normalization/fold) already collapses
    // the whole group; if NFKC or the case fold was needed to make them collide,
    // the difference is Unicode composition/compatibility (composed "é" vs
    // "e"+combining-accent, or `ẞ`⇄`SS`).
    const caseOnly = new Set(group.map((p) => p.toLowerCase())).size === 1;
    out.push({
      code: caseOnly ? "path-collision-case" : "path-collision-unicode",
      path: group.join(" ⇄ "),
      detail: `paths collide under ${caseOnly ? "case-folding" : "Unicode normalization"}: ${group.join(", ")}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// reserved names & trailing-dot/space / Windows-alias segments
// ---------------------------------------------------------------------------

// COM/LPT digits include the superscript forms ¹²³ (U+00B9/B2/B3), which
// Windows also reserves — COM² etc. (WP-003 r1).
const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;

/**
 * Strip the aliases Windows applies before it resolves a name: an NTFS alternate
 * data stream suffix (`name::$DATA`, `.git::$INDEX_ALLOCATION`) and any trailing
 * dots/spaces. `foo.txt::$DATA` and `foo.txt` are the same file; `.git::$INDEX_
 * ALLOCATION` reaches the `.git` dir (WP-003 r2).
 */
function stripWindowsAlias(seg: string): string {
  const colon = seg.indexOf(":");
  const base = colon >= 0 ? seg.slice(0, colon) : seg;
  return base.replace(/[ .]+$/, "");
}

export function checkNameAliases(entries: readonly TreeEntry[]): Rejection[] {
  const out: Rejection[] = [];
  for (const e of entries) {
    // A path git handed us that did not round-trip as UTF-8 decodes to U+FFFD:
    // its real bytes are non-portable and its identity is ambiguous. Reject
    // rather than guess (WP-003 r2).
    if (e.path.includes("�")) {
      out.push({
        code: "windows-alias",
        path: e.path,
        detail: `path "${e.path}" is not valid UTF-8 (non-portable, ambiguous identity)`,
      });
    }
    for (const seg of e.path.split("/")) {
      // A `\` segment is a Windows path separator slipped past our `/` split,
      // and a `:` is an NTFS ADS marker / invalid POSIX-portable char; either
      // makes the path mean different things across platforms (WP-003 r2).
      if (seg.includes("\\") || seg.includes(":")) {
        out.push({
          code: "windows-alias",
          path: e.path,
          detail: `path segment "${seg}" contains a backslash or colon (Windows separator / ADS)`,
        });
      }
      // Reserved device name — matched on the ADS/trailing-stripped stem, so
      // `con.txt`, `CON `, and `NUL::$DATA` all resolve.
      if (RESERVED.test(stripWindowsAlias(seg))) {
        out.push({
          code: "reserved-name",
          path: e.path,
          detail: `path segment "${seg}" resolves to a reserved device name`,
        });
      }
      if (/[ .]$/.test(seg)) {
        out.push({
          code: "trailing-dot-or-space",
          path: e.path,
          detail: `path segment "${seg}" has a trailing dot or space (aliases to "${seg.replace(/[ .]+$/, "")}")`,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// `.git` directory aliases
// ---------------------------------------------------------------------------

/** A path segment that resolves to a `.git` directory on some platform. */
function isDotGitSegment(seg: string): boolean {
  // Strip NTFS ADS + trailing dots/spaces first, then match `.git` (any case) or
  // the 8.3 short-name alias `git~N` (WP-003 r1 + r2).
  const s = stripWindowsAlias(seg);
  return /^\.git$/i.test(s) || /^git~[0-9]+$/i.test(s);
}

/**
 * A `.git` entry anywhere in the tree lets a worker rewrite repo internals when
 * the candidate is checked out (hooks, config, alternates). Reject any tree path
 * containing a `.git` segment or a short-name/trailing-alias of it. (`.gitignore`
 * / `.gitattributes` / `.gitmodules` are NOT `.git` and are handled elsewhere.)
 */
export function checkDotGitPaths(entries: readonly TreeEntry[]): Rejection[] {
  const out: Rejection[] = [];
  for (const e of entries) {
    for (const seg of e.path.split("/")) {
      if (isDotGitSegment(seg)) {
        out.push({
          code: "dotgit-path",
          path: e.path,
          detail: `path contains a .git segment ("${seg}") — repo-internals overwrite risk`,
        });
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// submodule / gitlink
// ---------------------------------------------------------------------------

/**
 * A gitlink (mode 160000) pulls in out-of-tree history the intake never vetted.
 * Only a gitlink the worker INTRODUCED or moved is rejected — one already
 * present and unchanged in the assigned base is not the worker's doing
 * (CAM-EXEC-04 blocks *introductions*; WP-003 r2). `changed` is the base↔head
 * path set.
 *
 * `.gitmodules` is the ROUTING metadata that maps a gitlink path to the URL git
 * clones it from. The "unchanged gitlink is safe" exception is only sound while
 * that routing is fixed: a worker that leaves the gitlink OID untouched but
 * edits `.gitmodules` to retarget it at an attacker-controlled repository has
 * changed where the submodule resolves. So ANY worker change to `.gitmodules`
 * is rejected here too (review r1 finding 5), regardless of gitlink changes.
 */
export function checkSubmodules(
  entries: readonly TreeEntry[],
  changed: ReadonlySet<string>,
): Rejection[] {
  const out: Rejection[] = entries
    .filter((e) => (e.mode === "160000" || e.type === "commit") && changed.has(e.path))
    .map((e) => ({
      code: "submodule-gitlink" as const,
      path: e.path,
      detail: `submodule/gitlink introduced at "${e.path}" (${e.sha})`,
    }));
  if (changed.has(".gitmodules")) {
    out.push({
      code: "submodule-gitlink",
      path: ".gitmodules",
      detail: "worker changed .gitmodules — submodule routing metadata may not be worker-edited",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// path length
// ---------------------------------------------------------------------------

/**
 * A stored path longer than MAX_STORED_PATH_LENGTH is rejected as a POLICY
 * violation, not left to fail later at the durable-diff schema (which would make
 * the emitter throw rather than return a rejection — review r1 finding 10). Such
 * a path passes git fsck and every other check, so without this it would reach
 * the accept branch and only then be refused by the schema's own cap.
 */
export function checkPathLength(entries: readonly TreeEntry[]): Rejection[] {
  const out: Rejection[] = [];
  for (const e of entries) {
    if (e.path.length > MAX_STORED_PATH_LENGTH) {
      out.push({
        code: "path-too-long",
        path: e.path.slice(0, 80) + "…",
        detail: `stored path is ${e.path.length} code units (budget ${MAX_STORED_PATH_LENGTH})`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// symlink target escapes
// ---------------------------------------------------------------------------

/** Does a symlink at `linkPath` with `target` resolve outside the repo root? */
export function symlinkEscapes(linkPath: string, target: string): boolean {
  if (target.length === 0) return true;
  // A NUL or control byte cannot be a real symlink target (the OS truncates at
  // NUL), so the stored candidate would not materialize faithfully — reject
  // (WP-003 r2).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(target)) return true;
  if (target.startsWith("/")) return true; // POSIX absolute
  // Any `X:` prefix is a Windows drive path — absolute (`C:\x`) OR drive-relative
  // (`C:x`, resolved against drive C's cwd, outside our lexical root) (WP-003 r1).
  if (/^[a-zA-Z]:/.test(target)) return true;
  if (target.startsWith("\\")) return true; // UNC / drive-relative
  // Resolve relative to the link's own directory, counting depth from root.
  const dir = linkPath.includes("/") ? linkPath.slice(0, linkPath.lastIndexOf("/")) : "";
  const parts = dir.length > 0 ? dir.split("/") : [];
  for (const seg of target.split(/[/\\]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return true; // escaped above root
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return false;
}

/** A symlink target is dangerous if it escapes the root OR dives into `.git`. */
export function symlinkTargetDanger(linkPath: string, target: string): "escape" | "dotgit" | null {
  if (target.split(/[/\\]/).some((seg) => isDotGitSegment(seg))) return "dotgit";
  if (symlinkEscapes(linkPath, target)) return "escape";
  return null;
}

/**
 * A real symlink target is a single path, bounded by PATH_MAX (~4 KiB). Anything
 * larger is not a symlink the OS could materialize — and reading it would blow
 * the subprocess buffer before any budget runs (WP-003 r3), so the intake does
 * not read oversized targets and we reject on size alone here.
 */
export const SYMLINK_TARGET_MAX_BYTES = 4096;

/** `targets` maps each symlink entry path → its stored target string. */
export function checkSymlinks(
  entries: readonly TreeEntry[],
  targets: ReadonlyMap<string, string>,
): Rejection[] {
  const out: Rejection[] = [];
  for (const e of entries) {
    if (e.mode !== "120000") continue;
    if (e.size != null && e.size > SYMLINK_TARGET_MAX_BYTES) {
      out.push({
        code: "symlink-escape",
        path: e.path,
        detail: `symlink "${e.path}" target is ${e.size} bytes (> ${SYMLINK_TARGET_MAX_BYTES}) — not a real symlink`,
      });
      continue;
    }
    const target = targets.get(e.path) ?? "";
    const danger = symlinkTargetDanger(e.path, target);
    if (danger === "escape") {
      out.push({
        code: "symlink-escape",
        path: e.path,
        detail: `symlink "${e.path}" targets "${target}", which escapes the repo root`,
      });
    } else if (danger === "dotgit") {
      out.push({
        code: "symlink-escape",
        path: e.path,
        detail: `symlink "${e.path}" targets "${target}", which points into a .git directory`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// size / count budgets
// ---------------------------------------------------------------------------

/**
 * The FINAL-TREE policy budget (design's "tree size budget"): per-blob size,
 * total tree bytes, and object count. `objectCount` is ALL objects in the tree
 * — every subtree plus every leaf — not just flattened leaves: a pathologically
 * DEEP tree has one leaf but arbitrarily many tree objects, the resource
 * blow-up the budget must catch (WP-003 r1). The intake supplies it from
 * `ls-tree -r -t`.
 */
export function checkBudgets(
  entries: readonly TreeEntry[],
  budgets: Budgets,
  objectCount: number,
): Rejection[] {
  const out: Rejection[] = [];
  if (objectCount > budgets.maxEntries) {
    out.push({
      code: "entry-budget",
      detail: `final tree has ${objectCount} objects, trees + leaves (budget ${budgets.maxEntries})`,
    });
  }
  let total = 0;
  for (const e of entries) {
    const size = e.size ?? 0;
    total += size;
    if (size > budgets.maxBlobBytes) {
      out.push({
        code: "blob-size-budget",
        path: e.path,
        detail: `blob "${e.path}" is ${size} bytes (budget ${budgets.maxBlobBytes})`,
      });
    }
  }
  if (total > budgets.maxTreeBytes) {
    out.push({
      code: "tree-size-budget",
      detail: `final tree totals ${total} bytes (budget ${budgets.maxTreeBytes})`,
    });
  }
  return out;
}

/**
 * The registry-item-11 FETCH budget (PRD §5 item 11: "fetch ≤5,000 objects /
 * 500 MB") — a HARD outer cap on the shallow-fetch footprint, NOT
 * contract-overridable. `objectCount` is the final-tree object count (the fetch
 * pulls exactly the final tree under `--depth=1`); `totalBytes` is the summed
 * blob size. A breach refuses the candidate: the intake proceeds no further and
 * discards the pristine store. The numbers come from `@camino/shared`
 * REGISTRY_ITEM_11_QUOTAS.fetch — one source, no drift.
 *
 * BOUNDARY, stated: this is an ADMISSION check computed AFTER the local fetch
 * completes — it refuses to squash-rebuild an over-budget candidate, but does
 * not prevent the local git transfer from the worker's already-bounded (≤2 GB
 * workspace) isolated clone. A pre-transfer/network ceiling is bounded
 * out-of-process by the WP-107 container + WP-114 supervisor, the same
 * in-process-best-effort / out-of-process-authoritative split WP-107 states.
 */
export const REGISTRY_ITEM_11_FETCH_BUDGET: FetchBudget = Object.freeze({
  maxObjects: REGISTRY_ITEM_11_QUOTAS.fetch.maxObjects,
  maxBytes: REGISTRY_ITEM_11_QUOTAS.fetch.maxBytes,
});

export function checkFetchBudget(
  objectCount: number,
  totalBytes: number,
  budget: FetchBudget = REGISTRY_ITEM_11_FETCH_BUDGET,
): Rejection[] {
  const out: Rejection[] = [];
  if (objectCount > budget.maxObjects) {
    out.push({
      code: "fetch-object-budget",
      detail: `shallow-fetch footprint is ${objectCount} objects (registry-item-11 budget ${budget.maxObjects})`,
    });
  }
  if (totalBytes > budget.maxBytes) {
    out.push({
      code: "fetch-size-budget",
      detail: `shallow-fetch footprint is ${totalBytes} bytes (registry-item-11 budget ${budget.maxBytes})`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// scope vs contract & protected paths (over CHANGED paths)
// ---------------------------------------------------------------------------

/** Minimal glob → RegExp: `**` spans `/`, `*`/`?` do not. */
function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` consumes an optional leading directory run; bare `**` spans all.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(re + "$");
}

export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

/**
 * Protected paths may never be touched by a worker, regardless of scope:
 * `.gitattributes` (rewrites how blobs are interpreted), CI definitions — both
 * workflow YAML (`.github/workflows/**`, the token/secrets surface) AND LOCAL
 * ACTIONS (`.github/actions/**`) — and `.camino/**` (Camino's own config).
 *
 * A local composite/JS action runs with the same privilege as the workflow that
 * references it (`uses: ./.github/actions/foo`), so a worker that edits an
 * action's code changes CI/gating behaviour without touching any protected
 * workflow YAML (review r1 finding 3). Match order is basename for
 * `.gitattributes`, prefix for the directory sets.
 *
 * BOUNDARY, stated: a workflow may reference a local action by an ARBITRARY path
 * (`uses: ./scripts/foo`), which this path list cannot enumerate. The complete
 * defence — parsing each workflow's `uses: ./…` references and protecting those
 * targets — is the WP-118 CI-posture onboarding analyzer (CAM-SEC-03). This list
 * covers the conventional `.github/actions/**` location; other `.github/*`
 * policy files that do not execute code (CODEOWNERS, dependabot.yml) are left
 * scope-governed, not protected.
 */
export function isProtectedPath(path: string): boolean {
  // Case-insensitive: a case-insensitive host (macOS/Windows) resolves
  // `.GITATTRIBUTES` / `.GitHub/Workflows` / `.Camino` to the protected path,
  // and git even applies a `.GITATTRIBUTES` on such a host (WP-003 r1).
  const p = path.toLowerCase();
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (base === ".gitattributes") return true;
  if (p === ".github/workflows" || p.startsWith(".github/workflows/")) return true;
  if (p === ".github/actions" || p.startsWith(".github/actions/")) return true;
  if (p === ".camino" || p.startsWith(".camino/")) return true;
  return false;
}

/** `changed` = every path added/modified/deleted between base and head. */
export function checkScopeAndProtected(
  changed: readonly string[],
  allowedPaths: readonly string[],
): Rejection[] {
  const out: Rejection[] = [];
  for (const path of changed) {
    if (isProtectedPath(path)) {
      out.push({
        code: "protected-path",
        path,
        detail: `worker changed protected path "${path}"`,
      });
      continue; // a protected change is reported once, not also as out-of-scope
    }
    if (!matchesAnyGlob(path, allowedPaths)) {
      out.push({
        code: "out-of-scope",
        path,
        detail: `changed path "${path}" is outside the contract scope [${allowedPaths.join(", ")}]`,
      });
    }
  }
  return out;
}
