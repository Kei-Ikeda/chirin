import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { LeaderElection, defaultLockPath } from "../src/leader.js";

/** Places the lock beside a config file in a per-test tmpdir and removes it afterwards. */
function setup(t: { after(fn: () => void): void }): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chirin-leader-"));
  t.after(() => {
    // Some tests make it non-writable, so always restore permissions before cleaning up
    fs.chmodSync(base, 0o700);
    fs.rmSync(base, { recursive: true, force: true });
  });
  return defaultLockPath(path.join(base, "config.json"));
}

interface Spy {
  acquired: number;
  released: number;
  followed: number;
  stalled: number;
}

/** Builds an election that counts promotion/demotion calls. It is stopped automatically after the test. */
function makeElection(
  t: { after(fn: () => void): void },
  lockPath: string,
  options: { heartbeatMs?: number; followerCheckMs?: number } = {},
): { election: LeaderElection; spy: Spy } {
  const spy: Spy = { acquired: 0, released: 0, followed: 0, stalled: 0 };
  const election = new LeaderElection(
    lockPath,
    options.heartbeatMs ?? 60_000, // long enough that no heartbeat fires during the test
    {
      onAcquire: () => spy.acquired++,
      onRelease: () => spy.released++,
      onFollow: () => spy.followed++,
      onStalled: () => spy.stalled++,
    },
    options.followerCheckMs ?? 20,
  );
  t.after(() => election.stop());
  return { election, spy };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("the first instance takes the lock and becomes leader", (t) => {
  const lockPath = setup(t);
  const { election, spy } = makeElection(t, lockPath);

  election.start();

  assert.equal(election.isLeader(), true);
  assert.equal(spy.acquired, 1);
  assert.equal(fs.existsSync(lockPath), true);
});

test("the lock is created with 0600 (no other user can take it)", (t) => {
  const lockPath = setup(t);
  const { election } = makeElection(t, lockPath);

  election.start();

  assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600);
});

test("a second instance is not promoted (preventing duplicate notifications)", (t) => {
  const lockPath = setup(t);
  const first = makeElection(t, lockPath);
  const second = makeElection(t, lockPath);

  first.election.start();
  second.election.start();

  assert.equal(first.election.isLeader(), true);
  assert.equal(second.election.isLeader(), false);
  assert.equal(second.spy.acquired, 0);
});

test("stopping the leader releases the lock and the next instance takes over", async (t) => {
  const lockPath = setup(t);
  const first = makeElection(t, lockPath);
  const second = makeElection(t, lockPath);

  first.election.start();
  second.election.start();
  assert.equal(second.election.isLeader(), false);

  first.election.stop();
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(first.spy.released, 1);

  await sleep(80); // a few cycles of followerCheckMs (20ms)
  assert.equal(second.election.isLeader(), true);
  assert.equal(second.spy.acquired, 1);
});

test("a stale lock whose heartbeat stopped is stolen (the window was force-quit)", (t) => {
  const lockPath = setup(t);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // Place another process's lock with a ts far older than heartbeatMs=1000
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, owner: "someone-else", ts: Date.now() - 60_000 }),
    { mode: 0o600 },
  );

  const { election, spy } = makeElection(t, lockPath, { heartbeatMs: 1000 });
  election.start();

  assert.equal(election.isLeader(), true);
  assert.equal(spy.acquired, 1);
});

test("a lock with a far-future ts is stolen (the clock rolled back)", (t) => {
  const lockPath = setup(t);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // A lock whose ts stayed in the future after the owner died, because of a clock rollback
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, owner: "someone-else", ts: Date.now() + 60_000 }),
    { mode: 0o600 },
  );

  const { election, spy } = makeElection(t, lockPath, { heartbeatMs: 1000 });
  election.start();

  assert.equal(election.isLeader(), true);
  assert.equal(spy.acquired, 1);
  // No displaced or staging file is left behind after a steal
  assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), [path.basename(lockPath)]);
});

test("a lock with a slightly future ts is not stolen (a live leader keeps it)", (t) => {
  const lockPath = setup(t);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // The clock rolled back only slightly and the owner is still heartbeating
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, owner: "someone-else", ts: Date.now() + 2000 }),
    { mode: 0o600 },
  );

  const { election, spy } = makeElection(t, lockPath, { heartbeatMs: 1000 });
  election.start();

  assert.equal(election.isLeader(), false);
  assert.equal(spy.acquired, 0);
});

