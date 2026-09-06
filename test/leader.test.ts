import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LeaderElection, defaultLockPath } from "../src/leader.js";

/** Places the lock in a per-test tmpdir and removes it afterwards. */
function setup(t: { after(fn: () => void): void }): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chirin-leader-"));
  t.after(() => {
    // Some tests make it non-writable, so always restore permissions before cleaning up
    fs.chmodSync(base, 0o700);
    fs.rmSync(base, { recursive: true, force: true });
  });
  return defaultLockPath(base);
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
  // No displaced file is left behind after a steal
  assert.deepEqual(fs.readdirSync(path.dirname(lockPath)), ["watcher.lock"]);
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
