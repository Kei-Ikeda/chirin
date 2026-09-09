import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  ConfigError,
  ConfigNotFoundError,
  MAX_CONFIG_BYTES,
  hasNestedUnboundedQuantifier,
  loadConfig,
  readConfigText,
  tccProtectedTargets,
  validateConfig,
} from "../src/config.js";

// Baseline valid config (each test clones and mutates it)
function baseConfig(): Record<string, unknown> {
  return {
    defaults: { pollIntervalMs: 1000, globRefreshMs: 30000, throttleMs: 5000 },
    rules: [
      {
        id: "rule-1",
        watch: ["/work/*/.claude/chirin-notify-state.json"],
        match: { type: "event", equals: "Stop" },
        notify: { title: "T", message: "M {{dir}}", sound: "Pop" },
        throttleMs: 3000,
      },
    ],
  };
}

function makeTmpDir(t: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chirin-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The text of a successful read: most change-detection tests care about content, not kind. */
function configTextOf(configPath: string): string | undefined {
  const read = readConfigText(configPath);
  return read.kind === "text" ? read.text : undefined;
}

function writeConfigFile(dir: string, content: string, mode: number): string {
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, content);
  fs.chmodSync(file, mode);
  return file;
}

test("happy path: values are applied", () => {
  const config = validateConfig(baseConfig());
  assert.equal(config.pollIntervalMs, 1000);
  assert.equal(config.globRefreshMs, 30000);
  assert.equal(config.rules.length, 1);
  const rule = config.rules[0]!;
  assert.equal(rule.id, "rule-1");
  assert.equal(rule.throttleMs, 3000);
  assert.equal(rule.title, "T");
  assert.equal(rule.sound, "Pop");
});

test("omitting defaults falls back to the built-in defaults", () => {
  const data = baseConfig();
  delete data.defaults;
  delete (data.rules as Record<string, unknown>[])[0]!.throttleMs;
  const config = validateConfig(data);
  assert.equal(config.pollIntervalMs, 1000);
  assert.equal(config.globRefreshMs, 30000);
  assert.equal(config.rules[0]!.throttleMs, 5000); // default value of defaults.throttleMs
});

test("omitting notify.title uses the tool name; the default field for contains is message", () => {
  const data = baseConfig();
  (data.rules as Record<string, unknown>[])[0]!.match = { type: "contains", pattern: "wait" };
  (data.rules as Record<string, unknown>[])[0]!.notify = { message: "M" };
  const config = validateConfig(data);
  assert.equal(config.rules[0]!.title, "chirin");
  const match = config.rules[0]!.match;
  assert.equal(match.type, "contains");
  assert.equal(match.type === "contains" && match.field, "message");
});

test("~/ in watch is expanded to the home directory", () => {
  const data = baseConfig();
  (data.rules as Record<string, unknown>[])[0]!.watch = ["~/work/*/.claude/chirin-notify-state.json"];
  const config = validateConfig(data);
  assert.ok(config.rules[0]!.watch[0]!.startsWith(os.homedir() + path.sep));
});

test("a regex is compiled", () => {
  const data = baseConfig();
  (data.rules as Record<string, unknown>[])[0]!.match = {
    type: "regex",
    field: "cwd",
    pattern: "^/work/",
  };
  const match = validateConfig(data).rules[0]!.match;
  assert.ok(match.type === "regex" && match.regex instanceof RegExp);
});

