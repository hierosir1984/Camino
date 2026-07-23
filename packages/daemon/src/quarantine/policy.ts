// WP-108 quarantine — policy checks (CAM-EXEC-04, design §5.1).
//
// Pure functions over the parsed final tree and the base↔head diff. Each
// returns Rejection[] (collect-all, never throws), so one intake run reports
// every violation a candidate carries. Product promotion of the WP-003 spike:
// the malformed-object class is delegated to `git fsck` (in git.ts / intake.ts),
// and canonical path-identity uses an ICU-backed fold (see checkPathCollisions)
// rather than the spike's hand-rolled residual list — the two hard-learned
// lessons from that spike's r1–r3 review.
import { MAX_CHANGED_PATHS, REGISTRY_ITEM_11_QUOTAS } from "@camino/shared";
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
 * HFS+ IGNORABLE codepoints are stripped FIRST: a case-insensitive HFS+ volume
 * ignores a fixed set of formatting codepoints (zero-width joiners, bidi
 * controls, the BOM) when it compares names, so `.gitattributes` with a
 * U+200C spliced in is the SAME file as `.gitattributes` on that volume, and
 * git's own `is_hfs_dotgit` strips exactly this set (review r6 finding 2). NFKC
 * does NOT remove these (they are valid format controls), so without the strip a
 * spliced protected name folds to itself and slips both the collision and the
 * protected-identity check. The set is git's (utf8.c) — a bounded, authoritative
 * list, the delegate-to-git lesson applied to the fold.
 *
 * BOUNDARY, stated (the WP-003 "name the boundary" lesson): JavaScript exposes
 * no `u_strFoldCase`, so this is the HFS-ignorable strip + NFKC + an ICU
 * upper/lower round trip + the `ß` residual — a strong approximation of Unicode
 * default case folding, NOT the complete CaseFolding.txt table. Same- or
 * cross-script case-fold pairs beyond what NFKC and ICU's upper/lower casing
 * collapse may still slip; the design bias is to ERR TOWARD COLLAPSING (a false
 * collision over-rejects — the safe direction, e.g. the locale-dependent
 * `I`⇄`ı`; a MISS would be a missed collision, never an accept of something
 * worse). The complete target-filesystem identity oracle is deferred (a bundled
 * fold table / WP-118 onboarding).
 */
// Git's HFS+ ignorable set (utf8.c `is_hfs_dotgit`): zero-width (non-)joiners and
// LRM/RLM, the bidi embedding/override controls, the Arabic/national digit-shape
// controls, and the BOM (U+FEFF). A case-insensitive HFS+ volume ignores these in
// name comparison, so they cannot distinguish two paths.
const HFS_IGNORABLE_RE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

function foldKey(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(HFS_IGNORABLE_RE, "")
    .normalize("NFKC")
    .toUpperCase()
    .toLowerCase()
    .replace(/ß/g, "ss");
}

/**
 * The canonical identity of ONE path segment for PROTECTED-name matching: strip
 * the Windows aliases first (a trailing dot/space, and an NTFS `::$DATA` /
 * `::$INDEX_ALLOCATION` alternate-stream suffix — `stripWindowsAlias`), THEN
 * fold. So `.gitattributes.`, `.gitattributes::$DATA`, and `.GITATTRIBUTES` all
 * canonicalize to `.gitattributes` (review r3 finding 1). The collision key
 * (`foldKey`) deliberately does NOT strip these — a trailing-dot NAME is its own
 * collision/alias, reported by checkNameAliases — but a PROTECTED identity must
 * match the resolved target, which is what a target OS opens.
 */
function protectedSegment(seg: string): string {
  return foldKey(stripWindowsAlias(seg));
}