test("a fresh lock owned by another process is not stolen", (t) => {
  const lockPath = setup(t);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, owner: "someone-else", ts: Date.now() }),
    { mode: 0o600 },
  );

  const { election, spy } = makeElection(t, lockPath, { heartbeatMs: 1000 });
  election.start();

  assert.equal(election.isLeader(), false);
  assert.equal(spy.acquired, 0);
});

test("a corrupted lock is stolen (never leaving a state where nobody can be promoted)", (t) => {
  const lockPath = setup(t);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, "{ not json", { mode: 0o600 });

  const { election } = makeElection(t, lockPath);
  election.start();

  assert.equal(election.isLeader(), true);
});

test("a leader whose lock was overwritten by another process demotes", async (t) => {
  const lockPath = setup(t);
  // Keep the follower check interval long so it is not re-promoted right after demoting.
  // A delayed timer on CI would mark the external lock stale, steal it back and break the assertion.
  const { election, spy } = makeElection(t, lockPath, { heartbeatMs: 20, followerCheckMs: 10_000 });

  election.start();
  assert.equal(election.isLeader(), true);

  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, owner: "someone-else", ts: Date.now() }),
    { mode: 0o600 },
  );

  await sleep(80); // a few cycles of heartbeatMs (20ms)
  assert.equal(election.isLeader(), false);
  assert.equal(spy.released, 1);
});

test("the leader recreates a vanished lock (and keeps watching under its own owner)", async (t) => {
  const lockPath = setup(t);
  const { election, spy } = makeElection(t, lockPath, { heartbeatMs: 20 });

  election.start();
  const owner = (JSON.parse(fs.readFileSync(lockPath, "utf8")) as { owner: string }).owner;

  fs.unlinkSync(lockPath); // as if removed by a cleanup tool
  await sleep(80); // a few cycles of heartbeatMs (20ms)

  assert.equal(election.isLeader(), true);
  assert.equal(spy.released, 0);
  assert.equal((JSON.parse(fs.readFileSync(lockPath, "utf8")) as { owner: string }).owner, owner);
});

test("an unreadable lock demotes instead of being overwritten (never clobbering a window mid-steal)", async (t) => {
  const lockPath = setup(t);
  // Keep the follower check interval long so it is not re-promoted right after demoting
  const { election, spy } = makeElection(t, lockPath, { heartbeatMs: 20, followerCheckMs: 10_000 });

  election.start();
  assert.equal(election.isLeader(), true);

  // An unreadable lock means "it exists but cannot be confirmed as ours". Overwriting via
  // rename here would clobber the lock created by a window mid-steal, producing two leaders.
  const unreadable = "{ broken";
  fs.writeFileSync(lockPath, unreadable, { mode: 0o600 });
  await sleep(80);

  assert.equal(election.isLeader(), false);
  assert.equal(spy.released, 1);
  assert.equal(fs.readFileSync(lockPath, "utf8"), unreadable);
});

test("another process's lock is not released (stop never deletes someone else's lock)", async (t) => {
  const lockPath = setup(t);
  // Keep the follower check interval long so it does not steal the lock back as stale after demoting
  const { election } = makeElection(t, lockPath, { heartbeatMs: 20, followerCheckMs: 10_000 });

  election.start();
  const foreign = JSON.stringify({ pid: 999999, owner: "someone-else", ts: Date.now() });
  fs.writeFileSync(lockPath, foreign, { mode: 0o600 });
  await sleep(80); // wait for the demotion

  election.stop();

  assert.equal(fs.readFileSync(lockPath, "utf8"), foreign);
});

test("a leader that keeps failing to renew the lock is force-demoted (zombie-leader mitigation)", async (t) => {
  const lockPath = setup(t);
  const { election, spy } = makeElection(t, lockPath, { heartbeatMs: 20, followerCheckMs: 10_000 });

  election.start();
  assert.equal(election.isLeader(), true);

  // Drop the directory permissions so lock reads and writes fail (standing in for fd
  // exhaustion and the like). Without demoting, ts refreshes would just stop and we would
  // keep notifying after another window steals the lock.
  const dir = path.dirname(lockPath);
  fs.chmodSync(dir, 0o000);

  const deadline = Date.now() + 2000; // comfortably longer than the consecutive-failure limit (3 x 20ms)
  while (election.isLeader() && Date.now() < deadline) await sleep(20);

  // after hooks run in registration order (setup's rmSync comes first), so restore permissions here
  fs.chmodSync(dir, 0o700);
  assert.equal(election.isLeader(), false);
  assert.equal(spy.released, 1);
});

