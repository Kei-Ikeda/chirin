// Handlers for the commands invoked from the Command Palette.
// User-facing output goes to the OutputChannel (through log).

import fs from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import {
  ConfigError,
  defaultConfigPath,
  expandHome,
  loadConfig,
  tccProtectedTargets,
  tccWarningMessage,
  type Config,
  type RuleMatch,
} from "./config.js";
import { CONFIG_TEMPLATE } from "./configTemplate.js";
import { expandGlobs } from "./glob.js";
import { mergeHookSettingsText, type HookSettingsExample } from "./hookSettings.js";
import { errorMessage, log } from "./log.js";
import { MESSAGE_MAX_LEN, SUBTITLE_MAX_LEN, TITLE_MAX_LEN } from "./notifier.js";
import { sanitize } from "./sanitize.js";
import { buildNotifier } from "./vscodeNotifier.js";
import { renderTemplate } from "./watcher.js";

/** Workspace-relative path of the hook script we install. Also used for the .gitignore entry. */
const CHIRIN_HOOK_PATH = ".claude/hooks/chirin-notify.sh";

/**
 * Path of the config in use. Falls back to the default when `chirin.configPath` is empty.
 * The setting is `scope: application` (user settings only), so it cannot be overridden from
 * a `.vscode/settings.json` the container can write.
 */
export function resolveConfigPath(): string {
  const configured = vscode.workspace.getConfiguration("chirin").get<string>("configPath") ?? "";
  const trimmed = configured.trim();
  if (trimmed === "") return defaultConfigPath();
  const expanded = expandHome(trimmed);
  // A relative path or a bare `~` resolves against the extension host's cwd ("/" and the
  // like when launched from Finder), creating the config and lock file somewhere
  // unintended. Require an absolute path, as watch patterns do (glob.ts).
  if (!path.isAbsolute(expanded)) {
    throw new ConfigError(`chirin.configPath must be an absolute path (got: ${trimmed})`);
  }
  return expanded;
}

/** Creates config.json from the template and opens it. An existing file is overwritten only after confirmation. */
export async function runInit(): Promise<void> {
  const configPath = resolveConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(configPath)) {
    const OVERWRITE = "Overwrite";
    const overwrite = await vscode.window.showWarningMessage(
      `${configPath} already exists. Overwrite it with the template?`,
      { modal: true },
      OVERWRITE,
    );
    if (overwrite !== OVERWRITE) return;
  }
  fs.writeFileSync(configPath, CONFIG_TEMPLATE, { mode: 0o600 });
  // An overwrite keeps the existing mode, so force 0600 after writing
  fs.chmodSync(configPath, 0o600);
  log.info(`wrote ${configPath} (mode 0600)`);
  await openInEditor(configPath);
  // Offer the next step as a button rather than naming the command. Command titles are
  // localized (package.nls.*.json), so quoting the English title here would name an entry
  // that does not exist in the palette of a non-English VS Code.
  const VALIDATE = "Validate config";
  const choice = await vscode.window.showInformationMessage(
    "chirin: config file created. Edit the watch targets, save, then validate it.",
    VALIDATE,
  );
  if (choice === VALIDATE) await vscode.commands.executeCommand("chirin.validate");
}

/** Opens config.json in the editor. Offers to create it when it does not exist. */
export async function runOpenConfig(): Promise<void> {
  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) {
    const CREATE = "Create";
    const create = await vscode.window.showWarningMessage(
      `No config file: ${configPath}`,
      CREATE,
    );
    if (create === CREATE) {
      await runInit();
      // As with the chirin.init command, restart watching with the config we just created.
      // Without this, first-time setup stalls with "Config error" in the status bar.
      await vscode.commands.executeCommand("chirin.reload");
    }
    return;
  }
  await openInEditor(configPath);
}

