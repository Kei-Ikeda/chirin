import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateConfig, type Config } from "../src/config.js";
import type { NotifyOptions } from "../src/notifier.js";
import { Watcher } from "../src/watcher.js";

// Integration tests for the Watcher through the source adapters.
// The notifier is a stub and time comes from a fixed clock.

interface Harness {
  base: string;
  notes: NotifyOptions[];
  watcher: Watcher;
  clock: { now: number };
}

function setup(
  t: { after(fn: () => void): void },
  rules: (base: string) => Record<string, unknown>[],
): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chirin-wsrc-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const config: Config = validateConfig({
    defaults: { pollIntervalMs: 1000, globRefreshMs: 30000, throttleMs: 0 },
    rules: rules(base),
  });
  const notes: NotifyOptions[] = [];
  const clock = { now: 1_000_000 };
  const watcher = new Watcher(config, (opts) => notes.push(opts), () => clock.now);
  return { base, notes, watcher, clock };
}

function writeLog(base: string, project: string, content: string): string {
  const dir = path.join(base, project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "app.log");
  fs.writeFileSync(file, content);
  return file;
}

// --- through log-lines --------------------------------------------------

test("log-lines: only the appended lines that match are notified", (t) => {
  const h = setup(t, (base) => [
    {
      id: "errors",
      watch: [`${base}/*/app.log`],
      source: { type: "log-lines", windowBytes: 65536 },
      match: { type: "contains", pattern: "ERROR" },
      notify: { message: "{{dir}}: {{line}}" },
    },
  ]);
  writeLog(h.base, "proj1", "INFO started\n");
  h.watcher.runOnce();
  assert.equal(h.notes.length, 0);

  fs.appendFileSync(path.join(h.base, "proj1", "app.log"), "INFO ok\nERROR boom\nINFO fine\n");
  h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.message, "proj1: ERROR boom");
});

test("log-lines: several matches in one cycle collapse into a single notification carrying count", (t) => {
  const h = setup(t, (base) => [
    {
      id: "errors",
      watch: [`${base}/*/app.log`],
      source: { type: "log-lines", windowBytes: 65536 },
      match: { type: "contains", pattern: "ERROR" },
      notify: { message: "{{count}} hit(s): {{line}}" },
    },
  ]);
  writeLog(h.base, "proj1", "seed\n");
  h.watcher.runOnce();

  fs.appendFileSync(path.join(h.base, "proj1", "app.log"), "ERROR a\nERROR b\nERROR c\n");
  h.watcher.pollOnce();
  // Even a burst produces one notification. The body is the latest line plus the count
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.message, "3 hit(s): ERROR c");
});

test("log-lines: nothing is notified when no line matches", (t) => {
  const h = setup(t, (base) => [
    {
      id: "errors",
      watch: [`${base}/*/app.log`],
      source: { type: "log-lines", windowBytes: 65536 },
      match: { type: "regex", pattern: "^ERROR" },
      notify: { message: "{{line}}" },
    },
  ]);
  writeLog(h.base, "proj1", "seed\n");
  h.watcher.runOnce();
  fs.appendFileSync(path.join(h.base, "proj1", "app.log"), "INFO a\nDEBUG b\n");
  h.watcher.pollOnce();
  assert.equal(h.notes.length, 0);
});

test("log-lines: two rules watching the same file do not interfere", (t) => {
  const h = setup(t, (base) => [
    {
      id: "errors",
      watch: [`${base}/*/app.log`],
      source: { type: "log-lines", windowBytes: 65536 },
      match: { type: "contains", pattern: "ERROR" },
      notify: { message: "E: {{line}}" },
    },
    {
      id: "warns",
      watch: [`${base}/*/app.log`],
      source: { type: "log-lines", windowBytes: 65536 },
      match: { type: "contains", pattern: "WARN" },
      notify: { message: "W: {{line}}" },
    },
  ]);
  writeLog(h.base, "proj1", "seed\n");
  h.watcher.runOnce();

  fs.appendFileSync(path.join(h.base, "proj1", "app.log"), "ERROR x\nWARN y\n");
  h.watcher.pollOnce();
  assert.deepEqual(h.notes.map((n) => n.message).sort(), ["E: ERROR x", "W: WARN y"]);
});