/** The whole path canonicalized segment-by-segment for protected-name matching. */
function protectedPathKey(path: string): string {
  return path
    .split("/")
    .map((s) => protectedSegment(s))
    .join("/");
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
// Windows also reserves — COM² etc. (WP-003 r1). CONIN$ / CONOUT$ are the console
// input/output DOS devices in Microsoft's `RtlIsDosDeviceName_U` set, absent from
// the earlier list (review r6 finding 4); a name that resolves to a device is a
// non-faithful materialization on Windows. NAMED BOUNDARY: the authoritative set
// is the Windows kernel's `RtlIsDosDeviceName_U`; this enumerates its documented
// members (CON/PRN/AUX/NUL, COM/LPT¹⁻⁹ incl. superscripts, CONIN$/CONOUT$).
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;

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
    // rather than guess (WP-003 r2). A LITERAL U+FFFD filename is indistinguishable
    // from a decode substitution here and is over-rejected — the safe direction,
    // and such a name is non-portable anyway (review r4 finding 5).
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
      if (is83ShortName(seg)) {
        out.push({
          code: "windows-alias",
          path: e.path,
          detail: `path segment "${seg}" is an NTFS 8.3 short-name alias (may resolve to a different long name, incl. a protected path)`,
        });
      }
    }
  }
  return out;
}

/**
 * Does a segment look like ANY NTFS 8.3 SHORT NAME (`GITATT~1`, `GI7D29~1`,
 * `FOO~12.TXT`, `~1000000`)? Windows can create such an alias for a long name and
 * it resolves to that long name on access — so it can alias a PROTECTED path the
 * long-name check never sees (review r4 finding 1). Git's REAL fallback short
 * name is HASH-based (`.gitattributes`→`GI7D29~1`, not `GITATT~1`; path.c), and
 * git tests a ZERO-length prefix with up to seven digits (`~1000000`,
 * `~9999999`) as an alias of `.gitmodules` (review r6 finding 3), so a name-
 * prefix allowlist — or a `{1,8}~{1,6}` shape that requires ≥1 leading char and
 * ≤6 digits — cannot enumerate them.
 *
 * The COMPLETE, over-reject-safe rule is MS-FSCC's own bound: an 8.3 name is
 * NAME(≤8).EXT(≤3), and the `~<digits>` tilde tail lives INSIDE the ≤8 NAME. So
 * a segment aliases iff its base (up to an optional `.ext`, tilde + digits
 * included) is ≤8 ASCII-non-space chars, contains `~<digits>`, and any extension
 * is ≤3 dot-free ASCII chars. That catches every zero-prefix/hash/index form AND
 * stops over-rejecting an impossible-as-8.3 long name — an 11-char base like
 * `report~2024` (review r6 finding 9), or a non-ASCII/space base like `café~1`
 * or `foo ~1` that MS-FSCC forbids in an 8.3 name (review r7 finding 10). NAMED
 * BOUNDARY: the exact NTFS short-name ALGORITHM is git's own
 * (`core.protectNTFS`) applied at a Windows checkout — this is the intake's
 * bounded shape rule for the tree's raw bytes, matching git's ≤8-base limit.
 */
