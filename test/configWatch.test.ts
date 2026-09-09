import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MAX_CONFIG_BYTES } from "../src/config.js";
import { ConfigTracker } from "../src/configWatch.js";

// Change detection for the config file, driven against real files and real permissions:
// the case that matters most (a rejection repaired with chmod alone) leaves the bytes
// untouched, so nothing but the real mode bits can reproduce it.

const VALID_CONFIG = JSON.stringify({
  rules: [
    {
      id: "stop",
      watch: ["/tmp/chirin-configwatch/.claude/chirin-notify-state.json"],
      match: { type: "event", equals: "Stop" },
      notify: { message: "done" },
    },
  ],
});

interface Fixture {
  dir: string;
  configPath: string;
  tracker: ConfigTracker;
}

function setup(t: { after(fn: () => void): void }, content = VALID_CONFIG, mode = 0o600): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chirin-configwatch-"));
  t.after(() => {
    // A test may leave the directory group-writable or unreadable; restore before cleaning up
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.chmodSync(dir, 0o700);
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, content, { mode });
  fs.chmodSync(configPath, mode);
  return { dir, configPath, tracker: new ConfigTracker() };
}

test("a config rejected only for its mode recovers on chmod, with no edit", (t) => {
  const f = setup(t, VALID_CONFIG, 0o666);

  assert.equal(f.tracker.loadNow(f.configPath).kind, "rejected");
  // Polling again while nothing has changed must not report the config as healthy
  assert.equal(f.tracker.check(f.configPath).kind, "rejected");

  fs.chmodSync(f.configPath, 0o600);

  const status = f.tracker.check(f.configPath);
  assert.equal(status.kind, "accepted");
  // The bytes never moved, so the reload is driven by the revalidation rather than by a diff
  assert.equal(status.kind === "accepted" && status.changed, false);
});

test("repairing the config directory's mode recovers as well", (t) => {
  const f = setup(t);
  fs.chmodSync(f.dir, 0o777);

  assert.equal(f.tracker.loadNow(f.configPath).kind, "rejected");

  fs.chmodSync(f.dir, 0o700);

  assert.equal(f.tracker.check(f.configPath).kind, "accepted");
});

test("an unchanged, still-broken config reports its reason only once", (t) => {
  const f = setup(t, "{ not json", 0o600);

  const first = f.tracker.check(f.configPath);
  assert.equal(first.kind, "rejected");
  assert.equal(first.kind === "rejected" && first.firstReport, true);

  for (let i = 0; i < 3; i++) {
    const repeated = f.tracker.check(f.configPath);
    assert.equal(repeated.kind, "rejected");
    assert.equal(repeated.kind === "rejected" && repeated.firstReport, false);
  }
});

test("a different rejection reason is reported again", (t) => {
  const f = setup(t, "{ not json", 0o600);
  assert.equal(f.tracker.check(f.configPath).kind, "rejected");

  fs.writeFileSync(f.configPath, JSON.stringify({ rules: [] }), { mode: 0o600 });

  const status = f.tracker.check(f.configPath);
  assert.equal(status.kind, "rejected");
  assert.equal(status.kind === "rejected" && status.firstReport, true);
});

test("a healthy, unchanged config is left alone (the watcher is not rebuilt)", (t) => {
  const f = setup(t);
  assert.equal(f.tracker.loadNow(f.configPath).kind, "accepted");

  for (let i = 0; i < 3; i++) {
    assert.equal(f.tracker.check(f.configPath).kind, "unchanged");
  }
});

test("an edit that validates reloads, and one that does not keeps the previous config", (t) => {
  const f = setup(t);
  assert.equal(f.tracker.loadNow(f.configPath).kind, "accepted");

  fs.writeFileSync(f.configPath, "{ broken", { mode: 0o600 });
  assert.equal(f.tracker.check(f.configPath).kind, "rejected");

  // A corrected save recovers
  fs.writeFileSync(f.configPath, VALID_CONFIG, { mode: 0o600 });
  const status = f.tracker.check(f.configPath);
  assert.equal(status.kind, "accepted");
  assert.equal(status.kind === "accepted" && status.changed, true);
});

