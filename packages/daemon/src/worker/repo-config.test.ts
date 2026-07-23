// WP-107 · per-repo egress config parsing (CAM-EXEC-03): absent config is
// the deny-all baseline; malformed config REFUSES with a reason (never a
// silent deny); entry shapes are validated fail-closed.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_EGRESS_ALLOWLIST_ENTRIES,
  REPO_CONFIG_PATH,
  RepoConfigError,
  loadRepoEgressConfig,
  parseRepoEgressConfig,
} from "./repo-config.js";

let dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "camino-wp107-config-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("parseRepoEgressConfig", () => {
  it("parses the documented shape into a deduplicated allowlist", () => {
    const cfg = parseRepoEgressConfig(
      [
        "egress:",
        "  allow:",
        "    - host: registry.npmjs.org",
        "      port: 443",
        "    - host: docs.npmjs.com",
        "      port: 443",
        "    - host: registry.npmjs.org", // duplicate collapses
        "      port: 443",
      ].join("\n"),
    );
    expect(cfg).toEqual({
      allow: [
        { host: "registry.npmjs.org", port: 443 },
        { host: "docs.npmjs.com", port: 443 },
      ],
    });
  });

  it("treats an absent file, empty document, or absent egress section as deny-all", () => {
    expect(parseRepoEgressConfig(null)).toEqual({ allow: [] });
    expect(parseRepoEgressConfig("")).toEqual({ allow: [] });
    expect(parseRepoEgressConfig("other: config\n")).toEqual({ allow: [] });
    expect(parseRepoEgressConfig("egress:\n")).toEqual({ allow: [] });
    expect(parseRepoEgressConfig("egress:\n  allow: []\n")).toEqual({ allow: [] });
  });

  it("refuses malformed YAML with a reason (never a silent deny)", () => {
    expect(() => parseRepoEgressConfig("egress: [unclosed")).toThrow(RepoConfigError);
  });

  it("refuses unknown egress keys — a typo'd allowlist must surface, not silently deny", () => {
    expect(() => parseRepoEgressConfig("egress:\n  alow:\n    - host: a\n      port: 1\n")).toThrow(
      /unknown egress key/,
    );
  });

  it("refuses malformed entries: shape, host, port, extra keys", () => {
    expect(() => parseRepoEgressConfig("egress:\n  allow:\n    - just-a-string\n")).toThrow(
      RepoConfigError,
    );
    expect(() =>
      parseRepoEgressConfig('egress:\n  allow:\n    - host: "evil host"\n      port: 443\n'),
    ).toThrow(/host/);
    expect(() =>
      parseRepoEgressConfig('egress:\n  allow:\n    - host: ok.invalid\n      port: "443"\n'),
    ).toThrow(/port/);
    expect(() =>
      parseRepoEgressConfig("egress:\n  allow:\n    - host: ok.invalid\n      port: 70000\n"),
    ).toThrow(/port/);
    expect(() =>
      parseRepoEgressConfig(
        "egress:\n  allow:\n    - host: ok.invalid\n      port: 443\n      extra: 1\n",
      ),
    ).toThrow(/unknown key/);
  });

  it("caps the allowlist size", () => {
    const entries = Array.from(
      { length: MAX_EGRESS_ALLOWLIST_ENTRIES + 1 },
      (_, i) => `    - host: h${i}.invalid\n      port: 443`,
    ).join("\n");
    expect(() => parseRepoEgressConfig(`egress:\n  allow:\n${entries}\n`)).toThrow(/max/);
  });
});

describe("loadRepoEgressConfig", () => {
  it("reads .camino/config.yml from a repo checkout; absent file = deny-all", () => {
    const repo = tempDir();
    expect(loadRepoEgressConfig(repo)).toEqual({ allow: [] });
    mkdirSync(join(repo, ".camino"), { recursive: true });
    writeFileSync(
      join(repo, REPO_CONFIG_PATH),
      "egress:\n  allow:\n    - host: registry.invalid\n      port: 443\n",
    );
    expect(loadRepoEgressConfig(repo)).toEqual({
      allow: [{ host: "registry.invalid", port: 443 }],
    });
  });

  it("REFUSES a symlinked .camino/config.yml — a redirected read could set egress from an unprotected path (round-10 finding 8)", () => {
    const repo = tempDir();
    mkdirSync(join(repo, ".camino"), { recursive: true });
    // A worker points the protected config pathname at an UNPROTECTED file it can
    // edit (outside quarantine), controlling effective egress.
    writeFileSync(
      join(repo, "egress.yml"),
      "egress:\n  allow:\n    - host: worker-added.invalid\n      port: 4444\n",
    );
    symlinkSync(join(repo, "egress.yml"), join(repo, REPO_CONFIG_PATH));
    expect(() => loadRepoEgressConfig(repo)).toThrow(RepoConfigError);
    expect(() => loadRepoEgressConfig(repo)).toThrow(/symlink/i);
  });

  it("REFUSES a symlinked .camino directory (round-10 finding 8)", () => {
    const repo = tempDir();
    const elsewhere = tempDir();
    mkdirSync(join(elsewhere, "real-camino"), { recursive: true });
    writeFileSync(
      join(elsewhere, "real-camino", "config.yml"),
      "egress:\n  allow:\n    - host: worker-added.invalid\n      port: 4444\n",
    );
    symlinkSync(join(elsewhere, "real-camino"), join(repo, ".camino"));
    expect(() => loadRepoEgressConfig(repo)).toThrow(/symlink/i);
  });
});
