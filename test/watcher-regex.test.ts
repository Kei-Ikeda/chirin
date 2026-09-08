import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateConfig, type Config } from "../src/config.js";
import type { NotifyOptions } from "../src/notifier.js";
import { WorkerRegexMatcher, type RegexMatcher } from "../src/regexMatcher.js";
import { Watcher } from "../src/watcher.js";

// The Watcher's side of the regex isolation: a pattern that never finishes must cost one
// terminated worker and nothing else - not the poll cycle, not the other rules, and not a
// notification that arrives after watching has stopped.

const RUNAWAY_PATTERN = "(a|aa)+$";
const RUNAWAY_MESSAGE = `${"a".repeat(199)}!`;
/** Short enough to keep the suite quick; the production budget is REGEX_TIMEOUT_MS. */
const TEST_BUDGET_MS = 300;
/** Every test carries an outer deadline: a failure here must not hang the suite. */
const DEADLINE = { timeout: 15_000 };

interface Harness {
  base: string;
  notes: NotifyOptions[];
  watcher: Watcher;
}

function setup(
  t: { after(fn: () => void): void },
  rules: (base: string) => Record<string, unknown>[],
): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chirin-regex-"));
  const config: Config = validateConfig({
    defaults: { pollIntervalMs: 1000, globRefreshMs: 30000, throttleMs: 0 },
    rules: rules(base),
  });
  const notes: NotifyOptions[] = [];
  const clock = { now: 1_000_000 };
  const watcher = new Watcher(
    config,
    (opts) => notes.push(opts),
    () => clock.now,
    () => new WorkerRegexMatcher(TEST_BUDGET_MS),
  );
  t.after(() => {
    watcher.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, notes, watcher };
}

function stateFile(base: string): string {
  return path.join(base, ".claude", "chirin-notify-state.json");
}

function writeState(base: string, state: Record<string, unknown>): void {
  fs.mkdirSync(path.join(base, ".claude"), { recursive: true });
  fs.writeFileSync(stateFile(base), JSON.stringify(state));
}

/** One rule whose pattern never finishes, alongside one ordinary rule watching the same file. */
function mixedRules(base: string): Record<string, unknown>[] {
  return [
    {
      id: "runaway",
      watch: [stateFile(base)],
      match: { type: "regex", field: "message", pattern: RUNAWAY_PATTERN },
      notify: { message: "runaway matched" },
    },
    {
      id: "ordinary",
      watch: [stateFile(base)],
      match: { type: "event", equals: "Stop" },
      notify: { message: "ordinary: {{event}}" },
    },
  ];
}

test("a config accepts the pattern this file relies on", () => {
  // The static heuristic rejects nested quantifiers, and this one is not one of them: if a
  // future heuristic did reject it, these tests would silently stop covering anything.
  validateConfig({
    rules: [
      {
        id: "runaway",
        watch: ["/tmp/chirin-regex/state.json"],
        match: { type: "regex", field: "message", pattern: RUNAWAY_PATTERN },
        notify: { message: "m" },
      },
    ],
  });
});

test("a rule whose pattern never finishes does not stop the other rules", DEADLINE, async (t) => {
  const h = setup(t, mixedRules);
  writeState(h.base, { ts: "1-a", event: "Stop", message: "seed" });
  await h.watcher.runOnce();

  writeState(h.base, { ts: "2-b", event: "Stop", message: RUNAWAY_MESSAGE });
  await h.watcher.pollOnce();

  assert.deepEqual(
    h.notes.map((note) => note.message),
    ["ordinary: Stop"],
    "the cycle did not deliver the rules that were fine",
  );
});

test("the abandoned rule is skipped from then on, at no further cost", DEADLINE, async (t) => {
  const h = setup(t, mixedRules);
  writeState(h.base, { ts: "1-a", event: "Stop", message: "seed" });
  await h.watcher.runOnce();

  writeState(h.base, { ts: "2-b", event: "Stop", message: RUNAWAY_MESSAGE });
  await h.watcher.pollOnce();

  // A second cycle over the same pathological input must not spend the budget again
  writeState(h.base, { ts: "3-c", event: "Stop", message: RUNAWAY_MESSAGE });
  const started = Date.now();
  await h.watcher.pollOnce();
  const elapsed = Date.now() - started;

  assert.ok(elapsed < TEST_BUDGET_MS, `the rule was re-evaluated (${elapsed}ms)`);
  assert.deepEqual(
    h.notes.map((note) => note.message),
    ["ordinary: Stop", "ordinary: Stop"],
  );
});

