import assert from "node:assert/strict";
import { test } from "node:test";
import { REGEX_TIMEOUT_MS, RegexTimeoutError, WorkerRegexMatcher } from "../src/regexMatcher.js";

// The regex that motivated the worker: it passes the config's static ReDoS heuristic, its
// target is inside the runtime length cap, and evaluating it never finishes in any time we
// are prepared to wait.
const RUNAWAY_PATTERN = "(a|aa)+$";
const RUNAWAY_TARGET = `${"a".repeat(199)}!`;

/** Every test carries an outer deadline: a failure here must not hang the suite. */
const DEADLINE = { timeout: 15_000 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("the default budget is the one the README documents", () => {
  // The README states the budget in seconds; keep it pinned so the two cannot drift
  assert.equal(REGEX_TIMEOUT_MS, 1000);
});

test("ordinary patterns match, and the indices come back in order", DEADLINE, async (t) => {
  const matcher = new WorkerRegexMatcher(2000);
  t.after(() => matcher.dispose());

  assert.deepEqual(await matcher.match("^ERROR", ["ERROR a", "INFO b", "ERROR c"]), [0, 2]);
  assert.deepEqual(await matcher.match("^0$", ["0"]), [0]);
  assert.deepEqual(await matcher.match("^0$", ["1"]), []);
});

test("a runaway pattern gives up on its budget instead of running forever", DEADLINE, async (t) => {
  const matcher = new WorkerRegexMatcher(200);
  t.after(() => matcher.dispose());

  const started = Date.now();
  await assert.rejects(
    matcher.match(RUNAWAY_PATTERN, [RUNAWAY_TARGET]),
    RegexTimeoutError,
  );
  assert.ok(Date.now() - started < 5000, "the match was not abandoned near its budget");
});

test("the calling thread keeps running while a runaway pattern is being matched", DEADLINE, async (t) => {
  const matcher = new WorkerRegexMatcher(300);
  t.after(() => matcher.dispose());

  // Timers are the observable proof: on the thread doing the matching none of these would
  // fire, which in the extension host means a frozen window, a stalled poll loop and a
  // leader lock that stops being refreshed.
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    await assert.rejects(matcher.match(RUNAWAY_PATTERN, [RUNAWAY_TARGET]), RegexTimeoutError);
  } finally {
    clearInterval(timer);
  }

  assert.ok(ticks >= 5, `the calling thread was blocked (only ${ticks} timer ticks)`);
});

test("matching still works after a pattern was abandoned", DEADLINE, async (t) => {
  const matcher = new WorkerRegexMatcher(300);
  t.after(() => matcher.dispose());

  await assert.rejects(matcher.match(RUNAWAY_PATTERN, [RUNAWAY_TARGET]), RegexTimeoutError);

  // The worker was terminated, so this one runs on a fresh worker
  assert.deepEqual(await matcher.match("^ERROR", ["ERROR a", "INFO b"]), [0]);
});

test("a pattern queued behind a runaway one is still answered", DEADLINE, async (t) => {
  const matcher = new WorkerRegexMatcher(300);
  t.after(() => matcher.dispose());

  const runaway = matcher.match(RUNAWAY_PATTERN, [RUNAWAY_TARGET]);
  const normal = matcher.match("^ERROR", ["ERROR a"]);

  await assert.rejects(runaway, RegexTimeoutError);
  assert.deepEqual(await normal, [0]);
});

test("dispose rejects the match in flight and stops the worker", DEADLINE, async () => {
  const matcher = new WorkerRegexMatcher(10_000);
  const inFlight = matcher.match(RUNAWAY_PATTERN, [RUNAWAY_TARGET]);
  const queued = matcher.match("^ERROR", ["ERROR a"]);

  matcher.dispose();

  await assert.rejects(inFlight, /watching stopped/);
  await assert.rejects(queued, /watching stopped/);
  // Nothing is left running: had the worker survived its termination, this sleep would be the
  // only thing holding the loop and the test runner would still see an active handle.
  await sleep(50);
});

test("an invalid pattern is reported rather than silently matching nothing", DEADLINE, async (t) => {
  const matcher = new WorkerRegexMatcher(2000);
  t.after(() => matcher.dispose());

  await assert.rejects(matcher.match("(", ["anything"]));
  // The worker survives a bad pattern
  assert.deepEqual(await matcher.match("^a", ["abc"]), [0]);
});
