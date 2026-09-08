import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { mergeHookSettingsText, type HookSettingsExample } from "../src/hookSettings.js";

// The real bundled example, so these tests exercise the command form actually installed.
const EXAMPLE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "hooks", "settings.example.json"), "utf8"),
) as HookSettingsExample;

/** The command string chirin installs (the single form every released version has used). */
const CHIRIN_COMMAND = 'bash "${CLAUDE_PROJECT_DIR}/.claude/hooks/chirin-notify.sh"';

interface HookCommand {
  type?: string;
  command?: string;
  async?: boolean;
}
interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}
type HookMap = Record<string, HookEntry[]>;

/** Runs the merge over settings given as an object (null = the file does not exist yet). */
function merge(existing: unknown): { settings: Record<string, unknown>; hooks: HookMap } {
  return mergeText(existing === null ? null : JSON.stringify(existing, null, 2));
}

function mergeText(existing: string | null): { settings: Record<string, unknown>; hooks: HookMap } {
  const outcome = mergeHookSettingsText(existing, EXAMPLE);
  assert.equal(outcome.kind, "ok");
  if (outcome.kind !== "ok") throw new Error("unreachable");
  const settings = JSON.parse(outcome.text) as Record<string, unknown>;
  return { settings, hooks: settings.hooks as HookMap };
}

function commandsOf(entries: HookEntry[] | undefined): string[] {
  return (entries ?? []).flatMap((entry) => entry.hooks.map((hook) => hook.command ?? ""));
}

test("the bundled example really does register the command these tests pin", () => {
  // Ownership below is decided by an exact match, so a change to the example's command form
  // has to be noticed here rather than silently making the tests test nothing.
  assert.deepEqual(commandsOf(EXAMPLE.hooks.Stop as HookEntry[]), [CHIRIN_COMMAND]);
});

test("a hook whose command merely contains the install path is left alone", () => {
  // The reported case: the user's own backup script, whose name starts with chirin's path
  const backup = 'bash "${CLAUDE_PROJECT_DIR}/.claude/hooks/chirin-notify.sh.backup"';
  const { hooks } = merge({
    hooks: {
      Stop: [
        {
          hooks: [
            { type: "command", command: backup },
            { type: "command", command: "bash other-hook.sh" },
          ],
        },
      ],
    },
  });

  const commands = commandsOf(hooks.Stop);
  assert.ok(commands.includes(backup), "the .backup hook was removed");
  assert.ok(commands.includes("bash other-hook.sh"));
  assert.equal(commands.filter((command) => command === CHIRIN_COMMAND).length, 1);
});

test("a user-composed command that also runs the hook keeps its extra behaviour", () => {
  const composed = `${CHIRIN_COMMAND} && say done`;
  const { hooks } = merge({
    hooks: { Stop: [{ hooks: [{ type: "command", command: composed }] }] },
  });

  assert.ok(commandsOf(hooks.Stop).includes(composed));
});

test("installing twice does not register the bundled hook twice", () => {
  const first = mergeHookSettingsText(null, EXAMPLE);
  assert.equal(first.kind, "ok");
  const { hooks } = mergeText(first.kind === "ok" ? first.text : null);

  assert.deepEqual(commandsOf(hooks.Stop), [CHIRIN_COMMAND]);
  assert.deepEqual(commandsOf(hooks.Notification), [CHIRIN_COMMAND]);
});

test("an existing registration is replaced rather than duplicated, whitespace and all", () => {
  const { hooks } = merge({
    hooks: { Stop: [{ hooks: [{ type: "command", command: `  ${CHIRIN_COMMAND}  ` }] }] },
  });

  assert.deepEqual(commandsOf(hooks.Stop), [CHIRIN_COMMAND]);
});

test("a mixed entry keeps its matcher and its other hooks, in order", () => {
  const { hooks } = merge({
    hooks: {
      Stop: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: "bash lint.sh" },
            { type: "command", command: CHIRIN_COMMAND },
            { type: "command", command: "bash notify-slack.sh" },
          ],
        },
      ],
    },
  });

  const kept = hooks.Stop?.[0];
  assert.equal(kept?.matcher, "Bash");
  assert.deepEqual(
    (kept?.hooks ?? []).map((hook) => hook.command),
    ["bash lint.sh", "bash notify-slack.sh"],
  );
  assert.deepEqual(commandsOf(hooks.Stop).slice(-1), [CHIRIN_COMMAND]);
});

test("an entry holding nothing but chirin's command is dropped rather than left empty", () => {
  const { hooks } = merge({
    hooks: {
      Stop: [
        { hooks: [{ type: "command", command: CHIRIN_COMMAND }] },
        { hooks: [{ type: "command", command: "bash keep.sh" }] },
      ],
    },
  });

  assert.deepEqual(commandsOf(hooks.Stop), ["bash keep.sh", CHIRIN_COMMAND]);
});

test("hooks for other events, and settings outside hooks, survive the merge", () => {
  const { settings, hooks } = merge({
    permissions: { allow: ["Bash(ls:*)"] },
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "bash guard.sh" }] }] },
  });

  assert.deepEqual(settings.permissions, { allow: ["Bash(ls:*)"] });
  assert.deepEqual(commandsOf(hooks.PreToolUse), ["bash guard.sh"]);
});

test("content that cannot be merged mechanically is reported instead of rewritten", () => {
  assert.equal(mergeHookSettingsText("{ // a comment\n}", EXAMPLE).kind, "unparsable");
  assert.equal(mergeHookSettingsText("[]", EXAMPLE).kind, "not-object");
  assert.equal(mergeHookSettingsText('{"hooks": []}', EXAMPLE).kind, "hooks-not-object");
});
