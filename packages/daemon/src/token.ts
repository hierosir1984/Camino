/**
 * GUI auth token custody (WP-102, CAM-CORE-01).
 *
 * The token lives in a single file under `~/.camino` with owner-only
 * permissions. Startup is fail-closed: an existing file that is a symlink,
 * not a regular file, owned by another user, readable by group/other by mode
 * bits OR by an extended ACL, or whose content is not a plausible token
 * REFUSES startup with a precise remediation message — it is never silently
 * repaired or regenerated, because "the file changed shape" is exactly the
 * signal a user should see. Only a genuinely absent file is created (0600,
 * enforced with fchmod so an unusual umask cannot widen it, and with any
 * inherited ACL stripped so a directory ACL cannot widen it either).
 *
 * Hardening folded from round 1:
 *  - the existing-file open is non-blocking, so a FIFO or device left at the
 *    token path is refused instead of hanging startup on the open (finding 4);
 *  - a new token is written to a unique temp file and published into place with
 *    an atomic link(), so the `auth-token` pathname is never observable in a
 *    half-written state by a concurrent first run (finding 5);
 *  - mode bits alone do not prove owner-only on macOS, where an ACL grants
 *    access independently; the ACL is checked (and, on our created files,
 *    stripped) on darwin. On other POSIX platforms mode + ownership are
 *    enforced and ACL-based widening is a documented residual (finding 2).
 *
 * Verification binds to the OPENED INODE: the file is fstat-checked and read
 * through the same fd, so a concurrent swap of the directory entry cannot
 * substitute a different token into the running daemon. The on-disk path
 * naming a different file afterwards does not affect the loaded token
 * (finding 8 is scoped to that, not a compromise of the token in use).
 *
 * POSIX semantics (mode bits, uid, O_NOFOLLOW) are assumed; the walking
 * skeleton targets macOS and Linux (build plan §1.2 posture).
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";

import { caminoHome, tokenFilePath } from "./config.js";

/** Startup refusal: the caller reports the message and exits non-zero. */
export class TokenError extends Error {}

/** base64url alphabet, one line; wide bounds so hand-provisioned tokens work. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;

/** 32 random bytes → 43 base64url chars (~256 bits). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * True if `path` carries an extended ACL that could grant access beyond its
 * mode bits. Implemented on darwin (POSIX `ls -le` lists ACL entries after the
 * mode line); returns false elsewhere — where mode + ownership are enforced and
 * ACL detection is a documented residual (round 1, finding 2). Any exec failure
 * is treated as "cannot prove clean" only on darwin, where it refuses.
 */
export function hasExtendedAcl(path: string): boolean {
  if (process.platform !== "darwin") return false;
  let output: string;
  try {
    output = execFileSync("/bin/ls", ["-lde", path], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // On darwin we cannot confirm the file is ACL-free — fail closed.
    return true;
  }
  // ACL entries are numbered lines ("0: group:everyone allow read") after the
  // long-listing line; their presence is the signal.
  return output.split("\n").some((line) => /^\s*\d+:\s/.test(line));
}

/** Best-effort strip of any inherited ACL from a file/dir we created (darwin). */
function stripInheritedAcl(path: string): void {
  if (process.platform !== "darwin") return;
  try {
    execFileSync("/bin/chmod", ["-N", path], { timeout: 5000, stdio: "ignore" });
  } catch {
    // Non-fatal: the verification step re-checks and refuses if an ACL remains.
  }
}

/**
 * The permission gate, split out pure so unit tests can exercise uid/mode
 * combinations that cannot be created without privileges (foreign owner).
 * `expectedUid` is undefined on platforms without process.getuid (Windows) —
 * the mode check still applies there in name only; POSIX is the real target.
 */
export function tokenStatRefusal(
  stat: Pick<Stats, "mode" | "uid"> & { isFile(): boolean },
  expectedUid: number | undefined,
): string | undefined {
  if (!stat.isFile()) {
    return "is not a regular file";
  }
  if (expectedUid !== undefined && stat.uid !== expectedUid) {
    return `is owned by uid ${stat.uid}, not the daemon user (uid ${expectedUid})`;
  }
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return `has permissions 0${mode.toString(8)} — group/other access must be 0 (expected 0600)`;
  }
  return undefined;
}

export interface LoadedToken {
  token: string;
  path: string;
  /** True when this startup created the file (first run). */
  created: boolean;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** Read the whole file through an already-open fd (no path re-resolution). */
function readAllFromFd(fd: number, sizeHint: number): string {
  const size = Math.min(Math.max(sizeHint, 0), 4096);
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(fd, buffer, offset, size - offset, offset);
    if (read === 0) break;
    offset += read;
  }
  return buffer.subarray(0, offset).toString("utf8");
}

