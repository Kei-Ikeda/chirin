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
import {
  RegexTimeoutError,
  WorkerRegexMatcher,
  type RegexMatcher,
} from "./regexMatcher.js";
import { sanitize } from "./sanitize.js";
import { createSource, truncate, type Source, type SourceEvent } from "./sources.js";

const MAX_NOTIFICATIONS_PER_CYCLE = 5;
// Cap on the total number of watch targets. Bounds the attack where a container fills
// the watched path hierarchy with directories to inflate the number of stats per poll.
// Anything beyond the cap is dropped with a warning (never truncate silently).
const MAX_WATCH_TARGETS = 1024;

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

/** Every match type except `any` reads one field of the event. */
type FieldMatch = Exclude<RuleMatch, { type: "any" }>;

/** The value a rule matches against. undefined when the source does not expose that field. */
function matchTarget(match: FieldMatch, fields: Record<string, string>): string | undefined {
  const field = match.type === "event" ? "event" : match.field;
  const value = fields[field];
  if (value === undefined) return undefined;
  // Bound the length of the match target to curb ReDoS backtracking blowup
  return truncate(value, MAX_MATCH_TARGET_LEN);
}

/**
 * Applies the match types that cost a bounded amount of work on this thread.
 * `regex` is not one of them and is resolved through the worker instead (see regexMatcher.ts).
 */
function matchesOnThread(match: Exclude<RuleMatch, { type: "regex" }>, fields: Record<string, string>): boolean {
  if (match.type === "any") return true;
  const target = matchTarget(match, fields);
  if (target === undefined) return false;
  switch (match.type) {
    case "event":
      return target === match.equals;
    case "equals":
      return target === match.value;
    case "contains":
      return target.includes(match.pattern);
  }
}

/** Aggregated events that matched the same rule x file within one cycle. */
interface Aggregate {
  /** Fields of the last matching event (used for the notification body) */
  fields: Record<string, string>;
  /** Number of matches (so a burst collapses into one notification) */
  count: number;
}

/**
 * One rule x file's worth of matching within a poll cycle.
 *
 * The events are read from every target first and the matching is decided afterwards, so that
 * regex rules - whose matching leaves this thread - can be resolved without changing the order
 * in which the results are aggregated. That order decides which notifications the per-cycle
 * cap keeps, so it must not depend on when a worker happens to reply.
 */
interface CollectStep {
  rule: Rule;
  file: string;
  events: SourceEvent[];
  /** Indices into events that matched. undefined until a regex rule's worker reply arrives. */
  matched: number[] | undefined;
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
  /** Created on the first regex match, so a config without one never starts a worker. */
  private regexMatcher: RegexMatcher | undefined;
  /**
   * Bumped by stop(). A cycle that started before the bump must not notify: its matching
   * outlived the reason it was running (the window was demoted, or the config was reloaded).
   */
  private generation = 0;
  /** Whether a cycle is still running. Keeps the timer from stacking cycles on a slow match. */
  private polling = false;

  constructor(
    private readonly config: Config,
    private readonly notifier: Notifier,
    private readonly now: () => number = Date.now,
    /** How the regex worker is built. An injection point purely so tests can shorten its budget. */
    private readonly createMatcher: () => RegexMatcher = () => new WorkerRegexMatcher(),
  ) {
    for (const rule of config.rules) {
      this.ruleById.set(rule.id, rule);
      if (!this.sources.has(rule.sourceKey)) {
        this.sources.set(rule.sourceKey, createSource(rule.source));
      }
    }
  }