test("every validation violation raises ConfigError", () => {
  const cases: Array<[string, (data: Record<string, unknown>) => void, RegExp]> = [
    ["rules missing", (d) => delete d.rules, /rules/],
    ["rules is an empty array", (d) => (d.rules = []), /rules/],
    ["malformed id", (d) => (rule(d).id = "Bad_ID"), /id/],
    ["equals missing", (d) => (rule(d).match = { type: "event" }), /equals/],
    ["equals of 65 chars", (d) => (rule(d).match = { type: "event", equals: "e".repeat(65) }), /equals/],
    ["invalid match.type", (d) => (rule(d).match = { type: "glob", pattern: "x" }), /type/],
    [
      "pattern of 257 chars",
      (d) => (rule(d).match = { type: "contains", pattern: "p".repeat(257) }),
      /pattern/,
    ],
    // Field names are arbitrary, so the only rejection left is a malformed name
    [
      "malformed field name",
      (d) => (rule(d).match = { type: "contains", field: "1bad-name", pattern: "x" }),
      /field/,
    ],
    ["invalid regex", (d) => (rule(d).match = { type: "regex", pattern: "(" }), /regex/],
    ["watch is an empty array", (d) => (rule(d).watch = []), /watch/],
    ["relative path in watch", (d) => (rule(d).watch = ["work/x.json"]), /absolute/],
    ["** used in watch", (d) => (rule(d).watch = ["/w/**/x.json"]), /'\*\*'/],
    ["partial wildcard * in watch", (d) => (rule(d).watch = ["/w/proj*/x.json"]), /partial wildcard/],
    ["trailing * in watch", (d) => (rule(d).watch = ["/w/proj/*"]), /last segment/],
    ["notify.message missing", (d) => (rule(d).notify = { title: "T" }), /message/],
    ["sound containing a symbol", (d) => (rule(d).notify = { message: "M", sound: "Pop!" }), /sound/],
    ["sound of 31 chars", (d) => (rule(d).notify = { message: "M", sound: "s".repeat(31) }), /sound/],
    ["pollIntervalMs < 200", (d) => (defaults(d).pollIntervalMs = 100), /pollIntervalMs/],
    ["globRefreshMs < 5000", (d) => (defaults(d).globRefreshMs = 1000), /globRefreshMs/],
    ["negative throttleMs", (d) => (rule(d).throttleMs = -1), /throttleMs/],
    ["pollIntervalMs as a string", (d) => (defaults(d).pollIntervalMs = "1000"), /pollIntervalMs/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const data = baseConfig();
    mutate(data);
    assert.throws(() => validateConfig(data), ConfigError, name);
    assert.throws(() => validateConfig(data), pattern, name);
  }

  function rule(d: Record<string, unknown>): Record<string, unknown> {
    return (d.rules as Record<string, unknown>[])[0]!;
  }
  function defaults(d: Record<string, unknown>): Record<string, unknown> {
    return d.defaults as Record<string, unknown>;
  }
});

test("a regex with a nested unbounded quantifier (ReDoS) raises ConfigError", () => {
  for (const pattern of ["(a+)+$", "([a-z]*)*", "(\\d+)*", "((ab)+)+", "(a{1,}){2,}"]) {
    const data = baseConfig();
    (data.rules as Record<string, unknown>[])[0]!.match = { type: "regex", pattern };
    assert.throws(() => validateConfig(data), /ReDoS|backtracking/, pattern);
  }
});

test("a safe regex is accepted", () => {
  for (const pattern of ["^/work/", "permission", "a+b+", "(abc)?def", "[a-z]{1,10}"]) {
    const data = baseConfig();
    (data.rules as Record<string, unknown>[])[0]!.match = { type: "regex", pattern };
    assert.doesNotThrow(() => validateConfig(data), pattern);
  }
});

test("hasNestedUnboundedQuantifier: the check on its own", () => {
  assert.equal(hasNestedUnboundedQuantifier("(a+)+"), true);
  assert.equal(hasNestedUnboundedQuantifier("([a-z]*)*"), true);
  assert.equal(hasNestedUnboundedQuantifier("(a+)?"), false); // the outer quantifier is bounded
  assert.equal(hasNestedUnboundedQuantifier("(a+)b+"), false); // not nested
  assert.equal(hasNestedUnboundedQuantifier("a+b+"), false);
  assert.equal(hasNestedUnboundedQuantifier("a\\+b\\+"), false); // escaped quantifiers
  assert.equal(hasNestedUnboundedQuantifier("\\(a+\\)"), false); // escaped parentheses are not a group
});

test("a contains pattern longer than the match target cap (200) raises ConfigError", () => {
  const data = baseConfig();
  (data.rules as Record<string, unknown>[])[0]!.match = {
    type: "contains",
    pattern: "p".repeat(201),
  };
  assert.throws(() => validateConfig(data), /200/);
});

test("a contains pattern of exactly 200 is accepted", () => {
  const data = baseConfig();
  (data.rules as Record<string, unknown>[])[0]!.match = {
    type: "contains",
    pattern: "p".repeat(200),
  };
  assert.doesNotThrow(() => validateConfig(data));
});

test("notify.subtitle is optional and preserved verbatim when given", () => {
  assert.equal(validateConfig(baseConfig()).rules[0]!.subtitle, undefined);

  const data = baseConfig();
  (data.rules as Record<string, unknown>[])[0]!.notify = {
    message: "M",
    subtitle: "done 🚀 {{dir}}",
  };
  assert.equal(validateConfig(data).rules[0]!.subtitle, "done 🚀 {{dir}}");
});

test("an empty or non-string notify.subtitle raises ConfigError", () => {
  for (const subtitle of ["", 123, null]) {
    const data = baseConfig();
    (data.rules as Record<string, unknown>[])[0]!.notify = { message: "M", subtitle };
    assert.throws(() => validateConfig(data), /subtitle/);
  }
});

test("omitting source means json-state", () => {
  const config = validateConfig(baseConfig());
  assert.equal(config.rules[0]!.source.type, "json-state");
  assert.equal(config.rules[0]!.sourceKey, "json-state");
});

test("source: log-lines has a default windowBytes, reflected in sourceKey", () => {
  const data = baseConfig();
  (data.rules as Record<string, unknown>[])[0]!.source = { type: "log-lines" };
  (data.rules as Record<string, unknown>[])[0]!.match = { type: "contains", pattern: "ERROR" };
  const rule = validateConfig(data).rules[0]!;
  assert.equal(rule.source.type, "log-lines");
  assert.equal(rule.source.type === "log-lines" && rule.source.windowBytes, 1024 * 1024);
  assert.equal(rule.sourceKey, "log-lines:1048576");
});

test("source: an out-of-range windowBytes raises ConfigError", () => {
  for (const windowBytes of [1024, 32 * 1024 * 1024]) {
    const data = baseConfig();
    (data.rules as Record<string, unknown>[])[0]!.source = { type: "log-lines", windowBytes };
    (data.rules as Record<string, unknown>[])[0]!.match = { type: "contains", pattern: "E" };
    assert.throws(() => validateConfig(data), /windowBytes/);
  }
});

test("source: an unknown type raises ConfigError", () => {
  const data = baseConfig();
  (data.rules as Record<string, unknown>[])[0]!.source = { type: "bogus-source" };
  assert.throws(() => validateConfig(data), /source\.type/);
});

test("the default match.field varies by source type", () => {
  const forSource = (source: Record<string, unknown> | undefined): string => {
    const data = baseConfig();
    const rule = (data.rules as Record<string, unknown>[])[0]!;
    if (source !== undefined) rule.source = source;
    rule.match = { type: "contains", pattern: "x" };
    const match = validateConfig(data).rules[0]!.match;
    return match.type === "contains" ? match.field : "";
  };
  assert.equal(forSource(undefined), "message"); // json-state
  assert.equal(forSource({ type: "log-lines" }), "line");
  assert.equal(forSource({ type: "file-meta" }), "size");
});

test("match: the any type is always accepted", () => {
  const data = baseConfig();
  (data.rules as Record<string, unknown>[])[0]!.match = { type: "any" };
  assert.equal(validateConfig(data).rules[0]!.match.type, "any");
});

test("match: the equals type is an exact match on an arbitrary field", () => {
  const data = baseConfig();
  (data.rules as Record<string, unknown>[])[0]!.match = {
    type: "equals",
    field: "branch",
    value: "main",
  };
  const match = validateConfig(data).rules[0]!.match;
  assert.equal(match.type, "equals");
  assert.equal(match.type === "equals" && match.field, "branch");
  assert.equal(match.type === "equals" && match.value, "main");
});

test("match: an arbitrary field name can be used", () => {
  const data = baseConfig();
  (data.rules as Record<string, unknown>[])[0]!.match = {
    type: "contains",
    field: "customField_1",
    pattern: "x",
  };
  assert.doesNotThrow(() => validateConfig(data));
});

test("tccProtectedTargets: the count follows the input even with duplicates (deduplication is the caller's job)", () => {
  const home = os.homedir();
  const same = path.join(home, "Desktop", "proj", "state.json");
  // When several rules watch the same file, the caller deduplicates before passing them in
  assert.equal(tccProtectedTargets([same, same]).length, 2);
  assert.equal(tccProtectedTargets([...new Set([same, same])]).length, 1);
});

test("tccProtectedTargets: extracts only the TCC-protected paths", () => {
  const home = os.homedir();
  const targets = [
    path.join(home, "Documents", "proj", "app.log"),
    path.join(home, "Desktop", "state.json"),
    path.join(home, "Downloads", "x", "y.json"),
    path.join(home, "work", "proj", "app.log"), // not protected
    "/var/log/system.log", // not protected
    path.join(home, "DocumentsBackup", "a.log"), // a different directory that merely shares a prefix is excluded
  ];
  const found = tccProtectedTargets(targets);
  assert.equal(found.length, 3);
  assert.ok(found.every((f) => /Documents\/|Desktop\/|Downloads\//.test(f)));
  assert.ok(!found.some((f) => f.includes("DocumentsBackup")));
});

test("a duplicate id raises ConfigError", () => {
  const data = baseConfig();
  const first = (data.rules as Record<string, unknown>[])[0]!;
  data.rules = [first, { ...first }];
  assert.throws(() => validateConfig(data), /duplicate rule id/);
});

test("loadConfig: reads a valid file (0600)", (t) => {
  const dir = makeTmpDir(t);
  const file = writeConfigFile(dir, JSON.stringify(baseConfig()), 0o600);
  assert.equal(loadConfig(file).rules.length, 1);
});

test("loadConfig: reads JSON with comments (JSONC)", (t) => {
  const dir = makeTmpDir(t);
  const content = [
    "{",
    "  // leading line comment",
    '  "defaults": { "pollIntervalMs": 1000, "globRefreshMs": 30000, "throttleMs": 5000 },',
    "  /* block",
    "     comment */",
    '  "rules": [',
    "    {",
    '      "id": "rule-1",',
    '      "watch": ["/work/*/.claude/chirin-notify-state.json"],',
    '      // "watch": ["/work/only-one/.claude/chirin-notify-state.json"],',
    '      "match": { "type": "event", "equals": "Stop" },',
    '      "notify": { "title": "T", "message": "M {{dir}}", "sound": "Pop" },',
    '      "throttleMs": 3000',
    "    }",
    "  ]",
    "}",
  ].join("\n");
  const file = writeConfigFile(dir, content, 0o600);
  const config = loadConfig(file);
  assert.equal(config.rules.length, 1);
  assert.deepEqual(config.rules[0]!.watch, ["/work/*/.claude/chirin-notify-state.json"]);
});

test("loadConfig: 0644 (not group/other writable) is allowed", (t) => {
  const dir = makeTmpDir(t);
  const file = writeConfigFile(dir, JSON.stringify(baseConfig()), 0o644);
  assert.equal(loadConfig(file).rules.length, 1);
});

/** Changing ownership needs privileges; inject only uid while keeping real file type/mode/size. */
function mockOwner(t: TestContext, method: "lstatSync" | "statSync" | "fstatSync", uid: number): void {
  const original = fs[method];
  t.mock.method(fs, method, ((...args: unknown[]) => {
    const st = Reflect.apply(original, fs, args) as fs.Stats;
    st.uid = uid;
    return st;
  }) as typeof original);
}

test("loadConfig: rejects a different file owner despite safe mode bits", (t) => {
  const file = writeConfigFile(makeTmpDir(t), JSON.stringify(baseConfig()), 0o644);
  mockOwner(t, "lstatSync", process.getuid!() + 1);
  assert.throws(() => loadConfig(file), /config must be owned by the current user or root/);
});

test("loadConfig: rejects a different directory owner despite safe mode bits", (t) => {
  const file = writeConfigFile(makeTmpDir(t), JSON.stringify(baseConfig()), 0o644);
  mockOwner(t, "statSync", process.getuid!() + 1);
  assert.throws(() => loadConfig(file), /config directory must be owned by the current user or root/);
});

test("loadConfig: accepts root-owned files and directories for managed provisioning", (t) => {
  const file = writeConfigFile(makeTmpDir(t), JSON.stringify(baseConfig()), 0o644);
  mockOwner(t, "lstatSync", 0);
  mockOwner(t, "fstatSync", 0);
  mockOwner(t, "statSync", 0);
  assert.equal(loadConfig(file).rules.length, 1);
  fs.chmodSync(file, 0o666);
  assert.throws(() => loadConfig(file), /writable by group\/other/, "root ownership does not bypass mode checks");
});

test("loadConfig: skips uid checks when process.getuid is unavailable (Windows)", (t) => {
  const file = writeConfigFile(makeTmpDir(t), JSON.stringify(baseConfig()), 0o644);
  const getuid = process.getuid;
  Object.defineProperty(process, "getuid", { value: undefined, configurable: true, writable: true });
  t.after(() => Object.defineProperty(process, "getuid", { value: getuid, configurable: true, writable: true }));
  mockOwner(t, "lstatSync", 12345);
  mockOwner(t, "fstatSync", 12345);
  mockOwner(t, "statSync", 12345);
  assert.equal(loadConfig(file).rules.length, 1);
});

test("loadConfig: checks the opened inode's owner as well as the initial path", (t) => {
  const file = writeConfigFile(makeTmpDir(t), JSON.stringify(baseConfig()), 0o644);
  mockOwner(t, "fstatSync", process.getuid!() + 1);
  assert.throws(() => loadConfig(file), /config must be owned by the current user or root/);
});

test("config reads: reject oversized files before allocating or reading their contents", (t) => {
  const file = writeConfigFile(makeTmpDir(t), JSON.stringify(baseConfig()), 0o600);
  fs.truncateSync(file, 1024 * 1024 * 1024); // sparse fixture
  const read = t.mock.method(fs, "readSync");
  assert.throws(() => loadConfig(file), /config exceeds/);
  const bounded = readConfigText(file);
  assert.ok(bounded.kind === "rejected", "change detection must be bounded too");
  assert.match(bounded.error.message, /config exceeds/);
  assert.equal(read.mock.callCount(), 0);
});

test("config reads: accept valid JSON exactly at the byte limit", (t) => {
  const raw = JSON.stringify(baseConfig()).padEnd(MAX_CONFIG_BYTES);
  const file = writeConfigFile(makeTmpDir(t), raw, 0o600);
  assert.equal(loadConfig(file).rules.length, 1);
  assert.equal(configTextOf(file), raw);
  fs.appendFileSync(file, " ");
  assert.throws(() => loadConfig(file), /config exceeds/);
  assert.equal(readConfigText(file).kind, "rejected");
});

test("readConfigText: refuses symlinks and FIFOs during change detection", (t) => {
  const dir = makeTmpDir(t);
  const file = writeConfigFile(dir, JSON.stringify(baseConfig()), 0o600);
  const link = path.join(dir, "link.json");
  fs.symlinkSync(file, link);
  // O_NOFOLLOW fails the open itself, so the symlink never reaches the "is it a regular
  // file?" verdict. ELOOP carries that verdict on its own, and the swap has to be reported
  // like the directory and the FIFO below rather than waited out as a transient failure.
  assert.equal(readConfigText(link).kind, "rejected");
  const fifo = path.join(dir, "fifo.json");
  execFileSync("/usr/bin/mkfifo", [fifo]);
  assert.equal(readConfigText(fifo).kind, "rejected");
});

test("loadConfig: rejects a group-writable file (0620)", (t) => {
  const dir = makeTmpDir(t);
  const file = writeConfigFile(dir, JSON.stringify(baseConfig()), 0o620);
  assert.throws(() => loadConfig(file), /writable/);
});

test("loadConfig: rejects a group/other-writable parent directory (0777)", (t) => {
  const dir = makeTmpDir(t);
  const file = writeConfigFile(dir, JSON.stringify(baseConfig()), 0o600);
  fs.chmodSync(dir, 0o777);
  try {
    assert.throws(() => loadConfig(file), /directory must not be writable/);
  } finally {
    fs.chmodSync(dir, 0o700); // restore permissions so the after hook can rm it
  }
});

test("loadConfig: rejects a parent directory the current user cannot write (0500)", (t) => {
  const dir = makeTmpDir(t);
  const file = writeConfigFile(dir, JSON.stringify(baseConfig()), 0o600);
  // Traversable and readable, so the config itself loads: only the watcher lock, created in
  // this directory, would fail -- silently, three heartbeats later.
  fs.chmodSync(dir, 0o500);
  try {
    assert.throws(() => loadConfig(file), /directory must be writable/);
  } finally {
    fs.chmodSync(dir, 0o700); // restore permissions so the after hook can rm it
  }
});

test("loadConfig: rejects an other-writable file (0602)", (t) => {
  const dir = makeTmpDir(t);
  const file = writeConfigFile(dir, JSON.stringify(baseConfig()), 0o602);
  assert.throws(() => loadConfig(file), /writable/);
});

test("loadConfig: rejects a symlink", (t) => {
  const dir = makeTmpDir(t);
  const real = writeConfigFile(dir, JSON.stringify(baseConfig()), 0o600);
  const link = path.join(dir, "link.json");
  fs.symlinkSync(real, link);
  assert.throws(() => loadConfig(link), /regular file/);
});

test("loadConfig: a missing file raises ConfigError", () => {
  assert.throws(() => loadConfig("/no/such/config.json"), /not found/);
});

// A missing config is a waypoint of first-time setup, so the extension must be able to
// tell it apart from a "broken config". It is a subclass, so existing ConfigError checks
// still hold.
test("loadConfig: a missing file raises ConfigNotFoundError", () => {
  assert.throws(() => loadConfig("/no/such/config.json"), ConfigNotFoundError);
  assert.throws(() => loadConfig("/no/such/config.json"), ConfigError);
});

test("loadConfig: a broken config is not a ConfigNotFoundError", (t) => {
  const dir = makeTmpDir(t);
  const file = writeConfigFile(dir, "{ not json", 0o600);
  assert.throws(() => loadConfig(file), (err: unknown) => {
    assert.ok(err instanceof ConfigError);
    assert.ok(!(err instanceof ConfigNotFoundError));
    return true;
  });
});

test("loadConfig: invalid JSON raises ConfigError", (t) => {
  const dir = makeTmpDir(t);
  const file = writeConfigFile(dir, "{ not json", 0o600);
  assert.throws(() => loadConfig(file), /JSON/);
});

// Auto-reload decides on "did the content change?". Comparing content rather than mtime
// matters because rebuilding the watch on a save that changed nothing would reset the source
// baselines and drop events arriving in that gap.
test("readConfigText: returns the content verbatim", (t) => {
  const dir = makeTmpDir(t);
  const file = writeConfigFile(dir, JSON.stringify(baseConfig()), 0o600);
  assert.equal(configTextOf(file), JSON.stringify(baseConfig()));
});

test("readConfigText: a changed content yields a different value", (t) => {
  const dir = makeTmpDir(t);
  const file = writeConfigFile(dir, "{ \"a\": 1 }", 0o600);
  const before = configTextOf(file);
  fs.writeFileSync(file, "{ \"a\": 2 }");
  assert.notEqual(configTextOf(file), before);
});

// Validation is loadConfig's job. If change detection did not treat broken content as
// "read", it would latch onto content caught mid-save and miss the next save.
test("readConfigText: returns the content without throwing even for broken JSON", (t) => {
  const dir = makeTmpDir(t);
  const file = writeConfigFile(dir, "{ not json", 0o600);
  assert.equal(configTextOf(file), "{ not json");
});

// loadConfig rejects permission violations. Throwing here would stop the watch loop.
test("readConfigText: does not throw for a group-writable file", (t) => {
  const dir = makeTmpDir(t);
  const file = writeConfigFile(dir, "{}", 0o666);
  assert.equal(configTextOf(file), "{}");
  assert.throws(() => loadConfig(file), /writable by group\/other/);
});

test("readConfigText: a missing file is transient, not a rejection", () => {
  assert.equal(readConfigText("/no/such/config.json").kind, "unreadable");
});

test("readConfigText: a directory is rejected, not merely unreadable", (t) => {
  const dir = makeTmpDir(t);
  assert.equal(readConfigText(dir).kind, "rejected");
});
