import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateConfig } from "../src/config.js";
import { CONFIG_TEMPLATE } from "../src/configTemplate.js";
import { stripJsonComments } from "../src/jsonc.js";

// The template is written by `chirin: Create config file` and read back as JSONC. A malformed
// comment in it (an unbalanced quote before a `//`, an unterminated `/*`) would ship a config
// the extension immediately rejects, so run the constant through the real strip + validate path.

test("the config template survives comment stripping and parses as JSON", () => {
  const stripped = stripJsonComments(CONFIG_TEMPLATE);
  assert.doesNotThrow(() => JSON.parse(stripped));
});

test("the config template passes validation", () => {
  const config = validateConfig(JSON.parse(stripJsonComments(CONFIG_TEMPLATE)));
  assert.ok(config.rules.length > 0);
  for (const rule of config.rules) {
    // ~ must already be expanded, and every watch pattern must be absolute
    for (const pattern of rule.watch) {
      assert.ok(path.isAbsolute(pattern), `${rule.id}: ${pattern} is not absolute`);
      assert.ok(pattern.startsWith(os.homedir() + path.sep), `${rule.id}: ${pattern} is not under home`);
      // The documented default targets ~/src/<host>/<owner>/<repo>. Keep the depth pinned so
      // a change here has to be made deliberately (the READMEs and the walkthrough quote it).
      assert.equal(
        pattern,
        path.join(os.homedir(), "src", "*", "*", "*", ".claude", "chirin-notify-state.json"),
        `${rule.id}: unexpected default watch pattern`,
      );
    }
  }
});

test("comment stripping does not disturb the template's values", () => {
  const data = JSON.parse(stripJsonComments(CONFIG_TEMPLATE)) as {
    rules: Array<{ id: string; notify: { message: string } }>;
  };
  // A comment swallowed into a string (or vice versa) would show up here first
  assert.deepEqual(
    data.rules.map((r) => r.id),
    ["claude-stop", "claude-notification"],
  );
  for (const rule of data.rules) {
    assert.ok(!rule.notify.message.includes("//"), `${rule.id}: a comment leaked into message`);
  }
});

// The claude-notification rule filters on notification_type so that background-agent traffic
// (agent_needs_input / agent_completed, raised for FleetView sessions, teammates and cloud
// agents) does not notify. Assert the compiled pattern actually draws that line: a silent
// widening here would bring the noise back without any test failing.
test("the template's notification rule matches only the session's own prompts", () => {
  const config = validateConfig(JSON.parse(stripJsonComments(CONFIG_TEMPLATE)));
  const rule = config.rules.find((r) => r.id === "claude-notification");
  assert.ok(rule, "claude-notification rule is missing");
  const match = rule.match;
  assert.equal(match.type, "regex");
  assert.ok(match.type === "regex");
  assert.equal(match.field, "notification_type");

  assert.ok(match.regex.test("permission_prompt"), "a permission request should notify");
  for (const value of [
    // The session merely going idle is not a question: it also fires while background work is
    // still running, which is exactly the noise the default is meant to avoid.
    "idle_prompt",
    "agent_needs_input",
    "agent_completed",
    "worker_permission_prompt",
    "auth_success",
    "push_notification",
    "quota_auto_resume_fired",
    "", // what the hook writes for every non-Notification event (Stop included)
  ]) {
    assert.ok(!match.regex.test(value), `${value} should stay silent`);
  }
});

// The claude-stop rule filters on background_task_count so that "Complete" fires on a real
// completion and not on a turn that merely parked to wait for background work. Widening this
// pattern would bring back a "done!" notification for every intermediate stop.
test("the template's stop rule matches only a completion with no background work left", () => {
  const config = validateConfig(JSON.parse(stripJsonComments(CONFIG_TEMPLATE)));
  const rule = config.rules.find((r) => r.id === "claude-stop");
  assert.ok(rule, "claude-stop rule is missing");
  const match = rule.match;
  assert.equal(match.type, "regex");
  assert.ok(match.type === "regex");
  assert.equal(match.field, "background_task_count");

  assert.ok(match.regex.test("0"), "a completion with nothing in flight should notify");
  for (const value of ["1", "2", "10", "01"]) {
    assert.ok(!match.regex.test(value), `${value} background task(s) left should stay silent`);
  }
});

// The two template rules must not both fire for the same event: the hook writes
// notification_type only on Notification and background_task_count only on Stop/SubagentStop,
// and a rule whose field is absent never matches (watcher.ts). Assert the fields stay disjoint.
test("the template's rules match on disjoint fields", () => {
  const config = validateConfig(JSON.parse(stripJsonComments(CONFIG_TEMPLATE)));
  const fields = config.rules.map((r) => (r.match.type === "regex" ? r.match.field : r.match.type));
  assert.deepEqual([...new Set(fields)].sort(), ["background_task_count", "notification_type"]);
});
