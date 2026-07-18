// WP-005 scrubbing suite — CAM-VAL-03 (scrubbing half), CAM-SEC-08 groundwork.
//
// Seeds synthetic secret literals into a fixture artifact tree (logs, XML,
// binary blobs, file names) and proves the retained copies are redacted —
// including the base64 and URL-encoded forms accidental leakage rides on —
// while clean files survive byte-identical. The T3 residual (design §5.3:
// transformed encodings — compression, reversal, …) is STATED, not hidden:
// the documented-miss cases assert exactly what passes through, executably.
//
// All secret values below are synthetic markers (WP-004 convention) — nothing
// here is, or resembles, real credential material.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIN_SECRET_LENGTH, scrubRetained, variantsFor, type ScrubReport } from "./scrub/scrub.js";

const ALPHA = "SYNTHETIC-wp005-alpha-3f9d7c21e5b8";
const BRAVO = "SYNTHETIC-wp005-bravo-0a1b2c3d";
const CHARLIE = "SYNTHETIC wp005/charlie+key=9&x"; // URL-encoding differs from raw
const SECRETS = [
  { id: "alpha", value: ALPHA },
  { id: "bravo", value: BRAVO },
];

const b64 = (s: string | Buffer): string => Buffer.from(s).toString("base64");
const reversed = (s: string): string => [...s].reverse().join("");

let root: string;

async function freshDirs(name: string): Promise<{ src: string; retained: string }> {
  const src = path.join(root, name, "src");
  const retained = path.join(root, name, "retained");
  await fs.mkdir(src, { recursive: true });
  return { src, retained };
}

async function write(dir: string, rel: string, content: string | Buffer): Promise<void> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

async function walkFiles(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await fs.readdir(dir)).sort()) {
    const abs = path.join(dir, name);
    const r = rel === "" ? name : `${rel}/${name}`;
    if ((await fs.lstat(abs)).isDirectory()) out.push(...(await walkFiles(abs, r)));
    else out.push(r);
  }
  return out;
}