test("a window whose onAcquire failed does not become leader and gives up both the lock and the watch", (t) => {
  const lockPath = setup(t);
  let released = 0;
  // Holding the lock without managing to start watching would block every other window from being promoted
  const election = new LeaderElection(
    lockPath,
    60_000,
    {
      onAcquire: () => {
        throw new Error("failed to start the watcher");
      },
      onRelease: () => {
        released++;
      },
    },
    20,
  );
  t.after(() => election.stop());

  election.start();

  assert.equal(election.isLeader(), false);
  assert.equal(fs.existsSync(lockPath), false);
  // Run the cleanup so the Watcher does not keep running when onAcquire partly succeeded
  assert.equal(released, 1);
});

test("a window that could not be promoted receives onFollow (so it knows another window is watching)", (t) => {
  const lockPath = setup(t);
  const first = makeElection(t, lockPath);
  const second = makeElection(t, lockPath);

  first.election.start();
  second.election.start();

  // It never became leader, so onRelease is not called. onFollow is the only path that
  // conveys "another window is watching".
  assert.equal(second.spy.followed, 1);
  assert.equal(second.spy.released, 0);
  // The leader was promoted, so it does not receive onFollow
  assert.equal(first.spy.followed, 0);
});

test("onFollow arrives on every tick for as long as the window stays a follower", async (t) => {
  const lockPath = setup(t);
  const first = makeElection(t, lockPath);
  const second = makeElection(t, lockPath, { followerCheckMs: 10 });

  first.election.start();
  second.election.start();
  const initial = second.spy.followed;
  await sleep(60);

  assert.equal(second.election.isLeader(), false);
  assert.ok(
    second.spy.followed > initial,
    `onFollow was not re-delivered (initial=${initial}, now=${second.spy.followed})`,
  );
});

/**
 * Makes the directory holding the lock non-writable so lock operations reliably fail.
 * Making the lock path a directory would not work: stealLock could still take it via rename.
 */
function breakLock(lockPath: string): void {
  fs.chmodSync(path.dirname(lockPath), 0o500);
}

/** Undoes breakLock so lock operations succeed again. */
function repairLock(lockPath: string): void {
  fs.chmodSync(path.dirname(lockPath), 0o700);
}

test("a follower whose lock operations keep failing reports the unknown state through onStalled", async (t) => {
  const lockPath = setup(t);
  breakLock(lockPath);
  const { election, spy } = makeElection(t, lockPath, { followerCheckMs: 10 });

  election.start();

  // Retry silently up to the third failure (a transient failure raises no warning)
  assert.equal(spy.stalled, 0);
  await sleep(80);

  assert.equal(election.isLeader(), false);
  assert.ok(spy.stalled > 0, "onStalled was not called");
  // It was neither promoted nor demoted, so no other callback fires
  assert.equal(spy.acquired, 0);
  assert.equal(spy.released, 0);
  assert.equal(spy.followed, 0);
});

test("once lock operations recover, the follower returns to the normal path", async (t) => {
  const lockPath = setup(t);
  breakLock(lockPath);
  const { election, spy } = makeElection(t, lockPath, { followerCheckMs: 10 });

  election.start();
  await sleep(80);
  assert.ok(spy.stalled > 0, "precondition: it went stalled at least once");

  repairLock(lockPath);
  await sleep(40);

  assert.equal(election.isLeader(), true);
  assert.equal(spy.acquired, 1);
});

// --- lock identity (one lock per config file) -----------------------------

/** A tmpdir that is cleaned up after the test. */
function tmpdir(t: { after(fn: () => void): void }): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chirin-lockid-"));
  t.after(() => {
    fs.chmodSync(base, 0o700);
    fs.rmSync(base, { recursive: true, force: true });
  });
  return base;
}

test("the lock is named after the config file, beside it", (t) => {
  const base = tmpdir(t);
  const configPath = path.join(base, "config.json");
  fs.writeFileSync(configPath, "{}", { mode: 0o600 });

  const lockPath = defaultLockPath(configPath);

  // The README documents this shape, and an upgrade note depends on it having changed
  assert.equal(path.dirname(lockPath), fs.realpathSync.native(base));
  assert.match(path.basename(lockPath), /^watcher-[0-9a-f]{16}\.lock$/);
});

test("two configs in the same directory each get their own leader", (t) => {
  const base = tmpdir(t);
  fs.writeFileSync(path.join(base, "a.json"), "{}", { mode: 0o600 });
  fs.writeFileSync(path.join(base, "b.json"), "{}", { mode: 0o600 });

  const a = makeElection(t, defaultLockPath(path.join(base, "a.json")));
  const b = makeElection(t, defaultLockPath(path.join(base, "b.json")));

  a.election.start();
  b.election.start();

  // Keying the lock on the directory alone made the second config's watcher never start
  assert.equal(a.election.isLeader(), true);
  assert.equal(b.election.isLeader(), true);
});

