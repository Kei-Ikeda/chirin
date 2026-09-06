// Sanitization for notification strings.
// Removes (not replaces) control characters and the bidirectional text controls that can be
// used to spoof notification text, then truncates to maxLen by code point.
// Pure function; never throws.
//
// Removed:
//   - C0 controls (U+0000-U+001F) and DEL (U+007F)
//   - C1 controls (U+0080-U+009F) ... includes the single-byte CSI (0x9B) and friends
//   - Bidi/formatting controls (LRM/RLM, LRE..RLO, LRI..PDI) ... guards against display-reversal spoofing
function isStripped(cp: number): boolean {
  if (cp <= 0x1f || cp === 0x7f) return true; // C0 + DEL
  if (cp >= 0x80 && cp <= 0x9f) return true; // C1
  if (cp === 0x200e || cp === 0x200f) return true; // LRM, RLM
  if (cp >= 0x202a && cp <= 0x202e) return true; // LRE, RLE, PDF, LRO, RLO
  if (cp >= 0x2066 && cp <= 0x2069) return true; // LRI, RLI, FSI, PDI
  return false;
}

export function sanitize(input: string, maxLen: number): string {
  if (typeof input !== "string" || maxLen <= 0) return "";
  const kept: string[] = [];
  for (const ch of input) {
    if (isStripped(ch.codePointAt(0)!)) continue;
    kept.push(ch);
    if (kept.length >= maxLen) break;
  }
  return kept.join("");
}
