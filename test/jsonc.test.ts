import assert from "node:assert/strict";
import { test } from "node:test";
import { stripJsonComments } from "../src/jsonc.js";

test("replaces a line comment with spaces", () => {
  assert.equal(stripJsonComments('{"a": 1} // trailing'), '{"a": 1}            ');
  assert.deepEqual(JSON.parse(stripJsonComments('// head\n{"a": 1}')), { a: 1 });
});

test("replaces a block comment with spaces", () => {
  assert.deepEqual(JSON.parse(stripJsonComments('{/* c */ "a": 1}')), { a: 1 });
  // An unclosed block comment swallows everything to the end (JSON.parse then reports the error)
  assert.equal(stripJsonComments("/* unterminated").trim(), "");
});

test("line and column numbers do not shift after comments are stripped", () => {
  const input = ['{', '  // note', '  /* multi-line', '     comment */', '  "a": 1', '}'].join("\n");
  const stripped = stripJsonComments(input);
  const lines = stripped.split("\n");
  assert.equal(lines.length, 6);
  assert.equal(lines[4], '  "a": 1');
  assert.deepEqual(JSON.parse(stripped), { a: 1 });
});

test("// and /* inside a string literal are not treated as comments", () => {
  assert.deepEqual(JSON.parse(stripJsonComments('{"url": "https://example.com"}')), {
    url: "https://example.com",
  });
  assert.deepEqual(JSON.parse(stripJsonComments('{"p": "/src/*/x"}')), { p: "/src/*/x" });
  assert.deepEqual(JSON.parse(stripJsonComments('{"p": "a/*b*/c"}')), { p: "a/*b*/c" });
});

test("an escaped quote does not terminate the string", () => {
  assert.deepEqual(JSON.parse(stripJsonComments('{"q": "he said \\"//\\" ok"}')), {
    q: 'he said "//" ok',
  });
  // A backslash (\\) right before the string does not escape the quote
  assert.deepEqual(JSON.parse(stripJsonComments('{"b": "x\\\\", "c": 1 // tail\n}')), {
    b: "x\\",
    c: 1,
  });
});

test("JSON without comments is unchanged", () => {
  const input = '{\n  "a": [1, 2],\n  "b": "x"\n}';
  assert.equal(stripJsonComments(input), input);
});
