# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

chirin is a **zero-dependency VS Code extension** (macOS only) that watches files for changes
and delivers them to the macOS Notification Center. Its main use is getting Claude Code hook
firings inside an egress-blocked devcontainer through to the host.

The only delivery path is a file on the bind-mounted workspace; the network is never used.

## Commands

```bash
npm ci
npm run check:zero-deps   # verify that dependencies is empty (guaranteed mechanically in CI)
npm run build             # rm -rf dist && tsc (emits src/ and test/ into dist/)
npm test                  # build, then node --test dist/test/*.test.js
npm run package           # produce the .vsix
```

To run a single test file, point at the built JS (the tests run against `dist`):

```bash
npm run build && node --test dist/test/watcher.test.js
node --test --test-name-pattern "throttle" dist/test/watcher.test.js
```

Opening this repository in VS Code and pressing `F5` ("Run Extension" in `.vscode/launch.json`)
starts an extension development host. `CHIRIN_DEBUG=1` enables debug logging.

CI is GitHub Actions (`.github/workflows/ci.yml`), running a macos-latest / Node 22 and 24
matrix on pushes to `main` and on pull requests. Reproduce it locally in the same order:
`check:zero-deps` → `build` → `test` → `vsce package` → confirming the .vsix carries no sources.

## Architecture

### Where it runs (the foundation of every assumption in this extension)

`extensionKind: ["ui"]` in `package.json` keeps the extension host on the **host macOS side**
even with a devcontainer open. That is what lets it call `osascript` and read the host's real
paths directly. As a workspace extension, chirin itself would move to the untrusted side
(inside the container) and both sanitization and the config permission checks would become
meaningless. **Do not change `extensionKind`.**

### Trust boundary

The container is untrusted. The content of the watched files (`chirin-notify-state.json` and
the rest) is **entirely attacker-controlled input**. Every limit, validation and sanitization
scattered through the code is a defense tied to that premise; do not remove one because it
"looks redundant". The threat model is in the "Design notes" section of README.md.

**The boundary is redrawn per output sink.** The same untrusted string needs different handling
depending on whether it goes to osascript or to the VS Code notification API (the latter
renders `[label](url)` as a link, so `](` is broken).

### Layers (the core does not depend on vscode)

| Layer | Files | Role |
|---|---|---|
| VS Code boundary | `extension.ts` / `commands.ts` / `vscodeLog.ts` / `vscodeNotifier.ts` | The only files that import `vscode` |
| Watch loop | `watcher.ts` | glob expansion → poll → rule match → throttle → sanitize → notify |
| Regex isolation | `regexMatcher.ts` / `regexWorker.ts` | `regex` matching in a worker thread, terminated past its budget (nothing on the evaluating thread can interrupt a runaway match) |
| Source adapters | `sources.ts` | Answers "what are the new events?" per source type (json-state / log-lines / file-meta) |
| Read primitives | `fileread.ts` | Trust-boundary checks and bounded reads (O_NOFOLLOW / O_NONBLOCK / fstat for TOCTOU) |
| Policies extracted for testing | `configWatch.ts` (when a config poll is worth acting on) / `hookSettings.ts` (which existing hooks survive the install) | Decisions that would otherwise sit in `extension.ts` / `commands.ts` behind `vscode` |
| Single-purpose utilities | `config.ts` `configTemplate.ts` `glob.ts` `jsonc.ts` `leader.ts` `log.ts` `notifier.ts` `sanitize.ts` | — |

**Do not import `vscode` into the core.** That boundary is what lets the tests run on
`node:test` alone. It is deliberate, and breaking it would sharply narrow what can be tested
automatically.

Keep the division of responsibility too: "how many bytes are allowed, and whether exceeding the
limit means rejecting or reading only the tail" is decided by `sources.ts`; `fileread.ts` makes
no such judgment.

### Data flow

The container-side hook (`hooks/chirin-notify.sh`) writes to a tmp file and `rename`s it within
the same directory to atomically replace `<workspace>/.claude/chirin-notify-state.json` → the
host-side chirin readFiles it every second and compares the `ts` field with the previous value
→ rule match → `/usr/bin/osascript` (fixed script plus argv).

It is **polling** rather than FS events because on VirtioFS the events for container-side writes
sometimes never reach the host. It is **a single state file overwritten (last-write-wins)**
rather than an append log or a spool because the point of a notification is to convey the
latest state.

