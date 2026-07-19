/**
 * Token custody tests (WP-102, CAM-CORE-01): the daemon refuses to start when
 * the token file's permissions or shape are wrong — every refusal path here
 * is one of the acceptance clauses ("token-file permissions verified at
 * startup; refuse to start otherwise").
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  generateToken,
  hasExtendedAcl,
  loadOrCreateToken,
  TokenError,
  tokenStatRefusal,
} from "./token.js";

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
    const { env, home, tokenPath } = scratchHome();
    mkdirSync(home, { recursive: true, mode: 0o700 }); // valid state dir…
    mkdirSync(tokenPath); // …but the token path itself is a directory
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

  it("finding 5: publishes the created token atomically, leaving no temp file", () => {
    const { env, home } = scratchHome();
    const loaded = loadOrCreateToken(env);
    const entries = readdirSync(home);
    expect(entries).toEqual(["auth-token"]); // the .tmp.* file is gone
    expect(readFileSync(join(home, "auth-token"), "utf8")).toBe(`${loaded.token}\n`);
  });
});

/**
 * Finding 4: a FIFO (or any file whose open blocks) at the token path must be
 * refused, not hang startup. Run in a CHILD process with a hard timeout: if a
 * regression drops O_NONBLOCK the open blocks the event loop synchronously (a
 * vitest timeout could not interrupt it), so the child is killed and the test
 * fails cleanly instead of wedging the suite.
 */
describe("finding 4: non-blocking open of the existing token file", () => {
  const CHILD = `
    const [, , tokenModule, home] = process.argv;
    import(tokenModule)
      .then((m) => { m.loadOrCreateToken({ CAMINO_HOME: home }); process.exit(0); })
      .catch(() => process.exit(3));
  `;

  it("refuses a FIFO at the token path within the timeout", () => {
    const home = join(mkdtempSync(join(tmpdir(), "camino-fifo-")), "camino-home");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    execFileSync("mkfifo", [join(home, "auth-token")]);
    chmodSync(join(home, "auth-token"), 0o600);

    const childPath = join(home, "child.mjs");
    writeFileSync(childPath, CHILD);
    const tokenModule = new URL("./token.ts", import.meta.url).href;

    let status: number | undefined;
    let timedOut = false;
    try {
      execFileSync(process.execPath, ["--import", "tsx", childPath, tokenModule, home], {
        timeout: 8000,
        stdio: "ignore",
      });
      status = 0;
    } catch (error) {
      const err = error as { status?: number; killed?: boolean; signal?: string };
      timedOut = err.killed === true || err.signal === "SIGTERM";
      status = err.status;
    }
    expect(timedOut, "startup hung on the FIFO open").toBe(false);
    expect(status, "expected a refusal exit (3)").toBe(3);
  }, 15000);
});

describe("finding 2: extended-ACL detection (darwin)", () => {
  it.skipIf(process.platform !== "darwin")(
    "refuses a 0600 token file widened by an everyone-read ACL",
    () => {
      const { env, home, tokenPath } = scratchHome();
      mkdirSync(home, { recursive: true, mode: 0o700 });
      writeFileSync(tokenPath, `${generateToken()}\n`, { mode: 0o600 });
      execFileSync("/bin/chmod", ["+a", "everyone allow read", tokenPath]);

      expect(hasExtendedAcl(tokenPath)).toBe(true);
      expect(() => loadOrCreateToken(env)).toThrow(/ACL/);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "strips a directory's inherited ACL when it creates the state dir + token",
    () => {
      // scratchHome's parent temp dir is created here; loadOrCreateToken creates
      // the state dir under it and strips any inherited ACL from both dir + file.
      const { env, home, tokenPath } = scratchHome();
      const loaded = loadOrCreateToken(env);
      expect(loaded.created).toBe(true);
      expect(hasExtendedAcl(home)).toBe(false);
      expect(hasExtendedAcl(tokenPath)).toBe(false);
      // A second startup accepts the ACL-free dir + file it just created.
      expect(loadOrCreateToken(env).token).toBe(loaded.token);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "refuses a state directory widened by an extended ACL (the confidentiality gate)",
    () => {
      const { env, home } = scratchHome();
      mkdirSync(home, { recursive: true, mode: 0o700 });
      execFileSync("/bin/chmod", ["+a", "everyone allow read,file_inherit", home]);
      expect(hasExtendedAcl(home)).toBe(true);
      expect(() => loadOrCreateToken(env)).toThrow(/ACL/);
    },
  );

  it("reports no ACL on non-darwin platforms (documented residual)", () => {
    if (process.platform === "darwin") return;
    const { env, tokenPath } = scratchHome();
    loadOrCreateToken(env);
    expect(hasExtendedAcl(tokenPath)).toBe(false);
  });
});

describe("finding 1/2: state directory is the confidentiality gate", () => {
  it("refuses a state directory that is group/other-accessible", () => {
    const { env, home } = scratchHome();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    chmodSync(home, 0o755);
    expect(() => loadOrCreateToken(env)).toThrow(/group and other access must be 0/);
  });

  it("accepts an owner-only 0500 state directory holding an existing token", () => {
    // 0500 is as confidential as 0700 for an existing token (round 4, finding 4).
    const { env, home, tokenPath } = scratchHome();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const token = generateToken();
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    chmodSync(home, 0o500);
    try {
      expect(loadOrCreateToken(env).token).toBe(token);
    } finally {
      chmodSync(home, 0o700); // restore so the temp dir can be cleaned
    }
  });

  it("refuses when the state directory path is a regular file, not a directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "camino-gate-"));
    const home = join(parent, "camino-home");
    writeFileSync(home, "not a directory");
    expect(() => loadOrCreateToken({ CAMINO_HOME: home })).toThrow(/not a directory/);
  });

  it("accepts a correctly 0700 owner-only state directory", () => {
    const { env, home } = scratchHome();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    expect(loadOrCreateToken(env).created).toBe(true);
  });

  it("finding 5: surfaces a clean TokenError with only an errno code, not a raw OS message", () => {
    // A CAMINO_HOME whose parent is a regular file → ENOTDIR on mkdir.
    const scratch = mkdtempSync(join(tmpdir(), "camino-errno-"));
    const aFile = join(scratch, "afile");
    writeFileSync(aFile, "x");
    const badHome = join(aFile, "child");
    try {
      loadOrCreateToken({ CAMINO_HOME: badHome });
      expect.unreachable("should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(TokenError);
      const message = (error as Error).message;
      // The raw node message ("ENOTDIR: not a directory, mkdir '/…/child'") must
      // not leak; only the errno code is surfaced.
      expect(message).not.toMatch(/not a directory, mkdir|no such file or directory/);
    }
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
