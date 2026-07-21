#!/usr/bin/env node
import {
  ensureBase,
  createCharacter,
  readCourse,
  readSettings,
  writeSettings,
  openDb,
  replaceDocChunks,
  countDocChunks,
} from "./store.js";
import { listCharacters, characterExists, repoRoot, baseDir } from "./paths.js";
import { chunkText } from "./rag.js";
import { extractPdfText } from "./pdf.js";
import { runTeachSession } from "./session.js";
import { runSetupSession } from "./setup.js";
import { runNudgeCheck } from "./nudge.js";
import { getTelegramChats, sendTelegram } from "./telegram.js";
import { loadEnv } from "./env.js";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function nowIso(): string {
  return new Date().toISOString();
}

function usage(): void {
  console.log(`teachmate — キャラクターに教えて学ぶ学習ツール

使い方:
  teachmate init <name> [--theme "AWS認定 SAA"]   キャラクターを新規作成
  teachmate list                                   キャラクター一覧
  teachmate setup <name>                           初回セットアップ会話でコースを決める
  teachmate teach <name>                           キャラクターに教える（会話セッション）
  teachmate ingest <name> <path>                   基準知識を取り込む（.md/.txt/.pdf）
  teachmate nudge-check [--dry-run] [--force]      催促を判定して Telegram 送信
  teachmate telegram whoami                        ボットに話しかけた chat_id を確認
  teachmate telegram <name> <chatId>               送信先 chat_id を設定
  teachmate telegram <name> test                   テスト送信
  teachmate schedule install [--time HH:MM] [--print]   日次催促をタスクスケジューラに登録
  teachmate schedule uninstall                     登録を解除
  teachmate schedule status                        登録状況を表示
  teachmate help                                   このヘルプ

環境変数（~/.teachmate/.env または カレントの .env でも可）:
  TEACHMATE_PROVIDER   LLM 接続先: anthropic（既定, 要APIキー）| claude-cli（claude ログイン流用）
  ANTHROPIC_API_KEY    Claude API キー（provider=anthropic のとき使用）
  TELEGRAM_BOT_TOKEN   Telegram ボットのトークン（催促送信に必須）
  TEACHMATE_MODEL      使用モデル（既定 claude-sonnet-4-6）
  TEACHMATE_HOME       データ配置（既定 ~/.teachmate）
  TEACHMATE_DEBUG=1    理解判定の内部値を表示
  TEACHMATE_MOCK=1     オフライン・デモ用のモック応答（API キー不要）
`);
}