async function openInEditor(configPath: string): Promise<void> {
  let document = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
  // The extension stays .json but the content is JSONC. Opening it in the default json mode
  // would flag every comment line in the template as a syntax error, so switch to jsonc.
  // Failing to switch the language mode does not abort opening the config.
  if (document.languageId !== "jsonc") {
    try {
      document = await vscode.languages.setTextDocumentLanguage(document, "jsonc");
    } catch (err) {
      log.warn(`failed to switch language mode to jsonc: ${errorMessage(err)}`);
    }
  }
  await vscode.window.showTextDocument(document);
}

/** Validates the config and lists the expanded watch targets in the OutputChannel. */
export function runValidate(configPath: string): Config {
  const config = loadConfig(configPath);
  log.info(`config ok: ${configPath}`);
  log.info(`defaults: pollIntervalMs=${config.pollIntervalMs} globRefreshMs=${config.globRefreshMs}`);
  const allTargets: string[] = [];
  for (const rule of config.rules) {
    log.info(
      `rule ${rule.id}: source=${rule.sourceKey}, ${describeMatch(rule.match)}, throttleMs=${rule.throttleMs}`,
    );
    for (const pattern of rule.watch) log.info(`  watch: ${sanitize(pattern, 1024)}`);
    const targets = expandGlobs(rule.watch);
    allTargets.push(...targets);
    log.info(`  targets now (${targets.length}):`);
    // An expanded path can contain container-controlled directory names (the `*` segments),
    // so sanitize before printing.
    for (const target of targets) log.info(`    ${sanitize(target, 1024)}`);
  }

  // A TCC-protected location needs a permission granted to VS Code itself. Surface it at
  // configuration time. Several rules can watch the same file, so count per file.
  const tcc = tccProtectedTargets([...new Set(allTargets)]);
  if (tcc.length > 0) {
    log.warn(tccWarningMessage(tcc.length));
    for (const file of tcc) log.warn(`    ${sanitize(file, 1024)}`);
  }
  warnIfConfigInsideWorkspace(configPath);
  return config;
}

/**
 * Warns when the config sits inside a local workspace folder.
 *
 * A workspace can be bind-mounted into the container, so a config inside it is writable from
 * the container even after passing the permission checks (not group/other writable). That
 * breaks the assumption that the config lives somewhere the container cannot tamper with
 * so it is surfaced both at startup and when the config is validated.
 * Because it concerns the trust boundary, it also raises a toast so it is noticed without
 * watching the output panel.
 * A remote workspace URI is a container-side path that cannot be compared against the host
 * config, so only local (file scheme) folders are checked.
 */
export function warnIfConfigInsideWorkspace(configPath: string): void {
  // This is a string comparison, so a path opened through a symlink or with different
  // casing (macOS defaults to a case-insensitive FS) would slip through. Resolve to the real
  // path before comparing.
  const resolvedConfig = realpathOrSelf(configPath);
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== "file") continue;
    if (!isInside(realpathOrSelf(folder.uri.fsPath), resolvedConfig)) continue;
    log.warn(
      `the config is inside the workspace ${folder.uri.fsPath}. ` +
        `A config inside the workspace is writable from the container, ` +
        `so move it outside the workspace, e.g. to ~/.config/chirin/: ${configPath}`,
    );
    void vscode.window.showWarningMessage(
      "chirin: the config is inside the workspace. It is writable from the container, " +
        "so move it outside the workspace, e.g. to ~/.config/chirin/.",
    );
    return;
  }
}

function describeMatch(match: RuleMatch): string {
  switch (match.type) {
    case "any":
      return "any change";
    case "event":
      return `event == "${match.equals}"`;
    case "equals":
      return `${match.field} == "${match.value}"`;
    case "contains":
      return `${match.field} contains "${match.pattern}"`;
    case "regex":
      return `${match.field} =~ /${match.pattern}/`;
  }
}

/**
 * Fires one notification from a dummy event (used to trigger the first permission prompt).
 * It plays a sound even by default and goes through the real path, sound and toast settings
 * included.
 */
