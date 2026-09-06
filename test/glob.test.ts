import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MAX_GLOB_DIRS_PER_PATTERN, expandGlobs, validateGlobPattern } from "../src/glob.js";
import { resetLogSink, setLogSink } from "../src/log.js";

/** Captures warn logs during a test (restoring the default destination at the end). */
function captureWarnings(t: { after(fn: () => void): void }): string[] {
  const warnings: string[] = [];
  setLogSink((level, message) => {
    if (level === "warn") warnings.push(message);
  });
  t.after(() => resetLogSink());
  return warnings;
}

function makeTree(t: { after(fn: () => void): void }): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chirin-glob-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, "proj1", ".claude"), { recursive: true });
  fs.writeFileSync(path.join(base, "proj1", ".claude", "chirin-notify-state.json"), "{}");
  fs.mkdirSync(path.join(base, "proj2", ".claude"), { recursive: true }); // no leaf file
  fs.mkdirSync(path.join(base, ".hidden", ".claude"), { recursive: true });
  fs.symlinkSync(path.join(base, "proj1"), path.join(base, "linked"));
  fs.writeFileSync(path.join(base, "regular-file"), "");
  return base;
}

test("expands a `*` segment and includes the leaf file even when it does not exist", (t) => {
  const base = makeTree(t);
  const result = expandGlobs([`${base}/*/.claude/chirin-notify-state.json`]).sort();
  assert.deepEqual(result, [
    path.join(base, "proj1", ".claude", "chirin-notify-state.json"),
    path.join(base, "proj2", ".claude", "chirin-notify-state.json"),
  ]);
});

test("hidden directories, symlinks and regular files do not match `*`", (t) => {
  const base = makeTree(t);
  const result = expandGlobs([`${base}/*/.claude/chirin-notify-state.json`]);
  assert.ok(!result.some((p) => p.includes(".hidden")));
  assert.ok(!result.some((p) => p.includes("linked")));
  assert.ok(!result.some((p) => p.includes("regular-file")));
});

test("duplicates across patterns are removed", (t) => {
  const base = makeTree(t);
  const pattern = `${base}/*/.claude/chirin-notify-state.json`;
  const result = expandGlobs([pattern, pattern, path.join(base, "proj1", ".claude", "chirin-notify-state.json")]);
  assert.equal(result.length, 2);
});

test("a pattern without `*` is returned as-is with no existence check", () => {
  const result = expandGlobs(["/no/such/dir/chirin-notify-state.json"]);
  assert.deepEqual(result, ["/no/such/dir/chirin-notify-state.json"]);
});

test("expanding `*` under a non-existent directory yields nothing", () => {
  assert.deepEqual(expandGlobs(["/no/such/dir/*/chirin-notify-state.json"]), []);
});

test("validateGlobPattern: returns null for a valid pattern", () => {
  assert.equal(validateGlobPattern("/home/x/work/*/.claude/chirin-notify-state.json"), null);
  assert.equal(validateGlobPattern("/home/x/one/chirin-notify-state.json"), null);
});

test("validateGlobPattern: rejects a relative path", () => {
  assert.match(validateGlobPattern("work/*/chirin-notify-state.json")!, /absolute/);
});

test("validateGlobPattern: rejects `**`", () => {
  assert.match(validateGlobPattern("/home/x/**/chirin-notify-state.json")!, /'\*\*' is not supported/);
});

test("validateGlobPattern: rejects a partial wildcard", () => {
  assert.match(validateGlobPattern("/home/x/proj*/chirin-notify-state.json")!, /partial wildcard/);
});

test("validateGlobPattern: rejects `*` as the last segment", () => {
  assert.match(validateGlobPattern("/home/x/work/*")!, /last segment/);
});

test("`*` expansion is truncated at MAX_GLOB_DIRS_PER_PATTERN per pattern and warns", (t) => {
  const warnings = captureWarnings(t);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chirin-glob-cap-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (let i = 0; i < MAX_GLOB_DIRS_PER_PATTERN + 10; i++) {
    fs.mkdirSync(path.join(base, `d${String(i).padStart(4, "0")}`));
  }
  const result = expandGlobs([`${base}/*/chirin-notify-state.json`]);
  assert.equal(result.length, MAX_GLOB_DIRS_PER_PATTERN);
  assert.equal(warnings.filter((m) => m.includes("directory cap")).length, 1);
});

test("an expansion of exactly MAX_GLOB_DIRS_PER_PATTERN does not warn about truncation", (t) => {
  const warnings = captureWarnings(t);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chirin-glob-cap-exact-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (let i = 0; i < MAX_GLOB_DIRS_PER_PATTERN; i++) {
    fs.mkdirSync(path.join(base, `d${String(i).padStart(4, "0")}`));
  }
  const result = expandGlobs([`${base}/*/chirin-notify-state.json`]);
  assert.equal(result.length, MAX_GLOB_DIRS_PER_PATTERN);
  assert.deepEqual(warnings.filter((m) => m.includes("directory cap")), []);
});