function artifactOf(report: ScrubReport, retainedPath: string) {
  const a = report.artifacts.find((x) => x.path === retainedPath);
  if (!a) {
    throw new Error(
      `no artifact at '${retainedPath}' (have: ${report.artifacts.map((x) => x.path).join(", ")})`,
    );
  }
  return a;
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "camino-wp005-scrub-"));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("CAM-VAL-03 scrubbing half — seeded literals are redacted in retained copies", () => {
  let report: ScrubReport;
  let src: string;
  let retained: string;

  beforeAll(async () => {
    ({ src, retained } = await freshDirs("main"));
    await write(
      src,
      "logs/run.log",
      `boot ok\ntoken=${ALPHA} again ${ALPHA}\nheader: Basic ${b64(`user:${ALPHA}`)}\ndone\n`,
    );
    await write(src, `logs/token-${ALPHA}.txt`, "name-carried case\n");
    await write(src, "report/junit.xml", `<sys-out>${ALPHA}</sys-out><err>${BRAVO}</err>`);
    await write(
      src,
      "blobs/dump.bin",
      Buffer.concat([
        Buffer.from([0, 1, 2, 254, 255, 7]),
        Buffer.from(ALPHA, "utf8"),
        Buffer.from([9, 0, 128, 250]),
      ]),
    );
    await write(src, "clean/readme.txt", "no secret material here\n");
    await write(src, "t3/gzip-of-secret.bin", gzipSync(Buffer.from(ALPHA, "utf8")));
    await write(src, "t3/reversed.txt", `residual: ${reversed(ALPHA)}\n`);
    await fs.symlink("/etc/hosts", path.join(src, "link-out"));
    report = await scrubRetained({ sourceDir: src, retainedDir: retained, secrets: SECRETS });
  });

  it("raw literals in logs are redacted, with ground-truth occurrence counts", async () => {
    const a = artifactOf(report, "logs/run.log");
    const bytes = await fs.readFile(path.join(retained, a.path), "utf8");
    expect(bytes).not.toContain(ALPHA);
    expect(bytes).toContain("[SCRUBBED:alpha:raw]");
    expect(a.scrubbed).toBe(true);
    expect(a.occurrences).toContainEqual({ secretId: "alpha", encoding: "raw", count: 2 });
  });

  it("the base64 form riding a Basic-auth header is redacted too", async () => {
    const a = artifactOf(report, "logs/run.log");
    const bytes = await fs.readFile(path.join(retained, a.path), "utf8");
    // The seeded header was base64("user:" + ALPHA); its alignment core must be gone.
    expect(bytes).not.toContain(b64(`user:${ALPHA}`));
    expect(a.occurrences.some((o) => o.secretId === "alpha" && o.encoding === "base64")).toBe(true);
  });

  it("XML and binary artifacts are redacted alike (byte-level, format-agnostic)", async () => {
    const xml = await fs.readFile(path.join(retained, "report/junit.xml"), "utf8");
    expect(xml).not.toContain(ALPHA);
    expect(xml).not.toContain(BRAVO);
    expect(xml).toContain("[SCRUBBED:alpha:raw]");
    expect(xml).toContain("[SCRUBBED:bravo:raw]");

    const bin = await fs.readFile(path.join(retained, "blobs/dump.bin"));
    expect(bin.indexOf(Buffer.from(ALPHA, "utf8"))).toBe(-1);
    expect(bin.subarray(0, 6)).toEqual(Buffer.from([0, 1, 2, 254, 255, 7]));
  });

  it("file names carrying a secret are renamed; the report itself carries no secret material", () => {
    const a = artifactOf(report, "logs/token-SCRUBBED-alpha.txt");
    expect(a.sourcePath).toBe("logs/token-SCRUBBED-alpha.txt");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(ALPHA);
    expect(serialized).not.toContain(BRAVO);
    expect(serialized).not.toContain(b64(ALPHA));
  });

  it("clean files survive byte-identical with scrubbed:false and a verifiable sha256", async () => {
    const a = artifactOf(report, "clean/readme.txt");
    expect(a.scrubbed).toBe(false);
    expect(a.occurrences).toEqual([]);
    const bytes = await fs.readFile(path.join(retained, a.path));
    expect(bytes.toString("utf8")).toBe("no secret material here\n");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(a.sha256);
  });

  it("symlinks are withheld, never followed or retained", async () => {
    expect(report.withheld).toContainEqual(
      expect.objectContaining({ path: "link-out", reason: "symlink" }),
    );
    await expect(fs.lstat(path.join(retained, "link-out"))).rejects.toThrow();
  });

  it("post-write verification passes and an INDEPENDENT re-scan agrees: no variant anywhere retained", async () => {
    expect(report.verifiedClean).toBe(true);
    // Independent scan: raw values and canonical base64 forms, test-side only.
    const needles = [ALPHA, BRAVO, b64(ALPHA), b64(BRAVO)].map((n) => Buffer.from(n, "utf8"));
    for (const rel of await walkFiles(retained)) {
      const bytes = await fs.readFile(path.join(retained, rel));
      for (const n of needles) {
        expect(bytes.indexOf(n), `variant residue in ${rel}`).toBe(-1);
        expect(rel.includes(n.toString("utf8")), `variant residue in name ${rel}`).toBe(false);
      }
    }
  });

  it("T3 residual, stated not hidden (design §5.3): transformed encodings pass through", async () => {
    // gzip(secret): retained byte-identical — and the miss is REAL: the
    // retained bytes still decompress to the seeded literal.
    const gz = await fs.readFile(path.join(retained, "t3/gzip-of-secret.bin"));
    expect(gunzipSync(gz).toString("utf8")).toBe(ALPHA);
    expect(artifactOf(report, "t3/gzip-of-secret.bin").scrubbed).toBe(false);
    // reversed(secret): same statement.
    const rev = await fs.readFile(path.join(retained, "t3/reversed.txt"), "utf8");
    expect(rev).toContain(reversed(ALPHA));
    expect(artifactOf(report, "t3/reversed.txt").scrubbed).toBe(false);
  });
});

