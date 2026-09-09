import crypto from "node:crypto";
import { readRange, statFile, withFile } from "./fileread.js";
import { log } from "./log.js";

// Source adapters: each source type answers "what are the new events in this file?".
//
// Read limits, and what happens when they are exceeded (reject, or read only the tail),
// are decided here. The shared trust-boundary checks live in fileread.ts.
//
// | Type       | Change detection          | Limit           | On overflow          |
// |------------|---------------------------|-----------------|----------------------|
// | json-state | ts field                  | 64KB            | reject (treated as anomalous) |
// | log-lines  | hash of already-seen lines| bytes + line cap| read only the newest bounded batch |
// | file-meta  | mtime + size              | - (not read)    | -                    |

/** A single candidate event. Every value in fields is untrusted (sanitized before notifying). */
export interface SourceEvent {
  /** Deduplication key. The same key means the same event */
  key: string;
  fields: Record<string, string>;
}

export type SourceConfig =
  | { type: "json-state" }
  | { type: "log-lines"; windowBytes: number }
  | { type: "file-meta" };

export interface Source {
  /** Returns the file's new events. On first observation it only records state and returns an empty array. */
  poll(file: string): SourceEvent[];
  /** Discards the state of a file that is no longer a watch target. */
  forget(file: string): void;
  /** The target files currently retained (used to sweep away stale state). */
  files(): Iterable<string>;
}

// --- json-state ---------------------------------------------------------

/** Cap on the state file size. Anything larger is treated as an anomaly or an attack and rejected wholesale. */
const MAX_STATE_FILE_BYTES = 64 * 1024;
const TS_PATTERN = /^[0-9]+-[a-z0-9]+$/;
const MAX_TS_LEN = 64;
/** Per-field limits. Each is defined individually so a change to one cannot widen another. */
const MAX_EVENT_LEN = 64;
const MAX_MESSAGE_LEN = 200;
const MAX_CWD_LEN = 512;
/** Limits for the arbitrary extra fields a state file may carry */
const MAX_EXTRA_FIELDS = 32;
const MAX_FIELD_VALUE_LEN = 512;
/** Shape of a field name a source may expose. Shared with the validation of match.field in the config. */
export const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

class JsonStateSource implements Source {
  private readonly lastKey = new Map<string, string>();
  private readonly warnedOversize = new Set<string>();
  /**
   * Files observed as "missing" after watching began. When a file listed here becomes
   * readable, that appearance is definitely a new event, so we notify even on the first
   * read (this keeps the very first notification after installing a hook from being
   * dropped). Files that already existed at startup never land here, so a VS Code restart
   * or a leader handover does not re-notify stale content.
   */
  private readonly seenMissing = new Set<string>();

  poll(file: string): SourceEvent[] {
    const result = withFile(file, (fd, size) => {
      if (size > MAX_STATE_FILE_BYTES) return { oversize: size };
      return { raw: readRange(fd, 0, size).toString("utf8") };
    });
    if (result.kind === "missing") {
      this.seenMissing.add(file);
      return [];
    }
    if (result.kind === "unreadable") {
      // Unreadable does not imply missing (a symlink swap, for instance). Do not treat it as an appearance.
      log.debug(`cannot read ${file}: ${result.reason}`);
      return [];
    }
    if ("oversize" in result.value) {
      // Warn only once per file, so a permanently oversized file does not warn every second
      if (!this.warnedOversize.has(file)) {
        this.warnedOversize.add(file);
        log.warn(
          `state file exceeds ${MAX_STATE_FILE_BYTES} bytes (${result.value.oversize}), skipping: ${file}`,
        );
      }
      return [];
    }
    this.warnedOversize.delete(file);

    const fields = parseStateFields(result.value.raw);
    if (fields === null) {
      log.debug(`invalid state file, skipping: ${file}`);
      return [];
    }
    const key = fields.ts!;
    const prev = this.lastKey.get(file);
    // A previously-missing file became readable: it appeared after watching began. Consume
    // the flag as soon as a valid state is read (so a spell of broken JSON in between does
    // not cost us the first notification once it becomes valid).
    const appearedAfterMissing = this.seenMissing.delete(file);
    this.lastKey.set(file, key);
    if (prev === key) return []; // unchanged
    // For a file that already existed at startup, the first read only records (no notification for a past event)
    if (prev === undefined && !appearedAfterMissing) return [];
    return [{ key, fields }];
  }

