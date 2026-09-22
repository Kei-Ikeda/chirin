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

// Matches the specifier of the import and re-export forms this codebase uses (always
// double-quoted, as the formatter writes them). Scanning raw text rather than parsing
// means a specifier written inside a comment is matched too; a false positive fails
// loudly, which is the safe direction for a check like this.
const FROM_SPECIFIER = /\bfrom\s+"([^"]+)"/g;

function tsFiles(dir: string): string[] {
  return fs
    .readdirSync(path.join(repoRoot, dir))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => path.join(dir, name));
}

function specifiers(file: string): string[] {
  const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
  return [...source.matchAll(FROM_SPECIFIER)].map((match) => match[1]!);
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
