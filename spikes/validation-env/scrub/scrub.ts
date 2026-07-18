// Retained-artifact scrubbing — WP-005 (CAM-VAL-03 scrubbing half, CAM-SEC-08
// groundwork "scrubbing before storage").
//
// Scope, per PRD §5.3 (design 17): this is LITERAL secret-pattern scrubbing —
// the caller supplies the exact secret values it injected (in production the
// vault knows them), and every retained byte and file name is cleared of:
//   - the raw literal,
//   - its base64 form: standard (+/) AND url-safe (-_), canonical plus all 3
//     stream alignments — so it is found inside a larger base64 blob, and JWT
//     segments (base64url) are covered;
//   - its URL-encoded forms: canonical encodeURIComponent, plus the
//     lowercase-hex and space-as-"+" (form) dialects.
// Transformed encodings beyond these (compression, reversal, chunking, …) are
// the T3 residual — stated, not hidden (see scrub.test.ts, which asserts the
// documented misses, and the README risk-model section).
//
// Fail-closed posture:
//   - nothing is written into retainedDir before it has been redacted, and the
//     ENTIRE retained tree is re-walked afterwards (bytes + names) plus the
//     serialized report; any residue deletes the file and drops verifiedClean;
//   - files are read through an O_NOFOLLOW descriptor and fstat'd on that same
//     descriptor (no lstat→read symlink/size TOCTOU); symlinks, special files,
//     oversize files, and beyond-depth trees are withheld, never copied
//     unscanned;
//   - short secrets are refused, and any secret id whose redaction marker would
//     reproduce ANY variant of ANY secret is refused (so a report/name can
//     never encode a secret via a marker).
//
// Reuse shape: WP-115 wires this into retention — the per-file result is a
// PRECURSOR to the evidence-packet artifact item (`path`, `sha256`,
// `scrubbed`); WP-115 adds the packet's `type`/`sha`/`base_sha`/`class` fields.
import { createHash } from "node:crypto";
import { constants as FS } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export interface SecretSpec {
  id: string;
  value: string;
}

export type SecretEncoding = "raw" | "base64" | "base64url" | "urlencoded";

export interface Occurrence {
  secretId: string;
  encoding: SecretEncoding;
  count: number;
}

export interface RetainedArtifact {
  /** Retained relative path (differs from sourcePath when the name carried a secret). */
  path: string;
  /** Source relative path, itself name-redacted so the report never carries secret material. */
  sourcePath: string;
  /** sha256 of the retained bytes — the evidence-packet artifact identity. */
  sha256: string;
  /** True iff any redaction happened (the packet `scrubbed` field). */
  scrubbed: boolean;
  occurrences: Occurrence[];
}

export type WithholdReason = "symlink" | "special-file" | "oversize" | "depth" | "verify-failed";

export interface WithheldArtifact {
  path: string;
  reason: WithholdReason;
  detail: string;
}

export interface ScrubReport {
  artifacts: RetainedArtifact[];
  withheld: WithheldArtifact[];
  /** True iff the post-write re-scan of the whole retained tree + report found zero variants. */
  verifiedClean: boolean;
}

export interface ScrubOptions {
  sourceDir: string;
  /** Must be fresh (absent or empty): retained copies never mix with pre-existing content. */
  retainedDir: string;
  secrets: SecretSpec[];
  /** Files larger than this are withheld, never retained unscanned. Default 32 MiB. */
  maxFileBytes?: number;
}

export const MIN_SECRET_LENGTH = 8;
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_ENTRIES = 10_000;
// base64 cores shorter than this are skipped (false-positive floor). The raw
// form is always covered; only some alignments of very short secrets lose
// their base64 variant.
const MIN_B64_CORE = 8;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

interface Variant {
  secretId: string;
  encoding: SecretEncoding;
  needle: Buffer;
}

const bufferMarker = (id: string, enc: SecretEncoding): string => `[SCRUBBED:${id}:${enc}]`;
const nameMarker = (id: string): string => `SCRUBBED-${id}`;

