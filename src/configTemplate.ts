// The initial config template, kept out of commands.ts so it stays free of `vscode` and can
// be tested. It is read back as JSONC (JSON with comments), so a malformed comment here would
// make `chirin: Create config file` write a config that loadConfig immediately rejects --
// configTemplate.test.ts runs this constant through the real strip + validate path.

export const CONFIG_TEMPLATE = `{
  // chirin config file. \`//\` and \`/* */\` comments are allowed.
  "defaults": {
    // How often each watched file is read, in milliseconds. Lower means a notification
    // arrives sooner, at the cost of reading the files more often. Minimum 200.
    "pollIntervalMs": 1000,
    // How often the watch patterns below are expanded again, in milliseconds. This is how
    // quickly a newly created repository joins the watch set; a lower value finds it sooner
    // but walks the directory tree more often. Minimum 5000.
    "globRefreshMs": 30000,
    // Default suppression window, in milliseconds, applied per rule and file. Once a rule has
    // notified for a file it stays quiet for this long, so a burst collapses into one
    // notification. Use 0 to notify every time. A rule can override it with its own
    // "throttleMs" (see claude-stop below).
    "throttleMs": 5000
  },
  "rules": [
    {
      "id": "claude-stop",
      // watch takes absolute paths on the macOS (host) side.
      // Each \`*\` matches exactly one directory level, and never a hidden one.
      // The default assumes repositories live at ~/src/<host>/<owner>/<repo>, for example
      // ~/src/github.com/acme/web. Adjust the number of \`*\` to your own layout:
      //   ~/src/*/.claude/...     -> repositories directly under ~/src
      //   ~/src/*/*/.claude/...   -> one level deeper
      // Afterwards, run the validate command from the Command Palette: it prints the files
      // that actually matched, so a wrong number of levels shows up immediately.
      "watch": ["~/src/*/*/*/.claude/chirin-notify-state.json"],
      // You can also list repositories one by one:
      // "watch": [
      //   "~/src/github.com/acme/web/.claude/chirin-notify-state.json",
      //   "~/src/github.com/acme/api/.claude/chirin-notify-state.json"
      // ],
      // \`Stop\` fires at the end of every turn, including a turn that ended only because the
      // session parked to wait for background work (a background agent, a backgrounded shell,
      // a workflow). Claude Code reports that in-flight work, and \`background_task_count\` is
      // 0 only on a real completion -- matching on it keeps "Complete" from firing while work
      // is still running.
      // The field is written only for \`Stop\` / \`SubagentStop\`, so this rule never fires for
      // a \`Notification\`. If you also register the SubagentStop hook it will fire for those
      // too; give them their own rule if you want a different sound.
      // To notify on every turn instead, use: { "type": "event", "equals": "Stop" }
      "match": { "type": "regex", "field": "background_task_count", "pattern": "^0$" },
      "notify": {
        "title": "Claude Code",
        "subtitle": "Complete 🚀",
        "message": "{{dir}}",
        "sound": "Glass"
      }
    },
    {
      "id": "claude-notification",
      // Same watch targets as claude-stop above, but notifying on a different event.
      "watch": ["~/src/*/*/*/.claude/chirin-notify-state.json"],
      // Match on \`notification_type\` rather than the event, so background-agent noise stays
      // out. Claude Code raises Notification for background agents and teammates too, and the
      // message text alone cannot tell them apart from your own session's prompts.
      // The field is "" for every non-Notification event, so this rule never fires for \`Stop\`.
      // By default only a permission request rings. Other values you can add here:
      //   idle_prompt                         ... "Claude is waiting for your input". Fires
      //                                           whenever the session goes idle, including
      //                                           while background work is still running
      //   agent_needs_input, agent_completed  ... background agents (FleetView / teammate / cloud)
      //   worker_permission_prompt            ... a teammate worker asking the team lead
      //   elicitation_dialog, elicitation_url_dialog, auth_success, push_notification,
      //   computer_use_enter, computer_use_exit, quota_auto_resume_fired,
      //   quota_auto_resume_stale, quota_auto_resume_disabled
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
`;
