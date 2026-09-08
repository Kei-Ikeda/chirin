---
name: release
description: Cut a chirin release end to end - pick the version with the operator, run the CI checks, build and verify the .vsix, commit, tag, push, then hand over the GitHub Release and the Marketplace upload. Use this whenever the operator asks to release, publish or ship chirin, bump the version, cut a tag, build a .vsix, write release notes, or put a new version on the Marketplace - reach for it even when they ask for only one of those pieces, because the ordering and the irreversible steps are exactly what it protects.
---

# Releasing chirin

A release is `main` plus a lightweight `v<x.y.z>` tag, a GitHub Release carrying the `.vsix`
and its checksum, and that same `.vsix` uploaded to the Marketplace.

Two properties shape every step below:

- **A published version can never be replaced.** The Marketplace refuses a version it already
  has, so a mistake costs a new version number. Confirm everything before an upload, never after.
- **`vsce package` is not byte-reproducible.** Two builds of the same commit differ, so the
  checksum you publish describes only the file you published. Never rebuild a version that is
  already out; to get its bytes back, download them from the GitHub Release.

Credentials live with the operator: `gh` is unauthenticated inside the container and reading the
git credential helper is blocked. For those steps hand over exact commands or the browser URL
instead of attempting them.

## 1. Decide the version with the operator

Ask, do not assume. A release whose internals changed behaviour - a lock file name, a thread
model, when state is first read - is a minor bump even with no new feature, because the version
number is the only warning a user gets before installing it. 1.1.0 was minor on exactly that
ground: it renamed the leader lock, so every window has to be restarted.

```bash
npm version <x.y.z> --no-git-tag-version   # package.json + package-lock.json, no git side effects
```

## 2. Preflight

```bash
./.claude/skills/release/scripts/preflight.sh
```

It runs `check:zero-deps` → `npm test` → `vsce package` in CI's order, refuses to continue if
the `.vsix` carries `src/**`, `dist/test/**` or a `*.map`, writes `.tmp/chirin-<x.y.z>.vsix.sha256`,
and stops outright if `v<x.y.z>` is already tagged (see byte-reproducibility above).

The notifier is the one thing no test covers. Before tagging, have the operator install the
`.vsix` on the host, **restart every VS Code window**, and run `chirin: Send test notification`.

## 3. Commit, tag and push

One commit titled `<version>: <summary>`, with the version bump inside it. `git log` shows the
form: a title, then prose explaining what changed and why, wrapped at ~95 columns.

```bash
git tag v<x.y.z>              # lightweight, on the release commit
git push origin main
git push origin v<x.y.z>
```

## 4. Write the release notes

Put them in `.tmp/release-notes-<x.y.z>.md`, in English like the rest of the project's prose.
Read the previous release first and follow it:

```bash
curl -sS https://api.github.com/repos/Kei-Ikeda/chirin/releases/latest \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['body'])"
```

The shape is: one line saying what this release is, the upgrade action if there is one, bullets
of user-visible changes, then `## Install` and `## Verify the download` with the hash inline.

Two things to get right:

- **If the release changes any cross-window state - the leader lock name above all - the upgrade
  line must tell users to quit every VS Code window and reopen it.** An old window keeps holding
  the previous lock, watches in parallel and notifies twice, and nothing in the product tells
  them why.
- Show the notes to the operator before step 5. They are user-facing prose about their product,
  and step 6 cannot be undone.

## 5. GitHub Release (operator)

```bash
gh release create v<x.y.z> --title "chirin <x.y.z>" \
  -F .tmp/release-notes-<x.y.z>.md \
  chirin-<x.y.z>.vsix .tmp/chirin-<x.y.z>.vsix.sha256
```

Browser equivalent: `https://github.com/Kei-Ikeda/chirin/releases/new?tag=v<x.y.z>`, title
`chirin <x.y.z>`, the notes pasted in, both files attached.

## 6. Marketplace (operator)

Browser: <https://marketplace.visualstudio.com/manage/publishers/kei-ikeda> → `chirin` → the
`...` menu → Update → upload `chirin-<x.y.z>.vsix`. The listing text, icon and README come from
inside the `.vsix`, so there is nothing to edit on the site. CLI equivalent:
`npx vsce login kei-ikeda` then `npx vsce publish`, which publishes the version already in
`package.json` and adds no tag.

Validation takes a few minutes; the listing and `code --install-extension kei-ikeda.chirin`
follow within about fifteen.

## Where the artefacts live

None of them is ever committed - they are build output, and a checksum of an ignored file is
not something the repository can verify anyway.

- `chirin-<x.y.z>.vsix` stays at the repository root beside the previous releases (`*.vsix` is
  gitignored). That is also where the operator's browser upload picks it up.
- The checksum and the notes go under `.tmp/`, which is gitignored. `*.vsix` does not match
  `*.vsix.sha256`, which is why the checksum lives there rather than next to the package.