/** All search variants for one secret (exported for the suite's independent re-scan). */
export function variantsFor(secret: SecretSpec): Variant[] {
  const raw = Buffer.from(secret.value, "utf8");
  const out: Variant[] = [{ secretId: secret.id, encoding: "raw", needle: raw }];

  // base64: canonical padded encoding (consumes standalone blobs whole), plus
  // the 3 stream alignments; alignment quanta that mix neighbouring stream
  // bytes are dropped so the core matches regardless of surrounding content.
  // Boundary quanta can leave up to the base64 chars covering 2 residual bytes
  // (i.e. up to 3 base64 chars) of an embedded value — a stated bound; the raw
  // form is always covered. See README.
  const cores = new Set<string>();
  const full = raw.toString("base64").replace(/=+$/u, "");
  if (full.length >= MIN_B64_CORE) cores.add(full);
  for (let shift = 0; shift < 3; shift++) {
    let enc = Buffer.concat([Buffer.alloc(shift), raw])
      .toString("base64")
      .replace(/=+$/u, "");
    if (shift > 0) enc = enc.slice(4);
    if ((shift + raw.length) % 3 !== 0) enc = enc.slice(0, -4);
    if (enc.length >= MIN_B64_CORE) cores.add(enc);
  }
  for (const core of cores) {
    out.push({ secretId: secret.id, encoding: "base64", needle: Buffer.from(core, "utf8") });
    // url-safe alphabet (JWT segments, URL-safe tokens): +→-, /→_.
    const urlsafe = core.replace(/\+/gu, "-").replace(/\//gu, "_");
    if (urlsafe !== core) {
      out.push({
        secretId: secret.id,
        encoding: "base64url",
        needle: Buffer.from(urlsafe, "utf8"),
      });
    }
  }

  // URL-encoding dialects: canonical encodeURIComponent (uppercase hex, %20 for
  // space), plus lowercase-hex and space-as-"+" (application/x-www-form-
  // urlencoded). Deduped; only those that differ from the raw literal are kept.
  const canonical = encodeURIComponent(secret.value);
  const urlForms = new Set<string>([
    canonical,
    canonical.replace(/%[0-9A-F]{2}/gu, (m) => m.toLowerCase()),
    canonical.replace(/%20/gu, "+"),
    canonical.replace(/%20/gu, "+").replace(/%[0-9A-F]{2}/gu, (m) => m.toLowerCase()),
  ]);
  for (const form of urlForms) {
    if (form !== secret.value) {
      out.push({ secretId: secret.id, encoding: "urlencoded", needle: Buffer.from(form, "utf8") });
    }
  }
  return out;
}

function validateSecrets(secrets: SecretSpec[], allVariants: Variant[]): void {
  if (secrets.length === 0) throw new Error("scrub: at least one secret is required");
  const ids = new Set<string>();
  for (const s of secrets) {
    if (!ID_RE.test(s.id)) throw new Error(`scrub: secret id ${JSON.stringify(s.id)} rejected`);
    if (ids.has(s.id)) throw new Error(`scrub: duplicate secret id '${s.id}'`);
    ids.add(s.id);
    if (s.value.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `scrub: secret '${s.id}' is shorter than ${String(MIN_SECRET_LENGTH)} chars — refusing ` +
          "(a short literal shreds artifacts and gives false confidence; fail-closed)",
      );
    }
  }
  // A redaction marker must never reproduce ANY variant of ANY secret — else a
  // marked name/report could itself encode a secret (e.g. an id equal to
  // another secret's base64). Checked against every variant, not just raw
  // values, and also rules out non-terminating replacement.
  const encodings: SecretEncoding[] = ["raw", "base64", "base64url", "urlencoded"];
  for (const s of secrets) {
    const markers = [...encodings.map((e) => bufferMarker(s.id, e)), nameMarker(s.id)];
    for (const v of allVariants) {
      const needle = v.needle.toString("utf8");
      if (markers.some((m) => m.includes(needle))) {
        throw new Error(
          `scrub: redaction marker for id '${s.id}' would reproduce a ${v.encoding} variant of ` +
            `secret '${v.secretId}' — rejected (fail-closed)`,
        );
      }
    }
  }
}

type Counts = Map<string, Occurrence>;

function bump(counts: Counts, secretId: string, encoding: SecretEncoding): void {
  const key = `${secretId} ${encoding}`;
  const cur = counts.get(key);
  if (cur) cur.count += 1;
  else counts.set(key, { secretId, encoding, count: 1 });
}

