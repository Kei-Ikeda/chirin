### What to check in the output panel

`chirin: Validate config`, available from the Command Palette (`Shift+Cmd+P`), lists **the
files that are actually watched** after glob expansion.

```
rule claude-stop: source=json-state, background_task_count =~ /^0$/, throttleMs=5000
  watch: /Users/you/src/*/*/*/.claude/chirin-notify-state.json
  targets now (2):
    /Users/you/src/github.com/acme/web/.claude/chirin-notify-state.json
    /Users/you/src/github.com/acme/api/.claude/chirin-notify-state.json
```

`targets now (0)` means the paths in `watch` do not match your actual environment. Open the
config and fix them.

Watching anything under `~/Desktop`, `~/Documents` or `~/Downloads` requires Full Disk Access
for VS Code itself (without it, reads **fail silently**). Validation warns you when that
applies.
