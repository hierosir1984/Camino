// Retained-artifact scrubbing — WP-005 (CAM-VAL-03 scrubbing half, CAM-SEC-08
// groundwork "scrubbing before storage").
//
// Scope, per PRD §5.3 (design 17): this is LITERAL secret-pattern scrubbing —
// the caller supplies the exact secret values it injected (in production the
// vault knows them), and every retained byte and file name is cleared of:
//   - the raw literal,
//   - its base64 form (canonical, plus all 3 stream alignments so it is found
//     inside a larger base64 blob — accidental leakage routinely rides
//     Basic-auth headers, JWT segments, config dumps),
//   - its URL-encoded form where that differs from the raw literal.
// Transformed encodings beyond these (compression, reversal, chunking, …) are
// the T3 residual — stated, not hidden (see scrub.test.ts, which asserts the
// documented misses, and the README risk-model section).
//
// Fail-closed posture:
//   - nothing is written into retainedDir before it has been redacted, and the
//     retained tree is re-verified afterwards; any residue deletes the file
//     and reports it withheld (verify-failed);
//   - symlinks, special files, oversize files, and beyond-depth trees are
//     withheld, never copied unscanned;
//   - short secrets are refused (they shred artifacts and give false
//     confidence), as are secret ids whose redaction markers would themselves
//     carry secret material.
//
// Reuse shape: WP-115 wires this into retention — the per-file result matches
// the evidence-packet artifact item (`path`, `sha256`, `scrubbed`).
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface SecretSpec {
  id: string;
  value: string;
}

export type SecretEncoding = "raw" | "base64" | "urlencoded";

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
  /** True iff the post-write re-scan of every retained byte and name found zero variants. */
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
  // base64: the canonical padded encoding (consumes standalone blobs whole),
  // plus the 3 stream alignments; alignment quanta that mix neighbouring
  // stream bytes are dropped so the core matches regardless of surrounding
  // content. Boundary quanta can leave ≤2 base64 chars (≤2 partial bytes) of
  // an embedded value — part of the stated approach, see README.
  const cores = new Set<string>();
  const full = raw.toString("base64");
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
  }
  const url = encodeURIComponent(secret.value);
  if (url !== secret.value) {
    out.push({ secretId: secret.id, encoding: "urlencoded", needle: Buffer.from(url, "utf8") });
  }
  return out;
}

function validateSecrets(secrets: SecretSpec[]): void {
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
  // Redaction markers must never themselves carry secret material (also rules
  // out non-terminating replacement).
  const encodings: SecretEncoding[] = ["raw", "base64", "urlencoded"];
  for (const s of secrets) {
    for (const t of secrets) {
      const markers = [...encodings.map((e) => bufferMarker(s.id, e)), nameMarker(s.id)];
      if (markers.some((m) => m.includes(t.value))) {
        throw new Error(
          `scrub: redaction marker for id '${s.id}' would contain the value of secret '${t.id}' — rejected`,
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

function redactBuffer(input: Buffer, variants: Variant[], counts: Counts): Buffer {
  // Longest needle first: a value containing another value redacts as itself.
  const sorted = [...variants].sort((a, b) => b.needle.length - a.needle.length);
  let cur = input;
  for (const v of sorted) {
    const marker = Buffer.from(bufferMarker(v.secretId, v.encoding), "utf8");
    for (;;) {
      const i = cur.indexOf(v.needle);
      if (i === -1) break;
      bump(counts, v.secretId, v.encoding);
      cur = Buffer.concat([cur.subarray(0, i), marker, cur.subarray(i + v.needle.length)]);
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

async function assertFreshDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const existing = await fs.readdir(dir);
  if (existing.length > 0) {
    throw new Error(
      `scrub: retained dir ${dir} is not empty — refusing to mix with pre-existing content (fail-closed)`,
    );
  }
}

/**
 * Scrub sourceDir into retainedDir. Nothing lands in retainedDir unredacted;
 * see the header comment for the full posture.
 */
export async function scrubRetained(opts: ScrubOptions): Promise<ScrubReport> {
  validateSecrets(opts.secrets);
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const variants = opts.secrets.flatMap(variantsFor);
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
    const abs = path.join(opts.sourceDir, entry.rel);
    const st = await fs.lstat(abs);
    if (st.size > maxFileBytes) {
      withheld.push({
        path: redactName(entry.rel, variants, null),
        reason: "oversize",
        detail: `${String(st.size)} bytes > ${String(maxFileBytes)} cap — never retained unscanned`,
      });
      continue;
    }

    const counts: Counts = new Map();
    const out = redactBuffer(await fs.readFile(abs), variants, counts);
    const retainedRel = entry.rel
      .split("/")
      .map((seg) => redactName(seg, variants, counts))
      .join("/");
    if (usedRetainedPaths.has(retainedRel)) {
      // Impossible by construction (distinct ids yield distinct markers, and
      // identical names cannot share a directory) — fail closed if reached.
      throw new Error(`scrub: retained path collision on '${retainedRel}'`);
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

  // Post-write verification over the retained tree: bytes AND names.
  let verifiedClean = true;
  for (const a of [...artifacts]) {
    const abs = path.join(opts.retainedDir, a.path);
    const bytes = await fs.readFile(abs);
    const nameHit = variants.some((v) => a.path.includes(v.needle.toString("utf8")));
    const byteHit = variants.some((v) => bytes.indexOf(v.needle) !== -1);
    if (nameHit || byteHit) {
      verifiedClean = false;
      await fs.rm(abs, { force: true });
      artifacts.splice(artifacts.indexOf(a), 1);
      withheld.push({
        path: redactName(a.path, variants, null),
        reason: "verify-failed",
        detail: "residue found in retained copy — deleted (fail-closed)",
      });
    }
  }

  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  withheld.sort((a, b) => a.path.localeCompare(b.path));
  return { artifacts, withheld, verifiedClean };
}
