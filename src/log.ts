// Logging: by default writes `[ISO8601] [LEVEL] message` to stdio.
// info / debug -> stdout, warn / error -> stderr.
// debug is only emitted when the CHIRIN_DEBUG=1 environment variable is set.
//
// When running as a VS Code extension, setLogSink() swaps the destination for a
// LogOutputChannel. Sanitization stays in place regardless of the destination
// (log bodies carry untrusted values).

import { sanitize } from "./sanitize.js";

export type LogLevel = "error" | "warn" | "info" | "debug";

/** Destination that receives an already-sanitized, unformatted message. */
export type LogSink = (level: LogLevel, message: string) => void;

/**
 * Cheap per-destination check, evaluated before sanitization.
 * sanitize loops over code points, so never run it for a log line that gets dropped.
 */
export type LogFilter = (level: LogLevel) => boolean;

// Log bodies also carry untrusted container-controlled values (the `*` segment names of
// watched paths, for example). Sanitize everything before writing so the destination
// terminal (the default stdio sink) or OutputChannel cannot be driven with control
// characters or escape sequences.
const LOG_MAX_LEN = 4096;

const stdioFilter: LogFilter = (level) => level !== "debug" || process.env.CHIRIN_DEBUG === "1";

const stdioSink: LogSink = (level, message) => {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}\n`;
  if (level === "error" || level === "warn") {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
};

let sink: LogSink = stdioSink;
let filter: LogFilter = stdioFilter;

/**
 * Swap the destination (the extension's activate wires up a LogOutputChannel).
 * Pass a filter to describe whether the destination discards debug (default: emit every level).
 */
export function setLogSink(next: LogSink, nextFilter: LogFilter = () => true): void {
  sink = next;
  filter = nextFilter;
}

/** Restore the default stdio destination (so we do not keep holding an OutputChannel after deactivate). */
export function resetLogSink(): void {
  sink = stdioSink;
  filter = stdioFilter;
}

function emit(level: LogLevel, message: string): void {
  if (!filter(level)) return;
  sink(level, sanitize(message, LOG_MAX_LEN));
}

export const log = {
  error(message: string): void {
    emit("error", message);
  },
  warn(message: string): void {
    emit("warn", message);
  },
  info(message: string): void {
    emit("info", message);
  },
  debug(message: string): void {
    emit("debug", message);
  },
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
