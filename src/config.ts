import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateGlobPattern } from "./glob.js";
import { stripJsonComments } from "./jsonc.js";
import { errorMessage } from "./log.js";
import { SOUND_PATTERN } from "./notifier.js";
import {
  DEFAULT_LOG_WINDOW_BYTES,
  FIELD_NAME_PATTERN,
  MAX_LOG_WINDOW_BYTES,
  MIN_LOG_WINDOW_BYTES,
  defaultFieldFor,
  sourceKey,
  type SourceConfig,
} from "./sources.js";

/** Config-originated error. activate never fails on it; it is surfaced through three paths (notification / output panel / status bar). */
export class ConfigError extends Error {}

/**
 * The config file does not exist yet. During first-time setup this is a normal waypoint
 * rather than a fault, so it is distinguished from a "broken config" and lets callers offer
 * a path to creating one.
 */
export class ConfigNotFoundError extends ConfigError {}

/**
 * Name of the field a rule matches on. Sources expose arbitrary per-source-type fields,
 * so only the shape of the name is validated, not a fixed enumeration.
 */
export type MatchField = string;

export type RuleMatch =
  /** Always matches (for notifying on "something changed" without inspecting the content) */
  | { type: "any" }
  | { type: "event"; equals: string }
  | { type: "equals"; field: MatchField; value: string }
  | { type: "contains"; field: MatchField; pattern: string }
  | { type: "regex"; field: MatchField; pattern: string; regex: RegExp };

export interface Rule {
  id: string;
  /** Absolute path patterns, already ~-expanded. */
  watch: string[];
  source: SourceConfig;
  /** Key used to share a source between rules with identical source settings. */
  sourceKey: string;
  match: RuleMatch;
  /** Template for the notification title. */
  title: string;
  /** Template for the notification subtitle (second line). Optional. */
  subtitle?: string | undefined;
  /** Template for the notification body. */
  message: string;
  sound?: string | undefined;
  throttleMs: number;
}

export interface Config {
  pollIntervalMs: number;
  globRefreshMs: number;
  rules: Rule[];
}

const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_EQUALS_LEN = 64;
const MAX_PATTERN_LEN = 256;
const SOURCE_TYPES: readonly string[] = ["json-state", "log-lines", "file-meta"];
// Default used when a rule omits notify.title. Shows the tool name
// (rules for Claude Code set "Claude Code" explicitly in the config template).
const DEFAULT_TITLE = "chirin";

// Cap on the length of a match target. A runtime limit that curbs ReDoS backtracking blowup,
// shared with the truncation on the watcher side (referenced here as a cap as well, so a
// pattern accepted by the config cannot be silently truncated at runtime into one that
// "never matches").
export const MAX_MATCH_TARGET_LEN = 200;

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".config", "chirin", "config.json");
}

export function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * Returns the watch targets that live under a TCC-protected directory (Transparency,
 * Consent, and Control). Reading them requires a permission granted to VS Code itself
 * (Full Disk Access and similar); without it the read **fails silently**. General-purpose
 * file watching runs into this easily, so we warn at startup and on validate.
 */
export function tccProtectedTargets(files: readonly string[]): string[] {
  const home = os.homedir();
  const protectedRoots = ["Desktop", "Documents", "Downloads"].map((d) => path.join(home, d));
  return files.filter((file) =>
    protectedRoots.some((root) => file === root || file.startsWith(root + path.sep)),
  );
}

/** Warning text emitted when TCC-protected targets are found (wording shared by validate and Watcher startup). */
export function tccWarningMessage(count: number): string {
  return (
    `${count} watch target(s) are under TCC-protected directories ` +
    `(~/Desktop, ~/Documents, ~/Downloads). ` +
    `Reading them requires granting VS Code itself a permission such as Full Disk Access. ` +
    `If you would rather not grant it, move the targets to an unprotected directory such as ~/src.`
  );
}

