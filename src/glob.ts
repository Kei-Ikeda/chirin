import fs from "node:fs";
import path from "node:path";
import { log } from "./log.js";

// Cap on entries expanded per directory. Guards against a container creating a huge number of
// directories under a watched path to exhaust memory/CPU: opendir is read incrementally
// and aborted at the cap.
const MAX_GLOB_ENTRIES_PER_DIR = 10000;

// Cap on intermediate directories retained while expanding a single pattern. Stacking `*`
// segments multiplies the candidates (up to MAX_GLOB_ENTRIES_PER_DIR per directory), and the
// watcher-side cap on watch targets (MAX_WATCH_TARGETS) only applies after expansion finishes.
// Truncate the intermediate results here too, so a container filling the `*` levels with
// directories cannot exhaust memory/CPU during expansion itself.
// (The value matches MAX_WATCH_TARGETS.)
export const MAX_GLOB_DIRS_PER_PATTERN = 1024;

// Minimal glob implementation supporting only a whole-segment `*`.
// - `**`, partial matches (`foo*`) and a trailing `*` segment are rejected by validateGlobPattern
// - `*` does not match hidden directories (those starting with `.`)
// - Symlinks are not followed (readdir's Dirent does not report a symlink as a directory)
// - The leaf file need not exist (only intermediate directories are expanded via readdir; the
//   leaf is joined onto the path)

/** Returns null if the pattern is valid, or an error message describing the problem. */
export function validateGlobPattern(pattern: string): string | null {
  if (!pattern.startsWith("/")) return "must be an absolute path (or start with ~/)";
  const segments = pattern.split("/").filter((s) => s !== "");
  if (segments.length === 0) return "must end with a file name";
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment === "**") return "'**' is not supported";
    if (segment.includes("*") && segment !== "*") {
      return `partial wildcard '${segment}' is not supported (a wildcard segment must be exactly '*')`;
    }
    if (segment === "*" && i === segments.length - 1) {
      return "the last segment must be a concrete file name, not '*'";
    }
  }
  return null;
}

/** Returns the expanded absolute paths (deduplicated). Patterns must already be validated and ~-expanded. */
export function expandGlobs(patterns: string[]): string[] {
  const result = new Set<string>();
  for (const pattern of patterns) {
    for (const file of expandOne(pattern)) result.add(file);
  }
  return [...result];
}

function expandOne(pattern: string): string[] {
  const segments = pattern.split("/").filter((s) => s !== "");
  const fileName = segments[segments.length - 1]!;
  let dirs: string[] = ["/"];
  let truncated = false;
  for (const segment of segments.slice(0, -1)) {
    if (segment === "*") {
      const next: string[] = [];
      for (const dir of dirs) {
        let dirp: fs.Dir;
        try {
          dirp = fs.opendirSync(dir);
        } catch {
          continue; // a directory that does not exist or cannot be read expands to nothing
        }
        try {
          let count = 0;
          for (let entry = dirp.readSync(); entry !== null; entry = dirp.readSync()) {
            if (++count > MAX_GLOB_ENTRIES_PER_DIR) {
              log.warn(
                `directory has more than ${MAX_GLOB_ENTRIES_PER_DIR} entries; truncating glob expansion: ${dir}`,
              );
              break;
            }
            if (entry.name.startsWith(".")) continue;
            if (!entry.isDirectory()) continue; // a symlink yields isDirectory() = false and is skipped
            // Check before pushing. Checking afterwards would emit a false truncation warning
            // when the count lands exactly on the cap and nothing was actually dropped. The
            // remaining directories are still walked once the cap is hit, but each aborts on
            // its first matching entry, so the amount of walking does not grow.
            if (next.length >= MAX_GLOB_DIRS_PER_PATTERN) {
              truncated = true;
              break;
            }
            next.push(path.join(dir, entry.name));
          }
        } finally {
          dirp.closeSync();
        }
      }
      dirs = next;
    } else {
      dirs = dirs.map((dir) => path.join(dir, segment));
    }
  }
  // Truncation produces targets that go unmonitored. Do not drop them silently; warn once per pattern.
  if (truncated) {
    log.warn(
      `glob expansion hit the ${MAX_GLOB_DIRS_PER_PATTERN}-directory cap; some targets are not monitored: ${pattern}`,
    );
  }
  return dirs.map((dir) => path.join(dir, fileName));
}
