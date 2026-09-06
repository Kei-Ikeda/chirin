// Extension entry point.
//
// This runs as a UI extension (extensionKind: ["ui"] in package.json). Even with a
// devcontainer open, the extension host lives on the host macOS side, so it can call
// osascript and read the host's real paths through fs.
// Running in that position is what makes chirin's threat model (the container is untrusted)
// hold together.

import path from "node:path";
import * as vscode from "vscode";
import {
  resolveConfigPath,
  runInit,
  runInstallHook,
  runOpenConfig,
  runTest,
  runValidate,
  warnIfConfigInsideWorkspace,
} from "./commands.js";
import {
  ConfigError,
  ConfigNotFoundError,
  loadConfig,
  readConfigText,
  type Config,
} from "./config.js";
import { LeaderElection, defaultLockPath } from "./leader.js";
import { errorMessage, log, resetLogSink, setLogSink } from "./log.js";
import { outputChannelFilter, outputChannelSink } from "./vscodeLog.js";
import { buildNotifier } from "./vscodeNotifier.js";
import { Watcher } from "./watcher.js";

/**
 * Heartbeat interval for leader election. Deliberately independent of the config's
 * pollIntervalMs. The lock freshness check measures against the reader's own heartbeatMs, so
 * a fixed value keeps every window in agreement even when their configs differ. Tying it to
 * the lower bound of pollIntervalMs (200ms) would also shrink the stale threshold to one
 * second, letting a stall in synchronous I/O (poll/glob) alone cost a live leader its lock.
 */
const LEADER_HEARTBEAT_MS = 1000;

/**
 * How often changes to the config file are picked up. Polling rather than FS events for the
 * same reason as the watched files (see the README's Design notes): detection must not be missed even when the
 * config lives on another volume.
 * Config changes are rare, so this can be coarser than the notification pollIntervalMs.
 */
const CONFIG_POLL_MS = 2000;

let controller: ChirinController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("chirin", { log: true });
  context.subscriptions.push(channel);
  setLogSink(outputChannelSink(channel), outputChannelFilter(channel));

  controller = new ChirinController(context);
  context.subscriptions.push(controller);

  // Always register the commands, even with a broken config; otherwise there is no path to fixing it.
  registerCommands(context, controller, channel);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      // reload rebuilds the Watcher, and resetting the source baselines drops events that
      // already arrived. Limit it to settings that change the watch configuration
      // (showInEditorToast is read on every notification, so it needs no rebuild).
      if (
        event.affectsConfiguration("chirin.enabled") ||
        event.affectsConfiguration("chirin.configPath")
      ) {
        controller?.reload();
      }
    }),
  );

  controller.start();
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
  // The OutputChannel is already disposed, so restore the default destination rather than holding on to it
  resetLogSink();
}

function registerCommands(
  context: vscode.ExtensionContext,
  target: ChirinController,
  channel: vscode.OutputChannel,
): void {
  const commands: Record<string, () => void | Promise<void>> = {
    "chirin.init": async () => {
      await runInit();
      target.reload();
    },
    "chirin.openConfig": runOpenConfig,
    "chirin.validate": () => {
      channel.show(true);
      const config = runValidate(resolveConfigPath());
      void vscode.window.showInformationMessage(
        `chirin: the config is valid (${config.rules.length} rule(s)). See the output panel for details.`,
      );
    },
    "chirin.test": () => runTest(resolveConfigPath()),
    "chirin.reload": () => target.reload(),
    "chirin.toggle": () => target.toggleEnabled(),
    "chirin.showLog": () => channel.show(),
    "chirin.installHook": () => runInstallHook(context, resolveConfigPath()),
    "chirin.openWalkthrough": () => openWalkthrough(context),
  };

  for (const [id, handler] of Object.entries(commands)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          await handler();
        } catch (err) {
          await reportError(err);
        }
      }),
    );
  }
}