export function loadConfig(configPath: string): Config {
  checkConfigFile(configPath);
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read config ${configPath}: ${errorMessage(err)}`);
  }
  let data: unknown;
  try {
    // The config may be JSON with comments (JSONC), so that the template can carry
    // descriptions of each setting and commented-out examples inside the file itself.
    data = JSON.parse(stripJsonComments(raw));
  } catch (err) {
    throw new ConfigError(`config is not valid JSON: ${errorMessage(err)}`);
  }
  return validateConfig(data);
}

/**
 * Returns the raw config text, or undefined if it cannot be read.
 *
 * This is used solely to decide whether the content changed since last time; it performs
 * neither permission checks nor JSON parsing (that is loadConfig's job). Comparing content
 * rather than mtime matters because rebuilding the Watcher on a save that changed nothing
 * would reset the source baselines and drop events that arrive in that gap.
 */
export function readConfigText(configPath: string): string | undefined {
  try {
    return fs.readFileSync(configPath, "utf8");
  } catch {
    return undefined;
  }
}

// The config is assumed to live somewhere the container cannot tamper with (outside the
// workspace). Require a regular file (no symlinks) that is not group/other writable.
// The parent directory must not be group/other writable either: even a hardened file can be
// swapped wholesale when its directory is writable.
function checkConfigFile(configPath: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(configPath);
  } catch {
    // Do not name a command title here: titles are localized, and both paths that surface
    // this error already offer the action as a button (promptInitialSetup / reportError).
    throw new ConfigNotFoundError(`config not found: ${configPath}`);
  }
  if (!st.isFile()) {
    throw new ConfigError(`config must be a regular file (not a symlink or directory): ${configPath}`);
  }
  if ((st.mode & 0o022) !== 0) {
    throw new ConfigError(
      `config must not be writable by group/other: ${configPath} (fix with: chmod 600 ${configPath})`,
    );
  }
  const dir = path.dirname(configPath);
  let dst: fs.Stats;
  try {
    dst = fs.statSync(dir); // follow symlinks so the real directory's permissions are checked
  } catch (err) {
    throw new ConfigError(`cannot stat config directory ${dir}: ${errorMessage(err)}`);
  }
  if ((dst.mode & 0o022) !== 0) {
    throw new ConfigError(
      `config directory must not be writable by group/other: ${dir} (fix with: chmod 700 ${dir})`,
    );
  }
  // The leader lock is created next to the config (defaultLockPath), so a directory this
  // process cannot write leaves every window failing to elect a leader. Rejecting it here
  // turns a silent stall into a reason: the config itself loads fine, and the only other
  // signal is a stalled election three heartbeats later.
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw new ConfigError(
      `config directory must be writable by the current user (it holds the watcher lock): ${dir}`,
    );
  }
}

export function validateConfig(data: unknown): Config {
  if (!isPlainObject(data)) throw new ConfigError("config root must be an object");
  const defaults = data.defaults ?? {};
  if (!isPlainObject(defaults)) throw new ConfigError("defaults must be an object");
  const pollIntervalMs = intOrDefault(defaults.pollIntervalMs, 1000, 200, "defaults.pollIntervalMs");
  const globRefreshMs = intOrDefault(defaults.globRefreshMs, 30000, 5000, "defaults.globRefreshMs");
  const defaultThrottleMs = intOrDefault(defaults.throttleMs, 5000, 0, "defaults.throttleMs");

  const rulesRaw = data.rules;
  if (!Array.isArray(rulesRaw) || rulesRaw.length === 0) {
    throw new ConfigError("rules must be a non-empty array");
  }
  const seenIds = new Set<string>();
  const rules = rulesRaw.map((rule, i) => validateRule(rule, i, defaultThrottleMs, seenIds));
  return { pollIntervalMs, globRefreshMs, rules };
}

function validateRule(
  raw: unknown,
  index: number,
  defaultThrottleMs: number,
  seenIds: Set<string>,
): Rule {
  const where = `rules[${index}]`;
  if (!isPlainObject(raw)) throw new ConfigError(`${where} must be an object`);

  const id = raw.id;
  if (typeof id !== "string" || !RULE_ID_PATTERN.test(id)) {
    throw new ConfigError(`${where}.id must match ${RULE_ID_PATTERN}`);
  }
  if (seenIds.has(id)) throw new ConfigError(`duplicate rule id: ${id}`);
  seenIds.add(id);

  const watchRaw = raw.watch;
  if (!Array.isArray(watchRaw) || watchRaw.length === 0) {
    throw new ConfigError(`${where}.watch must be a non-empty array of strings`);
  }
  const watch = watchRaw.map((pattern, j) => {
    if (typeof pattern !== "string" || pattern === "") {
      throw new ConfigError(`${where}.watch[${j}] must be a non-empty string`);
    }
    const expanded = expandHome(pattern);
    const problem = validateGlobPattern(expanded);
    if (problem !== null) throw new ConfigError(`${where}.watch[${j}] (${pattern}): ${problem}`);
    return expanded;
  });

  const source = validateSource(raw.source, `${where}.source`);
  const match = validateMatch(raw.match, `${where}.match`, source);

  const notify = raw.notify;
  if (!isPlainObject(notify)) throw new ConfigError(`${where}.notify must be an object`);
  const title =
    notify.title === undefined ? DEFAULT_TITLE : requireString(notify.title, `${where}.notify.title`);
  const subtitle =
    notify.subtitle === undefined
      ? undefined
      : requireString(notify.subtitle, `${where}.notify.subtitle`);
  const message = requireString(notify.message, `${where}.notify.message`);
  let sound: string | undefined;
  if (notify.sound !== undefined) {
    if (typeof notify.sound !== "string" || !SOUND_PATTERN.test(notify.sound)) {
      throw new ConfigError(`${where}.notify.sound must match ${SOUND_PATTERN}`);
    }
    sound = notify.sound;
  }

  const throttleMs = intOrDefault(raw.throttleMs, defaultThrottleMs, 0, `${where}.throttleMs`);
  return {
    id,
    watch,
    source,
    sourceKey: sourceKey(source),
    match,
    title,
    subtitle,
    message,
    sound,
    throttleMs,
  };
}

/** Validates `source`. When omitted it stays json-state, as it always was. */
function validateSource(raw: unknown, where: string): SourceConfig {
  if (raw === undefined) return { type: "json-state" };
  if (!isPlainObject(raw)) throw new ConfigError(`${where} must be an object`);
  const type = raw.type;
  if (typeof type !== "string" || !SOURCE_TYPES.includes(type)) {
    throw new ConfigError(`${where}.type must be one of: ${SOURCE_TYPES.join(", ")}`);
  }
  if (type === "log-lines") {
    const windowBytes = intOrDefault(
      raw.windowBytes,
      DEFAULT_LOG_WINDOW_BYTES,
      MIN_LOG_WINDOW_BYTES,
      `${where}.windowBytes`,
    );
    if (windowBytes > MAX_LOG_WINDOW_BYTES) {
      throw new ConfigError(`${where}.windowBytes must be <= ${MAX_LOG_WINDOW_BYTES}`);
    }
    return { type, windowBytes };
  }
  return { type: type as "json-state" | "file-meta" };
}

function validateMatch(raw: unknown, where: string, source: SourceConfig): RuleMatch {
  if (!isPlainObject(raw)) throw new ConfigError(`${where} must be an object`);
  const type = raw.type;
  if (type === "any") return { type };
  if (type === "event") {
    const equals = raw.equals;
    if (typeof equals !== "string" || equals.length === 0 || equals.length > MAX_EQUALS_LEN) {
      throw new ConfigError(`${where}.equals must be a string of 1-${MAX_EQUALS_LEN} chars`);
    }
    return { type, equals };
  }
  if (type === "equals") {
    const value = raw.value;
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_EQUALS_LEN) {
      throw new ConfigError(`${where}.value must be a string of 1-${MAX_EQUALS_LEN} chars`);
    }
    return { type, field: validateField(raw.field, where, source), value };
  }
  if (type === "contains" || type === "regex") {
    const pattern = raw.pattern;
    if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > MAX_PATTERN_LEN) {
      throw new ConfigError(`${where}.pattern must be a string of 1-${MAX_PATTERN_LEN} chars`);
    }
    const field = validateField(raw.field, where, source);
    if (type === "regex") {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch (err) {
        throw new ConfigError(`${where}.pattern is not a valid regex: ${errorMessage(err)}`);
      }
      // At runtime the input is capped at MAX_MATCH_TARGET_LEN, but catastrophic
      // backtracking can still stall. A conservative heuristic that rejects the classic
      // nested quantifier shapes (e.g. (a+)+ ) at startup.
      if (hasNestedUnboundedQuantifier(pattern)) {
        throw new ConfigError(
          `${where}.pattern has a nested unbounded quantifier (e.g. "(a+)+") which risks catastrophic backtracking (ReDoS); rewrite it to avoid nesting quantifiers`,
        );
      }
      return { type, field, pattern, regex };
    }
    // "contains" is an exact substring search. The target is truncated to
    // MAX_MATCH_TARGET_LEN at runtime, so a longer pattern could never match. Reject it
    // rather than let it fail silently.
    if (pattern.length > MAX_MATCH_TARGET_LEN) {
      throw new ConfigError(
        `${where}.pattern for a "contains" match must be <= ${MAX_MATCH_TARGET_LEN} chars (the match target is truncated to that length at runtime)`,
      );
    }
    return { type, field, pattern };
  }
  throw new ConfigError(
    `${where}.type must be one of: "any", "event", "equals", "contains", "regex"`,
  );
}

/**
 * Validates match.field. Since a source may expose arbitrary fields, only the shape of the name
 * is checked rather than a fixed enumeration. When omitted, the source type's default field
 * is used.
 */
function validateField(raw: unknown, where: string, source: SourceConfig): MatchField {
  if (raw === undefined) return defaultFieldFor(source.type);
  if (typeof raw !== "string" || !FIELD_NAME_PATTERN.test(raw)) {
    throw new ConfigError(`${where}.field must match ${FIELD_NAME_PATTERN}`);
  }
  return raw;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigError(`${label} must be a non-empty string`);
  }
  return value;
}

function intOrDefault(value: unknown, def: number, min: number, label: string): number {
  if (value === undefined) return def;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ConfigError(`${label} must be an integer`);
  }
  if (value < min) throw new ConfigError(`${label} must be >= ${min}`);
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Conservative heuristic that detects a group carrying a nested quantifier under an
// unbounded quantifier (*, +, {n,}) - e.g. (a+)+, ([a-z]*)* - and rejects at startup the
// classic shapes behind most catastrophic backtracking.
// Note this is a heuristic, not a proof: it is not a complete ReDoS decision procedure.
export function hasNestedUnboundedQuantifier(pattern: string): boolean {
  // Stack of "does this group's body contain an unbounded quantifier?" flags
  const bodyHasUnbounded: boolean[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++; // skip the single escaped character that follows
      continue;
    }
    if (c === "[") {
      // Skip the whole character class up to `]` (quantifier symbols inside are not quantifiers)
      i++;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "(") {
      bodyHasUnbounded.push(false);
      continue;
    }
    if (c === ")") {
      const innerHasUnbounded = bodyHasUnbounded.pop() ?? false;
      const groupIsUnbounded = isUnboundedQuantifierAt(pattern, i + 1);
      if (innerHasUnbounded && groupIsUnbounded) return true;
      // If this group itself is unbounded-quantified, set the body flag of the enclosing group
      if (groupIsUnbounded && bodyHasUnbounded.length > 0) {
        bodyHasUnbounded[bodyHasUnbounded.length - 1] = true;
      }
      continue;
    }
    if (c === "*" || c === "+") {
      if (bodyHasUnbounded.length > 0) bodyHasUnbounded[bodyHasUnbounded.length - 1] = true;
    } else if (c === "{" && /^\{\d*,\}/.test(pattern.slice(i))) {
      if (bodyHasUnbounded.length > 0) bodyHasUnbounded[bodyHasUnbounded.length - 1] = true;
    }
  }
  return false;
}

function isUnboundedQuantifierAt(pattern: string, idx: number): boolean {
  const c = pattern[idx];
  if (c === "*" || c === "+") return true;
  if (c === "{") return /^\{\d*,\}/.test(pattern.slice(idx));
  return false;
}
