// Minimal implementation for reducing JSON with comments (JSONC) to plain JSON.
// To stay zero-dependency we use no external parser and rewrite based on lexing alone.
//
// - Comments are replaced with spaces rather than deleted, and newlines are preserved.
//   That keeps the error positions reported by JSON.parse (`at position N` / line and
//   column) aligned with the original file, so users can open the offending line directly.
// - `//` and `/*` inside string literals are not treated as comments (escapes are tracked).
// - Only line comments (`//`) and block comments (`/* */`) are supported. Trailing commas
//   are not; JSON.parse reports them as errors, unchanged.

export function stripJsonComments(input: string): string {
  let out = "";
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;

    if (ch === '"') {
      // Pass string literals through without inspecting their contents. Skip ahead to the
      // closing quote so a value like `"https://example"` is not dropped as a comment.
      const start = i;
      i++;
      while (i < input.length) {
        const c = input[i]!;
        if (c === "\\") {
          i += 2; // an escaped character (including `\"`) never terminates the literal
          continue;
        }
        i++;
        if (c === '"') break;
      }
      // If input ends without a closing quote, emit it as-is and let JSON.parse complain.
      out += input.slice(start, i);
      continue;
    }

    if (ch === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    if (ch === "/" && input[i + 1] === "*") {
      const closed = input.indexOf("*/", i + 2);
      const end = closed === -1 ? input.length : closed + 2;
      for (; i < end; i++) out += input[i] === "\n" ? "\n" : " ";
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}