/** Errors are surfaced through three paths - notification, OutputChannel and status bar - so watching any one of them is enough to notice. */
async function reportError(err: unknown): Promise<void> {
  const message = errorMessage(err);
  log.error(message);
  if (err instanceof ConfigError) {
    const OPEN_CONFIG = "Open config";
    const choice = await vscode.window.showErrorMessage(
      `chirin: config error - ${message}`,
      OPEN_CONFIG,
    );
    if (choice === OPEN_CONFIG) await vscode.commands.executeCommand("chirin.openConfig");
    return;
  }
  void vscode.window.showErrorMessage(`chirin: ${message}`);
}

/**
 * Opens the setup walkthrough. A walkthrough id has the form `<publisher>.<name>#<id>`, and
 * is assembled from context.extension.id so that changing the publisher does not break it.
 */
async function openWalkthrough(context: vscode.ExtensionContext): Promise<void> {
  await vscode.commands.executeCommand(
    "workbench.action.openWalkthrough",
    `${context.extension.id}#setup`,
    false,
  );
}

/**
 * Guidance for a first run with no config yet. A missing config is not a fault, so it is
 * presented as the entrance to setup rather than as an error.
 */
async function promptInitialSetup(): Promise<void> {
  const OPEN_WALKTHROUGH = "Open setup";
  const CREATE_CONFIG = "Create config file";
  const choice = await vscode.window.showInformationMessage(
    "chirin: there is no config file yet. Start the setup?",
    OPEN_WALKTHROUGH,
    CREATE_CONFIG,
  );
  if (choice === OPEN_WALKTHROUGH) {
    await vscode.commands.executeCommand("chirin.openWalkthrough");
  } else if (choice === CREATE_CONFIG) {
    await vscode.commands.executeCommand("chirin.init");
  }
}

type State =
  | "leading"
  | "electing"
  | "following"
  | "stalled"
  | "disabled"
  | "unconfigured"
  | "error";

/**
 * Tooltip for a follower. The label matches the leader's, so this is the only place that
 * says "this window is not watching". It states outright that nothing needs fixing, so a
 * user on the non-watching side does not mistake it for a fault.
 */
const FOLLOWING_DETAIL =
  "Another window is watching, so notifications still reach you. " +
  "Only one window watches at a time to avoid duplicate notifications — nothing to fix here.";

/**
 * Lock operations have failed repeatedly and we cannot tell whether any window is watching.
 * Notifications may have stopped silently, so this must not look like the healthy state.
 */
const STALLED_DETAIL =
  "Cannot tell whether any window is watching: the watcher lock could not be read. " +
  "Notifications may be stopped. See the log for details.";