test("stopping while a match is outstanding prevents the notification", DEADLINE, async (t) => {
  const h = setup(t, (base) => [
    {
      id: "everything",
      watch: [stateFile(base)],
      match: { type: "regex", field: "message", pattern: "." },
      notify: { message: "{{message}}" },
    },
  ]);
  writeState(h.base, { ts: "1-a", event: "Stop", message: "seed" });
  await h.watcher.runOnce();

  writeState(h.base, { ts: "2-b", event: "Stop", message: "late" });
  const cycle = h.watcher.pollOnce();
  // Demotion, a config reload and deactivation all take this path
  h.watcher.stop();
  await cycle;

  assert.equal(h.notes.length, 0, "a notification was delivered after watching stopped");
});

test("regex rules still aggregate a burst into one notification", DEADLINE, async (t) => {
  const h = setup(t, (base) => [
    {
      id: "errors",
      watch: [path.join(base, "app.log")],
      source: { type: "log-lines", windowBytes: 65536 },
      match: { type: "regex", pattern: "^ERROR" },
      notify: { message: "{{count}}: {{line}}" },
    },
  ]);
  const file = path.join(h.base, "app.log");
  fs.writeFileSync(file, "seed\n");
  await h.watcher.runOnce();

  fs.appendFileSync(file, "ERROR a\nINFO b\nERROR c\n");
  await h.watcher.pollOnce();

  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0]!.message, "2: ERROR c");
});

test("one regex rule matches across several files in the right order", DEADLINE, async (t) => {
  const h = setup(t, (base) => [
    {
      id: "errors",
      watch: [path.join(base, "*", "app.log")],
      source: { type: "log-lines", windowBytes: 65536 },
      match: { type: "regex", pattern: "^ERROR" },
      notify: { message: "{{dir}}: {{line}}" },
    },
  ]);
  for (const project of ["p1", "p2"]) {
    fs.mkdirSync(path.join(h.base, project), { recursive: true });
    fs.writeFileSync(path.join(h.base, project, "app.log"), "seed\n");
  }
  await h.watcher.runOnce();

  for (const project of ["p1", "p2"]) {
    fs.appendFileSync(path.join(h.base, project, "app.log"), `ERROR in ${project}\n`);
  }
  await h.watcher.pollOnce();

  assert.deepEqual(
    h.notes.map((note) => note.message).sort(),
    ["p1: ERROR in p1", "p2: ERROR in p2"],
  );
});

/** Holds each match() in flight until the test releases it, so a glob refresh can interleave with a cycle. */
class GatedMatcher implements RegexMatcher {
  private inFlight: (() => void) | undefined;
  private onEnter: (() => void) | undefined;

  async match(_pattern: string, targets: readonly string[]): Promise<number[]> {
    await new Promise<void>((resolve) => {
      this.inFlight = resolve;
      this.onEnter?.();
    });
    return targets.map((_target, index) => index);
  }

  /** Resolves once a match is in flight. */
  entered(): Promise<void> {
    if (this.inFlight !== undefined) return Promise.resolve();
    return new Promise((resolve) => {
      this.onEnter = resolve;
    });
  }

  release(): void {
    const resume = this.inFlight;
    this.inFlight = undefined;
    this.onEnter = undefined;
    resume?.();
  }

  dispose(): void {}
}

test("a file dropped mid-cycle does not notify through the carried-over aggregates", DEADLINE, async (t) => {
  // Aggregates held back by the per-cycle cap leave this.pending at the start of the next
  // cycle, so a refresh during that cycle cannot prune them; only dispatch() can.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chirin-regex-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const projects = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
  const write = (project: string, ts: string): void => {
    const dir = path.join(base, project, ".claude");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "chirin-notify-state.json"),
      JSON.stringify({ ts, event: "Stop", message: project }),
    );
  };

  const config: Config = validateConfig({
    defaults: { pollIntervalMs: 1000, globRefreshMs: 30000, throttleMs: 5000 },
    rules: [
      {
        id: "everything",
        watch: [`${base}/*/.claude/chirin-notify-state.json`],
        match: { type: "regex", field: "message", pattern: "." },
        notify: { message: "{{dir}}" },
      },
    ],
  });
  const notes: NotifyOptions[] = [];
  const gated = new GatedMatcher();
  const watcher = new Watcher(config, (opts) => notes.push(opts), () => 1_000_000, () => gated);
  t.after(() => watcher.stop());

  for (const project of projects) write(project, "1-a");
  watcher.refreshTargets();
  for (const project of projects) write(project, "2-b");
  const first = watcher.pollOnce();
  await gated.entered();
  gated.release();
  await first;
  assert.equal(notes.length, 5, "the cap should hold 2 of the 7 back");

  // The next cycle needs a match in flight for the refresh to interleave with
  write("p1", "3-c");
  const second = watcher.pollOnce();
  await gated.entered();
  fs.rmSync(base, { recursive: true, force: true });
  watcher.refreshTargets(); // every target leaves the watch set mid-cycle
  gated.release();
  await second;

  assert.equal(notes.length, 5, "a path that had left the watch set still notified");
});
