/**
 * Token custody tests (WP-102, CAM-CORE-01): the daemon refuses to start when
 * the token file's permissions or shape are wrong — every refusal path here
 * is one of the acceptance clauses ("token-file permissions verified at
 * startup; refuse to start otherwise").
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { generateToken, loadOrCreateToken, TokenError, tokenStatRefusal } from "./token.js";

function scratchHome(): { env: NodeJS.ProcessEnv; home: string; tokenPath: string } {
  const home = join(mkdtempSync(join(tmpdir(), "camino-token-")), "camino-home");
  return { env: { CAMINO_HOME: home }, home, tokenPath: join(home, "auth-token") };
}

describe("loadOrCreateToken", () => {
  it("creates the token file on first run with owner-only permissions", () => {
    const { env, home, tokenPath } = scratchHome();
    const loaded = loadOrCreateToken(env);

    expect(loaded.created).toBe(true);
    expect(loaded.path).toBe(tokenPath);
    expect(loaded.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(readFileSync(tokenPath, "utf8")).toBe(`${loaded.token}\n`);
  });

  it("creates 0600 even under a permissive-to-hostile umask", () => {
    const { env, tokenPath } = scratchHome();
    const previous = process.umask(0o177);
    try {
      loadOrCreateToken(env);
    } finally {
      process.umask(previous);
    }
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it("reuses an existing valid token file", () => {
    const { env } = scratchHome();
    const first = loadOrCreateToken(env);
    const second = loadOrCreateToken(env);
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
  });

  it("accepts a hand-provisioned token without a trailing newline", () => {
    const { env, home, tokenPath } = scratchHome();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const token = generateToken();
    writeFileSync(tokenPath, token, { mode: 0o600 });
    expect(loadOrCreateToken(env).token).toBe(token);
  });

  it.each([0o640, 0o604, 0o644, 0o660, 0o666])(
    "refuses to start when the token file mode is %s",
    (mode) => {
      const { env, tokenPath } = scratchHome();
      loadOrCreateToken(env);
      chmodSync(tokenPath, mode);
      expect(() => loadOrCreateToken(env)).toThrow(TokenError);
      expect(() => loadOrCreateToken(env)).toThrow(/permissions/);
    },
  );

  it("refuses a token file that is a symbolic link, even to a valid target", () => {
    const { env, home, tokenPath } = scratchHome();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const target = join(home, "real-token");
    writeFileSync(target, `${generateToken()}\n`, { mode: 0o600 });
    symlinkSync(target, tokenPath);
    expect(() => loadOrCreateToken(env)).toThrow(/symbolic link/);
  });

  it("refuses a token path that is a directory", () => {
    const { env, tokenPath } = scratchHome();
    mkdirSync(tokenPath, { recursive: true });
    expect(() => loadOrCreateToken(env)).toThrow(TokenError);
  });

  it.each([
    "",
    "short",
    "two\nlines\n",
    "has spaces here padded out to length\n",
    "bad+chars/inside0000000000000000000000\n",
  ])("refuses malformed token content %j instead of regenerating", (content) => {
    const { env, home, tokenPath } = scratchHome();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, content, { mode: 0o600 });
    expect(() => loadOrCreateToken(env)).toThrow(TokenError);
    // The malformed file must survive untouched — a changed file is a signal.
    expect(readFileSync(tokenPath, "utf8")).toBe(content);
  });

  it("refuses an implausibly large token file without reading it whole", () => {
    const { env, home, tokenPath } = scratchHome();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(tokenPath, "A".repeat(8192), { mode: 0o600 });
    expect(() => loadOrCreateToken(env)).toThrow(/bytes/);
  });
});

describe("tokenStatRefusal", () => {
  const fileStat = (mode: number, uid: number) => ({
    isFile: () => true,
    mode,
    uid,
  });

  it("accepts 0600 owned by the daemon user", () => {
    expect(tokenStatRefusal(fileStat(0o100600, 501), 501)).toBeUndefined();
  });

  it("refuses foreign ownership even at 0600", () => {
    expect(tokenStatRefusal(fileStat(0o100600, 0), 501)).toMatch(/owned by uid 0/);
  });

  it("refuses group/other access bits", () => {
    expect(tokenStatRefusal(fileStat(0o100640, 501), 501)).toMatch(/permissions/);
    expect(tokenStatRefusal(fileStat(0o100601, 501), 501)).toMatch(/permissions/);
  });

  it("refuses non-regular files", () => {
    expect(tokenStatRefusal({ isFile: () => false, mode: 0o100600, uid: 501 }, 501)).toMatch(
      /not a regular file/,
    );
  });

  it("skips the uid clause only when the platform has no uid", () => {
    expect(tokenStatRefusal(fileStat(0o100600, 12345), undefined)).toBeUndefined();
  });
});
