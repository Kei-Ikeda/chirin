// Adapter that routes log.ts output into a VS Code LogOutputChannel.
// The LogOutputChannel adds the timestamp and level itself, so only the body is passed here.
// Debug visibility is controlled by VS Code's log level setting, not by CHIRIN_DEBUG.

import * as vscode from "vscode";
import type { LogFilter, LogSink } from "./log.js";

export function outputChannelSink(channel: vscode.LogOutputChannel): LogSink {
  return (level, message) => {
    switch (level) {
      case "error":
        channel.error(message);
        return;
      case "warn":
        channel.warn(message);
        return;
      case "info":
        channel.info(message);
        return;
      case "debug":
        channel.debug(message);
        return;
    }
  };
}

/**
 * Decides whether debug is emitted based on the channel's log level.
 * A cheap per-call check that avoids running sanitize for logs VS Code would discard.
 */
export function outputChannelFilter(channel: vscode.LogOutputChannel): LogFilter {
  // Off is enum value 0, so a naive comparison would classify it as "Debug or lower".
  // When the channel is Off, no level is retained, so drop them all.
  return (level) =>
    channel.logLevel !== vscode.LogLevel.Off &&
    (level !== "debug" || channel.logLevel <= vscode.LogLevel.Debug);
}
