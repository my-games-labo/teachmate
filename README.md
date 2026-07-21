# teachmate

キャラクターに教えて学ぶ学習ツール。ユーザーが「学習中のキャラクター」に知識を教えることで、自分自身も学習する。

詳しい設計思想と確定した方針は [docs/spec.md](docs/spec.md) を参照（特に「第20章 確定した設計判断」）。

## 現状

MVP をステップ順に構築中。

- [x] Step1: リポジトリ雛形とストア初期化
- [x] Step2: 会話ループ最小版（教える→理解判定→knowledge.db 更新）
- [x] Step3: 記憶の再登場（`next_review_at` による復習/矛盾）
- [x] Step4: RAG 接続（AWS 公式ドキュメント）
- [x] Step5: Telegram 送信＋タスクスケジューラ
- [x] 拡張: PDF 取り込み（whitepaper/BlackBelt 用、unpdf）
- [x] 拡張: 初回セットアップ会話（第6章）

MVP の縦切りは一通り完成。

## スタック

- TypeScript / Node（CLI）
- SQLite（better-sqlite3）— 概念ごとの知識状態と復習期日
- Claude — 理解判定・会話生成・矛盾検出（接続はプラガブル、下記）
- Telegram Bot — 催促のクロスデバイス配送（PC＋スマホ）

## LLM 接続（provider）

`TEACHMATE_PROVIDER` で切り替え。

- `claude-cli`（**API キー不要**）: `claude -p` をサブプロセスで呼び、既存の Claude Code ログインを流用。事前に `claude` にログイン済みであること。
- `anthropic`（既定）: `ANTHROPIC_API_KEY` で Anthropic API を直接利用。
- `TEACHMATE_MOCK=1`: オフラインのデモ用モック（キー・ログイン不要、応答は作り物）。

```bash
# 例: ログインを流用して動かす
export TEACHMATE_PROVIDER=claude-cli
node dist/index.js teach taro
```

## セットアップ

```bash
npm install
```

## 使い方（開発中）

```bash
# 開発実行（ビルド不要）
npm run dev -- init taro --theme "AWS認定 SAA"
npm run dev -- setup taro                        # 初回セットアップ会話でコースを決める
npm run dev -- ingest taro docs/aws-sample.md    # 基準知識を取り込む（.md/.txt/.pdf）
npm run dev -- teach taro                        # 教える会話セッション
npm run dev -- list
npm run dev -- nudge-check --dry-run

# ビルドして実行
npm run build
node dist/index.js list
```

## 催促（Telegram）のセットアップ

1. Telegram の @BotFather でボットを作成し、トークンを取得
2. `~/.teachmate/.env` に `TELEGRAM_BOT_TOKEN=...` と `ANTHROPIC_API_KEY=...` を記載
3. スマホ/PC の Telegram でそのボットに何か話しかける
4. 送信先 chat_id を確認して登録：
   ```bash
   node dist/index.js telegram whoami          # chat_id を表示
   node dist/index.js telegram taro <chatId>   # 送信先を設定
   node dist/index.js telegram taro test        # テスト送信
   ```
5. 日次催促をタスクスケジューラに登録（Windows）：
   ```bash
   node dist/index.js schedule install --time 20:00
   node dist/index.js schedule status
   node dist/index.js schedule uninstall
   ```

`.env` に鍵を置くと、スケジューラから起動される `nudge-check` でも読み込まれます。

## データ配置

既定は `~/.teachmate/`。`TEACHMATE_HOME` 環境変数で上書き可能。

```
~/.teachmate/
  characters/
    <name>/
      course.json      コース定義
      settings.json    学習頻度・通知・催促
      state.json       last_active / last_nudged_at 等
      knowledge.db     概念ごとの知識状態＋復習期日
```