export async function runTest(configPath: string): Promise<void> {
  let title = "chirin";
  let subtitle: string | undefined = "test 🔔";
  let message = "test notification";
  let sound: string | undefined = "Pop";

  const choice = await pickRule(configPath);
  if (choice.kind === "cancelled") {
    log.info("test notification cancelled");
    return;
  }
  if (choice.kind === "rule") {
    const { rule } = choice;
    // Provide the full set of variables the real path (watcher.fire) passes. A missing one
    // would render placeholders such as {{file}} literally, making the test notification
    // look different from the real thing.
    const vars = {
      dir: "chirin",
      file: "chirin-notify-state.json",
      event: "Stop",
      message: "test notification",
      count: "1",
      ts: `${Date.now()}-test`,
      cwd: "/work/chirin",
      line: "test notification",
      size: "0",
      mtime: new Date().toISOString(),
    };
    title = sanitize(renderTemplate(rule.title, vars), TITLE_MAX_LEN);
    subtitle =
      rule.subtitle === undefined
        ? undefined
        : sanitize(renderTemplate(rule.subtitle, vars), SUBTITLE_MAX_LEN);
    message = sanitize(renderTemplate(rule.message, vars), MESSAGE_MAX_LEN);
    sound = rule.sound;
  }
  log.info(
    `sending test notification: title="${title}"` +
      `${subtitle === undefined ? "" : ` subtitle="${subtitle}"`}` +
      ` message="${message}"${sound === undefined ? "" : ` sound=${sound}`}`,
  );
  // Use the same Notifier as the real path rather than calling osascript directly. With
  // showInEditorToast enabled, the toast path is exercised too (so a broken path shows up in
  // the test notification).
  buildNotifier()({ title, subtitle, message, sound });
}

/** Result of picking a rule to test. Lets the caller tell "cancelled" apart from "chose the default". */
type TestRuleChoice =
  | { kind: "cancelled" }
  | { kind: "default" }
  | { kind: "rule"; rule: Config["rules"][number] };

/**
 * Asks which rule to test with.
 * Falls back to the default notification when the config cannot be read, so a config error
 * never blocks the test notification itself (confirming notification permission is needed
 * independently of the config).
 */
async function pickRule(configPath: string): Promise<TestRuleChoice> {
  let config: Config;
  try {
    config = loadConfig(configPath);
  } catch {
    return { kind: "default" };
  }
  const DEFAULT_LABEL = "Default test notification";
  const picked = await vscode.window.showQuickPick(
    [
      { label: DEFAULT_LABEL, description: "chirin / test 🔔 / sound=Pop" },
      ...config.rules.map((r) => ({
        label: r.id,
        description: `${r.title}${r.sound === undefined ? "" : ` / sound=${r.sound}`}`,
      })),
    ],
    { placeHolder: "Which rule's notification would you like to try?" },
  );
  // Do nothing when dismissed with Esc. Treating it like choosing the default would fire a
  // notification the user just cancelled.
  if (picked === undefined) return { kind: "cancelled" };
  if (picked.label === DEFAULT_LABEL) return { kind: "default" };
  const rule = config.rules.find((r) => r.id === picked.label);
  return rule === undefined ? { kind: "default" } : { kind: "rule", rule };
}

/**
 * Installs the Claude Code hook into the workspace.
 *
 * A UI extension cannot write remote (in-container) files through Node's fs, so this goes
 * through URI-based workspace.fs. workspace.fs has no chmod and cannot mark
 * chirin-notify.sh executable, so the hook is invoked as `bash <path>`
 * (settings.example.json uses the same form).
 */