test("log-lines: when two rules match the same line, both are notified", (t) => {
  const h = setup(t, (base) => [
    {
      id: "rule-a",
      watch: [`${base}/*/app.log`],
      source: { type: "log-lines", windowBytes: 65536 },
      match: { type: "contains", pattern: "ERROR" },
      notify: { message: "A: {{line}}" },
    },
    {
      id: "rule-b",
      watch: [`${base}/*/app.log`],
      source: { type: "log-lines", windowBytes: 65536 },
      match: { type: "contains", pattern: "boom" },
      notify: { message: "B: {{line}}" },
    },
  ]);
  writeLog(h.base, "proj1", "seed\n");
  h.watcher.runOnce();

  fs.appendFileSync(path.join(h.base, "proj1", "app.log"), "ERROR boom\n");
  h.watcher.pollOnce();
  // One line matches both. Sharing the source must not let dedup drop either one
  assert.deepEqual(h.notes.map((n) => n.message).sort(), ["A: ERROR boom", "B: ERROR boom"]);
});

// --- through file-meta --------------------------------------------------

test("file-meta + match any: a change alone is enough to notify", (t) => {
  const h = setup(t, (base) => [
    {
      id: "any-change",
      watch: [`${base}/*/data.bin`],
      source: { type: "file-meta" },
      match: { type: "any" },
      notify: { message: "{{dir}}/{{file}} changed ({{size}} bytes)" },
    },
  ]);
  const dir = path.join(h.base, "proj1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "data.bin"), "abc");
  h.watcher.runOnce();
  assert.equal(h.notes.length, 0);

  fs.writeFileSync(path.join(dir, "data.bin"), "abcdef");
  h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.message, "proj1/data.bin changed (6 bytes)");
});

// --- mixed --------------------------------------------------------------

test("rules using different sources coexist in the same directory", (t) => {
  const h = setup(t, (base) => [
    {
      id: "state",
      watch: [`${base}/*/state.json`],
      source: { type: "json-state" },
      match: { type: "event", equals: "Stop" },
      notify: { message: "state: {{message}}" },
    },
    {
      id: "logs",
      watch: [`${base}/*/app.log`],
      source: { type: "log-lines", windowBytes: 65536 },
      match: { type: "contains", pattern: "ERROR" },
      notify: { message: "log: {{line}}" },
    },
  ]);
  const dir = path.join(h.base, "proj1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ ts: "1-a", event: "Stop" }));
  fs.writeFileSync(path.join(dir, "app.log"), "seed\n");
  h.watcher.runOnce();
  assert.equal(h.notes.length, 0);

  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({ ts: "2-b", event: "Stop", message: "done" }),
  );
  fs.appendFileSync(path.join(dir, "app.log"), "ERROR bad\n");
  h.watcher.pollOnce();
  assert.deepEqual(h.notes.map((n) => n.message).sort(), ["log: ERROR bad", "state: done"]);
});

test("json-state: arbitrary fields are usable in a template", (t) => {
  const h = setup(t, (base) => [
    {
      id: "branch",
      watch: [`${base}/*/state.json`],
      source: { type: "json-state" },
      match: { type: "equals", field: "branch", value: "main" },
      notify: { message: "{{branch}} @ {{dir}} ({{event}})" },
    },
  ]);
  const dir = path.join(h.base, "proj1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ ts: "1-a", branch: "dev" }));
  h.watcher.runOnce();
  assert.equal(h.notes.length, 0);

  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({ ts: "2-b", event: "Push", branch: "main" }),
  );
  h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.message, "main @ proj1 (Push)");
});

// --- caps and carry-over ------------------------------------------------

test("anything over the notification cap is carried to the next cycle (through the sources too)", (t) => {
  const h = setup(t, (base) => [
    {
      id: "errors",
      watch: [`${base}/*/app.log`],
      source: { type: "log-lines", windowBytes: 65536 },
      match: { type: "contains", pattern: "ERROR" },
      notify: { message: "{{dir}}: {{line}}" },
    },
  ]);
  const projects = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
  for (const p of projects) writeLog(h.base, p, "seed\n");
  h.watcher.runOnce();

  for (const p of projects) fs.appendFileSync(path.join(h.base, p, "app.log"), "ERROR x\n");
  h.watcher.pollOnce();
  assert.equal(h.notes.length, 5, "the cap is 5 per cycle");

  h.watcher.pollOnce();
  assert.equal(h.notes.length, 7, "the remaining 2 are notified next cycle (never dropped permanently)");
});

