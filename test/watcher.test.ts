import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateConfig, type Config } from "../src/config.js";
import type { NotifyOptions } from "../src/notifier.js";
import { deriveDirName, renderTemplate, Watcher } from "../src/watcher.js";

const BEL = String.fromCharCode(0x07);
const ESC = String.fromCharCode(0x1b);

interface Harness {
  base: string;
  notes: NotifyOptions[];
  watcher: Watcher;
  clock: { now: number };
}

// Builds a Watcher from a tmpdir, a stub notifier and a fixed clock
function setup(
  t: { after(fn: () => void): void },
  rules?: (base: string) => Record<string, unknown>[],
): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chirin-watcher-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const ruleList = rules?.(base) ?? [
    {
      id: "stop",
      watch: [`${base}/*/.claude/chirin-notify-state.json`],
      match: { type: "event", equals: "Stop" },
      notify: { title: "T", message: "{{dir}}: {{message}}" },
      throttleMs: 3000,
    },
  ];
  const config: Config = validateConfig({
    defaults: { pollIntervalMs: 1000, globRefreshMs: 30000, throttleMs: 5000 },
    rules: ruleList,
  });
  const notes: NotifyOptions[] = [];
  const clock = { now: 1_000_000 };
  const watcher = new Watcher(config, (opts) => notes.push(opts), () => clock.now);
  return { base, notes, watcher, clock };
}

let tsCounter = 0;
function nextTs(): string {
  return `${1723500000000 + ++tsCounter}-abc123`;
}

function writeState(base: string, project: string, state: Record<string, unknown>): void {
  const dir = path.join(base, project, ".claude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "chirin-notify-state.json"), JSON.stringify(state));
}

test("a newly discovered file only records ts and does not notify", async (t) => {
  const h = setup(t);
  writeState(h.base, "proj1", { ts: nextTs(), event: "Stop", message: "done" });
  await h.watcher.runOnce();
  assert.equal(h.notes.length, 0);
});

test("a change in ts notifies and the template is expanded", async (t) => {
  const h = setup(t);
  writeState(h.base, "proj1", { ts: nextTs(), event: "Stop", message: "first" });
  await h.watcher.runOnce();
  writeState(h.base, "proj1", { ts: nextTs(), event: "Stop", message: "hello" });
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.title, "T");
  assert.equal(h.notes[0]!.message, "proj1: hello");
});

test("re-polling with the same ts does not notify (idempotent)", async (t) => {
  const h = setup(t);
  writeState(h.base, "proj1", { ts: nextTs(), event: "Stop", message: "m" });
  await h.watcher.runOnce();
  writeState(h.base, "proj1", { ts: nextTs(), event: "Stop", message: "m" });
  await h.watcher.pollOnce();
  await h.watcher.pollOnce();
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);
});

test("a non-matching event does not notify", async (t) => {
  const h = setup(t);
  writeState(h.base, "proj1", { ts: nextTs(), event: "Stop", message: "m" });
  await h.watcher.runOnce();
  writeState(h.base, "proj1", { ts: nextTs(), event: "Notification", message: "m" });
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 0);
});

test("invalid JSON and an invalid ts are skipped; a later valid event notifies", async (t) => {
  const h = setup(t);
  writeState(h.base, "proj1", { ts: nextTs(), event: "Stop", message: "m" });
  await h.watcher.runOnce();

  const file = path.join(h.base, "proj1", ".claude", "chirin-notify-state.json");
  fs.writeFileSync(file, "{ broken json");
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 0);

  writeState(h.base, "proj1", { ts: "not-a-valid-ts!", event: "Stop", message: "m" });
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 0);

  writeState(h.base, "proj1", { ts: nextTs(), event: "Stop", message: "recovered" });
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.message, "proj1: recovered");
});