test("equivalent paths to one config still contend for a single lock", (t) => {
  const base = tmpdir(t);
  const configPath = path.join(base, "config.json");
  fs.writeFileSync(configPath, "{}", { mode: 0o600 });
  // The same file named through "." and through a symlink to its directory
  const link = path.join(base, "link");
  fs.symlinkSync(base, link);

  const direct = defaultLockPath(configPath);
  assert.equal(defaultLockPath(path.join(base, ".", "config.json")), direct);
  assert.equal(defaultLockPath(path.join(link, "config.json")), direct);

  const first = makeElection(t, direct);
  const second = makeElection(t, defaultLockPath(path.join(link, "config.json")));
  first.election.start();
  second.election.start();

  assert.equal(first.election.isLeader(), true);
  assert.equal(second.election.isLeader(), false);
});

// --- publishing a lock atomically -----------------------------------------

test("the lock is published complete: it is never created by a write to its own path", (t) => {
  const lockPath = setup(t);
  const { election } = makeElection(t, lockPath);
  t.after(() => mock.restoreAll());

  // Creating the file at lockPath and writing the JSON into it afterwards leaves it visible
  // but empty in between, and another window reads that as a corrupted lock it may take over.
  // The content is therefore written elsewhere and linked into place, so this records every
  // direct write to the lock path itself - there must be none.
  const realWriteFileSync = fs.writeFileSync;
  const directWrites: string[] = [];
  mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (args[0] === lockPath) directWrites.push(String(args[0]));
    return realWriteFileSync(...args);
  });

  election.start();
  mock.restoreAll();

  assert.equal(election.isLeader(), true);
  assert.deepEqual(directWrites, [], "the lock was created by writing to its own path");
});

test("a contender racing the moment before the lock is published does not become a second leader", (t) => {
  const lockPath = setup(t);
  const first = makeElection(t, lockPath);
  const second = makeElection(t, lockPath);
  t.after(() => mock.restoreAll());

  // Interleave the second election exactly where the first one has prepared its lock but has
  // not made it visible yet - the point at which the old protocol had already created an
  // empty file that a contender would take over, leaving both windows leaders.
  const realLinkSync = fs.linkSync;
  let interleaved = false;
  mock.method(fs, "linkSync", (...args: Parameters<typeof fs.linkSync>) => {
    if (!interleaved && args[1] === lockPath) {
      interleaved = true;
      second.election.start();
    }
    return realLinkSync(...args);
  });

  first.election.start();
  mock.restoreAll();

  assert.equal(interleaved, true, "the interleaving never happened");
  // Decided at the moment the lock became visible - not corrected by a later heartbeat, by
  // which point both windows would already have notified.
  assert.equal(
    Number(first.election.isLeader()) + Number(second.election.isLeader()),
    1,
    "two windows were promoted at once",
  );
  assert.equal(first.spy.acquired + second.spy.acquired, 1);
  // Whatever is visible at the lock path is a complete lock, and nothing else is left behind
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { owner?: unknown };
  assert.equal(typeof lock.owner, "string");
  assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), [path.basename(lockPath)]);
});

test("acquiring, recreating and stealing all leave no staging file behind", async (t) => {
  const lockPath = setup(t);
  const dir = path.dirname(lockPath);
  const { election } = makeElection(t, lockPath, { heartbeatMs: 20 });

  // 1. plain acquisition
  election.start();
  assert.deepEqual(fs.readdirSync(dir), [path.basename(lockPath)]);

  // 2. recreation after the lock vanished
  fs.unlinkSync(lockPath);
  await sleep(80);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(lockPath)]);

  // 3. takeover of a stale lock by another election
  election.stop();
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, owner: "someone-else", ts: Date.now() - 60_000 }),
    { mode: 0o600 },
  );
  const thief = makeElection(t, lockPath, { heartbeatMs: 1000 });
  thief.election.start();
  assert.equal(thief.election.isLeader(), true);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(lockPath)]);
});

// --- telling a lost race apart from a broken filesystem --------------------