On startup and when a file joins the watch set, `ts` is only recorded and nothing is notified (so
past events do not notify every time the extension host restarts). That baseline is taken as
watching starts (`primeTargets`), not by the first poll: leaving it to the poll misread
anything written in the gap as pre-existing state. The one exception is a file
first observed missing at a watched path: its appearance is a new event and notifies on the first
valid read (`seenMissing` in `sources.ts`), so the first notification after installing a hook is
not dropped.

### Leader election

The extension host is one process per window, so without suppression a single event notifies
once per window (the `Watcher`'s throttle is an in-process Map and cannot help). `leader.ts`
has the windows contend for a lock file, and only the leader's window runs the `Watcher`.
The lock is named `watcher-<digest of the config's resolved path>.lock` so that leadership is
per configuration, not per directory.

The lock operations in `leader.ts` (publishing a fully written file with `link`, `rename` →
validate → restore with `link`, the in-place write to an fd) are **all defenses against
specific races**. Failures are classified too: a lost race leaves the window a follower, while
a permission or I/O failure has to reach `onStalled` rather than look like healthy following.
Each one is explained in a comment at the point it happens; read those before touching them.

The `Watcher` is rebuilt on every promotion (reusing one would re-detect a change another window
notified about while this one was demoted, producing a duplicate).

## Toolchain constraints (a fragile combination)

- **`dependencies` is always empty.** Zero dependencies is a primary selling point of this product and is verified in CI. No bundler either (unpacking the `.vsix` shows exactly the code that runs)
- `module`/`moduleResolution` are `NodeNext`. The output is CommonJS (the extension host `require()`s `main`). **The `.js` extension on relative imports is mandatory**
- `types: ["node", "vscode"]` is stated explicitly. TypeScript 6.0 defaults `types` to `[]`, so removing it makes `vscode` unresolvable as a module
- `@types/vscode` is **pinned** to the lower bound of `engines.vscode` (`1.101.0`). With a caret it would float and let APIs absent from the minimum VS Code compile. `@types/node` is `^22` (the extension host at the lower bound is Node 22)
- `capabilities.untrustedWorkspaces.supported: true` is mandatory. Without the declaration the extension is disabled entirely in a Restricted Mode window and notifications stop silently

## Tests and manual verification

Tests create real files and directories in a tmpdir (config permission violations are verified
by actually running `chmod`). The `Watcher` is driven by injecting a stub notifier and a fixed
clock and calling the poll cycle directly.

**The notifier (real notifications) is outside the automated tests.** After touching the
notification path, verify by hand with `chirin: Send test notification`.

## Language and localization

- **Code comments, test names, log output and runtime notification text are English only.**
- User-facing strings contributed through `package.json` (command titles, setting descriptions, the walkthrough) are localized: write them as `%some.key%` and add the key to **both** `package.nls.json` (English, the default) and `package.nls.ja.json` (Japanese). A key missing from the Japanese bundle falls back to the English one
- The walkthrough panels exist twice: `media/walkthrough/` (English) and `media/walkthrough/ja/` (Japanese). The `media.markdown` path is itself localized through the nls bundles
- **Documentation is English only, the README included.** A `README.ja.md` and a Japanese design document both existed and were deleted: free-standing prose kept in two files drifts, and a stale translation is wrong without anything failing
- The exception is **text the extension itself renders** (command titles, setting descriptions, the walkthrough panels). Those stay honest because each Japanese side is structurally bound to an English one -- a sibling key in `package.nls.json`, or a `media.markdown` path that the same bundle resolves -- so dropping one half breaks a lookup you notice immediately. That coupling is exactly what a translated README never had, which is where the line is drawn

## Documentation conventions

- **`README.md` is the only document.** There is no `docs/` directory, and there should not be one: a separate design document duplicated the README, fell out of sync with the implementation repeatedly, and was removed for that reason
- **Split by what can drift, not by audience.** Anything visible in the code — module responsibilities, constants, the exact lock protocol — belongs in a comment *next to that code*, where it cannot fall out of sync. Only reasoning the code cannot show (architecture decisions, the threat model, rejected alternatives) goes in the README's "Design notes"
- Never write the same fact in two places. If the README states a constant, it must be one a test pins (see `test/configTemplate.test.ts`)
- The distribution carries only `dist/src`, `hooks`, `media`, the nls bundles, README and LICENSE

## Permanent non-goals

"Run a command on match" will never be implemented. It would turn untrusted container-side
input into arbitrary code execution on the host, defeating the point of blocking egress.
