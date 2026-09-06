### `~/.config/chirin/config.json`

chirin reads **only the config that lives on the host**. It is assumed to sit somewhere the
container cannot rewrite, so do not create it inside the workspace.

```json
{
  "rules": [
    {
      "id": "claude-stop",
      "watch": ["~/src/*/*/*/.claude/chirin-notify-state.json"],
      "match": { "type": "event", "equals": "Stop" },
      "notify": {
        "title": "Claude Code",
        "subtitle": "Complete 🚀",
        "message": "{{dir}}",
        "sound": "Glass"
      }
    }
  ]
}
```

The `~/src/` in `watch` is just the template's default. **Change it to the directory where
you keep your repositories.**

Each `*` matches exactly one directory level. The default assumes the
`~/src/<host>/<owner>/<repo>` layout — `~/src/github.com/acme/web`, say — which is why there
are three of them. Drop wildcards for a shallower layout:

| Your repositories live at | Pattern |
|---|---|
| `~/src/web` | `~/src/*/.claude/chirin-notify-state.json` |
| `~/src/acme/web` | `~/src/*/*/.claude/chirin-notify-state.json` |
| `~/src/github.com/acme/web` | `~/src/*/*/*/.claude/chirin-notify-state.json` (the default) |

Listing repositories one by one works too (the template has a commented-out example).

The config is read as JSON with comments (JSONC), so you can leave notes with `//` or keep
settings commented out.

Saving is enough: every window notices the change within a few seconds and rebuilds its watch.
To apply it right away, run `chirin: Reload config` from the Command Palette (`Shift+Cmd+P`).

If a save leaves the config broken (mid-edit, say), chirin keeps watching with the last valid
config and reports the problem in the status bar and the output panel.
