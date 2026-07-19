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
 * The confidentiality boundary is the STATE DIRECTORY, not the token file's
 * own bits (round 3). `~/.camino` is created and verified as a real directory,
 * owned by the daemon user, mode exactly 0700, with no extended ACL
 * (verifyStateDir). A token inside a 0700 owner-only directory is unreachable
 * by other users regardless of the file's own permissions, and every
 * file-level attack the review surfaced — inode swap, symlink/hardlink plant,
 * ACL widening on the token file — requires WRITE access to that directory,
 * which is limited to the owner (attacking themselves, meaningless) and root
 * (who can read the token regardless of any check). Camino does not defend
 * against a compromised user account or root; it relies on the OS enforcing
 * the directory's permissions, which it verifies at startup. The file-level
 * mode/owner/ACL checks below are defense-in-depth against ACCIDENTAL
 * misconfiguration, not against an active attacker with directory write.
 *
 * Hardening folded from earlier rounds:
 *  - the existing-file open is non-blocking, so a FIFO or device left at the
 *    token path is refused instead of hanging startup on the open (round 1);
 *  - a new token is written to a unique temp file and published with an atomic
 *    link(), so the `auth-token` pathname is never observable half-written by a
 *    concurrent first run (round 1); the ACL is stripped and verified on the
 *    EMPTY temp file before any secret bytes are written, and any pre-publish
 *    failure unlinks the temp file and raises a clean TokenError (round 3);
 *  - the file is fstat-checked and read through the opened fd, so the token in
 *    use always comes from a validated 0600 inode (round 1, finding 8).
 *
 * ACL detection/stripping is implemented on darwin; on other POSIX platforms
 * mode + ownership are enforced and ACL detection is a documented residual.
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
  lstatSync,
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
    // A failed strip is caught fail-closed by the caller, which re-checks
    // hasExtendedAcl on the created file and refuses if an ACL still remains.
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

/**
 * Verify the state directory is the confidentiality gate it must be: a real
 * directory (not a symlink), owned by the daemon user, mode exactly 0700 (no
 * group/other bits), and free of an extended ACL. This is what makes every
 * file-level attack (inode swap, symlink/hardlink plant, ACL widening) require
 * write access to an owner-only directory — the owner or root — rather than any
 * local user. Fail-closed: a wrong shape refuses startup with a precise fix.
 */
