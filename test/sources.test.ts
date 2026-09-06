import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createSource, parseStateFields, type Source } from "../src/sources.js";

function tmpDir(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chirin-sources-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Extracts the events as an array of lines (helper for log-lines) */
function lines(source: Source, file: string): string[] {
  return source.poll(file).map((e) => e.fields.line!);
}

// --- json-state ---------------------------------------------------------

test("json-state: the first read only records; a change in ts returns one event", (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "state.json");
  const source = createSource({ type: "json-state" });

  fs.writeFileSync(file, JSON.stringify({ ts: "1-a", event: "Stop", message: "m1" }));
  assert.equal(source.poll(file).length, 0); // first read

  fs.writeFileSync(file, JSON.stringify({ ts: "2-b", event: "Stop", message: "m2" }));
  const events = source.poll(file);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.fields.message, "m2");

  assert.equal(source.poll(file).length, 0); // the same ts returns nothing
});

test("json-state: a file that appears after being observed missing notifies from the first read", (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "state.json");
  const source = createSource({ type: "json-state" });

  assert.equal(source.poll(file).length, 0, "returns nothing while it is missing");

  // Equivalent to just after installing the hook. It appeared after watching began, so the first one notifies.
  fs.writeFileSync(file, JSON.stringify({ ts: "1-a", event: "Stop", message: "m1" }));
  const events = source.poll(file);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.fields.message, "m1");

  assert.equal(source.poll(file).length, 0, "the same ts returns nothing");
});

test("json-state: broken JSON after a missing observation still notifies the first valid read", (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "state.json");
  const source = createSource({ type: "json-state" });

  assert.equal(source.poll(file).length, 0);

  fs.writeFileSync(file, "{ broken");
  assert.equal(source.poll(file).length, 0, "broken content does not notify");

  fs.writeFileSync(file, JSON.stringify({ ts: "1-a", event: "Stop", message: "m1" }));
  assert.equal(source.poll(file).length, 1, "the first notification after an appearance is not dropped");
});

test("json-state: deleting and recreating with the same ts does not notify", (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "state.json");
  const source = createSource({ type: "json-state" });

  fs.writeFileSync(file, JSON.stringify({ ts: "1-a", event: "Stop" }));
  assert.equal(source.poll(file).length, 0); // present since startup = the first read only records

  fs.rmSync(file);
  assert.equal(source.poll(file).length, 0);

  fs.writeFileSync(file, JSON.stringify({ ts: "1-a", event: "Stop" }));
  assert.equal(source.poll(file).length, 0, "with the same ts, even a recreation does not notify");
});

test("json-state: a file never successfully read is still included in files()", (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "state.json");
  const source = createSource({ type: "json-state" });

  source.poll(file); // only observes that it is missing
  assert.deepEqual([...source.files()], [file], "it must be sweepable once it leaves the watch set");

  source.forget(file);
  assert.deepEqual([...source.files()], []);
});

test("json-state: rejects a file larger than 64KB", (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "state.json");
  const source = createSource({ type: "json-state" });
  fs.writeFileSync(file, JSON.stringify({ ts: "1-a", event: "Stop" }));
  source.poll(file);

  fs.writeFileSync(file, JSON.stringify({ ts: "2-b", event: "Stop", pad: "x".repeat(70 * 1024) }));
  assert.equal(source.poll(file).length, 0);
});

test("parseStateFields: takes in arbitrary fields", () => {
  const fields = parseStateFields(
    JSON.stringify({ ts: "1-a", event: "Stop", branch: "main", exitCode: 0, ok: true }),
  );
  assert.equal(fields!.branch, "main");
  assert.equal(fields!.exitCode, "0"); // numbers are stringified
  assert.equal(fields!.ok, "true");
});

test("parseStateFields: keeps the defaults and limits of the known fields", () => {
  const fields = parseStateFields(JSON.stringify({ ts: "1-a" }))!;
  assert.equal(fields.event, "unknown"); // missing -> unknown
  assert.equal(fields.message, "");
  assert.equal(fields.cwd, "");

  const long = parseStateFields(JSON.stringify({ ts: "1-a", event: "E".repeat(65) }))!;
  assert.equal(long.event, "unknown"); // over 64 chars -> unknown
});

test("parseStateFields: returns null when ts is invalid", () => {
  assert.equal(parseStateFields(JSON.stringify({ event: "Stop" })), null);
  assert.equal(parseStateFields(JSON.stringify({ ts: "bad!" })), null);
  assert.equal(parseStateFields("{ broken"), null);
});

