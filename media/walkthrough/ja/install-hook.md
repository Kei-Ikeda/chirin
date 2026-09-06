### プロジェクトごとに 1 回

コマンドパレット（`Shift+Cmd+P`）から
`chirin: Claude Code hook をこのプロジェクトに設置` を実行すると、開いているワークスペースへ
次の 3 つのファイルが書き換わります（`.gitignore` を含みます）。

1. `.claude/hooks/chirin-notify.sh` を配置
2. `.claude/settings.local.json` の `hooks` セクションへマージ（既存の chirin の hook は重複登録せず置き換えるので、再実行すると呼び出し形式の変更が反映されます。ファイルはインデント 2 の JSON で書き直されます）
3. `.gitignore` の末尾へ `# chirin` ブロックを追記し、chirin がここへ書き込むファイル（`.claude/hooks/chirin-notify.sh`・`.claude/chirin-notify-state.json`・`.claude/.chirin-notify-tmp-*`）を追跡対象から外す（同じ行が既にあれば追記しない）

設置後、**Claude Code のセッションを開き直す**と hook が有効になります。

hook は `bash <path>` の形で呼ぶため、実行権限は不要です。