test("a state file larger than 64KB is skipped", async (t) => {
  const h = setup(t);
  writeState(h.base, "proj1", { ts: nextTs(), event: "Stop", message: "m" });
  await h.watcher.runOnce();

  writeState(h.base, "proj1", { ts: nextTs(), event: "Stop", message: "m", pad: "x".repeat(70 * 1024) });
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 0);

  writeState(h.base, "proj1", { ts: nextTs(), event: "Stop", message: "small again" });
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);
});

test("throttle: consecutive events inside the window collapse to one, and notify again once it passes", async (t) => {
  const h = setup(t); // throttleMs: 3000
  writeState(h.base, "proj1", { ts: nextTs(), event: "Stop", message: "m" });
  await h.watcher.runOnce();

  writeState(h.base, "proj1", { ts: nextTs(), event: "Stop", message: "m" });
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);

  h.clock.now += 1000; // inside the window
  writeState(h.base, "proj1", { ts: nextTs(), event: "Stop", message: "m" });
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);

  h.clock.now += 3000; // past the window
  writeState(h.base, "proj1", { ts: nextTs(), event: "Stop", message: "m" });
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 2);
});

test("a single poll cycle notifies at most 5 times", async (t) => {
  const h = setup(t);
  const projects = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
  for (const p of projects) writeState(h.base, p, { ts: nextTs(), event: "Stop", message: p });
  await h.watcher.runOnce();
  for (const p of projects) writeState(h.base, p, { ts: nextTs(), event: "Stop", message: p });
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 5);
});

test("notifications over the cap are carried to the next cycle rather than dropped permanently", async (t) => {
  const h = setup(t);
  const projects = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
  for (const p of projects) writeState(h.base, p, { ts: nextTs(), event: "Stop", message: p });
  await h.watcher.runOnce();
  for (const p of projects) writeState(h.base, p, { ts: nextTs(), event: "Stop", message: p });

  await h.watcher.pollOnce(); // 5 fire; 2 are carried over by the cap (ts unchanged)
  assert.equal(h.notes.length, 5);

  // Next cycle: the earlier 5 are suppressed inside the throttle window and the 2 carried over fire
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 7);
});

test("control characters in message are removed from the notification", async (t) => {
  const h = setup(t);
  writeState(h.base, "proj1", { ts: nextTs(), event: "Stop", message: "m" });
  await h.watcher.runOnce();
  writeState(h.base, "proj1", {
    ts: nextTs(),
    event: "Stop",
    message: `evil${BEL}${ESC}[31mred`,
  });
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.message, "proj1: evil[31mred");
  assert.ok(!h.notes[0]!.message.includes(BEL));
  assert.ok(!h.notes[0]!.message.includes(ESC));
});

test("an event over 64 chars or missing is treated as 'unknown'", async (t) => {
  const h = setup(t, (base) => [
    {
      id: "stop",
      watch: [`${base}/*/.claude/chirin-notify-state.json`],
      match: { type: "event", equals: "Stop" },
      notify: { message: "stop" },
    },
    {
      id: "unk",
      watch: [`${base}/*/.claude/chirin-notify-state.json`],
      match: { type: "event", equals: "unknown" },
      notify: { message: "unknown event: {{event}}" },
    },
  ]);
  writeState(h.base, "proj1", { ts: nextTs(), event: "Stop", message: "m" });
  await h.watcher.runOnce();
  writeState(h.base, "proj1", { ts: nextTs(), event: "S".repeat(65), message: "m" });
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.message, "unknown event: unknown");
});

test("contains and regex matches work too", async (t) => {
  const h = setup(t, (base) => [
    {
      id: "waiting",
      watch: [`${base}/*/.claude/chirin-notify-state.json`],
      match: { type: "contains", field: "event", pattern: "permission" },
      notify: { message: "waiting: {{dir}}" },
    },
    {
      id: "cwd-work",
      watch: [`${base}/*/.claude/chirin-notify-state.json`],
      match: { type: "regex", field: "cwd", pattern: "^/work/" },
      notify: { message: "in work" },
    },
  ]);
  writeState(h.base, "proj1", { ts: nextTs(), event: "x", message: "m" });
  await h.watcher.runOnce();
  writeState(h.base, "proj1", {
    ts: nextTs(),
    event: "permission_request",
    message: "m",
    cwd: "/work/app",
  });
  await h.watcher.pollOnce();
  assert.deepEqual(h.notes.map((n) => n.message).sort(), ["in work", "waiting: proj1"]);
});