/**
 * Single linear pass per needle: collect every match index, then splice the
 * marker in once. O(n) per needle rather than the O(n·occurrences) that a
 * repeated whole-buffer concat costs — a 32 MiB artifact packed with an
 * 8-byte secret would otherwise drive millions of full-buffer copies (a
 * denial vector on agent-controlled artifacts).
 */
function redactBuffer(input: Buffer, variants: Variant[], counts: Counts): Buffer {
  // Longest needle first: a value containing another value redacts as itself.
  const sorted = [...variants].sort((a, b) => b.needle.length - a.needle.length);
  let cur = input;
  for (const v of sorted) {
    const marker = Buffer.from(bufferMarker(v.secretId, v.encoding), "utf8");
    const pieces: Buffer[] = [];
    let from = 0;
    let hits = 0;
    for (;;) {
      const i = cur.indexOf(v.needle, from);
      if (i === -1) break;
      pieces.push(cur.subarray(from, i), marker);
      from = i + v.needle.length;
      hits += 1;
    }
    if (hits > 0) {
      pieces.push(cur.subarray(from));
      cur = Buffer.concat(pieces);
      for (let k = 0; k < hits; k++) bump(counts, v.secretId, v.encoding);
    }
  }
  return cur;
}

function redactName(segment: string, variants: Variant[], counts: Counts | null): string {
  let out = segment;
  const sorted = [...variants].sort((a, b) => b.needle.length - a.needle.length);
  for (const v of sorted) {
    const needle = v.needle.toString("utf8");
    while (out.includes(needle)) {
      out = out.replace(needle, nameMarker(v.secretId));
      if (counts) bump(counts, v.secretId, v.encoding);
    }
  }
  return out;
}

function occurrencesFrom(counts: Counts): Occurrence[] {
  return [...counts.values()].sort(
    (a, b) => a.secretId.localeCompare(b.secretId) || a.encoding.localeCompare(b.encoding),
  );
}

interface WalkEntry {
  rel: string;
  kind: "file" | "withheld";
  reason?: WithholdReason;
  detail?: string;
}

async function walkSource(root: string): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  let entries = 0;
  const visit = async (dirRel: string, depth: number): Promise<void> => {
    const names = (await fs.readdir(path.join(root, dirRel))).sort();
    for (const name of names) {
      const rel = dirRel === "" ? name : `${dirRel}/${name}`;
      if (++entries > MAX_ENTRIES) {
        throw new Error(
          `scrub: artifact tree exceeds ${String(MAX_ENTRIES)} entries (fail-closed)`,
        );
      }
      const st = await fs.lstat(path.join(root, rel));
      if (st.isSymbolicLink()) {
        out.push({ rel, kind: "withheld", reason: "symlink", detail: "symbolic link" });
      } else if (st.isDirectory()) {
        if (depth + 1 > MAX_DEPTH) {
          out.push({
            rel,
            kind: "withheld",
            reason: "depth",
            detail: `deeper than ${String(MAX_DEPTH)}`,
          });
        } else {
          await visit(rel, depth + 1);
        }
      } else if (st.isFile()) {
        out.push({ rel, kind: "file" });
      } else {
        out.push({ rel, kind: "withheld", reason: "special-file", detail: "not a regular file" });
      }
    }
  };
  await visit("", 0);
  return out;
}

/**
 * Read a regular file through an O_NOFOLLOW descriptor and fstat THAT
 * descriptor — a symlink swapped in after the walk fails the open (ELOOP), and
 * the size/type check is on the same fd that is read (no lstat→read TOCTOU).
 * Returns null with a withhold reason instead of reading anything unsafe.
 */
async function safeRead(
  abs: string,
  maxFileBytes: number,
): Promise<{ bytes: Buffer } | { withhold: WithholdReason; detail: string }> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(abs, FS.O_RDONLY | FS.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") {
      return { withhold: "symlink", detail: "symlink swapped in after walk (O_NOFOLLOW)" };
    }
    throw err;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile())
      return { withhold: "special-file", detail: "not a regular file at read time" };
    if (st.size > maxFileBytes) {
      return {
        withhold: "oversize",
        detail: `${String(st.size)} bytes > ${String(maxFileBytes)} cap — never retained unscanned`,
      };
    }
    return { bytes: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

async function assertFreshDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const existing = await fs.readdir(dir);
  if (existing.length > 0) {
    throw new Error(
      `scrub: retained dir ${dir} is not empty — refusing to mix with pre-existing content (fail-closed)`,
    );
  }
}

