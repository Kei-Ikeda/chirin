import { execFile } from "node:child_process";
import { errorMessage, log } from "./log.js";
import { sanitize } from "./sanitize.js";

export interface NotifyOptions {
  title: string;
  /** Second line of a macOS notification: a short heading shown between title (who) and message (details). */
  subtitle?: string | undefined;
  message: string;
  sound?: string | undefined;
}

// Kept as an interface so it can later be swapped for alerter / terminal-notifier and the like
export type Notifier = (opts: NotifyOptions) => void;

export const TITLE_MAX_LEN = 60;
export const SUBTITLE_MAX_LEN = 60;
export const MESSAGE_MAX_LEN = 120;
export const SOUND_PATTERN = /^[A-Za-z ]{1,30}$/;

// Pinned to an absolute path so it does not depend on the PATH of the runtime (the VS Code extension host)
const OSASCRIPT_BIN = "/usr/bin/osascript";

// The AppleScript body is a constant; data is passed only through argv (AppleScript injection
// mitigation - building the script by string concatenation is forbidden).
// There are always four arguments (message / title / subtitle / sound); pass an empty string
// for anything to be omitted. Passing an empty string straight through as the subtitle or
// sound name makes display and playback undefined, so branch on emptiness explicitly.
const NOTIFY_SCRIPT = [
  "on run argv",
  "  set msg to item 1 of argv",
  "  set ttl to item 2 of argv",
  "  set sub to item 3 of argv",
  "  set snd to item 4 of argv",
  "  if snd is \"\" then",
  "    if sub is \"\" then",
  "      display notification msg with title ttl",
  "    else",
  "      display notification msg with title ttl subtitle sub",
  "    end if",
  "  else",
  "    if sub is \"\" then",
  "      display notification msg with title ttl sound name snd",
  "    else",
  "      display notification msg with title ttl subtitle sub sound name snd",
  "    end if",
  "  end if",
  "end run",
].join("\n");

export const osascriptNotifier: Notifier = (opts) => {
  // Callers are expected to have sanitized already, but reapply defensively here
  const title = sanitize(opts.title, TITLE_MAX_LEN);
  const subtitle = sanitize(opts.subtitle ?? "", SUBTITLE_MAX_LEN);
  const message = sanitize(opts.message, MESSAGE_MAX_LEN);
  const sound = opts.sound !== undefined && SOUND_PATTERN.test(opts.sound) ? opts.sound : "";
  if (process.platform !== "darwin") {
    log.warn("osascript notifier is only available on macOS; skipping notification");
    return;
  }
  // "--" ends osascript's own option parsing so the data is always delivered as run argv
  // arguments. Without it, an untrusted message starting with "-" could be reinterpreted by
  // getopt as another option (a second -e, say) and execute code on the host.
  const args = ["-e", NOTIFY_SCRIPT, "--", message, title, subtitle, sound];
  execFile(OSASCRIPT_BIN, args, { timeout: 5000 }, (err) => {
    if (err) log.warn(`osascript failed: ${errorMessage(err)}`);
  });
};

/**
 * Fans the same notification out to several Notifiers.
 * Used when an in-window VS Code toast should accompany the OS notification (osascript).
 * A throw from one does not stop delivery to the rest (notification paths are independent).
 */
export function compositeNotifier(...notifiers: readonly Notifier[]): Notifier {
  return (opts) => {
    for (const notify of notifiers) {
      try {
        notify(opts);
      } catch (err) {
        log.warn(`notifier failed: ${errorMessage(err)}`);
      }
    }
  };
}
