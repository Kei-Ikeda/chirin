# AGENTS.md

Instructions for coding agents and automated code review in this repository.

chirin is a zero-runtime-dependency VS Code UI extension for macOS. It watches files on the
host and turns changes into macOS notifications; the main use is carrying Claude Code hook
events out of a devcontainer whose network egress is blocked. **The container is untrusted,
and so is everything in the watched files.**

## Read these first

This file deliberately restates no architecture, no constant and no file list. Two places own
those, and each sits next to what it describes so it cannot fall out of step with it:

- **`.claude/CLAUDE.md`** — the layer boundaries, the toolchain constraints and the
  conventions a change has to satisfy
- **`README.md`, "Design notes"** — the threat model, the architecture decisions and the
  alternatives that were rejected

Every rule below names an invariant whose authoritative statement is a comment at the point
in the code where it happens. Read that comment before changing the line it guards. If a rule
here and the code disagree, the code and its comment are right and this file is stale.

## Before calling a change complete

Run what CI runs, in the order `.github/workflows/ci.yml` lists. That workflow is the only
place the sequence is written down, and copying it into a prompt or a commit message is how it
starts to drift.

Real notification delivery is outside the automated tests. After touching the notification
path, verify by hand with the `chirin: Send test notification` command.

## What already fails on its own

Do not spend review attention here. These are enforced mechanically, so a violation is a red
build rather than a review finding:

| Invariant | What catches it |
|---|---|
| runtime `dependencies` stays empty | `npm run check:zero-deps` |
| the `.js` extension on relative imports | `npm test`, in `test/sourceConventions.test.ts` |
| the core never imports `vscode` | `npm test`, in `test/sourceConventions.test.ts` |
| the `.vsix` carries only the distribution | the allowlist step in `ci.yml` |
| a dependency with a known high advisory | `npm audit --audit-level=high` in `ci.yml` |
| a VS Code API newer than `engines.vscode` | the pinned `@types/vscode`, as a type error |
| a limit `test/documentedLimits.test.ts` lists drifting from the README | `npm test` |
| the localization pairing, as far as `test/localization.test.ts` states it | `npm test` |

Neither of the first two is a compiler error, which is why they are tests: under a CommonJS
NodeNext emit an extensionless relative import compiles, and a type-only `vscode` import is
erased before anything can fail to resolve it. Weakening one of those tests is a change to
the guarantee, not to a test.

The two source-scanning tests read the sources with patterns rather than a parser, so what
they catch is the shape that gets written by accident -- a forgotten extension, a type-only
import, a file in a new subdirectory. A specifier hidden between tokens, say by a comment
sitting between `require` and its parenthesis, goes unseen. That limit is deliberate and not
worth closing: anyone who can write that can delete the test on the same commit, and what
this repository defends against is the container's input, not its own history. Nothing a user
relies on rests on these two -- the defenses that do are in the shipped code, and each is
listed below.

The last two rows name a test rather than a category, and that is deliberate. Written as a
category -- "every documented limit", "the localization pairing" -- the sentence is wider than
any check behind it, which is how six rounds of review each found something the claim covered
and the test did not. A row scoped to what its test enumerates cannot outrun it. Both tests
assert their own coverage where that is possible: the localization one fails if the manifest
gains a reference through a field it does not enumerate, which says to extend the list rather
than leaving the gap silent.

Two more things in that table are worth flagging when the change is to the check rather than
to the code: loosening the `@types/vscode` pin to a range, and adding a bundler or any
generated artifact that `check:zero-deps` does not see. Both trade a mechanical guarantee for
a prose rule.

If an invariant listed further down can be moved into this table, that is a better change than
a stronger rule here.

## Review priorities

Report concrete regressions. Rank a finding by what it costs: host-side code execution, host
files exposed, a blocked extension host, a notification missed or duplicated, a user's hook
configuration lost, or an install broken on a supported VS Code.

1. **Watched content becoming a command.** Anything that builds a shell command, AppleScript,
   JavaScript or any other executable program out of watched or container-controlled input, or
   that adds a configurable "run this on a match" feature. This is a permanent non-goal, and a
   change adding it in any form is declined rather than reviewed.

