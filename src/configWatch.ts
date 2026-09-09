// Deciding when the config file on disk has to be looked at again.
//
// Kept out of extension.ts so it stays free of `vscode` and can be tested against real files
// and real permissions. Both ways of getting this wrong are quiet: revisiting too eagerly
// rebuilds a healthy Watcher and resets the source baselines (dropping the events that arrive
// in the gap), while revisiting too rarely strands the extension in "Config error" after the
// user has already fixed the problem.

import { loadConfig, readConfigText, type Config, type ConfigRead } from "./config.js";
import { errorMessage } from "./log.js";

/** The config is valid. `changed` separates an edit from the repair of an earlier rejection. */
export interface ConfigAccepted {
  kind: "accepted";
  config: Config;
  changed: boolean;
}

/** The config was rejected. `firstReport` is false while the same reason keeps repeating. */
export interface ConfigRejected {
  kind: "rejected";
  error: unknown;
  firstReport: boolean;
}

export type ConfigStatus =
  /** Unchanged, and the running watch already reflects it: nothing to do. */
  | { kind: "unchanged" }
  /** Not readable right now (deleted, or caught mid-rename): keep the current state. */
  | { kind: "unreadable" }
  | ConfigAccepted
  | ConfigRejected;

export class ConfigTracker {
  /** Raw text of the last config read. The baseline for change detection (undefined if never read). */
  private text: string | undefined;
  /**
   * Whether the config the watch is running on was accepted. Tracked separately from the text
   * because a rejection is not always about the bytes: the mode of the file or of its
   * directory can be repaired without the content moving, and comparing text alone would
   * leave that repair undetected forever.
   */
  private accepted = false;
  /** Last rejection reason already reported. Keeps a still-broken config from reporting every poll. */
  private lastError: string | undefined;

  constructor(
    private readonly read: (configPath: string) => ConfigRead = readConfigText,
    private readonly load: (configPath: string) => Config = loadConfig,
  ) {}

  /**
   * Evaluates the config unconditionally (start-up and an explicit reload).
   * An unreadable file is still handed to the loader, so that "there is no config yet" stays
   * distinguishable from "the config is broken".
   */
  loadNow(configPath: string): ConfigAccepted | ConfigRejected {
    const read = this.read(configPath);
    this.text = read.kind === "text" ? read.text : undefined;
    return this.evaluate(configPath, true);
  }

  /** Decides what a config poll should do with the file. */
  check(configPath: string): ConfigStatus {
    const read = this.read(configPath);
    const text = read.kind === "text" ? read.text : undefined;
    const changed = text !== this.text;
    // Unchanged *and* accepted is the only case where nothing needs looking at. A rejection is
    // a verdict rather than a value, so it can never be "unchanged": a poll that saw the file
    // missing leaves no text behind, and the swap that follows would compare equal to it.
    if (read.kind !== "rejected" && !changed && this.accepted) return { kind: "unchanged" };
    this.text = text;
    // Only a transient failure may be waited out. A rejection of the file itself does not
    // move again on its own, so it has to be evaluated and reported: treating it as
    // unreadable would settle into "unchanged" on the next poll and stay silent for good.
    if (read.kind === "unreadable") return { kind: "unreadable" };
    return this.evaluate(configPath, changed);
  }

  private evaluate(configPath: string, changed: boolean): ConfigAccepted | ConfigRejected {
    let config: Config;
    try {
      config = this.load(configPath);
    } catch (error) {
      this.accepted = false;
      const message = errorMessage(error);
      const firstReport = this.lastError !== message;
      this.lastError = message;
      return { kind: "rejected", error, firstReport };
    }
    this.accepted = true;
    this.lastError = undefined;
    return { kind: "accepted", config, changed };
  }
}