test("parseStateFields: ignores object and array fields", () => {
  const fields = parseStateFields(
    JSON.stringify({ ts: "1-a", nested: { a: 1 }, list: [1, 2], nil: null }),
  )!;
  assert.equal(fields.nested, undefined);
  assert.equal(fields.list, undefined);
  assert.equal(fields.nil, undefined);
});

// --- log-lines ----------------------------------------------------------

test("log-lines: the first read skips existing content and returns only what is appended", (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "app.log");
  const source = createSource({ type: "log-lines", windowBytes: 64 * 1024 });

  fs.writeFileSync(file, "old line 1\nold line 2\n");
  assert.deepEqual(lines(source, file), []); // existing content does not notify

  fs.appendFileSync(file, "new line\n");
  assert.deepEqual(lines(source, file), ["new line"]);

  assert.deepEqual(lines(source, file), []); // unchanged
});

test("log-lines: a partially written line is withheld until it is complete (partial line)", (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "app.log");
  const source = createSource({ type: "log-lines", windowBytes: 64 * 1024 });
  fs.writeFileSync(file, "start\n");
  source.poll(file);

  fs.appendFileSync(file, "half a li"); // no newline
  assert.deepEqual(lines(source, file), []);

  fs.appendFileSync(file, "ne\n"); // completed here
  assert.deepEqual(lines(source, file), ["half a line"]);
});

test("log-lines: returns every line of a multi-line append", (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "app.log");
  const source = createSource({ type: "log-lines", windowBytes: 64 * 1024 });
  fs.writeFileSync(file, "x\n");
  source.poll(file);

  fs.appendFileSync(file, "a\nb\nc\n");
  assert.deepEqual(lines(source, file), ["a", "b", "c"]);
});

test("log-lines: re-reads from the beginning after a truncation", (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "app.log");
  const source = createSource({ type: "log-lines", windowBytes: 64 * 1024 });
  fs.writeFileSync(file, "line one\nline two\nline three\n");
  source.poll(file);

  fs.writeFileSync(file, "after rotate\n"); // the size shrinks
  assert.deepEqual(lines(source, file), ["after rotate"]);
});

test("log-lines: rewriting identical content does not notify twice (hash dedup)", (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "app.log");
  const source = createSource({ type: "log-lines", windowBytes: 64 * 1024 });
  fs.writeFileSync(file, "seed\n");
  source.poll(file);

  fs.appendFileSync(file, "ERROR boom\n");
  assert.deepEqual(lines(source, file), ["ERROR boom"]);

  // Truncate and rewrite the same line -> a known hash, so no notification
  fs.writeFileSync(file, "ERROR boom\n");
  assert.deepEqual(lines(source, file), []);
});

test("log-lines: an append larger than the window reads only the tail and reports the loss", (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "app.log");
  const source = createSource({ type: "log-lines", windowBytes: 4096 });
  fs.writeFileSync(file, "seed\n");
  source.poll(file);

  // Write far more than the window (4KB) at once
  const burst: string[] = [];
  for (let i = 0; i < 500; i++) burst.push(`line ${i}`);
  fs.appendFileSync(file, burst.join("\n") + "\n");

  const got = lines(source, file);
  assert.ok(got.length > 0, "the tail window was read");
  assert.ok(got.length < 500, "everything beyond the window was skipped");
  assert.equal(got[got.length - 1], "line 499", "the latest line is always included");
  // After jumping to the window, the truncated first line is dropped
  assert.ok(
    got.every((l) => /^line \d+$/.test(l)),
    "no fragment starting mid-line is mixed in",
  );
});

test("log-lines: strips a CRLF line ending", (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "app.log");
  const source = createSource({ type: "log-lines", windowBytes: 64 * 1024 });
  fs.writeFileSync(file, "seed\r\n");
  source.poll(file);
  fs.appendFileSync(file, "windows line\r\n");
  assert.deepEqual(lines(source, file), ["windows line"]);
});

test("log-lines: a multi-byte character is not corrupted at a chunk boundary", (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "app.log");
  const source = createSource({ type: "log-lines", windowBytes: 64 * 1024 });
  fs.writeFileSync(file, "seed\n");
  source.poll(file);

  // Stop midway through a multi-byte string, then complete it
  const jp = "完了しました"; // Japanese text: a multi-byte sequence
  const buf = Buffer.from(jp + "\n", "utf8");
  fs.appendFileSync(file, buf.subarray(0, 7)); // mid-way through a multi-byte character
  assert.deepEqual(lines(source, file), []);
  fs.appendFileSync(file, buf.subarray(7));
  assert.deepEqual(lines(source, file), [jp]);
});

