// The limits the README states, pinned to the values it states.
//
// CLAUDE.md asks that a constant the README documents be one a test pins, and it was not
// upheld: test/leader.test.ts builds its fixtures from MAX_LOCK_BYTES rather than asserting
// it, so widening the lock cap left the build green and the README wrong. A test that reads
// the constant is a test that follows it anywhere it goes.
//
// Some documented limits are missing from this list because they are not exported, and a test
// is not a reason to widen a module's surface: the 64KB json-state cap, the 256-character
// pattern length (which config.test.ts does pin against widening, by rejecting a 257-character
// pattern), and the cap of five notifications per poll cycle. Those are pinned by behaviour
// instead -- below for the first two, and in watcher.test.ts for the cap -- and their README
// wording is checked next to whichever test pins them.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConfigError, MAX_CONFIG_BYTES, MAX_MATCH_TARGET_LEN, validateConfig } from "../src/config.js";
import { createSource } from "../src/sources.js";
import { MAX_LOCK_BYTES } from "../src/leader.js";
import { MESSAGE_MAX_LEN, SOUND_PATTERN, SUBTITLE_MAX_LEN, TITLE_MAX_LEN } from "../src/notifier.js";
import { REGEX_TIMEOUT_MS } from "../src/regexMatcher.js";
import {
  DEFAULT_LOG_WINDOW_BYTES,
  MAX_LOG_LINES_PER_POLL,
  MAX_LOG_WINDOW_BYTES,
  MIN_LOG_WINDOW_BYTES,
} from "../src/sources.js";

/**
 * One row per documented occurrence: the constant, the value the README states, the line that
 * states it, and the phrase to find on that line. A constant can have more than one row when
 * the README promises the same limit in more than one place; each promise has to stay true.
 *
 * The anchor is what makes the check per-row, and searching the whole README is not enough
 * even with a phrase: the title and subtitle limits are both "Truncated to 60 characters", so
 * rewriting the subtitle row alone leaves the title's copy of the phrase for both rows to
 * find. Anchoring each row to its own line is what notices that.
 */
