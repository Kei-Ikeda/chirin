// Conventions that are stated in prose elsewhere and were, until now, enforced by nobody.
//
// Both were assumed to be compiler errors and are not. An extensionless relative import
// compiles under a CommonJS NodeNext emit, and a type-only `vscode` import is erased before
// anything can fail to resolve it. Prose that claims a mechanical guarantee it does not have
// is worse than no claim, because it tells a reviewer to look away.
//
// These read the TypeScript sources rather than the build output, since both conventions are
// about what the sources say.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/** dist/test/<this file> -> the repository root */
const repoRoot = path.join(__dirname, "..", "..");

// Every module specifier has to be reachable, or the check is a check on the forms someone
// happened to think of. Two patterns cover the static declarations:
//   - a clause naming its source, which is every import and re-export that has one
//   - a bare side-effect import, which has no such clause at all
// Either quote style is accepted; the formatter writes one of them, and nothing enforces
// that. Both are anchored to the start of a statement, which keeps a specifier mentioned in
// a comment out (an earlier version matched its own documentation) and leaves out dynamic
// `import()` and `require()`, neither of which appears in these sources.
const WITH_SOURCE = /^[ \t]*(?:import|export)\b[^;'"]*\bfrom\s+["']([^"']+)["']/gm;
const SIDE_EFFECT = /^[ \t]*import\s+["']([^"']+)["']/gm;

/** Every .ts file under dir, at any depth: tsconfig includes the directory, not its top level. */
function tsFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...tsFiles(relative));
    else if (entry.name.endsWith(".ts")) found.push(relative);
  }
  return found;
}

function specifiers(file: string): string[] {
  const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
  return [WITH_SOURCE, SIDE_EFFECT].flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1]!),
  );
}

test("every relative import carries the .js extension", () => {
  const offenders: string[] = [];
  for (const file of [...tsFiles("src"), ...tsFiles("test")]) {
    for (const specifier of specifiers(file)) {
      if (specifier.startsWith(".") && !specifier.endsWith(".js")) {
        offenders.push(`${file}: ${specifier}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `relative imports must name the emitted file, extension included:\n${offenders.join("\n")}`,
  );
});

test("only the VS Code boundary files import vscode", () => {
  // The boundary, and the reason the core stays outside it, is in CLAUDE.md. Adding a file
  // here is a deliberate widening of it, which is exactly what this list makes visible.
  const boundary = new Set([
    path.join("src", "extension.ts"),
    path.join("src", "commands.ts"),
    path.join("src", "vscodeLog.ts"),
    path.join("src", "vscodeNotifier.ts"),
  ]);
  const offenders = tsFiles("src")
    .filter((file) => !boundary.has(file))
    .filter((file) => specifiers(file).includes("vscode"));
  assert.deepEqual(
    offenders,
    [],
    `the core must stay testable without the extension host; a type-only import counts:\n${offenders.join("\n")}`,
  );
});