async function walkRetained(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  let names: string[];
  try {
    names = (await fs.readdir(path.join(root, rel))).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const r = rel === "" ? name : `${rel}/${name}`;
    const st = await fs.lstat(path.join(root, r));
    if (st.isDirectory()) out.push(...(await walkRetained(root, r)));
    else out.push(r);
  }
  return out;
}

/**
 * Scrub sourceDir into retainedDir. Nothing lands in retainedDir unredacted;
 * see the header comment for the full posture.
 */
export async function scrubRetained(opts: ScrubOptions): Promise<ScrubReport> {
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (!Number.isInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new Error(`scrub: maxFileBytes must be a positive integer (got ${String(maxFileBytes)})`);
  }
  const variants = opts.secrets.flatMap(variantsFor);
  validateSecrets(opts.secrets, variants);
  await assertFreshDir(opts.retainedDir);

  const artifacts: RetainedArtifact[] = [];
  const withheld: WithheldArtifact[] = [];
  const usedRetainedPaths = new Set<string>();

  for (const entry of await walkSource(opts.sourceDir)) {
    if (entry.kind === "withheld") {
      withheld.push({
        path: redactName(entry.rel, variants, null),
        reason: entry.reason ?? "special-file",
        detail: entry.detail ?? "",
      });
      continue;
    }
    const read = await safeRead(path.join(opts.sourceDir, entry.rel), maxFileBytes);
    if ("withhold" in read) {
      withheld.push({
        path: redactName(entry.rel, variants, null),
        reason: read.withhold,
        detail: read.detail,
      });
      continue;
    }

    const counts: Counts = new Map();
    const out = redactBuffer(read.bytes, variants, counts);
    let retainedRel = entry.rel
      .split("/")
      .map((seg) => redactName(seg, variants, counts))
      .join("/");
    // Distinct source names can redact to the same destination (e.g. a literal
    // "SCRUBBED-x" file alongside one whose name is secret x). Disambiguate
    // rather than throw (which would leave a partial retained tree).
    if (usedRetainedPaths.has(retainedRel)) {
      let n = 2;
      while (usedRetainedPaths.has(`${retainedRel}~${String(n)}`)) n++;
      retainedRel = `${retainedRel}~${String(n)}`;
    }
    usedRetainedPaths.add(retainedRel);

    const dest = path.join(opts.retainedDir, retainedRel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, out, { flag: "wx" });

    const occurrences = occurrencesFrom(counts);
    artifacts.push({
      path: retainedRel,
      sourcePath: redactName(entry.rel, variants, null),
      sha256: createHash("sha256").update(out).digest("hex"),
      scrubbed: occurrences.length > 0,
      occurrences,
    });
  }

  // Post-write verification: walk the ACTUAL retained tree (catches anything
  // written, expected or not — incl. names) and re-read each byte.
  let verifiedClean = true;
  const artifactByPath = new Map(artifacts.map((a) => [a.path, a]));
  for (const rel of await walkRetained(opts.retainedDir)) {
    const abs = path.join(opts.retainedDir, rel);
    const bytes = await fs.readFile(abs);
    const nameHit = variants.some((v) => rel.includes(v.needle.toString("utf8")));
    const byteHit = variants.some((v) => bytes.indexOf(v.needle) !== -1);
    if (nameHit || byteHit) {
      verifiedClean = false;
      await fs.rm(abs, { force: true });
      const a = artifactByPath.get(rel);
      if (a) artifacts.splice(artifacts.indexOf(a), 1);
      withheld.push({
        path: redactName(rel, variants, null),
        reason: "verify-failed",
        detail: "residue found in retained copy — deleted (fail-closed)",
      });
    }
  }

  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  withheld.sort((a, b) => a.path.localeCompare(b.path));
  const report: ScrubReport = { artifacts, withheld, verifiedClean };

  // Final belt-and-braces: the serialized report itself must carry no variant
  // (withheld names included). Marker-safety makes this true by construction;
  // assert it so a future change that breaks the invariant fails closed.
  const serialized = JSON.stringify(report);
  if (variants.some((v) => serialized.includes(v.needle.toString("utf8")))) {
    report.verifiedClean = false;
    throw new Error("scrub: serialized report carries a secret variant — refusing (fail-closed)");
  }
  return report;
}