  forget(file: string): void {
    this.lastKey.delete(file);
    this.warnedOversize.delete(file);
    this.seenMissing.delete(file);
  }

  files(): Iterable<string> {
    // Also return files never yet read (present only in seenMissing). Otherwise the
    // missing flag for a path that left the watch set would never be forgotten.
    return new Set([...this.lastKey.keys(), ...this.seenMissing]);
  }
}

/**
 * Validates an (untrusted) state file and converts it into a field dictionary.
 * If ts is missing or malformed, the whole file is ignored (null).
 * event / message / cwd keep their documented defaults and limits; other string, number and
 * boolean fields are also taken in, bounded by MAX_EXTRA_FIELDS and MAX_FIELD_VALUE_LEN.
 */
export function parseStateFields(raw: string): Record<string, string> | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;

  const ts = d.ts;
  if (typeof ts !== "string" || ts.length > MAX_TS_LEN || !TS_PATTERN.test(ts)) return null;

  const fields: Record<string, string> = {
    ts,
    // event falls back to "unknown" when missing or over the limit; message / cwd default to an empty string
    event:
      typeof d.event === "string" && d.event.length > 0 && d.event.length <= MAX_EVENT_LEN
        ? d.event
        : "unknown",
    message: typeof d.message === "string" ? truncate(d.message, MAX_MESSAGE_LEN) : "",
    cwd: typeof d.cwd === "string" ? truncate(d.cwd, MAX_CWD_LEN) : "",
  };

  let extras = 0;
  for (const [name, value] of Object.entries(d)) {
    if (Object.hasOwn(fields, name)) continue;
    if (!FIELD_NAME_PATTERN.test(name)) continue;
    if (extras >= MAX_EXTRA_FIELDS) break;
    if (typeof value === "string") fields[name] = truncate(value, MAX_FIELD_VALUE_LEN);
    else if (typeof value === "number" && Number.isFinite(value)) fields[name] = String(value);
    else if (typeof value === "boolean") fields[name] = String(value);
    else continue; // objects, arrays and null are ignored
    extras++;
  }
  return fields;
}

// --- log-lines ----------------------------------------------------------

export const DEFAULT_LOG_WINDOW_BYTES = 1024 * 1024;
export const MIN_LOG_WINDOW_BYTES = 4 * 1024;
export const MAX_LOG_WINDOW_BYTES = 16 * 1024 * 1024;
/** Per file and poll, including blank and duplicate lines. Also bounds events and retained hashes. */
export const MAX_LOG_LINES_PER_POLL = 2000;
const MAX_LINE_LEN = 1000;
const NEWLINE = 0x0a;

interface LogState {
  /** Byte offset just past the last complete line already processed */
  offset: number;
  /** Hashes of the most recent processed batch; at most MAX_LOG_LINES_PER_POLL entries */
  seen: Set<string>;
}

class LogLinesSource implements Source {
  private readonly state = new Map<string, LogState>();

  constructor(private readonly windowBytes: number) {}

  poll(file: string): SourceEvent[] {
    const prev = this.state.get(file);
    const result = withFile(file, (fd, size) => this.readNewLines(file, fd, size, prev));
    if (result.kind === "missing") return [];
    if (result.kind === "unreadable") {
      log.debug(`cannot read ${file}: ${result.reason}`);
      return [];
    }
    const { next, events } = result.value;
    this.state.set(file, next);
    return events;
  }