test("log-lines: ignores blank lines", (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "app.log");
  const source = createSource({ type: "log-lines", windowBytes: 64 * 1024 });
  fs.writeFileSync(file, "seed\n");
  source.poll(file);
  fs.appendFileSync(file, "\n\nreal\n\n");
  assert.deepEqual(lines(source, file), ["real"]);
});

// --- file-meta ----------------------------------------------------------

test("file-meta: the first read only records; a change in mtime/size notifies", (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "data.bin");
  const source = createSource({ type: "file-meta" });

  fs.writeFileSync(file, "abc");
  assert.equal(source.poll(file).length, 0); // first read

  fs.writeFileSync(file, "abcdef"); // the size changes
  const events = source.poll(file);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.fields.size, "6");
  assert.ok(events[0]!.fields.mtime !== undefined);

  assert.equal(source.poll(file).length, 0); // unchanged
});

test("file-meta: handles a huge file, since it never reads the content", (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "big.bin");
  const source = createSource({ type: "file-meta" });
  fs.writeFileSync(file, Buffer.alloc(200 * 1024)); // larger than the 64KB cap
  assert.equal(source.poll(file).length, 0); // first read

  fs.appendFileSync(file, Buffer.alloc(1024));
  assert.equal(source.poll(file).length, 1); // unlike json-state, this is not rejected
});

// --- shared safety properties -------------------------------------------

test("all sources: a missing file returns nothing", () => {
  for (const source of [
    createSource({ type: "json-state" }),
    createSource({ type: "log-lines", windowBytes: 4096 }),
    createSource({ type: "file-meta" }),
  ]) {
    assert.deepEqual(source.poll("/no/such/file.txt"), []);
  }
});

test("all sources: a symlink is never read", (t) => {
  const dir = tmpDir(t);
  const real = path.join(dir, "real.txt");
  const link = path.join(dir, "link.txt");
  fs.writeFileSync(real, JSON.stringify({ ts: "1-a", event: "Stop" }) + "\n");
  fs.symlinkSync(real, link);
  for (const source of [
    createSource({ type: "json-state" }),
    createSource({ type: "log-lines", windowBytes: 4096 }),
    createSource({ type: "file-meta" }),
  ]) {
    assert.deepEqual(source.poll(link), []);
  }
});

test("all sources: a file behind a symlinked parent directory is never read", (t) => {
  const dir = tmpDir(t);
  // The container-writable level (`.claude` in the default pattern) is swapped for a symlink
  // to a directory outside the workspace. Nothing about the file behind it may reach a
  // notification: not its contents, and not its size or mtime either.
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  const real = path.join(outside, "target.txt");
  fs.writeFileSync(real, JSON.stringify({ ts: "1-a", event: "Stop" }) + "\n");
  const claudeDir = path.join(dir, ".claude");
  fs.symlinkSync(outside, claudeDir);
  const viaLink = path.join(claudeDir, "target.txt");
  [
    createSource({ type: "json-state" }),
    createSource({ type: "log-lines", windowBytes: 4096 }),
    createSource({ type: "file-meta" }),
  ].forEach((source, i) => {
    assert.deepEqual(source.poll(viaLink), []);
    // A change after the first observation is what would leak, so change size and content
    fs.writeFileSync(real, JSON.stringify({ ts: `${i + 2}-b`, event: "Stop" }) + "\n" + "x".repeat(i + 1) + "\n");
    assert.deepEqual(source.poll(viaLink), []);
  });
});

test("all sources: forget discards the state and a rediscovery is treated as a first read", (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, "state.json");
  const source = createSource({ type: "json-state" });
  fs.writeFileSync(file, JSON.stringify({ ts: "1-a", event: "Stop" }));
  source.poll(file);
  fs.writeFileSync(file, JSON.stringify({ ts: "2-b", event: "Stop" }));
  assert.equal(source.poll(file).length, 1);

  source.forget(file);
  fs.writeFileSync(file, JSON.stringify({ ts: "3-c", event: "Stop" }));
  assert.equal(source.poll(file).length, 0, "after forget it is a first read and does not notify");
});
