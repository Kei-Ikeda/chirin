import path from "node:path";
import {
  MAX_MATCH_TARGET_LEN,
  tccProtectedTargets,
  tccWarningMessage,
  type Config,
  type Rule,
  type RuleMatch,
} from "./config.js";
import { expandGlobs } from "./glob.js";
import { errorMessage, log } from "./log.js";
import {
  MESSAGE_MAX_LEN,
  SUBTITLE_MAX_LEN,
  TITLE_MAX_LEN,
  type Notifier,
} from "./notifier.js";
import { sanitize } from "./sanitize.js";
import { createSource, truncate, type Source, type SourceEvent } from "./sources.js";

const MAX_NOTIFICATIONS_PER_CYCLE = 5;
// Cap on the total number of watch targets. Bounds the attack where a container fills
// the watched path hierarchy with directories to inflate the number of stats per poll.
// Anything beyond the cap is dropped with a warning (never truncate silently).
const MAX_WATCH_TARGETS = 1024;
// Time budget (ms) for a single regex match. A rule that exceeds it is disabled for the
// rest of the session. A runtime safety net that reduces a sustained DoS by a
// pathological regex - one that slipped past the static ReDoS heuristic in the config - to
// a single delay followed by skipping.
const REGEX_SLOW_MS = 100;

/** Substitutes `{{name}}` with the value from vars. Unknown placeholders are left as-is. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (whole, name: string) =>
    Object.hasOwn(vars, name) ? vars[name]! : whole,
  );
}

/** Derives {{dir}} from a watched file path (if the parent is .claude, use the basename one level higher). */
export function deriveDirName(file: string): string {
  const parent = path.dirname(file);
  return path.basename(path.basename(parent) === ".claude" ? path.dirname(parent) : parent);
}

function ruleMatches(match: RuleMatch, fields: Record<string, string>): boolean {
  if (match.type === "any") return true;
  const field = match.type === "event" ? "event" : match.field;
  const value = fields[field];
  if (value === undefined) return false;
  // Bound the length of the match target to curb ReDoS backtracking blowup
  const target = truncate(value, MAX_MATCH_TARGET_LEN);
  switch (match.type) {
    case "event":
      return target === match.equals;
    case "equals":
      return target === match.value;
    case "contains":
      return target.includes(match.pattern);
    case "regex":
      return match.regex.test(target);
  }
}

/** Aggregated events that matched the same rule x file within one cycle. */
interface Aggregate {
  /** Fields of the last matching event (used for the notification body) */
  fields: Record<string, string>;
  /** Number of matches (so a burst collapses into one notification) */
  count: number;
}

