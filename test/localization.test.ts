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

test("every key package.json references carries text in both bundles", () => {
  // `key in bundle` is not enough: a translation cleared to "" keeps the key, satisfies every
  // other check here, and renders as a blank label.
  const problem = (bundle: Record<string, string>, file: string, key: string): string[] => {
    if (!(key in bundle)) return [`${file} is missing ${key}`];
    return typeof bundle[key] === "string" && bundle[key]!.trim() !== ""
      ? []
      : [`${file} has ${key} but it is empty`];
  };
  const missing = [...referenced]
    .flatMap((key) => [
      ...problem(english, "package.nls.json", key),
      ...problem(japanese, "package.nls.ja.json", key),
    ])
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

/** A user-facing string package.json contributes, and where in the manifest it sits. */
interface Contributed {
  where: string;
  value: string;
}

/**
 * Every field package.json contributes a user-facing string through.
 *
 * Collecting only the values that already look like `%key%` cannot notice the case that
 * matters: a title replaced with inline English and its key deleted from both bundles leaves
 * equal key sets, no missing reference and no orphan, so every other check here passes while
 * a Japanese reader is handed English. The fields have to be enumerated first and checked
 * second, and the test below asserts the enumeration is complete.
 */
function contributed(): Contributed[] {
  const manifestJson = JSON.parse(manifest) as {
    description?: string;
    capabilities?: { untrustedWorkspaces?: { description?: string } };
    contributes?: {
      configuration?: { properties?: Record<string, { description?: string; markdownDescription?: string }> };
      commands?: { command?: string; title?: string }[];
      walkthroughs?: {
        id?: string;
        title?: string;
        description?: string;
        steps?: {
          id?: string;
          title?: string;
          description?: string;
          media?: { markdown?: string; altText?: string };
        }[];
      }[];
    };
  };
  const found: Contributed[] = [];
  const add = (where: string, value: unknown): void => {
    if (typeof value === "string") found.push({ where, value });
  };

  add("description", manifestJson.description);
  add("capabilities.untrustedWorkspaces.description", manifestJson.capabilities?.untrustedWorkspaces?.description);
  for (const [name, property] of Object.entries(manifestJson.contributes?.configuration?.properties ?? {})) {
    add(`configuration.${name}.description`, property.description);
    add(`configuration.${name}.markdownDescription`, property.markdownDescription);
  }
  for (const command of manifestJson.contributes?.commands ?? []) {
    add(`commands.${command.command}.title`, command.title);
  }
  for (const walkthrough of manifestJson.contributes?.walkthroughs ?? []) {
    add(`walkthroughs.${walkthrough.id}.title`, walkthrough.title);
    add(`walkthroughs.${walkthrough.id}.description`, walkthrough.description);
    for (const step of walkthrough.steps ?? []) {
      const at = `walkthroughs.${walkthrough.id}.steps.${step.id}`;
      add(`${at}.title`, step.title);
      add(`${at}.description`, step.description);
      add(`${at}.media.markdown`, step.media?.markdown);
      add(`${at}.media.altText`, step.media?.altText);
    }
  }
  return found;
}

const contributedStrings = contributed();

/**
 * The walkthrough keys, taken from the manifest rather than from how they are named.
 *
 * A key name is an arbitrary identifier: what makes one a panel is package.json pointing a
 * step's `media.markdown` at it. Collecting them by a `.media` suffix means a step renamed to
 * anything else silently leaves the panel checks below, taking its language pairing with it.
 */
const mediaKeys = [
  ...new Set(
    contributedStrings
      .filter(({ where }) => where.endsWith(".media.markdown"))
      .map(({ value }) => value.replace(/^%|%$/g, "")),
  ),
];

test("every walkthrough panel is a file, in both languages", () => {
  assert.ok(mediaKeys.length > 0, "no walkthrough media keys found; this test stopped covering anything");
  // Existing is not enough: a value pointing at `media/walkthrough/` resolves to a directory,
  // which satisfies existsSync and leaves VS Code with no panel to render.
  const isFile = (panel: string): boolean => {
    try {
      return fs.statSync(path.join(repoRoot, panel)).isFile();
    } catch {
      return false;
    }
  };
  const missing = mediaKeys
    .flatMap((key) => [
      [key, "package.nls.json", english[key]!],
      [key, "package.nls.ja.json", japanese[key]!],
    ])
    .filter(([, , panel]) => !isFile(panel!))
    .map(([key, bundle, panel]) => `${key} in ${bundle} does not point at a file: ${panel}`);
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

test("every contributed user-facing string is a localization reference", () => {
  const inlined = contributedStrings
    .filter(({ value }) => !/^%[^%]+%$/.test(value))
    .map(({ where, value }) => `${where} is the literal ${JSON.stringify(value)}, not a %key%`);
  assert.deepEqual(inlined, [], inlined.join("\n"));
});

test("the enumerated fields cover every localization reference in the manifest", () => {
  // This closes one direction only, and the other one cannot be closed from here. A field the
  // enumeration does not walk still passes if its value is inline English, because it adds
  // nothing to either set -- and knowing every field VS Code would localize means knowing the
  // manifest schema, which lives outside this repository and moves with the editor. So a
  // newly contributed field is a review matter, and AGENTS.md says so. What this does catch is
  // a reference reaching a field the enumeration cannot see, which says to extend the list.
  const enumerated = new Set(
    contributedStrings
      .filter(({ value }) => /^%[^%]+%$/.test(value))
      .map(({ value }) => value.slice(1, -1)),
  );
  assert.deepEqual(
    [...referenced].sort().filter((key) => !enumerated.has(key)),
    [],
    "package.json references a key through a field contributed() does not enumerate",
  );
});