describe("encoding variants", () => {
  it("base64 is caught at every stream alignment inside larger blobs", async () => {
    const { src, retained } = await freshDirs("alignments");
    const blobs = [
      b64(ALPHA),
      b64(Buffer.concat([Buffer.from("x"), Buffer.from(ALPHA), Buffer.from("tail")])),
      b64(Buffer.concat([Buffer.from("xy"), Buffer.from(ALPHA), Buffer.from("tail")])),
    ];
    await write(src, "aligned.log", blobs.map((b, i) => `blob${String(i)}: ${b}`).join("\n"));
    const report = await scrubRetained({
      sourceDir: src,
      retainedDir: retained,
      secrets: [{ id: "alpha", value: ALPHA }],
    });
    const out = await fs.readFile(path.join(retained, "aligned.log"), "utf8");
    for (const [i, blob] of blobs.entries()) {
      expect(out.includes(blob), `alignment ${String(i)} blob survived`).toBe(false);
    }
    const a = artifactOf(report, "aligned.log");
    const b64Count = a.occurrences.find((o) => o.encoding === "base64")?.count ?? 0;
    expect(b64Count).toBeGreaterThanOrEqual(3);
  });

  it("URL-encoded values are redacted where the encoding differs from the raw literal", async () => {
    const { src, retained } = await freshDirs("urlenc");
    await write(src, "query.log", `GET /cb?t=${encodeURIComponent(CHARLIE)} raw=${CHARLIE}\n`);
    const report = await scrubRetained({
      sourceDir: src,
      retainedDir: retained,
      secrets: [{ id: "charlie", value: CHARLIE }],
    });
    const out = await fs.readFile(path.join(retained, "query.log"), "utf8");
    expect(out).not.toContain(CHARLIE);
    expect(out).not.toContain(encodeURIComponent(CHARLIE));
    const a = artifactOf(report, "query.log");
    expect(a.occurrences).toContainEqual({ secretId: "charlie", encoding: "raw", count: 1 });
    expect(a.occurrences).toContainEqual({ secretId: "charlie", encoding: "urlencoded", count: 1 });
  });

  it("a value containing another value redacts as the longer one", async () => {
    const { src, retained } = await freshDirs("containment");
    await write(src, "one.log", `only: ${ALPHA}\n`);
    const report = await scrubRetained({
      sourceDir: src,
      retainedDir: retained,
      secrets: [
        { id: "alpha", value: ALPHA },
        { id: "alpha-sub", value: "wp005-alpha" }, // substring of ALPHA
      ],
    });
    const a = artifactOf(report, "one.log");
    expect(a.occurrences).toContainEqual({ secretId: "alpha", encoding: "raw", count: 1 });
    expect(a.occurrences.some((o) => o.secretId === "alpha-sub")).toBe(false);
  });

  it("variantsFor: url variant only when it differs; base64 cores above the floor", () => {
    const plain = variantsFor({ id: "p", value: "SYNTHETIC-plain-value" });
    expect(plain.some((v) => v.encoding === "urlencoded")).toBe(false);
    expect(plain.some((v) => v.encoding === "base64")).toBe(true);
    const special = variantsFor({ id: "s", value: CHARLIE });
    expect(special.some((v) => v.encoding === "urlencoded")).toBe(true);
  });
});

describe("fail-closed guards", () => {
  it("oversize files are withheld, never retained unscanned", async () => {
    const { src, retained } = await freshDirs("oversize");
    await write(src, "big.log", `${"x".repeat(2000)}${ALPHA}`);
    await write(src, "small.log", "fits\n");
    const report = await scrubRetained({
      sourceDir: src,
      retainedDir: retained,
      secrets: SECRETS,
      maxFileBytes: 1024,
    });
    expect(report.withheld).toContainEqual(
      expect.objectContaining({ path: "big.log", reason: "oversize" }),
    );
    expect(await walkFiles(retained)).toEqual(["small.log"]);
  });

  it("a non-empty retained dir is refused (never mix with pre-existing content)", async () => {
    const { src, retained } = await freshDirs("notfresh");
    await write(src, "a.log", "x\n");
    await write(retained, "leftover.txt", "old\n");
    await expect(
      scrubRetained({ sourceDir: src, retainedDir: retained, secrets: SECRETS }),
    ).rejects.toThrow(/not empty/);
  });

  it(`secrets shorter than ${String(MIN_SECRET_LENGTH)} chars are refused`, async () => {
    const { src, retained } = await freshDirs("tooshort");
    await write(src, "a.log", "x\n");
    await expect(
      scrubRetained({
        sourceDir: src,
        retainedDir: retained,
        secrets: [{ id: "short", value: "short" }],
      }),
    ).rejects.toThrow(/shorter/);
  });

  it("a redaction marker that would carry secret material is refused", async () => {
    const { src, retained } = await freshDirs("markersafety");
    await write(src, "a.log", "x\n");
    await expect(
      scrubRetained({
        sourceDir: src,
        retainedDir: retained,
        secrets: [{ id: "evil", value: "[SCRUBBED:evil" }],
      }),
    ).rejects.toThrow(/marker/);
  });

  it("duplicate secret ids are refused", async () => {
    const { src, retained } = await freshDirs("dupids");
    await write(src, "a.log", "x\n");
    await expect(
      scrubRetained({
        sourceDir: src,
        retainedDir: retained,
        secrets: [
          { id: "same", value: ALPHA },
          { id: "same", value: BRAVO },
        ],
      }),
    ).rejects.toThrow(/duplicate/);
  });

  it("an empty secret set is refused (scrubbing with nothing to scrub is a caller bug)", async () => {
    const { src, retained } = await freshDirs("nosecrets");
    await write(src, "a.log", "x\n");
    await expect(
      scrubRetained({ sourceDir: src, retainedDir: retained, secrets: [] }),
    ).rejects.toThrow(/at least one/);
  });
});
