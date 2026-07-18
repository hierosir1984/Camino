// WP-003 quarantine policy checks — pure functions over the parsed final tree
// and the base↔head diff. Each returns Rejection[] (collect-all, never throws),
// so one intake run reports every violation a fixture carries.
import type { Budgets, Rejection, TreeEntry } from "./types.js";

// --- path canonicalization (case-fold + Unicode collisions) ---

/** Fully canonical key: NFC-normalized then case-folded, per segment. */
function fullyCanonical(path: string): string {
  return path
    .split("/")
    .map((s) => s.normalize("NFC").toLowerCase())
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

// --- reserved names & trailing-dot/space aliases ---

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Windows reserved device names (CON, NUL, COM1…, LPT1…) — matched on the stem,
 * so `con.txt` is reserved but `console.txt` is not — resolve to a device rather
 * than a file, and trailing-dot / trailing-space segments are silently trimmed by
 * Windows, aliasing to a different path. Either lets a tree mean two things across
 * platforms. Reject.
 */
export function checkNameAliases(entries: readonly TreeEntry[]): Rejection[] {
  const out: Rejection[] = [];
  for (const e of entries) {
    for (const seg of e.path.split("/")) {
      if (RESERVED.test(seg)) {
        out.push({
          code: "reserved-name",
          path: e.path,
          detail: `path segment "${seg}" is a reserved device name`,
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

// --- submodule / gitlink ---

/** A gitlink (mode 160000) pulls in out-of-tree history the intake never vetted. */
export function checkSubmodules(entries: readonly TreeEntry[]): Rejection[] {
  return entries
    .filter((e) => e.mode === "160000" || e.type === "commit")
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
  if (target.startsWith("/")) return true; // POSIX absolute
  if (/^[a-zA-Z]:[\\/]/.test(target)) return true; // Windows drive-absolute
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

/** `targets` maps each symlink entry path → its stored target string. */
export function checkSymlinks(
  entries: readonly TreeEntry[],
  targets: ReadonlyMap<string, string>,
): Rejection[] {
  const out: Rejection[] = [];
  for (const e of entries) {
    if (e.mode !== "120000") continue;
    const target = targets.get(e.path) ?? "";
    if (symlinkEscapes(e.path, target)) {
      out.push({
        code: "symlink-escape",
        path: e.path,
        detail: `symlink "${e.path}" targets "${target}", which escapes the repo root`,
      });
    }
  }
  return out;
}

// --- size / count budgets ---

export function checkBudgets(entries: readonly TreeEntry[], budgets: Budgets): Rejection[] {
  const out: Rejection[] = [];
  if (entries.length > budgets.maxEntries) {
    out.push({
      code: "entry-budget",
      detail: `final tree has ${entries.length} entries (budget ${budgets.maxEntries})`,
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
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base === ".gitattributes") return true;
  if (path === ".github/workflows" || path.startsWith(".github/workflows/")) return true;
  if (path === ".camino" || path.startsWith(".camino/")) return true;
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