export async function runInstallHook(
  context: vscode.ExtensionContext,
  configPath: string,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showErrorMessage("chirin: no workspace is open.");
    return;
  }
  // In a multi-root workspace the destination is ambiguous, so ask (Esc does nothing)
  const folder =
    folders.length === 1
      ? folders[0]!
      : await vscode.window.showWorkspaceFolderPick({
          placeHolder: "Choose the workspace folder to install the hook into",
        });
  if (folder === undefined) return;
  const claudeDir = vscode.Uri.joinPath(folder.uri, ".claude");

  const installed = await installNotifyScript(context, claudeDir);
  if (!installed) {
    // When the overwrite was declined, no hook has been registered at all. Ending silently
    // would read as "installed", so say that nothing was changed.
    void vscode.window.showWarningMessage(
      "chirin: chirin-notify.sh was not updated, so the hooks settings were left unchanged.",
    );
    return;
  }
  const merged = await mergeHookSettings(context, claudeDir);
  await appendGitignoreEntries(folder.uri);
  await warnIfProbablyNotWatched(folder, configPath);

  // mergeHookSettings already explains the case where merging failed
  if (!merged) return;
  void vscode.window.showInformationMessage(
    "chirin: the hook is installed. Reopen the Claude Code session to activate it.",
  );
}

/** Places chirin-notify.sh. If an existing file differs, offers a diff before confirming the overwrite. */
async function installNotifyScript(
  context: vscode.ExtensionContext,
  claudeDir: vscode.Uri,
): Promise<boolean> {
  const source = vscode.Uri.joinPath(context.extensionUri, "hooks", "chirin-notify.sh");
  const target = vscode.Uri.joinPath(claudeDir, "hooks", "chirin-notify.sh");
  const bytes = await vscode.workspace.fs.readFile(source);

  const existing = await readFileIfExists(target);
  if (existing !== null) {
    if (Buffer.from(existing).equals(Buffer.from(bytes))) return true;
    const OVERWRITE = "Overwrite";
    const SHOW_DIFF = "Show diff";
    const choice = await vscode.window.showWarningMessage(
      ".claude/hooks/chirin-notify.sh already exists and differs from the one bundled with the extension.",
      { modal: true },
      OVERWRITE,
      SHOW_DIFF,
    );
    if (choice === SHOW_DIFF) {
      await vscode.commands.executeCommand("vscode.diff", target, source, "chirin-notify.sh (current ↔ bundled)");
      return false;
    }
    if (choice !== OVERWRITE) return false;
  }
  await vscode.workspace.fs.writeFile(target, bytes);
  return true;
}

/**
 * Merges the hooks from settings.example.json into .claude/settings.local.json. Returns true
 * when the merge succeeded.
 *
 * It writes to the personal, local `.claude/settings.local.json` rather than the shared
 * `.claude/settings.json` because this hook only means anything in the installer's own
 * environment: a macOS host, with chirin installed, whose config watches this repository.
 * Writing to the shared file would put a personal difference into a committed file and ship
 * a hook that does not work to teammates on other operating systems.
 *
 * Only the file I/O lives here; which existing hooks survive the merge is decided by
 * hookSettings.ts, which is free of `vscode` so that decision can be tested.
 */
async function mergeHookSettings(
  context: vscode.ExtensionContext,
  claudeDir: vscode.Uri,
): Promise<boolean> {
  const exampleUri = vscode.Uri.joinPath(context.extensionUri, "hooks", "settings.example.json");
  const example = JSON.parse(
    Buffer.from(await vscode.workspace.fs.readFile(exampleUri)).toString("utf8"),
  ) as HookSettingsExample;

  const target = vscode.Uri.joinPath(claudeDir, "settings.local.json");
  const existingRaw = await readFileIfExists(target);
  const existing = existingRaw === null ? null : Buffer.from(existingRaw).toString("utf8");
  const merged = mergeHookSettingsText(existing, example);
  if (merged.kind !== "ok") {
    // Content we cannot merge mechanically is left untouched and handed back to the user
    void vscode.window.showWarningMessage(mergeFailureMessage(merged.kind));
    return false;
  }
  await vscode.workspace.fs.writeFile(target, Buffer.from(merged.text, "utf8"));
  return true;
}