function verifyExistingToken(fd: number, path: string): LoadedToken {
  const stat = fstatSync(fd);
  const refusal = tokenStatRefusal(stat, currentUid());
  if (refusal !== undefined) {
    throw new TokenError(
      `Refusing to start: token file ${path} ${refusal}. ` +
        `Fix with: chmod 600 ${JSON.stringify(path)} (and chown to your user), ` +
        `or delete the file to have the daemon generate a fresh token.`,
    );
  }
  if (stat.size > 4096) {
    throw new TokenError(
      `Refusing to start: token file ${path} is ${stat.size} bytes — not a token file. ` +
        `Delete it to have the daemon generate a fresh token.`,
    );
  }
  if (hasExtendedAcl(path)) {
    throw new TokenError(
      `Refusing to start: token file ${path} carries an extended ACL that can ` +
        `grant access beyond its 0600 mode. Clear it with: chmod -N ${JSON.stringify(path)} ` +
        `(and check the containing directory), or delete the file to regenerate a fresh token.`,
    );
  }
  const raw = readAllFromFd(fd, stat.size);
  const token = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (!TOKEN_PATTERN.test(token)) {
    throw new TokenError(
      `Refusing to start: token file ${path} does not contain a valid token ` +
        `(expected one line of 32–512 base64url characters). ` +
        `Delete the file to have the daemon generate a fresh token.`,
    );
  }
  return { token, path, created: false };
}

/**
 * Load the GUI token, creating it on first run. Every failure mode is a
 * TokenError refusal; the only write path is O_CREAT|O_EXCL (never truncate,
 * never follow a symlink), so a concurrent first run loses the race cleanly
 * and reads the winner's file.
 */
export function loadOrCreateToken(env: NodeJS.ProcessEnv = process.env): LoadedToken {
  const home = caminoHome(env);
  const path = tokenFilePath(env);
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700); // mkdir's mode is umask-masked; force owner-only
    stripInheritedAcl(home); // a directory ACL must not widen what we create
  }

  const existing = openExistingToken(path);
  if (existing !== undefined) {
    try {
      return verifyExistingToken(existing, path);
    } finally {
      closeSync(existing);
    }
  }

  return createTokenAtomically(path);
}

/**
 * Open an existing token file for reading, non-blocking (O_NONBLOCK), so a FIFO
 * or device at the path returns a fd immediately instead of blocking the open —
 * the fstat check then refuses it as non-regular (round 1, finding 4). Returns
 * undefined if the file is absent; a symlink is refused outright.
 */
function openExistingToken(path: string): number | undefined {
  try {
    return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP" || code === "EMLINK") {
      throw new TokenError(
        `Refusing to start: token file ${path} is a symbolic link. ` +
          `Replace it with a regular file (chmod 600) or delete it.`,
      );
    }
    throw new TokenError(`Refusing to start: cannot open token file ${path}: ${String(error)}`);
  }
}

/**
 * Write a fresh token to a unique temp file, then publish it atomically with
 * link() so the visible `auth-token` path never exists half-written. If another
 * first run published first (link → EEXIST), read and return theirs.
 */
function createTokenAtomically(path: string): LoadedToken {
  const token = generateToken();
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  let tmpFd: number;
  try {
    tmpFd = openSync(
      tmpPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    throw new TokenError(
      `Refusing to start: cannot create temporary token file ${tmpPath}: ${String(error)}`,
    );
  }
  try {
    fchmodSync(tmpFd, 0o600); // umask-independent: open()'s mode is masked, this is not
    const payload = Buffer.from(`${token}\n`, "utf8");
    let offset = 0;
    while (offset < payload.length) {
      offset += writeSync(tmpFd, payload, offset, payload.length - offset);
    }
    fsyncSync(tmpFd);
  } finally {
    closeSync(tmpFd);
  }
  stripInheritedAcl(tmpPath); // strip before publish so the linked inode is clean

  try {
    linkSync(tmpPath, path); // atomic publish; EEXIST means another run won
  } catch (error) {
    safeUnlink(tmpPath);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = openExistingToken(path);
      if (raced === undefined) {
        throw new TokenError(`Refusing to start: token file ${path} appeared and vanished.`);
      }
      try {
        return verifyExistingToken(raced, path);
      } finally {
        closeSync(raced);
      }
    }
    throw new TokenError(`Refusing to start: cannot publish token file ${path}: ${String(error)}`);
  }
  safeUnlink(tmpPath); // the published path now holds the inode; drop the temp name
  return { token, path, created: true };
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // A leftover temp file is harmless (0600, never read); nothing to do.
  }
}
