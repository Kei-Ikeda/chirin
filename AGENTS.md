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

## What a red build already says

Some of what is below is also enforced mechanically, and `npm test` and the steps in
`.github/workflows/ci.yml` are the list of it -- read them rather than a copy kept here. A
finding that a red build would have produced anyway is not worth reporting.

Do not read that as a guarantee about any particular invariant. This section used to be a
table naming which ones were mechanically enforced, and every round of review on it found the
same defect: the claim was wider than the check behind it. Three of the eight rows were not
enforced at all when first written. The rest were, but only as far as the test enumerated,
which is never as far as a sentence describing a category. A file like this cannot state what
is currently true without going stale on its own, and a "do not look here" that is wrong is
worse than no claim at all -- so it states what matters instead, and leaves what is true to
the tests.

Two things are worth knowing about the checks that do exist, because neither is obvious:

- The `.js` extension and the core's independence from `vscode` are tests rather than compiler
  errors. Under a CommonJS NodeNext emit an extensionless relative import compiles, and a
  type-only `vscode` import is erased before anything can fail to resolve it. Weakening one of
  those tests is a change to a guarantee, not to a test
- They read the sources with patterns, not a parser, so what they catch is the shape written
  by accident. A specifier hidden between tokens, say by a comment between `require` and its
  parenthesis, goes unseen. That is deliberate: anyone who can write it can delete the test in
  the same commit, and what this repository defends against is the container's input, not its
  own history

Nothing a user relies on rests on any of that. The defenses that do are in the shipped code,
and each one is below.

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

13. **A limit the README documents.** `test/documentedLimits.test.ts` ties the ones it lists
    to the prose that states them, so a change to one is worth reading against what the
    README claims -- that list has been short of the truth every time anyone counted it.
    Three habits caused that, and each is worth recognising in a new test rather than
    repeating: rejecting a value far outside a range does not pin the range, comparing part
    of a value does not pin the value (a pattern's source without its flags), and a limit
    being unexported rules out naming the constant, not asking the validation where its edge
    is. Assert the documented edge and the step past it.

14. **A user-facing string contributed through a field nothing enumerates.**
    `test/localization.test.ts` requires every field it walks to hold a `%key%`, and requires
    every `%key%` in the manifest to be reachable through one of those fields. Neither reaches
    a new field whose value is inline English: it adds nothing to either side, so nothing
    fails while a Japanese reader is handed English. Closing that would mean knowing every
    field VS Code localizes, which is the editor's schema and not this repository's, so this
    one stays here. A new contribution to `package.json` carrying text a person reads is worth
    checking by eye, and worth adding to the enumeration.

## What not to report

Style preferences are not review findings.

Do not ask for information to be repeated here, or in a commit message, when it is already
stated next to the implementation or in the README. Prose kept in two places is the failure
this repository has already removed twice.

When an invariant could reasonably be checked by a test or a CI step, propose that instead of
a stronger rule in this file.

The reverse is worth saying too, because it took eight rounds of review on this file to reach
it: some invariants cannot be checks, and the honest move then is to say so here rather than
to claim a check that does not exist or is narrower than the sentence describing it. A rule
that states what matters keeps working. A rule that states what is currently true is a claim
someone will verify, and it goes stale without anything failing.