/** Explains why the hooks settings were left unchanged (one message per unmergeable shape). */
function mergeFailureMessage(kind: "unparsable" | "not-object" | "hooks-not-object"): string {
  switch (kind) {
    case "unparsable":
      return ".claude/settings.local.json could not be parsed, so the hooks settings were left unchanged. Please merge them manually.";
    case "not-object":
      return ".claude/settings.local.json is not a JSON object, so the hooks settings were left unchanged. Please merge them manually.";
    case "hooks-not-object":
      return "hooks in .claude/settings.local.json is not a JSON object, so the settings were left unchanged. Please merge them manually.";
  }
}

/** Appends the files chirin writes into the workspace to .gitignore (never duplicating an existing line). */
async function appendGitignoreEntries(folderUri: vscode.Uri): Promise<void> {
  // Limited to the files chirin itself writes. settings.local.json belongs to Claude Code,
  // and whether to track it is the project's decision.
  //
  // The hook script is included for the same reason its registration goes into
  // settings.local.json rather than the shared settings.json: it only means anything in the
  // installer's own environment (a macOS host running chirin whose config watches this
  // repository), so committing it would ship a file that is inert for everyone else. It also
  // changes between chirin releases, and tracking it would put a diff in every user's
  // repository each time they re-run this command to pick the update up.
  // Reuse CHIRIN_HOOK_PATH so the ignored path cannot drift from the installed one.
  const entries = [
    CHIRIN_HOOK_PATH,
    ".claude/chirin-notify-state.json",
    ".claude/.chirin-notify-tmp-*",
  ];
  const target = vscode.Uri.joinPath(folderUri, ".gitignore");
  const existingRaw = await readFileIfExists(target);
  const existing = existingRaw === null ? "" : Buffer.from(existingRaw).toString("utf8");
  const lines = existing.split("\n").map((line) => line.trim());
  const missing = entries.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return;

  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
  const block = `${prefix}\n# chirin\n${missing.join("\n")}\n`;
  await vscode.workspace.fs.writeFile(target, Buffer.from(existing + block, "utf8"));
}

/**
 * Checks whether this workspace is covered by the watch patterns in the host-side config.
 *
 * Local windows only. In a remote window (devcontainer / SSH) the workspace URI is a
 * container-side path with no way to resolve it to the host's real path. The workspace name
 * also becomes the basename of the mount point (`workspace`, say) and never matches a host
 * path, so a correct configuration would still always warn.
 */
async function warnIfProbablyNotWatched(
  folder: vscode.WorkspaceFolder,
  configPath: string,
): Promise<void> {
  if (vscode.env.remoteName !== undefined) {
    log.debug(
      "skipped the watch target check: remote workspace paths cannot be mapped to host paths",
    );
    return;
  }
  let config: Config;
  try {
    config = loadConfig(configPath);
  } catch {
    return; // a missing or broken config is surfaced through another path (the validate command)
  }
  const patterns = config.rules.flatMap((rule) => rule.watch);
  const targets = expandGlobs(patterns);
  const watched = targets.some((target) => isInside(folder.uri.fsPath, target));
  if (watched) return;

  const OPEN_CONFIG = "Open config";
  const choice = await vscode.window.showWarningMessage(
    `No watch target was found under "${folder.uri.fsPath}". ` +
      `Check the watch patterns in the config.`,
    OPEN_CONFIG,
  );
  if (choice === OPEN_CONFIG) await runOpenConfig();
}

/** Resolves to the real path (absorbing symlinks and case differences). Returns the input unchanged when it cannot be resolved. */
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** Whether target is a path under dir (dir itself excluded). */
function isInside(dir: string, target: string): boolean {
  const relative = path.relative(dir, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Reads a file. Returns null only when it does not exist.
 *
 * Returning null for a read failure too (permissions, a transient remote FS fault) would let
 * the caller read it as "the file is absent" and overwrite the existing content wholesale.
 * Failures we cannot classify are rethrown and left to the command's error display.
 */
async function readFileIfExists(uri: vscode.Uri): Promise<Uint8Array | null> {
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch (err) {
    if (err instanceof vscode.FileSystemError && err.code === "FileNotFound") return null;
    throw err;
  }
}