const documented = [
  { name: "MAX_CONFIG_BYTES", anchor: "Config reads, including auto-reload checks", actual: MAX_CONFIG_BYTES, stated: 1024 * 1024, spelling: "capped at 1MB" },
  { name: "MAX_MATCH_TARGET_LEN", anchor: "Malicious input to a user-defined regex", actual: MAX_MATCH_TARGET_LEN, stated: 200, spelling: "capped at 200 characters" },
  {
    name: "MAX_MATCH_TARGET_LEN (contains pattern)",
    anchor: "| `contains` | `field`, `pattern` |",
    actual: MAX_MATCH_TARGET_LEN,
    stated: 200,
    spelling: "`pattern` <= 200 characters",
  },
  {
    name: "MAX_MATCH_TARGET_LEN (runtime truncation)",
    anchor: "The match target is truncated",
    actual: MAX_MATCH_TARGET_LEN,
    stated: 200,
    spelling: "first 200",
  },
  {
    // regexMatcher.test.ts asserts this value, but nothing reads the sentence that promises
    // it, so the prose is free to name a different budget on its own.
    name: "REGEX_TIMEOUT_MS",
    anchor: "a rule whose match does not come back",
    actual: REGEX_TIMEOUT_MS,
    stated: 1000,
    spelling: "within 1 second",
  },
  {
    name: "MAX_CONFIG_BYTES (threat model)",
    anchor: "Memory exhaustion through a huge file",
    actual: MAX_CONFIG_BYTES,
    stated: 1024 * 1024,
    spelling: "1MB read cap",
  },
  { name: "MAX_LOCK_BYTES", anchor: "Huge or symlinked watcher lock", actual: MAX_LOCK_BYTES, stated: 4096, spelling: "cap reads at 4KB" },
  { name: "TITLE_MAX_LEN", anchor: "`rules[].notify.title`", actual: TITLE_MAX_LEN, stated: 60, spelling: "Truncated to 60 characters" },
  { name: "SUBTITLE_MAX_LEN", anchor: "`rules[].notify.subtitle`", actual: SUBTITLE_MAX_LEN, stated: 60, spelling: "Truncated to 60 characters" },
  { name: "MESSAGE_MAX_LEN", anchor: "`rules[].notify.message`", actual: MESSAGE_MAX_LEN, stated: 120, spelling: "Truncated to 120 characters" },
  {
    name: "DEFAULT_LOG_WINDOW_BYTES",
    anchor: "`windowBytes` (default",
    actual: DEFAULT_LOG_WINDOW_BYTES,
    stated: 1024 * 1024,
    spelling: "default 1MB",
  },
  { name: "MIN_LOG_WINDOW_BYTES", anchor: "`windowBytes` (default", actual: MIN_LOG_WINDOW_BYTES, stated: 4 * 1024, spelling: "4KB–16MB" },
  {
    name: "MAX_LOG_WINDOW_BYTES",
    anchor: "`windowBytes` (default",
    actual: MAX_LOG_WINDOW_BYTES,
    stated: 16 * 1024 * 1024,
    spelling: "4KB–16MB",
  },
  {
    // Documented as the pattern itself, so the pattern's source is what the README states.
    // config.test.ts rejects a 31-character name, which pins this against widening only:
    // narrowing it to 20 would keep that test green and start refusing documented names.
    name: "SOUND_PATTERN",
    anchor: "`rules[].notify.sound`",
    // The whole literal, flags included. Comparing only the source missed a flag being added:
    // `m` leaves the source untouched and turns the anchors per-line, so "Pop\n!" starts
    // passing validation while the README still documents a single-line name.
    actual: String(SOUND_PATTERN),
    stated: "/^[A-Za-z ]{1,30}$/",
    spelling: "`/^[A-Za-z ]{1,30}$/`",
  },
  {
    name: "MAX_LOG_LINES_PER_POLL",
    anchor: "`windowBytes` (default",
    actual: MAX_LOG_LINES_PER_POLL,
    stated: 2000,
    spelling: "2,000 complete lines",
  },
  {
    name: "MAX_LOG_LINES_PER_POLL (threat model)",
    anchor: "CPU/memory exhaustion through many tiny log lines",
    actual: MAX_LOG_LINES_PER_POLL,
    stated: 2000,
    spelling: "newest 2,000 complete lines per file/poll",
  },
] as const;

test("every limit the README documents still holds the value it documents", () => {
  for (const { name, actual, stated } of documented) {
    assert.equal(actual, stated, `${name} changed; the README states ${stated}`);
  }
});

test("the README still spells each documented limit on its own line", () => {
  // The pin above catches a changed constant. This catches the other direction: prose edited
  // away from the value, leaving the two describing different limits.
  const lines = fs.readFileSync(path.join(__dirname, "..", "..", "README.md"), "utf8").split("\n");
  const wrong: string[] = [];
  for (const { name, anchor, spelling } of documented) {
    const matched = lines.filter((line) => line.includes(anchor));
    if (matched.length !== 1) {
      // An anchor matching anything but one line is not the README being wrong, it is this row
      // no longer knowing where to look
      wrong.push(`${name}: "${anchor}" matches ${matched.length} README lines, expected 1`);
    } else if (!matched[0]!.includes(spelling)) {
      wrong.push(`${name}: the README line at "${anchor}" no longer says "${spelling}"`);
    }
  }
  assert.deepEqual(wrong, [], wrong.join("\n"));
});

/**
 * The bounds the README states as a range rather than a constant. They live inside the
 * validation instead of behind an exported name, so the value is reached by asking whether the
 * documented edge is accepted and the step outside it is not.
 *
 * Rejecting a value far outside the range, which is what config.test.ts does, leaves the edge
 * itself free to move: raising the poll minimum to 201 keeps a test that rejects 100 green
 * while turning away a configuration the README calls valid.
 */
const bounds = [
  { field: "pollIntervalMs", anchor: "`defaults.pollIntervalMs`", spelling: "(>= 200, default 1000)", lowest: 200 },
  { field: "globRefreshMs", anchor: "`defaults.globRefreshMs`", spelling: "(>= 5000, default 30000)", lowest: 5000 },
  { field: "throttleMs", anchor: "| `defaults.throttleMs` |", spelling: "(>= 0, default 5000)", lowest: 0 },
] as const;