/** Ties together config loading, leader election, starting/stopping the Watcher, and the status display. */
class ChirinController implements vscode.Disposable {
  private readonly statusBar: vscode.StatusBarItem;
  private watcher: Watcher | undefined;
  private election: LeaderElection | undefined;
  private state: State = "disabled";
  private detail = "";
  /** Raw text of the last config read. The baseline for change detection (undefined if never read). */
  private configText: string | undefined;
  private configPollTimer: NodeJS.Timeout | undefined;
  /** Path we already warned about for living inside the workspace. Prevents repeating the warning for the same misconfiguration. */
  private warnedWorkspaceConfig: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
    // Placeholder until the first render(). After that, render() swaps it per state.
    this.statusBar.command = "chirin.showLog";
    this.context.subscriptions.push(this.statusBar);
    this.statusBar.show();
  }

  start(): void {
    const settings = vscode.workspace.getConfiguration("chirin");
    if (!settings.get<boolean>("enabled", true)) {
      this.setState("disabled", "Watching is turned off (chirin.enabled is false).");
      return;
    }

    let configPath: string | undefined;
    let config: Config;
    try {
      // resolveConfigPath can throw during validation (an absolute path is required), so it
      // is inside the try.
      // Startup only loads. Listing the watch targets is the job of `chirin: Validate config`
      // (with many targets it would bury the log on every startup).
      configPath = resolveConfigPath();
      // Take the change-detection baseline before loadConfig. If the file changes right
      // after we read it, that shows up as a diff on the next tick, so at worst one extra
      // reload runs and nothing is missed.
      this.configText = readConfigText(configPath);
      config = loadConfig(configPath);
    } catch (err) {
      // Keep change detection running even with a broken or missing config, so saving a fix
      // recovers automatically (if configPath could not be resolved there is nothing to watch).
      if (configPath !== undefined) this.startConfigPolling(configPath);
      // On a first run, a missing config is a normal waypoint. Presenting it as an error
      // would read as "broken" to a newcomer, so route it into the setup flow instead.
      if (err instanceof ConfigNotFoundError) {
        this.setState("unconfigured", "No config file yet.");
        void promptInitialSetup();
        return;
      }
      // Never fail activate. Keep the path to fixing the config open and surface the error through all three channels.
      this.setState("error", errorMessage(err));
      void reportError(err);
      return;
    }

    this.startConfigPolling(configPath);

    // A config placed inside the workspace (i.e. somewhere the container can write) breaks
    // the trust boundary, so warn before watching starts (without refusing: noticing the
    // misconfiguration beats having notifications stop).
    // The warning also raises a toast, but it targets a static misconfiguration - where the
    // file lives. Since a reload now runs on every config save, emit it only once per path.
    if (this.warnedWorkspaceConfig !== configPath) {
      this.warnedWorkspaceConfig = configPath;
      warnIfConfigInsideWorkspace(configPath);
    }

    // The lock lives in the same directory as the config. Windows pointing at a different
    // config use a different lock and run independently (different settings mean different
    // notifications are wanted).
    const lockPath = defaultLockPath(path.dirname(configPath));
    this.election = new LeaderElection(lockPath, LEADER_HEARTBEAT_MS, {
      onAcquire: () => {
        try {
          // Rebuild the Watcher on every promotion. Sources hold the previous value per
          // file, so reusing one would let the re-promoted window detect again a change
          // another window already notified about while it was demoted, producing a
          // duplicate (throttling is time-based and cannot suppress it across a gap).
          const watcher = new Watcher(config, buildNotifier());
          this.watcher = watcher;
          watcher.start();
          const targets = watcher.targetCount();
          log.info(
            `watching ${targets} target(s), ${config.rules.length} rule(s), poll=${config.pollIntervalMs}ms`,
          );
          this.setState("leading", `This window is watching ${targets} file(s).`);
        } catch (err) {
          // When promotion fails the election drops the lock and calls onRelease, which
          // would display "another window is watching" even though nobody is. Surface it as
          // an error through all three channels (without re-notifying on every retry).
          if (this.state !== "error") void reportError(err);
          this.setState("error", errorMessage(err));
          throw err;
        }
      },
      onRelease: () => {
        this.watcher?.stop();
        this.watcher = undefined;
        // Do not let the onRelease right after a failed promotion overwrite the error display
        if (this.state !== "error") this.setState("following", FOLLOWING_DETAIL);
      },
      onFollow: () => {
        // The only way a window that never became leader learns that another one is
        // watching. Without it, a window that lost at startup looks stuck in electing.
        // Does not overwrite an error display (the cause stays visible).
        if (this.state !== "error") this.setState("following", FOLLOWING_DETAIL);
      },
      onStalled: () => {
        // A config error pinpoints the cause better, so do not overwrite it
        if (this.state !== "error") this.setState("stalled", STALLED_DETAIL);
      },
    });
    this.setState("electing", "Deciding which window will watch.");
    this.election.start();
  }

  stop(): void {
    if (this.configPollTimer !== undefined) clearInterval(this.configPollTimer);
    this.configPollTimer = undefined;
    // election.stop() releases our leadership and stops the watcher through onRelease
    this.election?.stop();
    this.election = undefined;
    this.watcher?.stop();
    this.watcher = undefined;
  }

  /**
   * Watches the config file's content for changes. Runs in **every window**, not just the
   * leader: restricting it to the leader would let a promoted follower keep using the stale
   * config it read at start(), making the outcome depend on which window did the editing.
   */
  private startConfigPolling(configPath: string): void {
    // Do not re-arm the timer if called twice (the previous timer would lose its reference and become unstoppable).
    if (this.configPollTimer !== undefined) return;
    this.configPollTimer = setInterval(() => {
      try {
        this.applyConfigChange(configPath);
      } catch (err) {
        // A failure in change detection must not stop watching
        log.error(`config poll failed: ${errorMessage(err)}`);
      }
    }, CONFIG_POLL_MS);
    // Do not hold the extension host open
    this.configPollTimer.unref?.();
  }

  /** If the config changed, rebuild the watch only when it passes validation. */
  private applyConfigChange(configPath: string): void {
    const text = readConfigText(configPath);
    if (text === this.configText) return;
    // Remember rejected content as the baseline too; otherwise the same content would warn
    // on every tick. Once the user fixes and saves, the content changes again and is
    // re-evaluated.
    this.configText = text;
    // If it became unreadable (deleted, or mid-rename), keep the current state and pick it up when it reappears.
    if (text === undefined) return;
    try {
      loadConfig(configPath);
    } catch (err) {
      // We can catch broken content mid-save, so validate before switching. This is not
      // triggered by a user action, so no popup: keep watching with the old config and make
      // it noticeable through the log and the status bar (an explicit reload still uses all
      // three channels).
      log.warn(`config change rejected, keeping the previous config: ${errorMessage(err)}`);
      this.setState("error", `${errorMessage(err)} (keeping the previous config)`);
      return;
    }
    log.info("config changed on disk; reloading");
    this.reload();
  }

  reload(): void {
    this.stop();
    this.start();
  }

  /** Flips `chirin.enabled`. The settings change triggers a reload through onDidChangeConfiguration. */
  async toggleEnabled(): Promise<void> {
    const settings = vscode.workspace.getConfiguration("chirin");
    const next = !settings.get<boolean>("enabled", true);
    // The setting has scope: application, so updates always land in the user settings (Global)
    await settings.update("enabled", next, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
      `chirin: watching ${next ? "started" : "stopped"}.`,
    );
  }

  dispose(): void {
    this.stop();
  }

  private setState(state: State, detail: string): void {
    // onFollow arrives on every tick while we stay a follower. With no change, skip both the render and the debug log.
    if (this.state === state && this.detail === detail) return;
    this.state = state;
    this.detail = detail;
    this.render();
  }

  private render(): void {
    const icons: Record<State, string> = {
      leading: "$(bell)",
      electing: "$(sync~spin)",
      following: "$(bell)",
      stalled: "$(alert)",
      disabled: "$(bell-slash)",
      unconfigured: "$(gear)",
      error: "$(alert)",
    };
    // While watching healthily, show just "chirin" with no state. Which window is watching
    // makes no difference to the user (notifications go to the whole OS), and separate
    // labels would make the non-watching side look broken. The tooltip explains which is
    // which. Spell out a state only when the user has to do something, so it stands out.
    const labels: Record<State, string> = {
      leading: "chirin",
      electing: "chirin: Electing",
      following: "chirin",
      stalled: "chirin: Unknown",
      disabled: "chirin: Disabled",
      unconfigured: "chirin: Not configured",
      error: "chirin: Config error",
    };
    // Point the click at the "next thing to do" for each state. Always opening the log
    // would leave the Command Palette as the only way back from stopped or unconfigured,
    // stalling first-time setup.
    const clickCommands: Record<State, string> = {
      leading: "chirin.showLog",
      electing: "chirin.showLog",
      following: "chirin.showLog",
      stalled: "chirin.showLog",
      disabled: "chirin.toggle",
      unconfigured: "chirin.openWalkthrough",
      error: "chirin.openConfig",
    };
    const clickHints: Record<State, string> = {
      leading: "Click to show the log.",
      electing: "Click to show the log.",
      following: "Click to show the log.",
      stalled: "Click to show the log.",
      disabled: "Click to resume watching.",
      unconfigured: "Click to open the setup walkthrough.",
      error: "Click to open the config file.",
    };
    this.statusBar.text = `${icons[this.state]} ${labels[this.state]}`;
    this.statusBar.tooltip = `chirin — ${this.detail}\n${clickHints[this.state]}`;
    this.statusBar.command = clickCommands[this.state];
    // Only states where notifications stay undelivered until the user acts get a background color.
    this.statusBar.backgroundColor =
      this.state === "error" || this.state === "stalled"
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
    log.debug(`state=${this.state} (${this.detail})`);
  }
}
