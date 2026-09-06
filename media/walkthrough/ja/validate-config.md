### 出力パネルで確認すること

コマンドパレット（`Shift+Cmd+P`）から実行できる `chirin: 設定を検証` は、
glob 展開後に**実際に監視されるファイル**を一覧表示します。

```
rule claude-stop: source=json-state, background_task_count =~ /^0$/, throttleMs=5000
  watch: /Users/you/src/*/*/*/.claude/chirin-notify-state.json
  targets now (2):
    /Users/you/src/github.com/acme/web/.claude/chirin-notify-state.json
    /Users/you/src/github.com/acme/api/.claude/chirin-notify-state.json
```

`targets now (0)` なら `watch` のパスが実環境と合っていません。config を開いて直してください。

`~/Desktop` `~/Documents` `~/Downloads` の配下を監視する場合は、VS Code 本体にフルディスク
アクセスが必要です（無許可だと**黙って失敗**します）。検証時に警告が出ます。