/** The smallest configuration validateConfig accepts, for mutating one field at a time. */
function minimalConfig(defaults: Record<string, number>): Record<string, unknown> {
  return {
    defaults,
    rules: [
      {
        id: "rule-1",
        watch: ["/work/*/.claude/chirin-notify-state.json"],
        match: { type: "event", equals: "Stop" },
        notify: { title: "T", message: "M" },
      },
    ],
  };
}

test("every documented lower bound accepts its edge and refuses the step below it", () => {
  for (const { field, lowest } of bounds) {
    assert.doesNotThrow(
      () => validateConfig(minimalConfig({ [field]: lowest })),
      `${field} rejects ${lowest}, which the README documents as valid`,
    );
    assert.throws(
      () => validateConfig(minimalConfig({ [field]: lowest - 1 })),
      ConfigError,
      `${field} accepts ${lowest - 1}, below the documented minimum`,
    );
  }
});

test("the README still states each documented lower bound on its own line", () => {
  const lines = fs.readFileSync(path.join(__dirname, "..", "..", "README.md"), "utf8").split("\n");
  const wrong: string[] = [];
  for (const { field, anchor, spelling } of bounds) {
    const matched = lines.filter((line) => line.includes(anchor));
    if (matched.length !== 1) {
      wrong.push(`${field}: "${anchor}" matches ${matched.length} README lines, expected 1`);
    } else if (!matched[0]!.includes(spelling)) {
      wrong.push(`${field}: the README line at "${anchor}" no longer says "${spelling}"`);
    }
  }
  assert.deepEqual(wrong, [], wrong.join("\n"));
});

/**
 * The edges the README documents inside a pattern rather than as a range. They are not
 * exported, and were left to review twice on that basis -- but "not exported" only rules out
 * naming the constant, not asking the validation where its edge is.
 *
 * Rejecting one character past a limit, which is what config.test.ts does, leaves the limit
 * free to shrink: at 255 a documented 256-character pattern starts being refused and that
 * rejection test stays green.
 */
const patternEdges = [
  {
    field: "match.pattern",
    anchor: "| `regex` | `field`, `pattern` |",
    spelling: "Regular expression (`pattern` <= 256 characters)",
    longest: 256,
    build: (length: number) => ({ type: "regex", field: "event", pattern: "p".repeat(length) }),
  },
  {
    field: "rules[].id",
    anchor: "| `rules[].id` |",
    spelling: "`/^[a-z0-9][a-z0-9-]{0,63}$/`",
    longest: 64,
    build: () => ({ type: "event", equals: "Stop" }),
  },
] as const;

test("every documented pattern edge is accepted and the character past it is not", () => {
  for (const { field, longest, build } of patternEdges) {
    const at = (length: number): Record<string, unknown> => {
      const rule: Record<string, unknown> = {
        // `rules[].id` is documented as /^[a-z0-9][a-z0-9-]{0,63}$/, so its edge is a 64-character id
        id: field === "rules[].id" ? `a${"b".repeat(length - 1)}` : "rule-1",
        watch: ["/work/*/.claude/chirin-notify-state.json"],
        match: build(length),
        notify: { title: "T", message: "M" },
      };
      return { rules: [rule] };
    };
    assert.doesNotThrow(
      () => validateConfig(at(longest)),
      `${field} rejects ${longest} characters, which the README documents as valid`,
    );
    assert.throws(
      () => validateConfig(at(longest + 1)),
      ConfigError,
      `${field} accepts ${longest + 1} characters, past the documented limit`,
    );
  }
});

test("the README still states each documented pattern edge on its own line", () => {
  // Finding the row is not enough. The behavioural test above is fixed at the documented
  // length, so a README rewritten to a different one -- {0,31} for the rule id, say -- has to
  // fail here or the two describe different limits with everything green.
  const lines = fs.readFileSync(path.join(__dirname, "..", "..", "README.md"), "utf8").split("\n");
  const wrong: string[] = [];
  for (const { field, anchor, spelling } of patternEdges) {
    const matched = lines.filter((line) => line.includes(anchor));
    if (matched.length !== 1) {
      wrong.push(`${field}: "${anchor}" matches ${matched.length} README lines, expected 1`);
    } else if (!matched[0]!.includes(spelling)) {
      wrong.push(`${field}: the README line at "${anchor}" no longer says "${spelling}"`);
    }
  }
  assert.deepEqual(wrong, [], wrong.join("\n"));
});

