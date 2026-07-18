// WP-003 quarantine policy checks — pure functions over the parsed final tree
// and the base↔head diff. Each returns Rejection[] (collect-all, never throws),
// so one intake run reports every violation a fixture carries.
import type { Budgets, Rejection, TreeEntry } from "./types.js";

// --- path canonicalization (case-fold + Unicode collisions) ---

/**
 * Full case-fold expansions NFKC does not perform. NFKC already folds the Latin
 * ligatures (ﬁ→fi …), the long s (ſ→s), and superscripts, so only `ß`⇄`SS`
 * remains (it has no compatibility decomposition). Not a complete Unicode fold —
 * the product check (WP-108) uses ICU — but it errs toward collapsing, and a
 * false collision is safe while a missed one is not (review r1 #8 / r2 #6).
 */
function foldExpand(s: string): string {
  return s.replace(/ß/g, "ss");
}

/**
 * Canonical collision key for one path. Steps, per segment:
 *  - treat `\` as `/` (Windows separator equivalence — review r2 #7);
 *  - NFKC-normalize, apply the residual full-folds, then lowercase.
 * Two stored paths sharing this key would resolve to one file on a
 * case-insensitive / normalizing filesystem. (Paths that are not valid UTF-8
 * are rejected upstream by checkNameAliases, so they never reach here as an
 * ambiguous replacement-char string — review r2 #8.)
 */
function fullyCanonical(path: string): string {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => foldExpand(s.normalize("NFKC")).toLowerCase())
    .join("/");
}

/**
 * Two distinct stored paths that map to the same OS file are a smuggling/overwrite
 * vector: on a case-insensitive or Unicode-normalizing filesystem one silently
 * shadows the other. Reject any such collision in the final tree, labelling
 * whether the paths differ only by case or by Unicode composition.
 */
export function checkPathCollisions(entries: readonly TreeEntry[]): Rejection[] {
  const byCanonical = new Map<string, string[]>();
  for (const e of entries) {
    const key = fullyCanonical(e.path);
    const list = byCanonical.get(key) ?? [];
    if (!list.includes(e.path)) list.push(e.path);
    byCanonical.set(key, list);
  }
  const out: Rejection[] = [];
  for (const paths of byCanonical.values()) {
    if (paths.length < 2) continue;
    // Case-only iff lowercasing ALONE (no normalization) already collapses them;
    // if NFC was needed to make them collide, the difference is Unicode
    // composition (e.g. composed "é" vs "e"+combining-accent).
    const caseOnly = new Set(paths.map((p) => p.toLowerCase())).size === 1;
    out.push({
      code: caseOnly ? "path-collision-case" : "path-collision-unicode",
      path: paths.join(" ⇄ "),
      detail: `paths collide under ${caseOnly ? "case-folding" : "Unicode normalization"}: ${paths.join(", ")}`,
    });
  }
  return out;
}

// --- reserved names & trailing-dot/space / Windows-alias segments ---

// COM/LPT digits include the superscript forms ¹²³ (U+00B9/B2/B3), which
// Windows also reserves — COM² etc. (review r1 #7).
const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i;

/**
 * Strip the aliases Windows applies before it resolves a name: an NTFS alternate
 * data stream suffix (`name::$DATA`, `.git::$INDEX_ALLOCATION`) and any trailing
 * dots/spaces. `foo.txt::$DATA` and `foo.txt` are the same file; `.git::$INDEX_
 * ALLOCATION` reaches the `.git` dir (review r2 #2).
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
    // its real bytes are non-portable and its identity is ambiguous (distinct
    // byte paths would collapse to one string). Reject rather than guess
    // (review r2 #8).
    if (e.path.includes("�")) {
      out.push({
        code: "windows-alias",
        path: e.path,
        detail: `path "${e.path}" is not valid UTF-8 (non-portable, ambiguous identity)`,
      });
    }
    for (const seg of e.path.split("/")) {
      // A `\` segment is a Windows path separator smuggled past our `/` split,
      // and a `:` is an NTFS ADS marker / invalid POSIX-portable char; either
      // makes the path mean different things across platforms (review r2 #7, #2).
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

// --- `.git` directory smuggling ---

/** A path segment that resolves to a `.git` directory on some platform. */
function isDotGitSegment(seg: string): boolean {
  // Strip NTFS ADS + trailing dots/spaces first, then match `.git` (any case) or
  // the 8.3 short-name alias `git~N` (review r1 + r2 #2).
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
          detail: `path contains a .git segment ("${seg}") — repo-internals smuggling`,
        });
        break;
      }
    }
  }
  return out;
}

// --- submodule / gitlink ---

/**
 * A gitlink (mode 160000) pulls in out-of-tree history the intake never vetted.
 * Only a gitlink the worker INTRODUCED or moved is rejected — one already
 * present and unchanged in the assigned base is not the worker's doing
 * (CAM-EXEC-04 says block *introductions*; review r2 #9). `changed` is the
 * base↔head path set.
 */
export function checkSubmodules(
  entries: readonly TreeEntry[],
  changed: ReadonlySet<string>,
): Rejection[] {
  return entries
    .filter((e) => (e.mode === "160000" || e.type === "commit") && changed.has(e.path))
    .map((e) => ({
      code: "submodule-gitlink" as const,
      path: e.path,
      detail: `submodule/gitlink introduced at "${e.path}" (${e.sha})`,
    }));
}

// --- symlink target escapes ---

/** Does a symlink at `linkPath` with `target` resolve outside the repo root? */
export function symlinkEscapes(linkPath: string, target: string): boolean {
  if (target.length === 0) return true;
  // A NUL or control byte cannot be a real symlink target (the OS truncates at
  // NUL), so the stored candidate would not materialize faithfully — reject
  // (review r2 #11).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(target)) return true;
  if (target.startsWith("/")) return true; // POSIX absolute
  // Any `X:` prefix is a Windows drive path — absolute (`C:\x`) OR drive-relative
  // (`C:x`, resolved against drive C's cwd, outside our lexical root) (review r1 #6).
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

/** `targets` maps each symlink entry path → its stored target string. */
export function checkSymlinks(
  entries: readonly TreeEntry[],
  targets: ReadonlyMap<string, string>,
): Rejection[] {
  const out: Rejection[] = [];
  for (const e of entries) {
    if (e.mode !== "120000") continue;
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

// --- size / count budgets ---

/**
 * `objectCount` is the count of ALL objects in the final tree — every subtree
 * plus every leaf — not just the flattened leaves: a pathologically deep tree
 * has one leaf but arbitrarily many tree objects, which is the resource bomb the
 * budget must catch (review r1 #5). The intake supplies it from `ls-tree -r -t`.
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

// --- scope vs contract & protected paths (over CHANGED paths) ---

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
 * `.gitattributes` (rewrites how blobs are interpreted), CI definitions
 * (`.github/workflows/**` — the token/secrets surface), and `.camino/**`
 * (Camino's own config). Match order is basename for `.gitattributes`, prefix
 * for the directory sets.
 */
export function isProtectedPath(path: string): boolean {
  // Case-insensitive: a case-insensitive host (macOS/Windows) resolves
  // `.GITATTRIBUTES` / `.GitHub/Workflows` / `.Camino` to the protected path,
  // and git even applies a `.GITATTRIBUTES` on such a host (review r1 #1).
  const p = path.toLowerCase();
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (base === ".gitattributes") return true;
  if (p === ".github/workflows" || p.startsWith(".github/workflows/")) return true;
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
