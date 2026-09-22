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

// Every module specifier has to be reachable, or the check only covers the forms someone
// happened to think of -- which is how two rounds of review each found a way past this.
// Three patterns cover the static declarations:
//   - a clause naming its source, which is every import and re-export that has one
//   - a bare side-effect import, which has no such clause at all
//   - an import-equals declaration, TypeScript's own form and valid in a CommonJS emit
// Either quote style is accepted; the formatter writes one of them and nothing enforces that
// it always will. All three are anchored to the start of a statement, which also keeps a
// specifier written inside a comment out; an earlier version matched its own documentation.
// The forms deliberately left out are not assumed absent: the last test here asserts it.
const WITH_SOURCE = /^[ \t]*(?:import|export)\b[^;'"]*\bfrom\s+["']([^"']+)["']/gm;
const SIDE_EFFECT = /^[ \t]*import\s+["']([^"']+)["']/gm;
const IMPORT_EQUALS =
  /^[ \t]*import\s+(?:type\s+)?[A-Za-z_$][\w$]*\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/gm;

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
  return [WITH_SOURCE, SIDE_EFFECT, IMPORT_EQUALS].flatMap((pattern) =>
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

test("no module is loaded by a form these patterns cannot read", () => {
  // The scanner above is only as good as its list of forms, and review found a missing one
  // twice. So the remaining ways to name a module are not declared out of scope, they are
  // asserted absent: a dynamic import or a bare call-style load added later fails here,
  // which says to widen the scanner before writing the import.
  const loaderCall = /\b(?:require|import)\s*\(/;
  const offenders = [...tsFiles("src"), ...tsFiles("test")].filter((file) => {
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    return loaderCall.test(source.replace(IMPORT_EQUALS, ""));
  });
  assert.deepEqual(
    offenders,
    [],
    `a module is named by a form the two convention tests above do not see:\n${offenders.join("\n")}`,
  );
});