/** 引数配列から "--key value" / "--flag" を取り出す簡易パーサ。 */
function parseFlags(args: string[]): {
  positionals: string[];
  flags: Record<string, string | boolean>;
} {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function cmdInit(args: string[]): void {
  const { positionals, flags } = parseFlags(args);
  const name = positionals[0];
  if (!name) {
    console.error("エラー: キャラクター名を指定してください（teachmate init <name>）");
    process.exit(1);
  }
  const theme = typeof flags.theme === "string" ? flags.theme : undefined;
  ensureBase();
  createCharacter(name, nowIso(), theme);
  console.log(`キャラクター "${name}" を作成しました。`);
  console.log(`テーマ: ${readCourse(name).theme}`);
  console.log(`（コース詳細は次段階の初回会話で埋めます）`);
}

function cmdList(): void {
  const names = listCharacters();
  if (names.length === 0) {
    console.log("キャラクターはまだいません。`teachmate init <name>` で作成してください。");
    return;
  }
  for (const name of names) {
    const course = readCourse(name);
    console.log(`- ${name}  [${course.theme}]`);
  }
}

/** 催促を判定し、必要なら Telegram へ送信する。 */
async function cmdNudgeCheck(args: string[]): Promise<void> {
  const { flags } = parseFlags(args);
  const results = await runNudgeCheck({
    dryRun: flags["dry-run"] === true,
    force: flags["force"] === true,
  });
  if (results.length === 0) {
    console.log("キャラクターがいません。");
    return;
  }
  for (const r of results) {
    if (r.status === "sent") console.log(`[送信 → ${r.name}] ${r.message}`);
    else if (r.status === "dry-run") console.log(`[dry-run ${r.name}] ${r.message}`);
    else if (r.status === "unconfigured")
      console.log(`[未設定 ${r.name}] ${r.reason} / 文面: ${r.message}`);
    else console.log(`[skip ${r.name}] ${r.reason}`);
  }
}

async function cmdTelegram(args: string[]): Promise<void> {
  const [a, b] = args;
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (a === "whoami") {
    if (!token) {
      console.error("エラー: TELEGRAM_BOT_TOKEN が未設定です。");
      process.exit(1);
    }
    console.log("まずスマホ/PC の Telegram でボットに何かメッセージを送ってから実行してください。\n");
    const chats = await getTelegramChats(token);
    if (chats.length === 0) {
      console.log("chat が見つかりません。ボットにメッセージを送ってから再実行してください。");
      return;
    }
    for (const c of chats) {
      console.log(`chat_id=${c.chatId}  name=${c.name}  最新="${c.lastText}"`);
    }
    return;
  }

  const name = a;
  if (!name || !characterExists(name)) {
    console.error("使い方: teachmate telegram <name> <chatId> | teachmate telegram <name> test | teachmate telegram whoami");
    process.exit(1);
  }

  if (b === "test") {
    const settings = readSettings(name);
    if (!token || !settings.telegramChatId) {
      console.error("エラー: TELEGRAM_BOT_TOKEN と chat_id（telegram <name> <chatId>）を設定してください。");
      process.exit(1);
    }
    await sendTelegram(token, settings.telegramChatId, `（テスト送信）${name} からのメッセージです。届いていますか？`);
    console.log("テスト送信しました。Telegram を確認してください。");
    return;
  }

  // chat_id を保存
  const chatId = b;
  if (!chatId) {
    console.error("使い方: teachmate telegram <name> <chatId>");
    process.exit(1);
  }
  const settings = readSettings(name);
  settings.telegramChatId = chatId;
  writeSettings(name, settings);
  console.log(`${name} の送信先 chat_id を ${chatId} に設定しました。`);
}

const TASK_NAME = "teachmate-nudge";

function cmdSchedule(args: string[]): void {
  const [sub] = args;
  const { flags } = parseFlags(args.slice(1));

  if (process.platform !== "win32" && sub !== "status") {
    console.log(
      "Windows 以外です。cron 等で以下を日次実行してください:\n" +
        `  cd "${repoRoot()}" && node dist/index.js nudge-check`,
    );
    return;
  }

  if (sub === "install") {
    const time = typeof flags.time === "string" ? flags.time : "20:00";
    const root = repoRoot();
    const entry = path.join(root, "dist", "index.js");
    const logPath = path.join(baseDir(), "nudge.log");
    const tr = `cmd /c cd /d "${root}" && node "${entry}" nudge-check >> "${logPath}" 2>&1`;
    const taskArgs = ["/Create", "/TN", TASK_NAME, "/SC", "DAILY", "/ST", time, "/TR", tr, "/F"];

    if (flags.print === true) {
      console.log("schtasks " + taskArgs.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" "));
      return;
    }
    if (!fs.existsSync(entry)) {
      console.error(`エラー: ${entry} がありません。先に \`npm run build\` を実行してください。`);
      process.exit(1);
    }
    const res = spawnSync("schtasks", taskArgs, { encoding: "utf8" });
    if (res.status === 0) {
      console.log(`タスク "${TASK_NAME}" を毎日 ${time} に登録しました。`);
      console.log(`ログ: ${logPath}`);
      console.log("※ API キー/トークンは ~/.teachmate/.env に置くとスケジューラ起動時も読み込まれます。");
    } else {
      console.error("登録に失敗しました:\n" + (res.stderr || res.stdout || res.error?.message));
      process.exit(1);
    }
    return;
  }

  if (sub === "uninstall") {
    const res = spawnSync("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"], { encoding: "utf8" });
    console.log(res.status === 0 ? `タスク "${TASK_NAME}" を解除しました。` : (res.stderr || res.stdout));
    return;
  }

  if (sub === "status") {
    const res = spawnSync("schtasks", ["/Query", "/TN", TASK_NAME], { encoding: "utf8" });
    console.log(res.status === 0 ? res.stdout : `タスク "${TASK_NAME}" は登録されていません。`);
    return;
  }

  console.error("使い方: teachmate schedule <install|uninstall|status> [--time HH:MM] [--print]");
  process.exit(1);
}