function is83ShortName(seg: string): boolean {
  const s = stripWindowsAlias(seg);
  const dot = s.indexOf(".");
  const base = dot >= 0 ? s.slice(0, dot) : s;
  const ext = dot >= 0 ? s.slice(dot + 1) : "";
  if (base.length > 8 || ext.length > 3) return false;
  // MS-FSCC: an 8.3 name is ASCII below 0x80 and contains NO space. So a base
  // with a non-ASCII char (`café~1`) or a space (`foo ~1`) CANNOT be an 8.3 alias
  // — do not over-reject it (review r7 finding 10). `[\x21-\x7e]` is printable
  // ASCII excluding both space (0x20) and every codepoint >= 0x80.
  if (!/^[\x21-\x7e]*$/.test(ext)) return false;
  // Punctuation Windows FORBIDS in a short name but ALLOWS in a long name, so its
  // presence proves the segment is not a genuine 8.3 alias (review r8 finding 8).
  if (/[+,;=[\]]/.test(base) || /[+,;=[\]]/.test(ext)) return false;
  return /^[\x21-\x7e]*~[0-9]+$/.test(base);
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
  // Match `.gitmodules` by its CANONICAL identity (Windows-alias-stripped +
  // folded), not exact string, so a case/normalization alias (`.GitModules`) OR
  // a Windows alias (`.gitmodules.`, `.gitmodules::$DATA`) a target FS resolves
  // to `.gitmodules` cannot slip the retarget guard (review r2 finding 4, r3
  // finding 1).
  for (const p of changed) {
    if (protectedPathKey(p) === ".gitmodules") {
      out.push({
        code: "submodule-gitlink",
        path: p,
        detail: `worker changed .gitmodules (as "${p}") — submodule routing metadata may not be worker-edited`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// path length + changed-path validity
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

/**
 * Validate the CHANGED-path set (base↔head), which — unlike the final-tree
 * `entries` — includes DELETED paths. A deleted path with a non-UTF-8 name (git
 * decodes it to U+FFFD, so two distinct raw names can collapse) or over the
 * length cap otherwise never reaches the entry-level checks and would surface
 * only as a thrown or corrupted emitted diff (review r2 finding 7). Reject it
 * here as a policy result instead.
 */
export function checkChangedPathValidity(changed: readonly string[]): Rejection[] {
  const out: Rejection[] = [];
  // Cardinality: a candidate with more changed paths than the emitted-diff schema
  // admits would throw at emit rather than reject (review r3 finding 3). Bound it
  // as a policy result. 100,000 matches the @camino/shared MAX_CHANGED_PATHS.
  if (changed.length > MAX_CHANGED_PATHS) {
    out.push({
      code: "entry-budget",
      detail: `${changed.length} changed paths exceed the diff cap (${MAX_CHANGED_PATHS})`,
    });
  }
  for (const path of changed) {
    if (path.includes("�")) {
      out.push({
        code: "windows-alias",
        path,
        detail: `changed path "${path}" is not valid UTF-8 (non-portable, ambiguous identity)`,
      });
    }
    if (path.length > MAX_STORED_PATH_LENGTH) {
      out.push({
        code: "path-too-long",
        path: path.slice(0, 80) + "…",
        detail: `changed path is ${path.length} code units (budget ${MAX_STORED_PATH_LENGTH})`,
      });
    }
    // Non-canonical changed path: a backslash (Windows separator) or an empty /
    // `.` / `..` segment. A DELETED such path is not in the final-tree entries,
    // so only this check sees it; without it the path reaches the emitter and
    // THROWS at the schema instead of rejecting cleanly (review r3 finding 3).
    const segs = path.split("/");
    if (path.includes("\\") || segs.some((s) => s === "" || s === "." || s === "..")) {
      out.push({
        code: "windows-alias",
        path,
        detail: `changed path "${path}" is not a canonical repo-root-relative POSIX path`,
      });
    }
    // NTFS 8.3 short-name aliases in a DELETED path (`GITATT~1`) that
    // checkNameAliases (final-tree entries only) never sees (review r4 finding 1).
    if (segs.some((s) => is83ShortName(s))) {
      out.push({
        code: "windows-alias",
        path,
        detail: `changed path "${path}" contains an NTFS 8.3 short-name alias`,
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
  // Compare on the CANONICAL fold of each segment, not a plain lowercase: a
  // case-insensitive / normalizing host resolves `.GITATTRIBUTES`, `.GitHub/
  // Workflows`, `.Camino`, and — the round-2 finding — `.gitattributeſ` (long-s
  // ⇄ s under NFKC) to the protected identity, and git even applies a
  // `.GITATTRIBUTES` on such a host. Folding both sides catches the alias a
  // literal match missed (review r2 finding 1); the fold's own residual is the
  // named boundary in checkPathCollisions.
  const segs = path.split("/").map((s) => protectedSegment(s));
  const base = segs[segs.length - 1];
  if (base === ".gitattributes") return true;
  if (segs[0] === ".github" && (segs[1] === "workflows" || segs[1] === "actions")) return true;
  if (segs[0] === ".camino") return true;
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
