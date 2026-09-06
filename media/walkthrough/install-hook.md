### Once per project

Running `chirin: Install the Claude Code hook into this project` from the Command Palette
(`Shift+Cmd+P`) writes these three files into the open workspace (`.gitignore` included).

1. Places `.claude/hooks/chirin-notify.sh`
2. Merges into the `hooks` section of `.claude/settings.local.json`. An existing chirin entry is replaced rather than duplicated, so re-running picks up a changed hook invocation without registering it twice (the file is re-serialized with two-space indentation)
3. Appends a `# chirin` block to the end of `.gitignore` so the files chirin writes here — `.claude/hooks/chirin-notify.sh`, `.claude/chirin-notify-state.json` and `.claude/.chirin-notify-tmp-*` — stay untracked (an identical line is never appended twice)

After installing, **reopen the Claude Code session** to activate the hook.

The hook is invoked as `bash <path>`, so it needs no executable bit.