export class Watcher {
  /** key: `${ruleId}\0${file}` -> time of the last notification (epoch ms) */
  private readonly lastFired = new Map<string, number>();
  /** Carried over because of the per-cycle notification cap. Keys use the same format as lastFired. */
  private readonly pending = new Map<string, Aggregate>();
  /** Glob expansion result: file -> the ids of the rules watching that file */
  private targets = new Map<string, Set<string>>();
  private readonly ruleById = new Map<string, Rule>();
  /** sourceKey -> source adapter (identical configurations share one, so a file is never read twice) */
  private readonly sources = new Map<string, Source>();
  /** Ids of regex rules disabled for exceeding the time budget (skipped for the rest of the session). */
  private readonly slowRules = new Set<string>();
  private pollTimer: NodeJS.Timeout | undefined;
  private globTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly config: Config,
    private readonly notifier: Notifier,
    private readonly now: () => number = Date.now,
  ) {
    for (const rule of config.rules) {
      this.ruleById.set(rule.id, rule);
      if (!this.sources.has(rule.sourceKey)) {
        this.sources.set(rule.sourceKey, createSource(rule.source));
      }
    }
  }

  refreshTargets(): void {
    const next = new Map<string, Set<string>>();
    for (const rule of this.config.rules) {
      for (const file of expandGlobs(rule.watch)) {
        let ruleIds = next.get(file);
        if (ruleIds === undefined) {
          ruleIds = new Set();
          next.set(file, ruleIds);
        }
        ruleIds.add(rule.id);
      }
    }
    this.targets = this.capTargets(next);
    // Discard state for files that dropped out of the watch set. The check is uniformly
    // against the post-cap targets.
    const active = this.targets;
    for (const key of this.lastFired.keys()) {
      if (!active.has(fileOfKey(key))) this.lastFired.delete(key);
    }
    for (const key of this.pending.keys()) {
      if (!active.has(fileOfKey(key))) this.pending.delete(key);
    }
    for (const source of this.sources.values()) {
      for (const file of [...source.files()]) {
        if (!active.has(file)) source.forget(file);
      }
    }
  }

  // If the total exceeds the cap, keep the first MAX_WATCH_TARGETS entries and log the truncation explicitly.
  private capTargets(next: Map<string, Set<string>>): Map<string, Set<string>> {
    if (next.size <= MAX_WATCH_TARGETS) return next;
    log.warn(
      `watch targets (${next.size}) exceed cap ${MAX_WATCH_TARGETS}; only the first ${MAX_WATCH_TARGETS} are monitored`,
    );
    const capped = new Map<string, Set<string>>();
    let n = 0;
    for (const [file, ruleIds] of next) {
      if (n++ >= MAX_WATCH_TARGETS) break;
      capped.set(file, ruleIds);
    }
    return capped;
  }

  pollOnce(): void {
    // Start with what was carried over after hitting the previous cycle's notification cap (avoid dropping it permanently)
    const aggregates = new Map<string, Aggregate>(this.pending);
    this.pending.clear();

    for (const [file, ruleIds] of this.targets) {
      try {
        this.collectFile(file, ruleIds, aggregates);
      } catch (err) {
        // A per-file failure only skips that file; it never stops the loop
        log.warn(`failed to process ${file}: ${errorMessage(err)}`);
      }
    }
    this.dispatch(aggregates);
  }

  /** Collects one file's events into aggregates. */
  private collectFile(
    file: string,
    ruleIds: Set<string>,
    aggregates: Map<string, Aggregate>,
  ): void {
    // Even when several rules watch the same file, one poll suffices as long as the source settings match
    const bySource = new Map<string, Rule[]>();
    for (const ruleId of ruleIds) {
      const rule = this.ruleById.get(ruleId);
      if (rule === undefined || this.slowRules.has(rule.id)) continue;
      const group = bySource.get(rule.sourceKey);
      if (group === undefined) bySource.set(rule.sourceKey, [rule]);
      else group.push(rule);
    }

    for (const [key, rules] of bySource) {
      const source = this.sources.get(key);
      if (source === undefined) continue;
      const events = source.poll(file);
      if (events.length === 0) continue;
      for (const rule of rules) {
        this.collectRule(rule, file, events, aggregates);
      }
    }
  }

  /** Aggregates one rule's matches (a burst collapses into a single notification). */
  private collectRule(
    rule: Rule,
    file: string,
    events: SourceEvent[],
    aggregates: Map<string, Aggregate>,
  ): void {
    const key = `${rule.id}\0${file}`;
    let matched = 0;
    let lastFields: Record<string, string> | undefined;
    const t0 = this.now();
    for (const event of events) {
      if (!ruleMatches(rule.match, event.fields)) continue;
      matched++;
      lastFields = event.fields;
    }
    if (rule.match.type === "regex" && this.now() - t0 > REGEX_SLOW_MS) {
      // Once a pathological regex is detected, skip it from here on, reducing a sustained DoS to a single delay
      this.slowRules.add(rule.id);
      log.warn(
        `rule ${rule.id} regex match exceeded ${REGEX_SLOW_MS}ms; disabling it for this session (possible ReDoS)`,
      );
      return;
    }
    if (matched === 0 || lastFields === undefined) return;

    const existing = aggregates.get(key);
    if (existing === undefined) aggregates.set(key, { fields: lastFields, count: matched });
    else {
      existing.fields = lastFields; // keep the most recent event
      existing.count += matched;
    }
  }

  /** Runs the aggregates through throttling and the notification cap, carrying the rest over to the next cycle. */
  private dispatch(aggregates: Map<string, Aggregate>): void {
    let fired = 0;
    let deferred = 0;
    for (const [key, aggregate] of aggregates) {
      const rule = this.ruleById.get(ruleIdOfKey(key));
      if (rule === undefined) continue;
      const file = fileOfKey(key);
      const nowMs = this.now();
      const firedAt = this.lastFired.get(key);
      if (firedAt !== undefined && nowMs - firedAt < rule.throttleMs) {
        // Throttling means suppression, so drop it rather than carrying it over
        log.debug(`throttled: rule=${rule.id} file=${file} (${aggregate.count} event(s))`);
        continue;
      }
      if (fired >= MAX_NOTIFICATIONS_PER_CYCLE) {
        this.pending.set(key, aggregate);
        deferred++;
        continue;
      }
      this.lastFired.set(key, nowMs);
      fired++;
      this.fire(rule, file, aggregate);
    }
    if (deferred > 0) {
      log.info(
        `notification cap (${MAX_NOTIFICATIONS_PER_CYCLE}/cycle) reached; deferred ${deferred} notification(s) to next cycle`,
      );
    }
  }

  /** Glob expansion plus a single poll cycle (for integration tests). */
  runOnce(): void {
    this.refreshTargets();
    this.pollOnce();
  }

  start(): void {
    // Do not re-arm the timers if called twice (the previous timers would lose their references and become unstoppable).
    if (this.pollTimer !== undefined || this.globTimer !== undefined) return;
    this.refreshTargets();
    this.warnTccProtected();
    this.pollTimer = setInterval(() => {
      try {
        this.pollOnce();
      } catch (err) {
        // Never let the watch loop crash
        log.error(`poll cycle failed: ${errorMessage(err)}`);
      }
    }, this.config.pollIntervalMs);
    this.globTimer = setInterval(() => {
      try {
        this.refreshTargets();
      } catch (err) {
        log.error(`glob refresh failed: ${errorMessage(err)}`);
      }
    }, this.config.globRefreshMs);
  }

  stop(): void {
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    if (this.globTimer !== undefined) clearInterval(this.globTimer);
    this.pollTimer = undefined;
    this.globTimer = undefined;
  }

  targetCount(): number {
    return this.targets.size;
  }

  /**
   * Warns at startup about watch targets under a TCC-protected directory.
   * Without a permission granted to VS Code itself (Full Disk Access and similar) the read
   * fails silently, so this surfaces the "configured everything but notifications never
   * arrive" state.
   */
  private warnTccProtected(): void {
    const affected = tccProtectedTargets([...this.targets.keys()]);
    if (affected.length === 0) return;
    log.warn(tccWarningMessage(affected.length));
    for (const file of affected) log.warn(`  TCC-protected: ${sanitize(file, 1024)}`);
  }

  private fire(rule: Rule, file: string, aggregate: Aggregate): void {
    // Layer the path-derived values on top of the source fields. file and count are trusted;
    // dir is a directory name a container may be able to choose (a `*` segment inside a
    // workspace), which is why the rendered text is sanitized as a whole below.
    const vars: Record<string, string> = {
      ...aggregate.fields,
      dir: deriveDirName(file),
      file: path.basename(file),
      count: String(aggregate.count),
    };
    const title = sanitize(renderTemplate(rule.title, vars), TITLE_MAX_LEN);
    const subtitle =
      rule.subtitle === undefined
        ? undefined
        : sanitize(renderTemplate(rule.subtitle, vars), SUBTITLE_MAX_LEN);
    const message = sanitize(renderTemplate(rule.message, vars), MESSAGE_MAX_LEN);
    log.info(`notify: rule=${rule.id} file=${file} events=${aggregate.count}`);
    this.notifier({ title, subtitle, message, sound: rule.sound });
  }
}

function ruleIdOfKey(key: string): string {
  return key.slice(0, key.indexOf("\0"));
}

function fileOfKey(key: string): string {
  return key.slice(key.indexOf("\0") + 1);
}