2. **Where the extension runs.** `extensionKind: ["ui"]` is a security boundary, not a
   deployment preference: it is what keeps chirin on the host side while a devcontainer is
   open. Flag its removal, and flag moving watching, notification delivery, config validation
   or any trust-boundary check into the container-side extension host. The path from the
   container is a file on the bind-mounted workspace; chirin must not need network access.

3. **The notification call.** Flag anything that puts data into an executable AppleScript body
   by concatenation or interpolation, replaces `execFile` with a shell, drops the absolute
   `osascript` path, or removes the `--` that ends its option parsing.

4. **Safe file access.** Flag replacing the open → `fstat` → bounded-read sequence with a
   pathname `stat` and an ordinary read, or dropping the flags and checks that make a symlink,
   a FIFO, a device or a path swapped mid-read unable to reach a host file or freeze the
   extension host.

5. **Config trust checks.** The config lives on the trusted side. Flag weakening the
   ownership, permission, regular-file, symlink or size checks on the file or on its
   directory. The directory holds the watcher lock and must stay writable by this process.

6. **Bounds on untrusted input.** Flag the removal or widening, without a stated reason and a
   test, of any limit on bytes read, lines processed, field count and length, template output,
   match target length, watch targets, or notifications per cycle. Flag any unbounded
   allocation, split, hash, parse, match or queue over attacker-controlled data.

7. **Sanitization per sink.** The same untrusted string needs different handling depending on
   where it goes; "it is sanitized" is not an argument by itself. Flag removing control and
   bidirectional-character filtering, the length bounds, or a protection specific to one sink
   because another sink is safe.

8. **Regex isolation.** User-configured patterns are untrusted computational input. Flag
   moving their evaluation back onto the extension-host thread, removing the load-time
   rejection of nested unbounded quantifiers, removing the budget or the worker termination
   that enforces it, or letting a rule that already exceeded its budget be retried every poll
   cycle.

9. **Leader election.** Flag a change that can leave two windows watching at once, that lets a
   permission or I/O failure read as healthy following, that reuses a `Watcher` across a
   promotion, or that replays events another leader already consumed. The lock operations are
   each a defense against one specific race, explained where it happens; do not simplify one
   without a test for the race it covers.

10. **Baseline semantics.** Existing content must not notify merely because watching started.
    Flag a change that replays stale events on a VS Code restart, a watcher rebuild, a config
    reload or a leader handoff. A path first seen missing and later appearing is the deliberate
    exception: that appearance is a new event.

11. **Polling.** Flag replacing polling with filesystem events without addressing the reason
    it is polling: on VirtioFS, events for container-side writes sometimes never reach the
    host. Flag overlapping poll cycles, and flag a stopped or replaced watcher that leaves
    outstanding asynchronous work able to notify later.

12. **Hook installation.** The bundled hook must never block Claude Code or report failure to
    it, whatever goes wrong. Flag losing a user's existing hooks or settings, and flag
    identifying chirin's own hook commands by anything looser than an exact match — a
    user-composed command or a copy at another path belongs to them. Changing the installed
    command means changing the migration handling that recognises the old one.

13. **A limit the README documents that `test/documentedLimits.test.ts` does not list.**
    That test names what it covers, and anything the README states outside its two tables is
    covered by nothing: a change to such a limit is worth reading against what the README
    claims. Do not read this as a short list. It was written as one twice, naming the limits
    believed to be left over, and review found a further one both times -- an exported
    pattern, then three documented lower bounds whose edges no test touched. Rejecting a
    value far outside a range does not pin the range. Where a limit is not exported, assert
    the behaviour at the documented edge rather than widening a module's surface for a test.

## What not to report

Style preferences are not review findings.

Do not ask for information to be repeated here, or in a commit message, when it is already
stated next to the implementation or in the README. Prose kept in two places is the failure
this repository has already removed twice.

When an invariant could reasonably be checked by a test or a CI step, propose that instead of
a stronger rule in this file.