test("aggregation inside the throttle window is suppressed and resumes once it passes", (t) => {
  const h = setup(t, (base) => [
    {
      id: "errors",
      watch: [`${base}/*/app.log`],
      source: { type: "log-lines", windowBytes: 65536 },
      match: { type: "contains", pattern: "ERROR" },
      notify: { message: "{{line}}" },
      throttleMs: 3000,
    },
  ]);
  writeLog(h.base, "proj1", "seed\n");
  h.watcher.runOnce();
  const file = path.join(h.base, "proj1", "app.log");

  fs.appendFileSync(file, "ERROR 1\n");
  h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);

  h.clock.now += 1000; // inside the window
  fs.appendFileSync(file, "ERROR 2\n");
  h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);

  h.clock.now += 3000; // past the window
  fs.appendFileSync(file, "ERROR 3\n");
  h.watcher.pollOnce();
  assert.equal(h.notes.length, 2);
  assert.equal(h.notes[1]!.message, "ERROR 3");
});

test("subtitle is template-expanded and sanitized too", (t) => {
  const h = setup(t, (base) => [
    {
      id: "errors",
      watch: [`${base}/*/app.log`],
      source: { type: "log-lines", windowBytes: 65536 },
      match: { type: "contains", pattern: "ERROR" },
      notify: {
        title: "app",
        subtitle: "alert 🚨 {{dir}} ({{count}})",
        message: "{{line}}",
      },
    },
  ]);
  writeLog(h.base, "proj1", "seed\n");
  h.watcher.runOnce();
  fs.appendFileSync(path.join(h.base, "proj1", "app.log"), "ERROR a\nERROR b\n");
  h.watcher.pollOnce();

  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.title, "app");
  assert.equal(h.notes[0]!.subtitle, "alert 🚨 proj1 (2)");
  assert.equal(h.notes[0]!.message, "ERROR b");
});

test("an unset subtitle reaches the notifier as undefined", (t) => {
  const h = setup(t, (base) => [
    {
      id: "errors",
      watch: [`${base}/*/app.log`],
      source: { type: "log-lines", windowBytes: 65536 },
      match: { type: "contains", pattern: "ERROR" },
      notify: { message: "{{line}}" },
    },
  ]);
  writeLog(h.base, "proj1", "seed\n");
  h.watcher.runOnce();
  fs.appendFileSync(path.join(h.base, "proj1", "app.log"), "ERROR x\n");
  h.watcher.pollOnce();
  assert.equal(h.notes[0]!.subtitle, undefined);
});

test("control characters in subtitle are removed too (when an untrusted field is interpolated)", (t) => {
  const h = setup(t, (base) => [
    {
      id: "errors",
      watch: [`${base}/*/app.log`],
      source: { type: "log-lines", windowBytes: 65536 },
      match: { type: "contains", pattern: "ERROR" },
      notify: { subtitle: "{{line}}", message: "detail" },
    },
  ]);
  writeLog(h.base, "proj1", "seed\n");
  h.watcher.runOnce();
  const esc = String.fromCharCode(0x1b);
  fs.appendFileSync(path.join(h.base, "proj1", "app.log"), `ERROR ${esc}[31mred\n`);
  h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);
  assert.ok(!h.notes[0]!.subtitle!.includes(esc));
});

test("control characters in the notification body are removed even when they come from a log line", (t) => {
  const h = setup(t, (base) => [
    {
      id: "errors",
      watch: [`${base}/*/app.log`],
      source: { type: "log-lines", windowBytes: 65536 },
      match: { type: "contains", pattern: "ERROR" },
      notify: { message: "{{line}}" },
    },
  ]);
  writeLog(h.base, "proj1", "seed\n");
  h.watcher.runOnce();
  const esc = String.fromCharCode(0x1b);
  const bel = String.fromCharCode(0x07);
  fs.appendFileSync(path.join(h.base, "proj1", "app.log"), `ERROR ${esc}]0;pwn${bel} x\n`);
  h.watcher.pollOnce();
  assert.equal(h.notes.length, 1);
  assert.ok(!h.notes[0]!.message.includes(esc));
  assert.ok(!h.notes[0]!.message.includes(bel));
  assert.equal(h.notes[0]!.message, "ERROR ]0;pwn x");
});
