// Leader election, to prevent duplicate notifications across windows.
//
// A VS Code extension host is one process per window, so three open windows means three
// chirin instances and three notifications for the same event. The Watcher's throttle is an
// in-process Map and cannot suppress that.
// So the windows contend for a lock file and only the leader runs the Watcher.
//
// Residency extends only as far as "runs while at least one VS Code window is open"; there
// is no mechanism to stay resident from login. This is an accepted trade-off.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readRange } from "./fileread.js";
import { errorMessage, log } from "./log.js";

/** How often a follower checks whether the lock is free. */
const FOLLOWER_CHECK_MS = 5000;
/** How many missed heartbeats before the owner is presumed dead. */
const STALE_HEARTBEATS = 5;
/** How far into the future a ts may sit and still count as a live owner (the clock rollback we anticipate). */
const FUTURE_TS_TOLERANCE_MS = 30_000;
/**
 * What happens once lock operations have failed this many times in a row.
 * A leader is force-demoted (zombie-leader mitigation). A follower has not even managed to
 * take the lock, so onStalled tells the caller that "which window is watching" cannot be
 * determined.
 */
const TICK_FAILURE_LIMIT = 3;
/** Serialized locks are under 128 bytes; leave room for compatible additions without unbounded reads. */
export const MAX_LOCK_BYTES = 4096;

interface LockData {
  pid: number;
  /**
   * Owner identifier. With the pid alone, pid reuse could make us mistake someone else's
   * lock for our own, so each process carries a random value for identification.
   */
  owner: string;
  ts: number;
}

export interface LeaderCallbacks {
  /** Promoted to leader (start the Watcher). */
  onAcquire(): void;
  /** Lost leadership (stop the Watcher). */
  onRelease(): void;
  /**
   * Tried to get promoted, but another window holds the lock.
   * onRelease is not called when promotion fails, so without this a window that never became
   * leader would have no way to learn that "another window is watching" (its status display
   * would drift from reality).
   * It fires on every tick for as long as the window stays a follower, so the receiver must
   * collapse repeats itself.
   */
  onFollow?(): void;
  /**
   * Lock operations have failed repeatedly and who the leader is can no longer be determined
   * (followers only). Without this, neither onFollow nor onAcquire fires, the previous
   * display lingers, and a possibly-unwatched state looks "healthy". It fires on every tick
   * until things recover.
   */
  onStalled?(): void;
}

export class LeaderElection {
  /** Value that uniquely identifies this process. Used to decide who owns the lock. */
  private readonly owner = crypto.randomUUID();
  private leader = false;
  private timer: NodeJS.Timeout | undefined;
  private tickFailures = 0;

  constructor(
    private readonly lockPath: string,
    /**
     * How often the leader refreshes ts. The freshness check (used when stealing) measures
     * against the reader's own heartbeatMs, so every window must pass the same value
     * (otherwise a follower with a short interval wrongly steals the lock of a leader with a
     * long one).
     */
    private readonly heartbeatMs: number,
    private readonly callbacks: LeaderCallbacks,
    /** How often a follower attempts promotion. An injection point purely so tests can shorten it. */
    private readonly followerCheckMs: number = FOLLOWER_CHECK_MS,
  ) {}

  isLeader(): boolean {
    return this.leader;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.tick();
  }