  refreshTargets(): void {
    const previous = this.targets;
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
    this.primeTargets(previous);
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

  /**
   * Records the baseline of every target that just joined the watch set, discarding whatever
   * it holds today.
   *
   * Without this the baseline was only taken by the first poll, one interval after watching
   * began, and anything written inside that gap was mistaken for pre-existing state and never
   * notified. Reading here closes the gap for start() as well as for a target a glob refresh
   * has just discovered.
   * Discarding the events is what keeps content that predates watching from replaying: a file
   * present at this moment leaves only its ts behind, while a path observed *missing* is
   * remembered as missing, so its later appearance still notifies (see sources.ts).
   */
  private primeTargets(previous: ReadonlyMap<string, Set<string>>): void {
    for (const [file, ruleIds] of this.targets) {
      if (previous.has(file)) continue;
      const primed = new Set<string>();
      for (const ruleId of ruleIds) {
        const rule = this.ruleById.get(ruleId);
        // Rules sharing a source read the same file once, as in a normal cycle
        if (rule === undefined || primed.has(rule.sourceKey)) continue;
        primed.add(rule.sourceKey);
        try {
          this.sources.get(rule.sourceKey)?.poll(file);
        } catch (err) {
          // A per-file failure only skips that file; the next poll reads it again
          log.warn(`failed to read ${file}: ${errorMessage(err)}`);
        }
      }
    }
  }

  async pollOnce(): Promise<void> {
    const generation = this.generation;
    // Start with what was carried over after hitting the previous cycle's notification cap (avoid dropping it permanently)
    const aggregates = new Map<string, Aggregate>(this.pending);
    this.pending.clear();

    const steps: CollectStep[] = [];
    for (const [file, ruleIds] of this.targets) {
      try {
        this.collectFile(file, ruleIds, steps);
      } catch (err) {
        // A per-file failure only skips that file; it never stops the loop
        log.warn(`failed to process ${file}: ${errorMessage(err)}`);
      }
    }
    await this.resolveRegexSteps(steps, generation);
    // Everything from here belongs to the cycle that started above. If watching stopped while
    // the worker was matching, these notifications are no longer ours to send.
    if (generation !== this.generation) return;
    for (const step of steps) this.aggregate(step, aggregates);
    this.dispatch(aggregates);
  }

  /** Reads one file's events once and records the matching work for every rule watching it. */
  private collectFile(file: string, ruleIds: Set<string>, steps: CollectStep[]): void {
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
        const match = rule.match;
        steps.push({
          rule,
          file,
          events,
          matched: match.type === "regex" ? undefined : matchedIndices(match, events),
        });
      }
    }
  }

  /** Resolves the regex steps through the worker: one round trip per rule, whatever the number of files. */
  private async resolveRegexSteps(steps: CollectStep[], generation: number): Promise<void> {
    const byRule = new Map<string, CollectStep[]>();
    for (const step of steps) {
      if (step.matched !== undefined) continue;
      const group = byRule.get(step.rule.id);
      if (group === undefined) byRule.set(step.rule.id, [step]);
      else group.push(step);
    }
    for (const group of byRule.values()) {
      if (generation !== this.generation) return;
      await this.resolveRegexRule(group, generation);
    }
  }

  private async resolveRegexRule(steps: CollectStep[], generation: number): Promise<void> {
    const rule = steps[0]!.rule;
    const match = rule.match;
    if (match.type !== "regex") return;
    // Flatten every event of every file into one batch, remembering where each target came from
    const targets: string[] = [];
    const slots: { step: CollectStep; event: number }[] = [];
    for (const step of steps) {
      step.matched = [];
      for (let i = 0; i < step.events.length; i++) {
        const target = matchTarget(match, step.events[i]!.fields);
        if (target === undefined) continue;
        targets.push(target);
        slots.push({ step, event: i });
      }
    }
    if (targets.length === 0) return;
    try {
      // The indices come back ascending, so each step's matched list stays in event order
      for (const index of await this.matcher().match(match.pattern, targets)) {
        const slot = slots[index];
        if (slot === undefined) continue;
        slot.step.matched!.push(slot.event);
      }
    } catch (err) {
      // Stopping disposes the matcher, which rejects the match in flight. That is the stop
      // working as intended, not a fault to report.
      if (generation !== this.generation) return;
      if (err instanceof RegexTimeoutError) {
        // The worker was terminated mid-match. Skip the rule from here on, so a pathological
        // pattern costs one terminated worker rather than one per cycle.
        this.slowRules.add(rule.id);
        log.warn(
          `rule ${rule.id} regex match exceeded its time budget and was terminated; disabling it for this session (possible ReDoS)`,
        );
        return;
      }
      log.warn(`rule ${rule.id} regex match failed: ${errorMessage(err)}`);
    }
  }

  private matcher(): RegexMatcher {
    if (this.regexMatcher === undefined) this.regexMatcher = this.createMatcher();
    return this.regexMatcher;
  }

  /** Folds one step's matches into the cycle's aggregates (a burst collapses into a single notification). */
  private aggregate(step: CollectStep, aggregates: Map<string, Aggregate>): void {
    const matched = step.matched;
    if (matched === undefined || matched.length === 0) return;
    // A glob refresh during the cycle may have dropped the file; do not notify about a path we no longer watch
    if (!this.targets.has(step.file)) return;
    const lastFields = step.events[matched[matched.length - 1]!]!.fields;
    const key = `${step.rule.id}\0${step.file}`;
    const existing = aggregates.get(key);
    if (existing === undefined) aggregates.set(key, { fields: lastFields, count: matched.length });
    else {
      existing.fields = lastFields; // keep the most recent event
      existing.count += matched.length;
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
      // A glob refresh may have dropped the file while this cycle was matching. Aggregates
      // carried over from the previous cycle are only checked here, so drop them rather than
      // notifying (or deferring again) for a path we no longer watch.
      if (!this.targets.has(file)) continue;
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
  async runOnce(): Promise<void> {
    this.refreshTargets();
    await this.pollOnce();
  }

  start(): void {
    // Do not re-arm the timers if called twice (the previous timers would lose their references and become unstoppable).
    if (this.pollTimer !== undefined || this.globTimer !== undefined) return;
    // Takes the baseline of every target before the first interval elapses, so an event
    // arriving right after watching starts is seen as a change rather than as existing state.
    this.refreshTargets();
    this.warnTccProtected();
    this.pollTimer = setInterval(() => {
      void this.runPollCycle();
    }, this.config.pollIntervalMs);
    this.globTimer = setInterval(() => {
      try {
        this.refreshTargets();
      } catch (err) {
        log.error(`glob refresh failed: ${errorMessage(err)}`);
      }
    }, this.config.globRefreshMs);
  }

  /** One timer-driven cycle. Cycles never overlap, which is what bounds the queued regex work. */
  private async runPollCycle(): Promise<void> {
    if (this.polling) {
      log.debug("skipping a poll cycle: the previous one is still matching");
      return;
    }
    this.polling = true;
    try {
      await this.pollOnce();
    } catch (err) {
      // Never let the watch loop crash
      log.error(`poll cycle failed: ${errorMessage(err)}`);
    } finally {
      this.polling = false;
    }
  }

  stop(): void {
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    if (this.globTimer !== undefined) clearInterval(this.globTimer);
    this.pollTimer = undefined;
    this.globTimer = undefined;
    // Invalidate any cycle still waiting on the worker before disposing it, so a late reply
    // cannot notify after watching stopped.
    this.generation++;
    this.regexMatcher?.dispose();
    this.regexMatcher = undefined;
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

/** Indices of the events a non-regex match accepts. */
function matchedIndices(
  match: Exclude<RuleMatch, { type: "regex" }>,
  events: SourceEvent[],
): number[] {
  const matched: number[] = [];
  for (let i = 0; i < events.length; i++) {
    if (matchesOnThread(match, events[i]!.fields)) matched.push(i);
  }
  return matched;
}

function ruleIdOfKey(key: string): string {
  return key.slice(0, key.indexOf("\0"));
}

function fileOfKey(key: string): string {
  return key.slice(key.indexOf("\0") + 1);
}
