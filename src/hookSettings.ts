// Merging chirin's Claude Code hook registration into .claude/settings.local.json.
//
// Kept out of commands.ts so it stays free of `vscode` and can be tested: the merge decides
// which of the user's existing hooks survive, and getting that wrong silently deletes work
// that is not ours.

/** Shape of the bundled hooks/settings.example.json. */
export interface HookSettingsExample {
  hooks: Record<string, unknown[]>;
}

/**
 * Outcome of the merge. The failure cases are content we must not rewrite mechanically; the
 * caller turns each into its own explanation (the wording is user-facing and lives there).
 */
export type HookMergeOutcome =
  | { kind: "ok"; text: string }
  /** Not JSON at all (JSON with comments, say) */
  | { kind: "unparsable" }
  /** Valid JSON, but an array/scalar/null rather than a settings object */
  | { kind: "not-object" }
  /** `hooks` exists but is not an object, so there is no map of events to merge into */
  | { kind: "hooks-not-object" };

/**
 * Hook commands earlier releases installed, kept so re-running the install migrates them
 * instead of leaving a second registration behind.
 *
 * Every released version (1.0.0 - 1.0.2) installed the form that is still in
 * hooks/settings.example.json, so there is nothing to migrate yet. Add the previous string
 * here - verbatim - whenever the invocation form in settings.example.json changes.
 */
export const HISTORICAL_HOOK_COMMANDS: readonly string[] = [];

/**
 * Merges the example's hooks into the existing settings text and returns the text to write.
 * `existing` is null when the file does not exist yet.
 *
 * Everything that is not chirin's own hook registration is preserved: other events, other
 * entries, other commands inside the same entry, the matcher and any other fields of an
 * entry, and every setting outside `hooks`.
 */
export function mergeHookSettingsText(
  existing: string | null,
  example: HookSettingsExample,
): HookMergeOutcome {
  let settings: Record<string, unknown> = {};
  if (existing !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      return { kind: "unparsable" };
    }
    // Arrays, null and scalars parse fine too. Merging into them would either fail on write
    // or discard the original content entirely (e.g. `[]` would become an `[]` with hooks).
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { kind: "not-object" };
    }
    settings = parsed as Record<string, unknown>;
  }

  const existingHooks = settings.hooks ?? {};
  if (typeof existingHooks !== "object" || existingHooks === null || Array.isArray(existingHooks)) {
    return { kind: "hooks-not-object" };
  }
  const hooks = existingHooks as Record<string, unknown[]>;
  const managed = managedHookCommands(example);
  for (const [event, entries] of Object.entries(example.hooks)) {
    const current = Array.isArray(hooks[event]) ? hooks[event] : [];
    // Remove existing chirin hooks before adding them back. That prevents a double
    // registration (two notifications) while letting a change to the hook invocation form be
    // picked up by re-running this command alone.
    // Dropping whole entries would take the user's own hooks and matchers living in the same
    // entry with them, so only chirin's commands inside an entry are removed.
    const others = current
      .map((entry) => withoutChirinHooks(entry, managed))
      .filter((entry) => entry !== null);
    hooks[event] = [...others, ...entries];
  }
  settings.hooks = hooks;
  return { kind: "ok", text: `${JSON.stringify(settings, null, 2)}\n` };
}

/**
 * The exact set of hook commands chirin owns: the ones the bundled settings.example.json
 * registers, plus the forms earlier releases registered.
 *
 * Taking the current form from the example file rather than restating it here keeps the two
 * from drifting: what a run writes is exactly what a later run recognizes as its own.
 */
export function managedHookCommands(example: HookSettingsExample): ReadonlySet<string> {
  const commands = new Set<string>(HISTORICAL_HOOK_COMMANDS);
  for (const entries of Object.values(example.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const command of hookCommandsOf(entry)) commands.add(command);
    }
  }
  return commands;
}

/** The command strings inside one hooks entry (whitespace-trimmed; non-strings skipped). */
function hookCommandsOf(entry: unknown): string[] {
  if (typeof entry !== "object" || entry === null) return [];
  const { hooks } = entry as { hooks?: unknown };
  if (!Array.isArray(hooks)) return [];
  const commands: string[] = [];
  for (const hook of hooks) {
    if (typeof hook !== "object" || hook === null) continue;
    const { command } = hook as { command?: unknown };
    if (typeof command === "string") commands.push(command.trim());
  }
  return commands;
}

/**
 * Removes only the hook commands chirin installed from an entry.
 * If non-chirin hooks remain, the entry (matcher and all) is kept; when it becomes empty the
 * result is null (= delete).
 *
 * Ownership is an **exact** match against the commands chirin writes (surrounding whitespace
 * aside), never a substring of them. A command that merely contains the install path belongs
 * to somebody else: `bash ".../chirin-notify.sh.backup"` names a different script, and a
 * user-composed `bash ".../chirin-notify.sh" && something-else` carries behaviour that
 * removing it would silently drop. Matching on the file name alone is wrong for the same
 * reason - it would take a copy the user placed at `scripts/chirin-notify.sh` with it.
 */
function withoutChirinHooks(entry: unknown, managed: ReadonlySet<string>): unknown | null {
  if (typeof entry !== "object" || entry === null) return entry;
  const { hooks } = entry as { hooks?: unknown };
  if (!Array.isArray(hooks)) return entry;
  const kept = hooks.filter((hook) => {
    if (typeof hook !== "object" || hook === null) return true;
    const { command } = hook as { command?: unknown };
    return !(typeof command === "string" && managed.has(command.trim()));
  });
  if (kept.length === hooks.length) return entry;
  if (kept.length === 0) return null;
  return { ...(entry as Record<string, unknown>), hooks: kept };
}