test("re-expanding the glob brings a new project into the watch set", async (t) => {
  const h = setup(t);
  writeState(h.base, "proj1", { ts: nextTs(), event: "Stop", message: "m" });
  await h.watcher.runOnce();
  assert.equal(h.watcher.targetCount(), 1);

  // A new project created before the re-expansion is picked up by the next refreshTargets
  writeState(h.base, "proj2", { ts: nextTs(), event: "Stop", message: "new" });
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 0); // not yet a watch target

  h.watcher.refreshTargets();
  assert.equal(h.watcher.targetCount(), 2);
  await h.watcher.pollOnce(); // first discovery: records only
  assert.equal(h.notes.length, 0);

  writeState(h.base, "proj2", { ts: nextTs(), event: "Stop", message: "go" });
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.message, "proj2: go");
});

test("state for a file that left the watch set is discarded, and a rediscovery is a first read", async (t) => {
  const h = setup(t);
  const ts = nextTs();
  writeState(h.base, "proj1", { ts, event: "Stop", message: "m" });
  await h.watcher.runOnce();

  fs.rmSync(path.join(h.base, "proj1"), { recursive: true });
  h.watcher.refreshTargets();
  assert.equal(h.watcher.targetCount(), 0);

  // Bringing it back with the same ts is a "first discovery", so it does not notify
  writeState(h.base, "proj1", { ts, event: "Stop", message: "m" });
  await h.watcher.runOnce();
  assert.equal(h.notes.length, 0);

  writeState(h.base, "proj1", { ts: nextTs(), event: "Stop", message: "back" });
  await h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);
});

test("the number of watch targets is truncated at the cap (1024)", (t) => {
  const h = setup(t);
  // Create 1030 project directories directly under base -> 1030 expanded targets
  for (let i = 0; i < 1030; i++) {
    fs.mkdirSync(path.join(h.base, `p${i}`, ".claude"), { recursive: true });
  }
  h.watcher.refreshTargets();
  assert.equal(h.watcher.targetCount(), 1024);
});

test("a state file whose parent directory is a symlink is skipped", async (t) => {
  const h = setup(t);
  // Replace proj1/.claude with a symlink pointing at an external directory
  const outside = path.join(h.base, "outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(
    path.join(outside, "chirin-notify-state.json"),
    JSON.stringify({ ts: nextTs(), event: "Stop", message: "leaked" }),
  );
  const claudeDir = path.join(h.base, "proj1", ".claude");
  fs.mkdirSync(path.join(h.base, "proj1"), { recursive: true });
  fs.symlinkSync(outside, claudeDir);

  await h.watcher.runOnce(); // first discovery (records only) ... but the symlinked parent means it is skipped unread
  writeState(h.base, "proj1b", { ts: nextTs(), event: "Stop", message: "ok" });
  h.watcher.refreshTargets();
  await h.watcher.pollOnce();
  // "leaked" behind the symlink never shows up in a notification
  assert.ok(!h.notes.some((n) => n.message.includes("leaked")));
});

test("renderTemplate: substitutes only known placeholders and leaves unknown ones intact", () => {
  const vars = { dir: "app", event: "Stop", message: "done" };
  assert.equal(renderTemplate("{{dir}} {{event}} {{message}}", vars), "app Stop done");
  assert.equal(renderTemplate("{{unknown}} {{dir}}", vars), "{{unknown}} app");
  assert.equal(renderTemplate("no placeholders", vars), "no placeholders");
});

test("deriveDirName: uses the basename one level up when the parent is .claude", () => {
  assert.equal(deriveDirName("/home/x/work/app/.claude/chirin-notify-state.json"), "app");
  assert.equal(deriveDirName("/home/x/work/app/state.json"), "app");
});
