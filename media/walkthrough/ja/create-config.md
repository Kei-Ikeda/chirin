### `~/.config/chirin/config.json`

chirin は**ホスト側に置かれた config だけ**を見ます。コンテナから書き換えられない場所に
置くのが前提なので、ワークスペース配下には作らないでください。

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

`watch` の `~/src/` はテンプレートの既定値です。**自分がリポジトリを置いている
ディレクトリに書き換えてください。**

`*` がマッチするのは 1 階層だけです。既定値は `~/src/<host>/<owner>/<repo>`
（例: `~/src/github.com/acme/web`）の配置を前提にしているので `*` が 3 つあります。
もっと浅い配置なら `*` を減らしてください:

| リポジトリの置き場所 | パターン |
|---|---|
| `~/src/web` | `~/src/*/.claude/chirin-notify-state.json` |
| `~/src/acme/web` | `~/src/*/*/.claude/chirin-notify-state.json` |
| `~/src/github.com/acme/web` | `~/src/*/*/*/.claude/chirin-notify-state.json`（既定値） |

リポジトリを 1 つずつ列挙する書き方も可能です（テンプレートにコメントで例があります）。

config はコメント付き JSON（JSONC）として読み込むので、`//` でメモを残したり
設定をコメントアウトしたまま置いておけます。

保存するだけで反映されます。各ウィンドウが数秒以内に変化を検知して監視を組み直します。
すぐに反映したい場合は、コマンドパレット（`Shift+Cmd+P`）から `chirin: 設定を再読み込み`
を実行してください。

保存した内容が壊れていた場合（編集途中の保存など）は、直前の正常な config で監視を続けたまま
ステータスバーと出力パネルに警告が出ます。
