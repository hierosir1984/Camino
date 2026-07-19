/**
 * GUI auth token custody (WP-102, CAM-CORE-01).
 *
 * The token lives in a single file under `~/.camino` with owner-only
 * permissions. Startup is fail-closed: an existing file that is a symlink,
 * not a regular file, owned by another user, readable by group/other, or
 * whose content is not a plausible token REFUSES startup with a precise
 * remediation message — it is never silently repaired or regenerated,
 * because "the file changed shape" is exactly the signal a user should see.
 * Only a genuinely absent file is created (0600, enforced with fchmod so an
 * unusual umask cannot widen it).
 *
 * POSIX semantics (mode bits, uid, O_NOFOLLOW) are assumed; the walking
 * skeleton targets macOS and Linux (build plan §1.2 posture).
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
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
  }

  const openExisting = (): number | undefined => {
    try {
      return openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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
  };

  const existingFd = openExisting();
  if (existingFd !== undefined) {
    try {
      return verifyExistingToken(existingFd, path);
    } finally {
      closeSync(existingFd);
    }
  }

  const token = generateToken();
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // Concurrent first run: the other process created it; verify and use theirs.
      const fdAfterRace = openExisting();
      if (fdAfterRace === undefined) {
        throw new TokenError(`Refusing to start: token file ${path} appeared and vanished.`);
      }
      try {
        return verifyExistingToken(fdAfterRace, path);
      } finally {
        closeSync(fdAfterRace);
      }
    }
    throw new TokenError(`Refusing to start: cannot create token file ${path}: ${String(error)}`);
  }
  try {
    fchmodSync(fd, 0o600); // umask-independent: the mode passed to open() is masked, this is not
    const payload = Buffer.from(`${token}\n`, "utf8");
    let offset = 0;
    while (offset < payload.length) {
      offset += writeSync(fd, payload, offset, payload.length - offset);
    }
    return { token, path, created: true };
  } finally {
    closeSync(fd);
  }
}
