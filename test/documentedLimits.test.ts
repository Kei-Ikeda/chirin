// The limits the README states, pinned to the values it states.
//
// CLAUDE.md asks that a constant the README documents be one a test pins, and it was not
// upheld: test/leader.test.ts builds its fixtures from MAX_LOCK_BYTES rather than asserting
// it, so widening the lock cap left the build green and the README wrong. A test that reads
// the constant is a test that follows it anywhere it goes.
//
// Two documented limits are missing from this list because they are not exported, and a test
// is not a reason to widen a module's surface: the 64KB json-state cap, and the 256-character
// pattern length (which config.test.ts does pin against widening, by rejecting a 257-character
// pattern).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { MAX_CONFIG_BYTES, MAX_MATCH_TARGET_LEN } from "../src/config.js";
import { MAX_LOCK_BYTES } from "../src/leader.js";
import { MESSAGE_MAX_LEN, SUBTITLE_MAX_LEN, TITLE_MAX_LEN } from "../src/notifier.js";
import {
  DEFAULT_LOG_WINDOW_BYTES,
  MAX_LOG_LINES_PER_POLL,
  MAX_LOG_WINDOW_BYTES,
  MIN_LOG_WINDOW_BYTES,
} from "../src/sources.js";

/**
 * One row per limit: the constant, the value the README states, the line that states it, and
 * the phrase to find on that line.
 *
 * The anchor is what makes the check per-row, and searching the whole README is not enough
 * even with a phrase: the title and subtitle limits are both "Truncated to 60 characters", so
 * rewriting the subtitle row alone leaves the title's copy of the phrase for both rows to
 * find. Anchoring each row to its own line is what notices that.
 */
const documented = [
  { name: "MAX_CONFIG_BYTES", anchor: "Config reads, including auto-reload checks", actual: MAX_CONFIG_BYTES, stated: 1024 * 1024, spelling: "capped at 1MB" },
  { name: "MAX_MATCH_TARGET_LEN", anchor: "Malicious input to a user-defined regex", actual: MAX_MATCH_TARGET_LEN, stated: 200, spelling: "capped at 200 characters" },
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
    name: "MAX_LOG_LINES_PER_POLL",
    anchor: "`windowBytes` (default",
    actual: MAX_LOG_LINES_PER_POLL,
    stated: 2000,
    spelling: "2,000 complete lines",
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
