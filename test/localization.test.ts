// The localization pairing, which until now was held together by eye.
//
// A key missing from the Japanese bundle falls back to English, so dropping one half of a
// pair degrades quietly rather than failing -- which is why the pairing needs a test more
// than the parts that break loudly. The walkthrough is the same shape: `media.markdown` is
// itself a localized key, so each language resolves to its own file and a missing file is an
// empty panel, not an error.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/** dist/test/<this file> -> the repository root */
const repoRoot = path.join(__dirname, "..", "..");

function readJson(file: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8")) as Record<string, string>;
}

const english = readJson("package.nls.json");
const japanese = readJson("package.nls.ja.json");
const manifest = fs.readFileSync(path.join(repoRoot, "package.json"), "utf8");

/** Every `%key%` package.json contributes a user-facing string through. */
const referenced = new Set([...manifest.matchAll(/"%([^%"]+)%"/g)].map((match) => match[1]!));

test("both nls bundles declare the same keys", () => {
  assert.deepEqual(
    Object.keys(japanese).sort(),
    Object.keys(english).sort(),
    "a key present in one bundle and not the other falls back silently to English",
  );
});

test("every key package.json references exists in both bundles", () => {
  const missing = [...referenced]
    .flatMap((key) => [
      key in english ? [] : [`package.nls.json is missing ${key}`],
      key in japanese ? [] : [`package.nls.ja.json is missing ${key}`],
    ])
    .flat()
    .sort();
  assert.deepEqual(missing, [], missing.join("\n"));
});

test("no bundle key is left behind by package.json", () => {
  // A key nothing contributes is a string no one sees, and the pair of them will drift
  // together unnoticed for as long as they stay.
  const orphans = Object.keys(english)
    .filter((key) => !referenced.has(key))
    .sort();
  assert.deepEqual(orphans, [], `nothing in package.json references:\n${orphans.join("\n")}`);
});

/** The walkthrough keys, which resolve to a file rather than to a string shown as-is. */
const mediaKeys = Object.keys(english).filter((key) => key.endsWith(".media"));

test("every walkthrough panel exists in both languages", () => {
  assert.ok(mediaKeys.length > 0, "no walkthrough media keys found; this test stopped covering anything");
  const missing = mediaKeys
    .flatMap((key) => [
      [key, "package.nls.json", english[key]!],
      [key, "package.nls.ja.json", japanese[key]!],
    ])
    .filter(([, , panel]) => !fs.existsSync(path.join(repoRoot, panel!)))
    .map(([key, bundle, panel]) => `${key} in ${bundle} points at a missing ${panel}`);
  assert.deepEqual(missing, [], missing.join("\n"));
});

test("each language resolves to its own walkthrough panel", () => {
  // Existence alone does not hold the pairing: a Japanese value edited to the English path
  // still resolves, still exists, and still leaves the key sets equal, so all of the above
  // passes while a Japanese reader is shown the English panel. That is the quiet degradation
  // these tests exist for, so the relationship itself is asserted -- the Japanese panel is
  // the English one under the `ja/` directory, as it is laid out on disk.
  const wrong = mediaKeys
    .map((key) => ({
      key,
      expected: english[key]!.replace("walkthrough/", "walkthrough/ja/"),
      actual: japanese[key]!,
    }))
    .filter(({ expected, actual }) => expected !== actual)
    .map(({ key, expected, actual }) => `${key}: expected ${expected}, package.nls.ja.json says ${actual}`);
  assert.deepEqual(wrong, [], wrong.join("\n"));
});