  private readNewLines(
    file: string,
    fd: number,
    size: number,
    prev: LogState | undefined,
  ): { next: LogState; events: SourceEvent[] } {
    // First observation: do not notify for existing content. Start tracking from the tail.
    if (prev === undefined) return { next: { offset: size, seen: new Set() }, events: [] };
    if (size === prev.offset) return { next: prev, events: [] }; // unchanged (no read)

    // The size shrank = truncation / rotation. Re-read from the beginning.
    // seen is not cleared (this prevents a duplicate notification if the same content is rewritten).
    const offset = size < prev.offset ? 0 : prev.offset;

    let readFrom = offset;
    let startsMidLine = false;
    let skipped = 0;
    if (size - readFrom > this.windowBytes) {
      // More than a window's worth was written. Read only the tail window and report how
      // much was skipped (never lose data silently).
      readFrom = size - this.windowBytes;
      skipped = readFrom - offset;
      startsMidLine = true;
    }

    const buf = readRange(fd, readFrom, size - readFrom);
    if (skipped > 0) {
      log.warn(
        `log window (${this.windowBytes} bytes) overflowed; skipped ${skipped} bytes without inspecting them: ${file}`,
      );
    }
    const lastNewline = buf.lastIndexOf(NEWLINE);
    if (lastNewline < 0) {
      // No complete line yet. Advance the offset only and wait for the next poll (partial-line handling).
      return { next: { offset: readFrom, seen: prev.seen }, events: [] };
    }
    // Bound the line count BEFORE decoding/splitting/hashing. A byte window alone can hold
    // millions of tiny lines. Scan backwards to keep the newest complete lines, counting
    // blanks and duplicates too so neither can bypass the work limit.
    const firstComplete = startsMidLine ? buf.indexOf(NEWLINE) + 1 : 0;
    let start = lastNewline + 1;
    for (let count = 0; count < MAX_LOG_LINES_PER_POLL && start > firstComplete; count++) {
      // Buffer.lastIndexOf treats negative offsets as relative to the end, not "not found".
      start = start > 1 ? buf.lastIndexOf(NEWLINE, start - 2) + 1 : 0;
      start = Math.max(start, firstComplete);
    }
    if (start > firstComplete) {
      log.warn(
        `log line cap (${MAX_LOG_LINES_PER_POLL}/poll) reached; skipped ${start - firstComplete} bytes of older complete lines without inspecting them: ${file}`,
      );
    }
    // The byte boundary is now a newline, so a multi-byte character cannot be cut here.
    const lines = start > lastNewline ? [] : buf.subarray(start, lastNewline).toString("utf8").split("\n");

    const seen = new Set<string>();
    const events: SourceEvent[] = [];
    for (const rawLine of lines) {
      const line = truncate(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine, MAX_LINE_LEN);
      if (line === "") continue;
      const key = hashLine(line);
      seen.add(key);
      if (!prev.seen.has(key)) events.push({ key, fields: { line } });
    }
    return { next: { offset: readFrom + lastNewline + 1, seen }, events };
  }

  forget(file: string): void {
    this.state.delete(file);
  }

  files(): Iterable<string> {
    return this.state.keys();
  }
}

function hashLine(line: string): string {
  // The container controls the content behind the dedup key, so use a cryptographic hash
  // to keep a collision from suppressing a notification. The batch cap bounds hash calls.
  return crypto.createHash("sha256").update(line).digest("base64");
}

// --- file-meta ----------------------------------------------------------

class FileMetaSource implements Source {
  private readonly lastKey = new Map<string, string>();

  poll(file: string): SourceEvent[] {
    const result = statFile(file);
    if (result.kind === "missing") return [];
    if (result.kind === "unreadable") {
      log.debug(`cannot stat ${file}: ${result.reason}`);
      return [];
    }
    const st = result.value;
    const key = `${Math.trunc(st.mtimeMs)}:${st.size}`;
    const prev = this.lastKey.get(file);
    this.lastKey.set(file, key);
    if (prev === undefined || prev === key) return [];
    return [
      {
        key,
        fields: { size: String(st.size), mtime: new Date(st.mtimeMs).toISOString() },
      },
    ];
  }

  forget(file: string): void {
    this.lastKey.delete(file);
  }

  files(): Iterable<string> {
    return this.lastKey.keys();
  }
}

// --- factory ------------------------------------------------------------

export function createSource(config: SourceConfig): Source {
  switch (config.type) {
    case "json-state":
      return new JsonStateSource();
    case "log-lines":
      return new LogLinesSource(config.windowBytes);
    case "file-meta":
      return new FileMetaSource();
  }
}

/** Key for sharing a source between identical configurations (so the same file is not read twice). */
export function sourceKey(config: SourceConfig): string {
  return config.type === "log-lines" ? `log-lines:${config.windowBytes}` : config.type;
}

/** Default field name (used by config validation to fill in match.field). */
export function defaultFieldFor(type: SourceConfig["type"]): string {
  switch (type) {
    case "json-state":
      return "message";
    case "log-lines":
      return "line";
    case "file-meta":
      return "size";
  }
}

/** Truncation by code point (never splits a surrogate pair). */
export function truncate(value: string, maxLen: number): string {
  // Stop at the limit instead of allocating an array for an entire untrusted log line.
  let end = 0;
  let count = 0;
  for (const cp of value) {
    if (count++ >= maxLen) break;
    end += cp.length;
  }
  return value.slice(0, end);
}
