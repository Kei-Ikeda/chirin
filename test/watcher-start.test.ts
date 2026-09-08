import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateConfig, type Config } from "../src/config.js";
import type { NotifyOptions } from "../src/notifier.js";
import { Watcher } from "../src/watcher.js";

// What the Watcher considers "state that was already there" when watching begins.
//
// The baseline is taken by start() itself. Leaving it to the first poll meant everything
// written in between - up to a whole poll interval - was mistaken for pre-existing state and
// never notified, which is exactly the window a hook fires in when it is installed and run
// straight away.

interface Harness {
  base: string;
  notes: NotifyOptions[];
  watcher: Watcher;
}

function setup(
  t: { after(fn: () => void): void },
  rules: (base: string) => Record<string, unknown>[],
  pollIntervalMs = 1000,
): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chirin-start-"));
  const config: Config = validateConfig({
    defaults: { pollIntervalMs, globRefreshMs: 30000, throttleMs: 0 },
    rules: rules(base),
  });
  const notes: NotifyOptions[] = [];
  const clock = { now: 1_000_000 };
  const watcher = new Watcher(config, (opts) => notes.push(opts), () => clock.now);
  t.after(() => {
    watcher.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, notes, watcher };
}

/** A rule watching one concrete state file (no glob), the shape a single repository uses. */
function stateRule(base: string): Record<string, unknown>[] {
  return [
    {
      id: "stop",
      watch: [path.join(base, ".claude", "chirin-notify-state.json")],
      match: { type: "event", equals: "Stop" },
      notify: { message: "{{message}}" },
    },
  ];
}

function writeState(base: string, state: Record<string, unknown>): void {
  const dir = path.join(base, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "chirin-notify-state.json"), JSON.stringify(state));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("an event arriving right after start() notifies", async (t) => {
  const h = setup(t, stateRule);
  h.watcher.start();

  // The state file appears between start() and the first poll
  writeState(h.base, { ts: "1-a", event: "Stop", message: "first" });
  await h.watcher.pollOnce();

  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.message, "first");
});

test("an event arriving right after start() notifies through the poll timer too", async (t) => {
  const h = setup(t, stateRule, 200);
  h.watcher.start();
  writeState(h.base, { ts: "1-a", event: "Stop", message: "first" });

  await sleep(600);

  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.message, "first");
});

test("state that was already there when start() ran stays silent, and the next change notifies", async (t) => {
  const h = setup(t, stateRule);
  writeState(h.base, { ts: "1-a", event: "Stop", message: "before" });

  h.watcher.start();
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 0, "content that predates watching replayed as a notification");

  writeState(h.base, { ts: "2-b", event: "Stop", message: "after" });
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.message, "after");
});

test("a spell of invalid JSON does not cost the first notification of a file that appeared", async (t) => {
  const h = setup(t, stateRule);
  h.watcher.start();

  fs.mkdirSync(path.join(h.base, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(h.base, ".claude", "chirin-notify-state.json"), "{ half-writ");
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 0);

  writeState(h.base, { ts: "1-a", event: "Stop", message: "finally" });
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.message, "finally");
});

test("stop() ends the poll timer, and start() twice does not stack timers", async (t) => {
  const h = setup(t, stateRule, 200);
  h.watcher.start();
  h.watcher.start(); // a second call must not arm a second pair of timers

  writeState(h.base, { ts: "1-a", event: "Stop", message: "one" });
  await sleep(500);
  assert.equal(h.notes.length, 1, "the event notified more than once (stacked timers)");

  h.watcher.stop();
  writeState(h.base, { ts: "2-b", event: "Stop", message: "two" });
  await sleep(500);
  assert.equal(h.notes.length, 1, "a notification arrived after stop()");
});

test("a target discovered by a glob refresh is baselined as it joins the watch set", async (t) => {
  const h = setup(t, (base) => [
    {
      id: "stop",
      watch: [path.join(base, "*", ".claude", "chirin-notify-state.json")],
      match: { type: "event", equals: "Stop" },
      notify: { message: "{{dir}}: {{message}}" },
    },
  ]);
  h.watcher.start();

  // A repository that appears later, already carrying a state file: its existing content is
  // the baseline, not an event
  const project = path.join(h.base, "proj1");
  fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".claude", "chirin-notify-state.json"),
    JSON.stringify({ ts: "1-a", event: "Stop", message: "old" }),
  );
  h.watcher.refreshTargets();
  assert.equal(h.watcher.targetCount(), 1);
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 0);

  // But a change written between the refresh and the next poll is a change
  fs.writeFileSync(
    path.join(project, ".claude", "chirin-notify-state.json"),
    JSON.stringify({ ts: "2-b", event: "Stop", message: "new" }),
  );
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.message, "proj1: new");
});

test("log-lines keeps its semantics across the startup baseline", async (t) => {
  const h = setup(t, (base) => [
    {
      id: "errors",
      watch: [path.join(base, "app.log")],
      source: { type: "log-lines", windowBytes: 65536 },
      match: { type: "contains", pattern: "ERROR" },
      notify: { message: "{{line}}" },
    },
  ]);
  const file = path.join(h.base, "app.log");
  fs.writeFileSync(file, "ERROR before watching\n");

  h.watcher.start();
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 0, "lines written before watching replayed");

  fs.appendFileSync(file, "ERROR after\n");
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.message, "ERROR after");
});

test("file-meta notifies a change made right after start()", async (t) => {
  const h = setup(t, (base) => [
    {
      id: "any-change",
      watch: [path.join(base, "data.bin")],
      source: { type: "file-meta" },
      match: { type: "any" },
      notify: { message: "{{size}} bytes" },
    },
  ]);
  const file = path.join(h.base, "data.bin");
  fs.writeFileSync(file, "abc");

  h.watcher.start();
  fs.writeFileSync(file, "abcdef");
  await h.watcher.pollOnce();

  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.message, "6 bytes");
});
