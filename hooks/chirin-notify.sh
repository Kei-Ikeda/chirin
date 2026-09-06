#!/usr/bin/env bash
# chirin: Claude Code hook -> chirin-notify-state.json writer
# The program below is passed through a quoted heredoc, NOT a single-quoted shell string.
# Do not re-embed it in '...': one apostrophe in a comment would terminate the string and
# silently break the hook (it always exits 0, so the failure would be invisible).
# The heredoc is read from this file, so node still receives the hook payload on stdin.
exec node -e "$(cat <<'CHIRIN_HOOK_JS'
// This hook must never block Claude Code.
// Exit 0 no matter what happens.
process.on("uncaughtException", () => process.exit(0));

let raw = "";
process.stdin.setEncoding("utf8"); // keeps multi-byte UTF-8 from breaking at a chunk boundary
process.stdin.on("error", () => process.exit(0));
process.stdin.on("data", c => raw += c).on("end", () => {
  try {
    let d = {}; try { d = JSON.parse(raw); } catch {}
    const fs = require("fs"), path = require("path");
    const dir = path.join(process.env.CLAUDE_PROJECT_DIR ?? ".", ".claude");
    fs.mkdirSync(dir, { recursive: true });

    // Sweep away stray tmp files older than an hour (best effort)
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(".chirin-notify-tmp-")) continue;
      try {
        const p = path.join(dir, f);
        if (Date.now() - fs.statSync(p).mtimeMs > 3600_000) fs.unlinkSync(p);
      } catch {}
    }

    // The random suffix in ts must never be empty (Math.random()===0 would empty it and get it rejected)
    const suffix = Math.random().toString(36).slice(2) || "0";
    // Unique tmp name (no collision even with concurrent runs)
    const tmp = path.join(dir, `.chirin-notify-tmp-${process.pid}-${suffix}`);
    // Stringify every field and cap its length (a huge event/cwd would exceed 64KB and be silently skipped)
    fs.writeFileSync(tmp, JSON.stringify({
      ts: `${Date.now()}-${suffix}`,
      event: String(d.hook_event_name ?? "unknown").slice(0, 64),
      // Only Notification carries this; it is "" for every other event. It is what lets a rule
      // tell an ordinary prompt apart from background-agent traffic (the message text cannot).
      notification_type: String(d.notification_type ?? "").slice(0, 64),
      // Only Stop / SubagentStop carry background_tasks, so the count is written only for
      // those: on any other event a rule matching "^0$" would fire too. A missing list counts
      // as 0, so a Claude Code that stops sending the field degrades to "always notify"
      // rather than to silently never notifying.
      ...(d.hook_event_name === "Stop" || d.hook_event_name === "SubagentStop"
        ? {
            background_task_count: String(
              Array.isArray(d.background_tasks) ? d.background_tasks.length : 0,
            ),
          }
        : {}),
      message: String(d.message ?? "").slice(0, 200),
      cwd: String(d.cwd ?? "").slice(0, 512),
    }));
    // A rename within the same directory = an atomic swap (last-write-wins)
    fs.renameSync(tmp, path.join(dir, "chirin-notify-state.json"));
  } catch {
    // A failed write (read-only / ENOSPC / .claude being a regular file) must not stop Claude Code
  }
  process.exit(0);
});
CHIRIN_HOOK_JS
)"