const INGEST_EXT = /\.(md|markdown|txt|pdf)$/i;

/** .md/.txt/.pdf ファイル（またはそのディレクトリ）を集める。 */
function collectTextFiles(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs
    .readdirSync(target)
    .filter((f) => INGEST_EXT.test(f))
    .map((f) => path.join(target, f));
}

/** ファイルからテキストを読む（PDF は抽出）。 */
async function readDocText(file: string): Promise<string> {
  if (/\.pdf$/i.test(file)) return extractPdfText(fs.readFileSync(file));
  return fs.readFileSync(file, "utf8");
}

async function cmdIngest(args: string[]): Promise<void> {
  const [name, target] = args;
  if (!name || !target) {
    console.error("エラー: teachmate ingest <name> <path>（ファイル or ディレクトリ）");
    process.exit(1);
  }
  if (!characterExists(name)) {
    console.error(`エラー: キャラクター "${name}" が見つかりません。まず init してください。`);
    process.exit(1);
  }
  if (!fs.existsSync(target)) {
    console.error(`エラー: パスが見つかりません: ${target}`);
    process.exit(1);
  }
  const now = new Date().toISOString();
  const db = openDb(name);
  try {
    const files = collectTextFiles(target);
    if (files.length === 0) {
      console.error("エラー: .md/.txt/.pdf ファイルが見つかりませんでした");
      process.exit(1);
    }
    let total = 0;
    for (const file of files) {
      const source = path.basename(file);
      const text = await readDocText(file);
      const chunks = chunkText(text);
      replaceDocChunks(db, source, chunks, now);
      total += chunks.length;
      console.log(`取り込み: ${source} → ${chunks.length} チャンク`);
    }
    console.log(`完了。基準知識チャンク合計: ${countDocChunks(db)} 件（今回 ${total} 件）`);
  } finally {
    db.close();
  }
}

function requireCharacter(name: string | undefined, cmd: string): asserts name is string {
  if (!name) {
    console.error(`エラー: キャラクター名を指定してください（teachmate ${cmd} <name>）`);
    process.exit(1);
  }
  if (!characterExists(name)) {
    console.error(`エラー: キャラクター "${name}" が見つかりません。まず init してください。`);
    process.exit(1);
  }
}

async function cmdTeach(args: string[]): Promise<void> {
  requireCharacter(args[0], "teach");
  await runTeachSession(args[0]);
}

async function cmdSetup(args: string[]): Promise<void> {
  requireCharacter(args[0], "setup");
  await runSetupSession(args[0]);
}

async function main(): Promise<void> {
  loadEnv();
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "init":
      cmdInit(rest);
      break;
    case "list":
      cmdList();
      break;
    case "setup":
      await cmdSetup(rest);
      break;
    case "teach":
      await cmdTeach(rest);
      break;
    case "ingest":
      await cmdIngest(rest);
      break;
    case "nudge-check":
      await cmdNudgeCheck(rest);
      break;
    case "telegram":
      await cmdTelegram(rest);
      break;
    case "schedule":
      cmdSchedule(rest);
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      console.error(`不明なコマンド: ${cmd}`);
      usage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`エラー: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