function verifyStateDir(home: string): void {
  let stat: Stats;
  try {
    stat = lstatSync(home);
  } catch (error) {
    throw new TokenError(
      `Refusing to start: cannot stat state directory ${home}: ${redactErrno(error)}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new TokenError(
      `Refusing to start: ${home} is not a directory (a symlink or file in its place is refused). ` +
        `Move it aside so the daemon can create an owner-only ~/.camino.`,
    );
  }
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) {
    throw new TokenError(
      `Refusing to start: state directory ${home} is owned by uid ${stat.uid}, not the daemon ` +
        `user (uid ${uid}). Fix ownership (chown) or move it aside.`,
    );
  }
  // The confidentiality requirement is that NO other user can reach the token
  // — i.e. no group/other permission bits — not an exact 0700 (round 4, finding
  // 4: an owner-only 0500 is equally confidential for an existing token). We
  // create the directory 0700; we accept any owner-only mode on an existing one.
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new TokenError(
      `Refusing to start: state directory ${home} has permissions 0${mode.toString(8)} — group and ` +
        `other access must be 0 so no other user can reach the token. Fix with: ` +
        `chmod 700 ${JSON.stringify(home)}.`,
    );
  }
  if (hasExtendedAcl(home)) {
    throw new TokenError(
      `Refusing to start: state directory ${home} carries an extended ACL that can grant other ` +
        `users access. Clear it with: chmod -N ${JSON.stringify(home)}.`,
    );
  }
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
  // Best-effort file-ACL check: catches the accidental case (a user ran
  // `chmod +a` on the token file). It runs `ls` on the PATH, not the fd, so it
  // is NOT a defense against an active attacker racing inode swaps — that is
  // handled structurally by the directory gate (verifyStateDir): every such
  // attack needs write access to the 0700 owner-only state directory, which is
  // limited to the owner (attacking themselves, meaningless) and root (who can
  // read the token regardless). See the module header. The token bytes read
  // below still come from the opened fd (inode-bound, finding 8).
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
    try {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      chmodSync(home, 0o700); // mkdir's mode is umask-masked; force owner-only
    } catch (error) {
      throw new TokenError(
        `Refusing to start: cannot create state directory ${home}: ${redactErrno(error)}.`,
      );
    }
    stripInheritedAcl(home); // a directory ACL must not widen what we create
  }
  // The state directory is the confidentiality gate (round 3, findings 1/2):
  // a token inside a 0700 owner-only directory is unreachable by other users
  // regardless of the file's own ACL, and every inode-swap/symlink/hardlink
  // attack on the token file needs write access to this directory. Verify it
  // fail-closed before trusting anything inside it.
  verifyStateDir(home);

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
    throw new TokenError(
      `Refusing to start: cannot open token file ${path}: ${redactErrno(error)}`,
    );
  }
}

/**
 * Write a fresh token to a unique temp file, then publish it atomically with
 * link() so the visible `auth-token` path never exists half-written. If another
 * first run published first (link → EEXIST), read and return theirs.
 *
 * Ordering matters (round 3, findings 2 and 4): the temp file's ACL is stripped
 * and verified ACL-free BEFORE any secret bytes are written, so the token is
 * never on disk while an inherited ACL is active. Any failure before publish
 * best-effort unlinks the temp file and raises a clean TokenError with only an
 * errno code (no raw OS message). If that cleanup unlink itself fails (the state
 * directory was made unwritable mid-flight), the leftover is a 0600 file inside
 * the 0700 owner-only directory — never read as a token, never cross-user
 * (round 4, finding 6).
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
      `Refusing to start: cannot create temporary token file ${tmpPath}: ${redactErrno(error)}`,
    );
  }

  // Everything from here until publish either succeeds or unlinks the temp file
  // and rethrows a clean TokenError — no secret bytes survive a failure.
  try {
    fchmodSync(tmpFd, 0o600); // umask-independent: open()'s mode is masked, this is not
    // Strip and verify ACL-free on the EMPTY file, before writing the secret.
    stripInheritedAcl(tmpPath);
    if (hasExtendedAcl(tmpPath)) {
      throw new TokenError(
        `Refusing to start: a freshly created token file inherited an extended ACL from its ` +
          `directory and it could not be stripped. Clear the ACL on the containing directory ` +
          `(chmod -N) so the token can be created owner-only.`,
      );
    }
    const payload = Buffer.from(`${token}\n`, "utf8");
    let offset = 0;
    while (offset < payload.length) {
      offset += writeSync(tmpFd, payload, offset, payload.length - offset);
    }
    fsyncSync(tmpFd);
  } catch (error) {
    closeSync(tmpFd);
    safeUnlink(tmpPath);
    throw error instanceof TokenError
      ? error
      : new TokenError(`Refusing to start: cannot write token file: ${redactErrno(error)}`);
  }
  closeSync(tmpFd);

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
    throw new TokenError(
      `Refusing to start: cannot publish token file ${path}: ${redactErrno(error)}`,
    );
  }
  safeUnlink(tmpPath); // the published path now holds the inode; drop the temp name
  return { token, path, created: true };
}

/** Surface only the errno code, never a raw message that could echo a secret path. */
function redactErrno(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code ?? "I/O error";
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Cleanup is best-effort (round 4, finding 6): if the state directory was
    // made unwritable mid-flight the unlink can fail, leaving a 0600 temp file.
    // That leftover is 0600 inside the 0700 owner-only state directory, so it is
    // never a cross-user exposure — the token file naming (`auth-token`) means
    // it is never read as a token, and the directory gate keeps it owner-only.
  }
}
