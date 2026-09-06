// Supplementary Notifier that shows an in-window VS Code notification in addition to the
// OS notification (osascript).
//
// This is not a replacement for osascript. When VS Code is in the background the in-window
// toast is invisible and chirin's whole reason for existing (reaching the host's
// Notification Center) is lost, so this is only ever used alongside it.

import * as vscode from "vscode";
import {
  MESSAGE_MAX_LEN,
  SUBTITLE_MAX_LEN,
  TITLE_MAX_LEN,
  compositeNotifier,
  osascriptNotifier,
  type Notifier,
} from "./notifier.js";
import { sanitize } from "./sanitize.js";

const vscodeToastNotifier: Notifier = (opts) => {
  // Callers are expected to have sanitized already, but reapply defensively as osascriptNotifier does
  const parts = [
    sanitize(opts.title, TITLE_MAX_LEN),
    sanitize(opts.subtitle ?? "", SUBTITLE_MAX_LEN),
    sanitize(opts.message, MESSAGE_MAX_LEN),
  ].filter((part) => part !== "");
  // VS Code notifications render `[label](url)` in the body as a clickable link. The message
  // can contain container-controlled (untrusted) strings, so break the link syntax to prevent
  // phishing link injection (a sink that osascript's plain text does not have).
  const text = parts.join(" — ").replaceAll("](", "] (");
  void vscode.window.showInformationMessage(text);
};

/**
 * Notifier that always emits the OS notification (osascript) and additionally shows an
 * in-window toast only while `chirin.showInEditorToast` is enabled.
 * The setting is read on every notification. Freezing it at construction time would force
 * rebuilding the Watcher on every settings change, and resetting the source baselines would
 * drop events that had already arrived.
 */
export function buildNotifier(): Notifier {
  return (opts) => {
    const showToast = vscode.workspace
      .getConfiguration("chirin")
      .get<boolean>("showInEditorToast", false);
    const notify = showToast
      ? compositeNotifier(osascriptNotifier, vscodeToastNotifier)
      : osascriptNotifier;
    notify(opts);
  };
}