test("a stale lock in an unwritable directory is reported as unknown, not as healthy following", async (t) => {
  const lockPath = setup(t);
  // A lock nobody is refreshing any more, in a directory we cannot write to: the takeover
  // fails for lack of permission, which is not the same thing as losing a race to another
  // window. Reporting it as following would claim a window is watching when none is.
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, owner: "someone-else", ts: Date.now() - 60_000 }),
    { mode: 0o600 },
  );
  breakLock(lockPath);

  const { election, spy } = makeElection(t, lockPath, { heartbeatMs: 1000, followerCheckMs: 10 });
  election.start();
  await sleep(80);

  assert.equal(election.isLeader(), false);
  assert.ok(spy.stalled > 0, "onStalled was not called");
  assert.equal(spy.followed, 0, "a permission failure was reported as ordinary following");
  assert.equal(spy.acquired, 0);

  // And it recovers on its own once the directory is writable again
  repairLock(lockPath);
  await sleep(40);
  assert.equal(election.isLeader(), true);
  assert.equal(spy.acquired, 1);
});

/** Places a lock nobody is refreshing any more (the window it belonged to was force-quit). */
function writeStaleLock(lockPath: string): void {
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, owner: "someone-else", ts: Date.now() - 60_000 }),
    { mode: 0o600 },
  );
}

/** Makes one fs function fail with the given errno, as a persistent fault would. */
function failWith(name: "renameSync" | "readFileSync", code: string, onlyFor?: string): void {
  const real = fs[name] as (...args: unknown[]) => unknown;
  mock.method(fs, name, (...args: unknown[]) => {
    if (onlyFor === undefined || String(args[0]) === onlyFor) {
      const err: NodeJS.ErrnoException = new Error(`${code}: injected failure`);
      err.code = code;
      throw err;
    }
    return real(...args);
  });
}

test("a takeover that fails for lack of permission is reported as unknown, not as following", async (t) => {
  const lockPath = setup(t);
  writeStaleLock(lockPath);
  t.after(() => mock.restoreAll());
  // The takeover rename fails persistently. Reading that as "another window got there first"
  // would claim a window is watching when the stale lock's owner is long gone.
  failWith("renameSync", "EACCES");

  const { election, spy } = makeElection(t, lockPath, { heartbeatMs: 1000, followerCheckMs: 10 });
  election.start();
  await sleep(80);
  mock.restoreAll();

  assert.equal(election.isLeader(), false);
  assert.ok(spy.stalled > 0, "onStalled was not called");
  assert.equal(spy.followed, 0, "a permission failure was reported as ordinary following");
  assert.equal(spy.acquired, 0);
});

test("a lock we cannot read is reported as unknown rather than taken over", async (t) => {
  const lockPath = setup(t);
  writeStaleLock(lockPath);
  t.after(() => mock.restoreAll());
  // Unparsable *content* is stealable, but a read that fails leaves us unable to tell whether
  // a live window owns the lock - taking it over there is how two leaders happen.
  failWith("readFileSync", "EACCES", lockPath);

  const { election, spy } = makeElection(t, lockPath, { heartbeatMs: 1000, followerCheckMs: 10 });
  election.start();
  await sleep(80);
  mock.restoreAll();

  assert.equal(election.isLeader(), false);
  assert.equal(spy.acquired, 0, "a lock that could not be read was taken over anyway");
  assert.ok(spy.stalled > 0, "onStalled was not called");
  assert.equal(spy.followed, 0);
});

test("a fresh lock held by a live owner stays an ordinary follower", async (t) => {
  const lockPath = setup(t);
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, owner: "someone-else", ts: Date.now() }),
    { mode: 0o600 },
  );

  const { election, spy } = makeElection(t, lockPath, { heartbeatMs: 1000, followerCheckMs: 10 });
  election.start();
  await sleep(80);

  assert.equal(election.isLeader(), false);
  assert.ok(spy.followed > 0, "onFollow was not called");
  assert.equal(spy.stalled, 0, "an expected race was reported as a persistent fault");
});

test("a lock that disappears mid-takeover is an expected race, not a fault", async (t) => {
  const lockPath = setup(t);
  const { election, spy } = makeElection(t, lockPath, { heartbeatMs: 1000, followerCheckMs: 10 });
  t.after(() => mock.restoreAll());

  // A stale lock that another window consumes just before our own rename reaches it
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, owner: "someone-else", ts: Date.now() - 60_000 }),
    { mode: 0o600 },
  );
  const realRenameSync = fs.renameSync;
  let stolen = false;
  mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
    if (!stolen) {
      stolen = true;
      fs.unlinkSync(lockPath); // the other window got there first
    }
    return realRenameSync(...args);
  });

  election.start();
  mock.restoreAll();

  assert.equal(stolen, true, "the interleaving never happened");
  assert.equal(spy.stalled, 0, "a lost race was reported as a persistent fault");
});