test("a json-state file at the documented 64KB is read, and one byte past it is not", (t) => {
  // The source rejects an oversized state file, and sources.test.ts proves that with a file of
  // roughly 70KB -- which leaves the edge free to move. At 60KB a state file the README calls
  // readable is dropped, silently, with that test still green.
  const documented = 64 * 1024;
  // The fixture is a literal, so the README row has to be read or a documentation change
  // alone leaves the two describing different limits.
  const row = fs
    .readFileSync(path.join(__dirname, "..", "..", "README.md"), "utf8")
    .split("\n")
    .filter((line) => line.includes("| `json-state` | A change in the `ts` field |"));
  assert.equal(row.length, 1, "the README row stating the json-state limit is no longer findable");
  assert.ok(row[0]!.includes("| 64KB |"), `the README no longer states the json-state limit as 64KB: ${row[0]}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chirin-limits-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** A valid state file of exactly `size` bytes, padded to length. */
  const write = (file: string, ts: string, size: number): void => {
    const withoutPad = JSON.stringify({ ts, event: "Stop", pad: "" });
    fs.writeFileSync(file, JSON.stringify({ ts, event: "Stop", pad: "x".repeat(size - withoutPad.length) }));
    assert.equal(fs.statSync(file).size, size, "the fixture has to sit exactly on the edge");
  };

  const atEdge = path.join(dir, "edge.json");
  const edgeSource = createSource({ type: "json-state" });
  write(atEdge, "1-a", 1024);
  edgeSource.poll(atEdge);
  write(atEdge, "2-b", documented);
  assert.equal(edgeSource.poll(atEdge).length, 1, `a ${documented}-byte state file is documented as read`);

  const pastEdge = path.join(dir, "past.json");
  const pastSource = createSource({ type: "json-state" });
  write(pastEdge, "1-a", 1024);
  pastSource.poll(pastEdge);
  write(pastEdge, "2-b", documented + 1);
  assert.equal(pastSource.poll(pastEdge).length, 0, "one byte past the documented size must be rejected");
});

/**
 * The documented values the table above cannot carry, because they are not exported. Each is
 * pinned by behaviour at the value the README states -- watcher.test.ts writes seven states
 * and asserts five notifications, so a cap of four or six fails there; config.test.ts reads
 * 5000 back off a rule that omits throttleMs; the pattern edge test above accepts 256
 * characters and refuses 257. Being fixed at the value is exactly what leaves the prose free
 * to name a different one.
 */
const proseOnly = [
  {
    name: "notifications per poll cycle",
    anchor: "| Notification flooding |",
    spelling: "at most 5 notifications per poll cycle",
  },
  {
    name: "defaults.throttleMs (threat model)",
    anchor: "| Notification flooding |",
    spelling: "default 5000ms",
  },
  {
    // The same README line the MAX_MATCH_TARGET_LEN row anchors, which reads only its half of
    // the sentence: the 200 is checked there, the 256 here.
    name: "match.pattern length (threat model)",
    anchor: "Malicious input to a user-defined regex",
    spelling: "the pattern length at 256",
  },
  {
    name: "defaults.throttleMs (grouping note)",
    anchor: "No notification grouping",
    spelling: "The default throttle (5 seconds)",
  },
] as const;

test("the README still states each documented value no constant here can reach", () => {
  const lines = fs.readFileSync(path.join(__dirname, "..", "..", "README.md"), "utf8").split("\n");
  const wrong: string[] = [];
  for (const { name, anchor, spelling } of proseOnly) {
    const matched = lines.filter((line) => line.includes(anchor));
    if (matched.length !== 1) {
      wrong.push(`${name}: "${anchor}" matches ${matched.length} README lines, expected 1`);
    } else if (!matched[0]!.includes(spelling)) {
      wrong.push(`${name}: the README line at "${anchor}" no longer says "${spelling}"`);
    }
  }
  assert.deepEqual(wrong, [], wrong.join("\n"));
});
