# chirin 🎐

**Word on the wind.** A zero-dependency VS Code extension that carries file changes to the
macOS Notification Center — first of all, Claude Code hooks that fire inside a devcontainer
with no network egress.

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/kei-ikeda.chirin?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=kei-ikeda.chirin)
[![CI](https://github.com/Kei-Ikeda/chirin/actions/workflows/ci.yml/badge.svg)](https://github.com/Kei-Ikeda/chirin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen)
![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)

> 風の便り — *kaze no tayori*: news that reaches you on the wind, from somewhere you cannot see.

<!--
  Screenshot: a chirin notification as it appears in the macOS Notification Center.
  Save the image as media/screenshot.png (media/ ships in the .vsix, and vsce rewrites the
  relative path for the Marketplace), then replace this comment with:

  <p align="center">
    <img src="media/screenshot.png" width="520" alt="A chirin notification in the macOS Notification Center: title Claude Code, subtitle Complete, and the repository name as the message">
  </p>
-->

chirin watches a handful of files on the host. When one of them changes, a rule decides
whether that is worth a notification and how it should read, and macOS rings. Its main use is
getting Claude Code hooks (`Stop`, `Notification` and friends) that fire inside an
egress-blocked devcontainer through to the host — but nothing in it is tied to Claude Code. It
also **follows an application's log file** and **reports updates to any file** (see
[Source types](#source-types)).

- **Zero dependencies.** `dependencies` is empty, and CI fails if it is not. The only runtime is the VS Code extension host
- **No network.** The only delivery path is a file in the already bind-mounted workspace. No egress policy needs loosening
- **Auditable.** The whole extension is a few thousand lines of TypeScript. No bundler is used, so unpacking the `.vsix` shows exactly the code that runs
- **A bell, not a hand.** chirin rings; it never runs anything. "Run a command on match" is a permanent non-goal, because it would turn untrusted container-side input into code execution on the host

> **macOS only.** Notifications go through `osascript`, so on Windows and Linux the extension activates but no notification appears.

## The name

*Chirin* (ちりん) is the sound a Japanese wind chime makes. A **fūrin** (風鈴, "wind bell")
hangs under the eaves through the summer, and nobody strikes it: it rings only when the air
moves. Its ancestors, the bronze **fūtaku** hung from temple roofs, were said to keep
misfortune away from any place their sound could reach.

There is an old phrase for what a chime tells you — **kaze no tayori** (風の便り), "word on
the wind": news that arrives from somewhere you cannot see. A devcontainer with its egress
blocked is such a place. chirin does not cut a window into that wall. It hangs a chime on the
one thing that already passes through it, the bind-mounted workspace, and rings when Claude
Code has something to say.

That is the whole design. A chime has no motor and nothing to say of its own; it only makes a
change in the air audible.

## When you need chirin

Claude Code has built-in notification channels, and **if you run it in iTerm2 on the host,
those are better**: the notification is attributed to iTerm2 and clicking it takes you to the
terminal. chirin goes through osascript, so the source shows up as Script Editor and clicking
does not navigate anywhere.

chirin is for the setups where the built-in notifications never reach the host's Notification
Center.

| Setup | Recommendation |
|---|---|
| Host + iTerm2 | Claude Code's built-in notifications |
| **Running inside a devcontainer** (the VS Code integrated terminal, say) | **chirin** (the built-in notifications are unavailable, and the container cannot reach `osascript` either) |
| Watching log files or arbitrary files | **chirin** (usable with no connection to Claude Code) |

To run both, the hook can check `TERM_PROGRAM` to avoid duplicate notifications.

## How it works

```
[devcontainer]
  Claude Code hook (Stop / Notification)
        │ writes to tmp → renames onto chirin-notify-state.json (atomic swap)
        ▼
  <workspace>/.claude/chirin-notify-state.json
        │ bind mount (an existing path; no network)
━━━━━━━━┿━━━━━━━━━━ container boundary
        ▼
[macOS]
  chirin extension (VS Code's UI extension host)
        │ readFile every second → compare the ts field with the previous value
        │ changed → rule match → throttle → sanitize
        ▼
  /usr/bin/osascript (fixed script + argv)
        ▼
  Notification Center
```

This is a **UI extension** (`"extensionKind": ["ui"]`). Even with a devcontainer open, the
extension host lives on the host macOS side, so it can call `osascript` and read the host's
real paths directly. The container is treated as untrusted: the content of the state file is
sanitized and validated before any notification (AppleScript injection defenses, control
character stripping, a 64KB cap, throttling and more). See [Design notes](#design-notes) for the reasoning.

## Setup

Everything is done from VS Code on the host. There is no work to do inside the container.

### Requirements

- macOS (Apple Silicon / Intel)
- VS Code 1.101 or later. No separate Node.js installation is needed (it runs on the extension host's Node)
- To use the hook inside a container, that container needs `node` and `bash`

### Once, up front (VS Code)

1. Install the extension, either way

   - **From the Marketplace**: search for `chirin` in the Extensions view (`Shift+Cmd+X`) and pick the one published by **kei-ikeda**, or run

     ```bash
     code --install-extension kei-ikeda.chirin
     ```

   - **From a `.vsix`**: download `chirin-<version>.vsix` from the [Releases page](https://github.com/Kei-Ikeda/chirin/releases), check its SHA-256 against the value in the release notes, then install

     ```bash
     shasum -a 256 chirin-<version>.vsix
     code --install-extension chirin-<version>.vsix
     ```

     You can also build the `.vsix` yourself from the repository with `npm ci && npm run package`.

2. Follow the **"Set up chirin" walkthrough** that opens right after installation

   If it does not open on its own, run `chirin: Open setup` from the Command Palette (`Shift+Cmd+P`).
   Each step of the walkthrough launches the corresponding command below.

   | Step | Command |
   |---|---|
   | 1 | `chirin: Create config file` … creates `~/.config/chirin/config.json` with mode 0600 and opens it in the editor |
   | 2 | (edit the watch targets in the editor and save) |
   | 3 | (a save is applied automatically within a few seconds; for an immediate reload, use `chirin: Reload config`) |
   | 4 | `chirin: Validate config` … lists the expanded watch targets in the output panel |
   | 5 | `chirin: Send test notification` … **respond to the macOS notification permission prompt here** |

3. Check the state in `$(bell) chirin` at the right end of the status bar

   Clicking it takes you to the "next thing to do" for the current state. Hovering shows the details.

   Only one window watches at a time (see [Multiple windows and leader election](#multiple-windows-and-leader-election)),
   but notifications appear in the macOS Notification Center, so **it makes no difference which
   window is watching**. Both sides therefore show the same `chirin` label, and the hover
   explains which one you are looking at.

   **A state name appears only when you have something to do.** A bare `chirin` means everything is fine.

   | Display | Meaning | Click target |
   |---|---|---|
   | `chirin` | Watching is running (healthy). The hover says whether it is **this window or another one** (see [Multiple windows and leader election](#multiple-windows-and-leader-election)) | Show log |
   | `chirin: Electing` | Leader election has not settled yet (normally becomes `chirin` in an instant) | Show log |
   | `chirin: Unknown` | Lock operations keep failing and **whether any window is watching cannot be determined**. Notifications may have stopped | Show log |
   | `chirin: Disabled` | `chirin.enabled` is false | **Resume watching** |
   | `chirin: Not configured` | No config yet (the normal state on a first run) | Open setup |
   | `chirin: Config error` | The config could not be read | Open config file |

### Once per repository

Open the repository you want notifications for in VS Code and run `chirin: Install the Claude
Code hook into this project` from the Command Palette (`Shift+Cmd+P`). The steps are identical
whether the folder is open in a devcontainer or locally. **This command rewrites the following
three files inside the workspace** (`.gitignore` included).

1. Places `.claude/hooks/chirin-notify.sh`
2. Merges into the `hooks` section of `.claude/settings.local.json`. An existing chirin entry is replaced rather than duplicated, so re-running picks up a changed hook invocation without registering it twice (the file is re-serialized with two-space indentation)
3. Appends a `# chirin` block to the end of `.gitignore`, untracking the three files chirin writes into the workspace: `.claude/hooks/chirin-notify.sh`, `.claude/chirin-notify-state.json` and `.claude/.chirin-notify-tmp-*`

Step 3 only appends; it never rewrites an existing line, and does nothing when the same line is
already present. In a repository without a `.gitignore`, one is created. Note that chirin does
not add `.claude/settings.local.json` itself: that file belongs to Claude Code, and whether to
track it is the repository's decision (add it to `.gitignore` yourself if you would rather not).

It writes to the personal, local `.claude/settings.local.json` rather than the shared
`.claude/settings.json` because this hook only means anything in the installer's own
environment: a macOS host, with chirin installed, whose config watches this repository.
Writing to the shared file would put a personal difference into a committed file and ship a
hook that does not work to teammates on other operating systems.

The hook script itself is ignored for the same reason, and because it changes between chirin
releases — tracking it would put a diff in the repository every time someone re-runs the
command to pick an update up. If your team does want it committed, delete that line from the
`# chirin` block; `.gitignore` has no effect on a file that is already tracked.

To do it by hand, copy `hooks/chirin-notify.sh` from inside the `.vsix` to
`<workspace>/.claude/hooks/chirin-notify.sh` and merge the content of
`hooks/settings.example.json` into `<workspace>/.claude/settings.local.json`. The hook is
invoked as `bash <path>`, so it needs no executable bit.

#### Breaking change in 0.9.0 (renamed files)

The generic names `notify.sh` and `notify-state.json` were easy to confuse with other tools'
artifacts, so every file chirin handles was renamed to start with `chirin-`.

| Old | New |
|---|---|
| `.claude/hooks/notify.sh` | `.claude/hooks/chirin-notify.sh` |
| `.claude/notify-state.json` | `.claude/chirin-notify-state.json` |
| `.claude/.notify-tmp-*` | `.claude/.chirin-notify-tmp-*` |

**In repositories where the hook was installed on 0.8.0 or earlier, the old files are not
cleaned up automatically.** After re-running `chirin: Install the Claude Code hook into this
project`, do the following by hand. Re-running alone leaves the old hook registration in
`.claude/settings.local.json`, and **the same event notifies twice**.

1. Delete the old hook entry calling `notify.sh` from `.claude/settings.local.json`
2. Delete `.claude/hooks/notify.sh`, `.claude/notify-state.json` and `.claude/.notify-tmp-*`
3. Delete the two stale lines left in the `# chirin` block of `.gitignore` (the new lines are appended by the re-run)

The `watch` patterns in the host-side config (`~/.config/chirin/config.json` by default) also
need `notify-state.json` changed to `chirin-notify-state.json`. Afterwards, confirm with
`chirin: Validate config` that the targets appear under `targets now`.

## Commands

Open the Command Palette (`Shift+Cmd+P`), type `chirin` and pick one.

| Command | What it does |
|---|---|
| `chirin: Create config file` | Creates `~/.config/chirin/config.json` from the template (mode 0600). An existing file is overwritten only after confirmation |
| `chirin: Open config file` | Opens the config in the editor |
| `chirin: Validate config` | Validates the config and prints the expanded rules and watch targets to the output panel |
| `chirin: Send test notification` | Fires one notification from a dummy event (for the first permission prompt). Picking a rule uses that rule's template and sound settings. The default uses the `Pop` sound, so the audio path is exercised too |
| `chirin: Reload config` | Re-reads the config and rebuilds the watch (for when you want a save applied immediately rather than waiting) |
| `chirin: Start / stop watching` | Toggles `chirin.enabled` |
| `chirin: Show log` | Opens the chirin channel in the output panel |
| `chirin: Install the Claude Code hook into this project` | Installs the hook into the open workspace |
| `chirin: Open setup` | Opens the first-run setup walkthrough |

Errors are surfaced through three paths: a notification popup, the output panel and the status
bar. The extension activates even with a broken config, and the commands always work (so the
path to fixing the config is never lost).

### Automatic config reload

When you save the config, every window notices the change within a few seconds and rebuilds its
watch. **Editing in any window applies**, so you never have to care which window is notifying.

If the saved content is broken (a mid-edit save, say), chirin **keeps watching with the last
valid config** and raises a warning in the status bar and the output panel. This keeps
notifications from stopping silently; fixing and saving again recovers automatically. No popup
is shown in that case (one on every save would get in the way of editing). Running
`chirin: Reload config` explicitly still reports errors through all three paths.

## Extension settings

All of them are `scope: application` (user settings only). That is deliberate, so a
`.vscode/settings.json` the container can write cannot override them — **do not change it**.

| Setting | Default | Description |
|---|---|---|
| `chirin.configPath` | `""` | Path to config.json. When empty, `~/.config/chirin/config.json` |
| `chirin.enabled` | `true` | Enable file watching |
| `chirin.showInEditorToast` | `false` | Also show a notification inside the VS Code window, in addition to the OS notification |

### Multiple windows and leader election

A VS Code extension host is one process per window. Left alone, three open windows would notify
three times for the same event, so chirin's windows contend for a lock file in the same
directory as the config (`watcher.lock`, mode 0600) and **only the window that becomes leader
watches**.

- Closing the leader's window releases the lock immediately and another window takes over
- If the leader is force-quit, another window detects the missing heartbeats and takes over. The heartbeat is a fixed 1 second, deliberately independent of `pollIntervalMs`: the lock goes stale after five missed heartbeats (5 seconds) and followers retry every 5 seconds, so the handover completes within roughly 10 seconds regardless of how `pollIntervalMs` is set
- `chirin.configPath` is `scope: application`, so it is shared by every window in the profile. That means a single lock, and exactly one watching window among those opened in the same profile

## Config reference

`~/.config/chirin/config.json` (host side, outside the workspace). It is refused at startup if the
file or its directory is group/other writable, or if the file is a symlink.

The extension is `.json`, but **it is read as JSON with comments (JSONC)**. `//` and `/* */`
are allowed, so unused settings can be left commented out (trailing commas are not supported).
Opening it through `chirin: Open config file` displays it as jsonc.

```jsonc
{
  "defaults": {
    // How often each watched file is read (>= 200)
    "pollIntervalMs": 1000,
    // How often the watch patterns are expanded again, i.e. how quickly a new repository
    // joins the watch set (>= 5000)
    "globRefreshMs": 30000,
    // Default suppression window per rule and file; a rule can override it (>= 0)
    "throttleMs": 5000
  },
  "rules": [
    {
      "id": "claude-stop",
      "watch": ["~/src/*/*/*/.claude/chirin-notify-state.json"],
      // Only a real completion, not a turn that parked to wait for background work
      "match": { "type": "regex", "field": "background_task_count", "pattern": "^0$" },
      "notify": {
        "title": "Claude Code",
        "subtitle": "Complete 🚀",
        "message": "{{dir}}",
        "sound": "Glass"
      },
      "throttleMs": 3000
    },
    {
      "id": "claude-notification",
      "watch": ["~/src/*/*/*/.claude/chirin-notify-state.json"],
      // Only a permission request from your own session, not background-agent traffic
      "match": { "type": "regex", "field": "notification_type", "pattern": "^permission_prompt$" },
      "notify": {
        "title": "Claude Code",
        "subtitle": "Ask for you 🤖",
        "message": "{{dir}}: {{message}}",
        "sound": "Ping"
      }
    }
  ]
}
```

Notifications scan best as three tiers: **title (who) / subtitle (what happened) / message
(details)**. Varying the sound by event type (`Glass` for completion, `Ping` for a pending
confirmation, say) lets you tell them apart without looking at the screen.

| Field | Description |
|---|---|
| `defaults.pollIntervalMs` | File read interval (>= 200, default 1000) |
| `defaults.globRefreshMs` | Glob re-expansion interval, i.e. new project detection (>= 5000, default 30000) |
| `defaults.throttleMs` | Default notification suppression window for a rule (>= 0, default 5000) |
| `rules[].id` | `/^[a-z0-9][a-z0-9-]{0,63}$/`, unique |
| `rules[].watch` | Watch patterns. `~/` expands to home. The only wildcard is a whole path segment `*` (`**` and `foo*` are not allowed). The last segment is a file name. Literal directories in a level an untrusted party such as a container can write are limited to one (see [Known limitations](#known-limitations-and-pitfalls)) |
| `rules[].source` | Watch method. Defaults to `{ "type": "json-state" }`. See [Source types](#source-types) |
| `rules[].match.type` | `any` / `event` / `equals` / `contains` / `regex`. See the table below |
| `rules[].notify.title` | Template. Truncated to 60 characters after expansion. Defaults to `"chirin"` |
| `rules[].notify.subtitle` | Template. The notification's second line. Truncated to 60 characters after expansion. Optional |
| `rules[].notify.message` | Template. Required. Truncated to 120 characters after expansion |
| `rules[].notify.sound` | `/^[A-Za-z ]{1,30}$/` (e.g. `Pop`). No sound when omitted. The name is looked up in the macOS sound directories, so a sound of your own works too: put `chirin.aiff` in `~/Library/Sounds/` and write `"chirin"` (the file name without its extension) |
| `rules[].throttleMs` | Notification suppression window per rule x file. Defaults to `defaults.throttleMs` |

### Match types

| type | Fields | Meaning |
|---|---|---|
| `any` | — | Always matches. For notifying that something changed at all |
| `event` | `equals` | Exact match against the `event` field (a shorthand for `json-state`) |
| `equals` | `field`, `value` | Exact match against an arbitrary field |
| `contains` | `field`, `pattern` | Substring (`pattern` <= 200 characters) |
| `regex` | `field`, `pattern` | Regular expression (`pattern` <= 256 characters) |

The default when `field` is omitted varies by source type (`json-state`→`message`,
`log-lines`→`line`, `file-meta`→`size`). The match target is truncated to its first 200
characters at runtime (a ReDoS defense).

Nested quantifiers prone to catastrophic backtracking (`(a+)+`, for instance) are rejected at
startup. If one slips through, a runtime safety net remains: the time a `regex` rule spends
matching one file's events in a poll cycle is measured afterwards, and a rule that exceeds
100ms is disabled for the rest of the session with a warning. That bounds a sustained slowdown
to a single delay, but it is not a hard limit: it cannot interrupt an evaluation already under
way, and on a `log-lines` source a large append can trip it for a benign pattern.

### Source types

| type | Change detection | Read limit | On overflow | Exposed fields |
|---|---|---|---|---|
| `json-state` | A change in the `ts` field | 64KB | **Reject** (anomalous for a state file) | `ts` / `event` / `notification_type` / `background_task_count` / `message` / `cwd` plus arbitrary fields from the JSON |
| `log-lines` | Appended lines (already-notified lines excluded by hash) | `windowBytes` (default 1MB, 4KB–16MB) | **Read only the tail window** (warning states how much was skipped) | `line` |
| `file-meta` | `mtime` + `size` | Content is never read | — | `size` / `mtime` |

#### Filtering out background-agent notifications

Claude Code raises a `Notification` event for background agents, teammates and cloud sessions
as well as for your own session, and the message text cannot tell them apart. The hook writes
Claude Code's `notification_type` into the state file so a rule can, and **the default template
matches on it rather than on the event**:

```jsonc
"match": {
  "type": "regex",
  "field": "notification_type",
  "pattern": "^permission_prompt$"
}
```

The field is `""` for every non-`Notification` event, so such a rule never fires for `Stop`.
The default deliberately rings only for a permission request — a question you have to answer.
Notably it leaves out `idle_prompt` ("Claude is waiting for your input"), which fires whenever
the session goes idle **including while background work is still running**; adding it back
brings a ping on every parked turn.

The values Claude Code uses are `permission_prompt`, `idle_prompt`, `auth_success`,
`elicitation_dialog`, `agent_needs_input`, `agent_completed`, `elicitation_url_dialog`,
`worker_permission_prompt`, `push_notification`, `computer_use_enter`, `computer_use_exit`,
`quota_auto_resume_fired`, `quota_auto_resume_stale`, `quota_auto_resume_disabled`. Add
`idle_prompt` for a "your turn" ping, `agent_needs_input|agent_completed` to hear background
agents, or give them their own rule with a different sound.

#### Notifying only on a real completion

`Stop` fires at the end of every turn — including a turn that ended only because the session
parked to wait for background work (a background agent, a backgrounded shell, a workflow).
Notifying on `Stop` alone therefore announces "done" once per intermediate stop.

The hook writes how much work is still in flight, and **the default template uses it** so
"Complete 🚀" fires only on a real completion:

```jsonc
"match": { "type": "regex", "field": "background_task_count", "pattern": "^0$" }
```

`background_task_count` is written only for `Stop` and `SubagentStop`, so such a rule never
fires for a `Notification`. To go back to notifying on every turn, use
`{ "type": "event", "equals": "Stop" }`.

> Already installed the hook before this? Re-run `chirin: Install the Claude Code hook into
> this project` to pick up the new fields — an older `chirin-notify.sh` writes neither
> `notification_type` nor `background_task_count`, so a rule matching on them stays
> permanently silent.

A `log-lines` example (follow an application log and notify only on error lines):

```json
{
  "id": "app-errors",
  "watch": ["~/src/*/app.log"],
  "source": { "type": "log-lines", "windowBytes": 1048576 },
  "match": { "type": "contains", "pattern": "ERROR" },
  "notify": { "title": "App error", "message": "{{dir}}: {{line}} ({{count}})" }
}
```

A `file-meta` example (report an update regardless of content):

```json
{
  "id": "export-done",
  "watch": ["~/src/*/export.csv"],
  "source": { "type": "file-meta" },
  "match": { "type": "any" },
  "notify": { "message": "{{file}} updated ({{size}} bytes)" }
}
```

### Template placeholders

| Name | Content | Trust |
|---|---|---|
| `{{dir}}` | Directory name derived from the watched file path (the `*` segment above it, or one higher when that is `.claude`) | path-derived, but a container can pick the name when that `*` level lies inside a workspace, so it is treated as **untrusted → sanitized** like the source fields |
| `{{file}}` | Basename of the watched file | trusted |
| `{{count}}` | Number of matches for that rule within the same cycle | trusted |
| A source's exposed fields | `line` / `message` / `size` and the rest from the table above | **untrusted → sanitized** |

Unknown placeholders are left as-is. When the same rule matches several times within one cycle,
they are **collapsed into a single notification** whose body carries the latest event and
`{{count}}`.

## Known limitations and pitfalls

- **Closing every VS Code window stops notifications**: the extension only runs inside a VS Code window. There is no mechanism to stay resident from login. One open window is enough
- **Startup follows VS Code's**: activation is on `onStartupFinished`, so nothing is watched for the first few seconds after opening a window
- **No notifications outside macOS**: installing on Windows or Linux does not crash the extension, but no notification appears and only a warning is logged (there is no mechanism to restrict a `.vsix` by platform)
- **Notification attribution**: because it goes through osascript, the Notification Center shows the source as Script Editor (the exact wording varies by OS version). Grant permission with `chirin: Send test notification` first, then confirm it under System Settings → Notifications. Showing our own app name would require a signed .app and is not supported
- **Notifications disappear after a few seconds (banner)**: to keep them on screen, go to System Settings → Notifications → (the entry that appeared after the test notification) and choose "Alerts". The entry does not show up in the notification list until a notification has been posted, so make this change after the test notification. It cannot be set from the config (`display notification` has no syntax for choosing banner or alert). The setting is per app, so notifications from other tools using the same osascript become alerts too. Note that a "banner" still accumulates in the Notification Center (the difference is only whether it stays on screen)
- **No notification grouping**: osascript cannot replace an existing notification, so notifications pile up. The default throttle (5 seconds) softens this
- **TCC-protected directories**: watching anything under `~/Desktop`, `~/Documents` or `~/Downloads` requires TCC permission, which means granting **VS Code itself** the equivalent of Full Disk Access. If you would rather not, keep the watch targets in an unprotected directory such as `~/src` (`chirin: Validate config` warns about any affected target)
- **Focus mode (DND)**: notifications are not displayed during Focus. Accepted as designed
- **`Stop` fires every turn**: a run of short exchanges produces a lot of notifications. Tune it with the watcher-side throttle and match rules. The default template already drops the intermediate stops by matching `background_task_count` on `^0$`
- **Event coalescing**: with `json-state`, when several events occur within one poll interval only the latest is notified (a consequence of the single state file and last-write-wins)
- **"Run a command on match" will never be supported**: a permanent non-goal, not a gap waiting for a pull request (the reason is in the principles at the top of this README)
- **At most one literal directory in an untrusted level**: the symlink check covers only the single level directly above the watched file. With `~/src/*/*/*/.claude/chirin-notify-state.json`, the container-writable level has one literal segment (`.claude`) and a swap is detected; with two or more, as in `~/src/*/logs/app/error.log`, replacing an upper directory (`logs`) with a symlink can make chirin read a different file on the host (only up to each field's character limit reaches the notification, but it is still an information disclosure path). When watching a container-writable area, use a pattern with no deep literal hierarchy
- **Keep the config outside the workspace**: if the config or lock file lives inside the workspace (i.e. somewhere that can be bind-mounted into the container), it is writable from the container even after passing the permission checks. If you move it away from the default `~/.config/chirin/`, keep it outside the workspace too (a config inside one warns at startup and on `chirin: Validate config`)
- **The in-window toast appears in the leader window**: notifications are fired by the Watcher in the window holding the lock, so the `chirin.showInEditorToast` toast appears there (not in whichever other window has focus). Anything missed is covered by the OS notification, which always appears

### `log-lines` specifics

- **Loss handling is best-effort**: if more than `windowBytes` is written within a single poll interval, the excess is not read. The 1MB default corresponds to roughly 11,000 lines per second, so it is normally out of reach — and **when a skip does happen, a warn log states "skipped N bytes"** (never dropped silently). Raise `windowBytes` for high log volume
- **Repeats are suppressed against the previous batch**: a line identical (by hash) to one in the most recently read batch of lines is not notified again, so a message repeated on every poll does not ring on every poll. Within one batch, identical lines collapse into a single notification whose `{{count}}` carries how many there were. A line that reappears after a batch without it notifies again
- **Tracking starts from what is appended after watching begins**: content already in the file when watching starts is not notified (this keeps old log lines from notifying every time a window is reopened)
- **Log rotation**: when the size shrinks, reading restarts from the beginning. A rotation first observed with the new file already larger than the old one cannot be detected

## Design notes

A wind chime is a simple object: a bell, a clapper and a strip of paper to catch the wind.
Most of what makes chirin trustworthy is likewise what it leaves out — no network, no
dependencies, no execution — and the notes below explain why each absence is deliberate.

Everything here is reasoning that the code cannot show on its own. Anything that *is* visible
in the code — module responsibilities, constants, the exact lock protocol — is documented in
comments next to the code instead, so it cannot drift out of sync.

### Architecture decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | The only delivery path is a file on the bind mount | Preserves the egress block. No additional communication path (HTTP/SSH/socket) is created |
| 2 | **A single state file overwritten**, not an append log or a spool | The point of a notification is to convey the latest state. last-write-wins is the correct specification, and it removes the whole complexity of a tailer (offset tracking, truncation detection, partial lines) and of a spool (cleanup, deduplication) |
| 3 | Writes are **to a tmp file, then renamed within the same directory** | POSIX rename is atomic within a filesystem. The watcher always reads either the complete old version or the complete new one; a half-written state is never observed |
| 4 | Detection is **readFile polling, not FS events** | On VirtioFS, events for container-side writes sometimes never reach the host. Keeping the update decision inside our own data (comparing the `ts` field) removes any dependence on the filesystem's notification mechanism |
| 5 | **Zero npm dependencies** (Node's standard library and the VS Code API only) | Eliminates supply-chain risk and keeps the code auditable. A primary selling point |
| 6 | Notifications run `/usr/bin/osascript` with a **fixed script plus argv** | The absolute path removes any dependence on PATH. The script body is a constant and data travels only through argv, which closes off AppleScript injection |
| 7 | The config lives in `~/.config/chirin/` (host side, outside the workspace) | Inside the workspace, the container could tamper with the rules |
| 8 | On startup and when a file joins the watch set, **only `ts` is recorded; nothing is notified**. The one exception is a file first observed *missing* at a watched path: its appearance is itself a new event, and it notifies on the first valid read | Prevents past events from notifying every time the extension host restarts, without dropping the very first notification after a hook is installed (the state file does not exist until the first event) |
| 9 | Runs as a **UI extension** (`extensionKind: ["ui"]`) | A workspace extension runs on the in-container extension host, moving chirin itself onto the untrusted side and rendering both sanitization and the config permission checks meaningless |
| 10 | Multiple windows are handled by **leader election through a lock file** | The extension host is one process per window and the throttle is an in-process Map. Without suppression, one event notifies once per window |
| 11 | Config changes are applied automatically, with **every window polling the content** | Only the leader notifies, but each window holds the config as a snapshot taken at `start()`. Reloading anywhere but the leader would have no effect, and a promoted follower would run on a stale config. Running detection in every window makes the outcome independent of where the edit happened |

### Threat model

- **Trust boundary**: the container is untrusted. Everything in the watched files is treated as attacker-controlled input
- **What is protected**: the host's runtime environment. Code execution, injection and resource exhaustion using the notification app as a stepping stone must all be prevented
- **The boundary is redrawn per output sink**: the same untrusted string needs different handling depending on whether it goes to osascript or to the VS Code notification API. "It is sanitized, so it is safe" is not enough — look at what the destination interprets, case by case

| Vector | Defense |
|---|---|
| AppleScript / shell injection through the notification body | osascript with a fixed script plus argv. Building commands by string concatenation is banned outright |
| Link injection into the in-window toast (phishing) | The VS Code notification API renders `[label](url)` in the body as a clickable link. `](` is broken right before display so it never forms link syntax |
| Control characters and escape sequences | Sanitization (removing U+0000–U+001F, U+007F and the rest) plus length limits |
| Memory exhaustion through a huge file | stat before reading, then reject or read only the tail according to the per-source-type limit |
| Malicious input to a user-defined regex (ReDoS) | The match target is capped at 200 characters. The pattern length is capped at 256, and nested unbounded quantifiers are rejected at load |
| Config tampering | Kept outside the workspace. Refused at startup if the file or its directory is group/other writable, or if the file is a symlink. Warned about if it sits inside the workspace |
| Notification flooding | A throttle per rule x file (default 5000ms) plus at most 5 notifications per poll cycle |

Every limit and validation in the code is tied to this model. Do not remove one because it
looks redundant.

### The parts of the code that look stranger than they are

- **`src/leader.ts`** — the lock operations (`rename` → validate → restore with `link`, an in-place write to an fd rather than a rename) are each a defense against a specific race that produces two leaders, i.e. duplicate notifications. Every one of them is explained in a comment at the point it happens. The heartbeat is a fixed 1s, deliberately decoupled from `pollIntervalMs`, so that all windows measure lock freshness with the same yardstick
- **`src/fileread.ts`** — `O_NOFOLLOW` / `O_NONBLOCK` plus an `fstat` after open exist to survive a symlink swap, a FIFO in place of a file, and a TOCTOU replacement between stat and read. The layer deliberately makes no decision about size limits; that belongs to the source adapters
- **`src/glob.ts`** — the per-directory and per-pattern caps bound an attack where the container fills the watched hierarchy with directories. Truncation is always warned about, never silent
- **Notifications stopping silently is the worst failure.** Several choices follow from that alone: a missing `background_tasks` counts as 0, a config that fails to parse keeps the previous one running, and the status bar shows a distinct state when it cannot tell whether any window is watching

### Prior art

The closest design is [DevContainer Host Notifier](https://github.com/tkit/vscode-extension-devcontainer-host-notifier),
which shares the skeleton: the container writes a file, a host-side UI extension reads it.
[claude-notifications](https://github.com/dimokol/claude-notifications) and
[claude-code-notifier](https://github.com/egiray/claude-code-notifier) run the notification
from the hook itself, which cannot reach the host from inside a container.
[claude-notifier](https://github.com/ashmitb95/claude-notifier) covers remote setups by
forwarding events over SSH — the natural approach when egress blocking is not a premise, and
the reason chirin does not do it.

What chirin adds on top of the file-watching skeleton is rule- and template-based shaping,
a single notification across multiple windows, source types that have nothing to do with
Claude Code, and zero dependencies. It is worth using only where all three of "an
egress-blocked devcontainer", "several windows open" and "no new dependencies" apply.

## Development

```bash
npm ci
npm run check:zero-deps   # verify that dependencies is empty
npm run build             # tsc (src/*.ts, test/*.ts -> dist/**/*.js)
npm test                  # node:test (no added dependencies)
npm run package           # produce the .vsix
```

Opening this repository in VS Code and pressing `F5` launches an extension development host window.

The core (`sanitize` / `glob` / `jsonc` / `fileread` / `sources` / `watcher` / `config` /
`leader`) does not depend on the VS Code API. Only four files touch VS Code —
`extension.ts`, `commands.ts`, `vscodeLog.ts` and `vscodeNotifier.ts` — and the tests run on
`node:test` alone. That boundary is deliberate, so please do not import `vscode` into the core.

The notifier (real notifications) is outside the automated tests. Verify it by hand with
`chirin: Send test notification`.

The reasoning behind the design is in [Design notes](#design-notes) above; anything specific
to a file is in a comment next to the code it explains.

### Localization

User-facing strings contributed through `package.json` (command titles, setting descriptions,
the walkthrough) are localized through `package.nls.json` (English, the default) and
`package.nls.ja.json` (Japanese); VS Code picks one based on its display language. The
walkthrough panels live in `media/walkthrough/` (English) and `media/walkthrough/ja/`
(Japanese).

Everything else is English only — code comments, log output, runtime notification text and
**all documentation, this README included**. The line is drawn at whether the two languages are
structurally bound: a localized string has a sibling key in `package.nls.json`, and a localized
walkthrough panel has a path the same bundle resolves, so letting one side rot breaks a lookup
that shows up immediately. Free-standing prose has no such tie — a `README.ja.md` existed, drifted,
and was removed.

When adding a user-facing string to `package.json`, write it as `%some.key%` and add that key
to **both** `package.nls.json` and `package.nls.ja.json`. A key missing from the Japanese
bundle falls back to the English one.

## Contributing

Issues and pull requests are welcome. Before opening one:

- Run what CI runs, in the same order: `npm run check:zero-deps && npm run build && npm test && npm run package`. The two constraints it guards — an empty `dependencies`, and a core that never imports `vscode` — are explained under [Development](#development)
- Put reasoning next to the code it explains. Only reasoning the code cannot show — an architecture decision, a threat, a rejected alternative — belongs in [Design notes](#design-notes), and no fact is written in two places
- "Run a command on match" is a permanent non-goal, and a pull request adding it in any form will be declined

## License

MIT