test("a config that disappears keeps the current state and is picked up when it returns", (t) => {
  const f = setup(t);
  assert.equal(f.tracker.loadNow(f.configPath).kind, "accepted");

  fs.rmSync(f.configPath);
  assert.equal(f.tracker.check(f.configPath).kind, "unreadable");

  fs.writeFileSync(f.configPath, VALID_CONFIG, { mode: 0o600 });
  assert.equal(f.tracker.check(f.configPath).kind, "accepted");
});

test("a missing config still reaches the loader, so 'not configured' stays distinguishable", (t) => {
  const f = setup(t);
  fs.rmSync(f.configPath);

  const status = f.tracker.loadNow(f.configPath);
  assert.equal(status.kind, "rejected");
  assert.match(
    status.kind === "rejected" ? String(status.error) : "",
    /config not found/,
    "loadNow must not swallow a missing config into 'unreadable'",
  );
});

// A config over the byte cap is not the transient case "unreadable" stands for: the bytes stay
// where they are until someone edits the file. Reported as unreadable it would settle into
// "unchanged" on the very next poll and never be surfaced again.
test("a config that grows past the byte cap keeps being reported", (t) => {
  const f = setup(t);
  assert.equal(f.tracker.loadNow(f.configPath).kind, "accepted");

  fs.writeFileSync(f.configPath, VALID_CONFIG.padEnd(MAX_CONFIG_BYTES + 1));
  assert.equal(f.tracker.check(f.configPath).kind, "rejected");
  // Nothing moved in between, so a second poll must not fall back to "unchanged"
  assert.equal(f.tracker.check(f.configPath).kind, "rejected");

  fs.writeFileSync(f.configPath, VALID_CONFIG);
  assert.equal(f.tracker.check(f.configPath).kind, "accepted", "shrinking below the cap recovers");
});

// Replacing the config with a symlink is the swap the container side is most likely to try.
// The bounded read refuses to follow it, but refusing and saying nothing are different things.
test("a config replaced by a symlink is reported, not waited out", (t) => {
  const f = setup(t);
  assert.equal(f.tracker.loadNow(f.configPath).kind, "accepted");

  const elsewhere = path.join(f.dir, "elsewhere.json");
  fs.writeFileSync(elsewhere, VALID_CONFIG, { mode: 0o600 });
  fs.rmSync(f.configPath);
  fs.symlinkSync(elsewhere, f.configPath);

  assert.equal(f.tracker.check(f.configPath).kind, "rejected");
});

// The swap does not have to follow the last good read directly. A poll that lands while the
// file is briefly gone leaves no text behind, so the rejection that follows compares equal to
// it: without care that is exactly the "unchanged" fast path, and the swap is never reported.
test("a config rejected after a poll saw it missing is still reported", (t) => {
  const f = setup(t);
  assert.equal(f.tracker.loadNow(f.configPath).kind, "accepted");

  const elsewhere = path.join(f.dir, "elsewhere.json");
  fs.writeFileSync(elsewhere, VALID_CONFIG, { mode: 0o600 });
  fs.rmSync(f.configPath);
  assert.equal(f.tracker.check(f.configPath).kind, "unreadable");
  fs.symlinkSync(elsewhere, f.configPath);

  assert.equal(f.tracker.check(f.configPath).kind, "rejected");
  // ...and it must keep saying so rather than latching on the first answer
  assert.equal(f.tracker.check(f.configPath).kind, "rejected");
});

// The same latch, reached by the other route: the file comes back over the byte cap rather
// than as a symlink.
test("a config that comes back oversized after a missing poll is still reported", (t) => {
  const f = setup(t);
  assert.equal(f.tracker.loadNow(f.configPath).kind, "accepted");

  fs.rmSync(f.configPath);
  assert.equal(f.tracker.check(f.configPath).kind, "unreadable");
  fs.writeFileSync(f.configPath, VALID_CONFIG.padEnd(MAX_CONFIG_BYTES + 1), { mode: 0o600 });

  assert.equal(f.tracker.check(f.configPath).kind, "rejected");
});
