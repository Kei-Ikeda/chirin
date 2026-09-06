import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitize } from "../src/sanitize.js";

const NUL = String.fromCharCode(0x00);
const SOH = String.fromCharCode(0x01);
const BEL = String.fromCharCode(0x07);
const ESC = String.fromCharCode(0x1b);
const DEL = String.fromCharCode(0x7f);
const CSI = String.fromCharCode(0x9b); // C1: single-byte CSI
const PAD = String.fromCharCode(0x80); // lower end of C1
const APC = String.fromCharCode(0x9f); // upper end of C1
const RLO = String.fromCodePoint(0x202e); // bidi override
const PDI = String.fromCodePoint(0x2069); // end of a bidi isolate
const RLM = String.fromCodePoint(0x200f); // right-to-left mark

test("removes control characters (U+0000-U+001F, U+007F)", () => {
  assert.equal(sanitize(`a${NUL}b${SOH}c${DEL}d`, 100), "abcd");
  assert.equal(sanitize(`tab\tnewline\nbell${BEL}esc${ESC}[31m`, 100), "tabnewlinebellesc[31m");
});

test("truncates at maxLen", () => {
  assert.equal(sanitize("abcdef", 3), "abc");
  assert.equal(sanitize("abc", 3), "abc");
});

test("truncation happens after control characters are removed", () => {
  assert.equal(sanitize(`${NUL}${SOH}abc`, 2), "ab");
});

test("an empty string is returned as-is", () => {
  assert.equal(sanitize("", 10), "");
});

test("returns an empty string when maxLen is 0 or less", () => {
  assert.equal(sanitize("abc", 0), "");
  assert.equal(sanitize("abc", -1), "");
});

test("counts surrogate pairs by code point and never splits them", () => {
  assert.equal(sanitize("👍👍👍", 2), "👍👍");
  assert.equal(sanitize("a👍b", 10), "a👍b");
});

test("removes C1 control characters (U+0080-U+009F, including the single-byte CSI 0x9B)", () => {
  assert.equal(sanitize(`a${CSI}b${PAD}c${APC}d`, 100), "abcd");
});

test("removes bidirectional text controls (RLO/PDI/RLM and friends)", () => {
  assert.equal(sanitize(`a${RLO}b${PDI}c${RLM}d`, 100), "abcd");
});

test("keeps ordinary visible characters (emoji and CJK included)", () => {
  assert.equal(sanitize("done: app 👍", 100), "done: app 👍");
});

test("a non-string input returns an empty string instead of throwing", () => {
  assert.equal(sanitize(123 as unknown as string, 10), "");
  assert.equal(sanitize(null as unknown as string, 10), "");
  assert.equal(sanitize(undefined as unknown as string, 10), "");
});