  /** Stops the timer and, if we are the leader, releases the lock (so the next window can be promoted immediately). */
  stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.leader) {
      this.leader = false;
      this.releaseLock();
      this.callbacks.onRelease();
    }
  }

  /**
   * Refreshes ts as leader, or attempts promotion as follower.
   * The next interval depends on the state, so a fresh setTimeout is armed each time rather
   * than a setInterval.
   */
  private tick(): void {
    try {
      if (this.leader) {
        this.renewOrDemote();
      } else {
        this.tryPromote();
      }
      this.tickFailures = 0;
    } catch (err) {
      // A failed lock operation must not take the extension down. Retry on the next tick.
      log.warn(`leader election tick failed: ${errorMessage(err)}`);
      if (++this.tickFailures >= TICK_FAILURE_LIMIT) {
        if (this.leader) {
          // Failing repeatedly while still leader means ts stops being refreshed; another
          // window steals the lock and we keep notifying without noticing (zombie leader =
          // duplicate notifications). Demote once the failures persist.
          log.warn(
            `renewing the watcher lock failed ${this.tickFailures} times in a row; demoting to avoid duplicate notifications`,
          );
          this.tickFailures = 0;
          this.demote();
        } else {
          // The follower has not even managed to attempt promotion. With onFollow never
          // firing, the previous display would linger and suggest "watching is fine", so
          // report that we cannot tell. Fire on every tick until recovery (the counter is
          // not reset).
          try {
            this.callbacks.onStalled?.();
          } catch (stalledErr) {
            log.warn(`onStalled callback failed: ${errorMessage(stalledErr)}`);
          }
        }
      }
    }
    const next = this.leader ? this.heartbeatMs : this.followerCheckMs;
    this.timer = setTimeout(() => this.tick(), next);
    // Do not hold the extension host open
    this.timer.unref?.();
  }

  /** Refreshes ts as leader. Demotes if the lock now belongs to someone else. */
  private renewOrDemote(): void {
    let fd: number;
    try {
      fd = fs.openSync(
        this.lockPath,
        fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ELOOP") {
        log.warn("lost leadership: the watcher lock is a symlink");
        this.demote();
        return;
      }
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // The lock is gone (a cleanup tool, say). Always recreate through the atomic publish,
      // and demote gracefully if another window has already published one.
      if (this.recreateLock()) return;
      log.warn("lost leadership: the watcher lock was recreated by another window");
      this.demote();
      return;
    }
    try {
      // The refresh is an in-place write to the fd, not a rename onto the path. Overwriting
      // via rename would also clobber the new lock of a window that stole it (rename + wx)
      // between our read and write, producing two leaders. With an fd, we keep pointing at
      // the displaced old file after a steal, so the write never reaches the new lock.
      const current = this.readLockFd(fd);
      if (current === null || current.owner !== this.owner) {
        // Do not overwrite an unreadable, corrupted lock either (never clobber a window mid-steal)
        log.warn("lost leadership: the watcher lock was taken by another window");
        this.demote();
        return;
      }
      const data = this.serialize();
      fs.writeSync(fd, data, 0, "utf8");
      fs.ftruncateSync(fd, Buffer.byteLength(data));
    } finally {
      fs.closeSync(fd);
    }
    // Re-read in case the lock was stolen between opening the fd and writing. If it was,
    // demote immediately rather than carrying a two-leader window to the next heartbeat.
    if (this.readLock()?.owner !== this.owner) {
      log.warn("lost leadership: the watcher lock was taken by another window");
      this.demote();
    }
  }

  /** Gives up leadership and stops the Watcher (without touching the lock). */
  private demote(): void {
    this.leader = false;
    this.callbacks.onRelease();
  }

  /** Recreates a vanished lock. Returns false if another window's lock already exists. */
  private recreateLock(): boolean {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true, mode: 0o700 });
    return this.publishLock();
  }

  /**
   * Makes our lock visible at lockPath, complete on the very first sight of it.
   * Returns false when another window's lock is already there; every other failure throws
   * (it is a persistent fault, not a lost race - see the tick failure counter).
   *
   * Creating the file with `wx` and writing the JSON afterwards would not do: between the two
   * operations the lock is visible but empty, and a window that reads it then parses nothing,
   * judges it corrupted, renames it aside and creates its own - after which our write still
   * succeeds against the displaced fd and we believe we hold a lock that nobody can see. Two
   * leaders, two notifications.
   * So write the content into a private temporary file first and publish it with link(),
   * which is atomic and refuses to overwrite: whatever becomes visible at lockPath is a
   * complete lock, and only one window can publish it.
   */
  private publishLock(): boolean {
    const staging = `${this.lockPath}.new-${process.pid}-${crypto.randomUUID()}`;
    fs.writeFileSync(staging, this.serialize(), { mode: 0o600, flag: "wx" });
    try {
      fs.linkSync(staging, this.lockPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    } finally {
      // The published lock keeps its own link, so removing the staging name never removes it.
      // Only ever our own file, so this cannot delete another owner's lock.
      try {
        fs.unlinkSync(staging);
      } catch (err) {
        log.warn(`failed to remove a temporary lock file: ${errorMessage(err)}`);
      }
    }
  }

  /** Takes the lock if it is free and is promoted to leader. */
  private tryPromote(): void {
    if (!this.acquireLock()) {
      // This is a display-only callback with no effect on the notification path, so a throw must not stop promotion retries.
      try {
        this.callbacks.onFollow?.();
      } catch (err) {
        log.warn(`onFollow callback failed: ${errorMessage(err)}`);
      }
      return;
    }
    log.info(`acquired the watcher lock: ${this.lockPath}`);
    try {
      this.callbacks.onAcquire();
    } catch (err) {
      // Becoming leader without managing to start watching would leave us refreshing ts
      // forever, blocking every other window's promotion and stopping notifications for
      // good. Release the lock, stay a follower, and bet on the next tick.
      this.releaseLock();
      // onAcquire may have partly succeeded, leaving the Watcher running. A window that
      // watches without holding the lock causes duplicate notifications, so run the same
      // cleanup as a demotion.
      try {
        this.callbacks.onRelease();
      } catch (releaseErr) {
        log.warn(`failed to clean up after a failed promotion: ${errorMessage(releaseErr)}`);
      }
      throw err;
    }
    // Only count as leader once onAcquire has succeeded
    this.leader = true;
  }

  /**
   * Attempts to take the lock.
   *  1. If publishLock links it into place, it is definitively ours (atomic, so no race)
   *  2. If it already exists, check the freshness of ts and steal it via rename when stale
   *
   * A liveness probe on the pid (`process.kill(pid, 0)`) is deliberately not used: the ts
   * freshness check is simpler and less brittle than misjudging a reused pid.
   */
  private acquireLock(): boolean {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true, mode: 0o700 });
    if (this.publishLock()) return true;

    const current = this.readLock();
    // An unreadable, corrupted lock would block everyone from being promoted if left alone, so treat it as stealable
    if (current !== null && this.isLockFresh(current.ts)) return false;

    return this.stealLock();
  }

  /**
   * Whether the lock's owner can still be presumed alive.
   *
   * A ts in the future comes from a clock rollback (an NTP correction, a snapshot restore).
   * With plain subtraction it would read as "fresh" forever and nobody could be promoted;
   * measuring it with the same yardstick as the past would let a small rollback steal a live
   * leader's lock and produce duplicate notifications. So only the future side gets a wide
   * tolerance.
   */
  private isLockFresh(ts: number): boolean {
    const age = Date.now() - ts;
    if (age < 0) return -age < FUTURE_TS_TOLERANCE_MS;
    return age < this.heartbeatMs * STALE_HEARTBEATS;
  }

  /**
   * Takes over a stale lock and recreates it.
   *
   * The rename that displaces it comes first because only one process can consume the same
   * source (the losers get ENOENT). With an overwrite, several windows judging the lock
   * "stale" at once would all succeed at writing, and reading back right afterwards would
   * still not prevent two leaders.
   */
  private stealLock(): boolean {
    const stale = `${this.lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
    try {
      fs.renameSync(this.lockPath, stale);
    } catch (err) {
      // ENOENT means another window took it over first (or the owner released it): an
      // expected race, so stay a follower and re-read on the next tick.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      // Anything else (a directory we cannot write to, an I/O error) is a persistent fault.
      // Reporting it as an ordinary lost race would display "another window is watching"
      // when no window is, so let it reach the tick failure counter instead.
      throw err;
    }
    try {
      // If an earlier thief recreated the lock between our staleness check and the rename,
      // we would be taking over a live lock. Validate what we took and, if it is fresh, put
      // it back and skip promotion.
      const moved = this.readLockAt(stale);
      if (moved !== null && this.isLockFresh(moved.ts)) {
        try {
          // Restoring with rename could clobber a third lock published in the meantime, so
          // restore with link instead (giving up on EEXIST if one exists. The displaced
          // owner demotes on its next heartbeat re-read, so there is no two-leader window).
          fs.linkSync(stale, this.lockPath);
        } catch {
          // A failed restore is left to the self-healing described above
        }
        return false;
      }
      // If another window published one between the takeover and now, publishLock returns
      // false and we are not promoted
      return this.publishLock();
    } finally {
      // Ignore cleanup failures (a leftover displaced file does not block the next steal).
      // If the takeover failed part-way and the displaced lock did belong to someone alive
      // after all, removing it costs nothing: that owner finds it gone on its next heartbeat
      // and recreates it under its own name, so there is still only one leader.
      try {
        fs.unlinkSync(stale);
      } catch {
        // Nothing to do about it
      }
    }
  }

  /**
   * Releases our own lock.
   * "Read it, and unlink if it is ours" would delete the new lock of a window that stole it
   * between the read and the unlink. As in stealLock, displace it with rename, validate the
   * content, and restore it with link when it belongs to someone else (even if the restore
   * fails, the displaced owner demotes on its next heartbeat re-read, so there is no
   * two-leader window).
   */
  private releaseLock(): void {
    const moved = `${this.lockPath}.release-${process.pid}-${crypto.randomUUID()}`;
    try {
      fs.renameSync(this.lockPath, moved);
    } catch {
      return; // if the lock is already gone (stolen or cleaned up) there is nothing to release
    }
    try {
      let owner: string | undefined;
      try {
        owner = this.readLockAt(moved)?.owner;
      } catch (err) {
        // Releasing must not throw (it runs from stop() and from a failed promotion), and an
        // unconfirmed lock is treated as somebody else's: restore it rather than delete it.
        log.warn(`could not confirm the watcher lock before releasing it: ${errorMessage(err)}`);
      }
      if (owner !== this.owner) {
        try {
          // On macOS link() follows a source symlink. Restoring it would turn the rejected
          // link into a regular hard link to its target; discard only the symlink instead.
          if (fs.lstatSync(moved).isSymbolicLink()) return;
          fs.linkSync(moved, this.lockPath);
        } catch {
          // A failed restore is left to self-healing (the owner demotes, then someone is promoted again)
        }
      }
    } finally {
      try {
        fs.unlinkSync(moved);
      } catch (err) {
        log.warn(`failed to release the watcher lock: ${errorMessage(err)}`);
      }
    }
  }

  private serialize(): string {
    const data: LockData = { pid: process.pid, owner: this.owner, ts: Date.now() };
    return JSON.stringify(data);
  }

  /** Reads the lock. Returns null when it is absent or corrupted (= stealable). */
  private readLock(): LockData | null {
    return this.readLockAt(this.lockPath);
  }

  /**
   * Reads a lock file. Absent, non-regular, symlinked, oversized or unparsable content is null
   * (= stealable); a read that fails for any other reason throws.
   *
   * Swallowing a permission or I/O error here would turn a persistent fault into "the lock is
   * corrupted", and the steal that follows would fail in the same way - reported as an
   * ordinary lost race. The failure has to stay visible so the tick counter can report it.
   */
  private readLockAt(p: string): LockData | null {
    let fd: number;
    try {
      fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ELOOP") return null;
      throw err;
    }
    try {
      return this.readLockFd(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Validate the opened inode, including on renewal, and never read beyond the lock budget. */
  private readLockFd(fd: number): LockData | null {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size > MAX_LOCK_BYTES) {
      log.warn(`watcher lock exceeds ${MAX_LOCK_BYTES} bytes; treating it as corrupted`);
      return null;
    }
    return this.parseLock(readRange(fd, 0, st.size).toString("utf8"));
  }

  private parseLock(raw: string): LockData | null {
    try {
      const data: unknown = JSON.parse(raw);
      if (typeof data !== "object" || data === null) return null;
      const { pid, owner, ts } = data as Partial<LockData>;
      if (typeof pid !== "number" || typeof owner !== "string" || typeof ts !== "number") {
        return null;
      }
      return { pid, owner, ts };
    } catch {
      return null;
    }
  }
}

/**
 * Default path of the lock file. Kept in the same directory as the config (outside the
 * workspace), and named after the config file so that leadership is per configuration.
 *
 * Keying it on the directory alone made two configs living side by side
 * (`.../a.json` and `.../b.json`) contend for one lock, so only one of them was ever watched.
 * The name carries a digest of the config's real path: equivalent paths to the same file
 * (a symlinked directory, a different case on a case-insensitive volume) resolve to the same
 * lock, while genuinely different files get their own.
 *
 * Note this renames the lock: a window still running an older build would use the previous
 * `watcher.lock` and could watch in parallel. Restart every window after upgrading (see the
 * README's Design notes).
 */
export function defaultLockPath(configPath: string): string {
  const canonical = canonicalConfigPath(configPath);
  const digest = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return path.join(path.dirname(canonical), `watcher-${digest}.lock`);
}

/**
 * The form of the config path every window agrees on: symlinks resolved, and the case
 * normalized as the (case-insensitive by default) volume stores it.
 * Resolving the directory as a fallback covers a config that does not exist yet, since the
 * ambiguity between two paths to the same file lives in the directory part.
 */
function canonicalConfigPath(configPath: string): string {
  const resolved = path.resolve(configPath);
  const real = tryRealpath(resolved);
  if (real !== undefined) return real;
  const dir = tryRealpath(path.dirname(resolved));
  return dir === undefined ? resolved : path.join(dir, path.basename(resolved));
}

function tryRealpath(p: string): string | undefined {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
}
