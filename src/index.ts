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
import { listCharacters, characterExists } from "./paths.js";
import { readState, listOpenItems, resolveAllContradictions } from "./store.js";
import { computeStats } from "./game.js";
import { renderDashboard, renderPanel } from "./dashboard.js";
import { chunkText } from "./rag.js";
import { extractPdfText } from "./pdf.js";
import { runTeachSession } from "./session.js";
import { runSetupSession } from "./setup.js";
import { runNudgeCheck } from "./nudge.js";
import { getTelegramChats, sendTelegram } from "./telegram.js";
import { loadEnv } from "./env.js";
import fs from "node:fs";
import path from "node:path";

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
  teachmate status <name>                          成長ダッシュボード（レベル/習熟度/称号）
  teachmate inspect <name> [--clear-contradictions]  内部状態（未解決の矛盾/疑問）を覗く
  teachmate ingest <name> <path>                   基準知識を取り込む（.md/.txt/.pdf）
  teachmate nudge-check [--dry-run] [--force]      催促を判定して Telegram 送信
  teachmate daemon [--interval 15]                 常駐して定期的に催促を判定（OS非依存）
  teachmate telegram whoami                        ボットに話しかけた chat_id を確認
  teachmate telegram <name> <chatId>               送信先 chat_id を設定
  teachmate telegram <name> test                   テスト送信
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

/** OS 非依存の常駐デーモン。一定間隔で催促を判定し、送るべきものを送る。 */
async function cmdDaemon(args: string[]): Promise<void> {
  const { flags } = parseFlags(args);
  const intervalMin = Math.max(1, Number(flags.interval) || 15);
  const intervalMs = intervalMin * 60_000;
  const hhmmss = (d: Date) => d.toTimeString().slice(0, 8);
  const sent: { time: string; name: string; message: string }[] = [];

  const doCheck = async (): Promise<string> => {
    try {
      const results = await runNudgeCheck();
      for (const r of results.filter((r) => r.status === "sent")) {
        sent.unshift({ time: hhmmss(new Date()), name: r.name, message: r.message ?? "" });
      }
      return `送信 ${results.filter((r) => r.status === "sent").length} 件 / 判定 ${results.length} 件`;
    } catch (e) {
      return `エラー: ${e instanceof Error ? e.message : e}`;
    }
  };

  // 背景（非TTY）: 素朴なログ行
  if (process.stdout.isTTY !== true) {
    console.log(`teachmate daemon 起動: ${intervalMin}分ごとに判定（Ctrl+C で停止）`);
    const tick = async () =>
      console.log(`[${new Date().toLocaleString()}] ${await doCheck()}`);
    await tick();
    setInterval(tick, intervalMs);
    await new Promise<void>(() => {});
    return;
  }

  // 前景（TTY）: キャラの状態＋次チェックまでを描画
  let nextCheckMs = Date.now();
  let checking = false;
  let lastResult = "起動しました";

  const panels = (): string => {
    const names = listCharacters();
    if (names.length === 0) return "  キャラクターがいません。";
    return names
      .map((name) => {
        const db = openDb(name);
        try {
          return renderPanel(name, computeStats(db, readState(name)));
        } finally {
          db.close();
        }
      })
      .join("\n\n");
  };

  const draw = () => {
    const remain = Math.max(0, nextCheckMs - Date.now());
    const mm = String(Math.floor(remain / 60000)).padStart(2, "0");
    const ss = String(Math.floor((remain % 60000) / 1000)).padStart(2, "0");
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    console.log(`teachmate daemon   ${new Date().toLocaleString()}   （Ctrl+C で停止）`);
    console.log(
      checking
        ? `  判定中…`
        : `  次のチェックまで ${mm}:${ss}   （${intervalMin}分間隔）   前回: ${lastResult}`,
    );
    console.log("");
    console.log(panels());
    console.log("");
    console.log("  最近の催促送信:");
    if (sent.length === 0) console.log("    （まだありません）");
    else for (const s of sent.slice(0, 5)) console.log(`    [${s.time}] ${s.name}: ${s.message}`);
  };

  draw();
  setInterval(async () => {
    if (!checking && Date.now() >= nextCheckMs) {
      checking = true;
      draw();
      lastResult = await doCheck();
      nextCheckMs = Date.now() + intervalMs;
      checking = false;
    }
    draw();
  }, 1000);
  await new Promise<void>(() => {});
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

function cmdStatus(args: string[]): void {
  requireCharacter(args[0], "status");
  const name = args[0];
  const db = openDb(name);
  try {
    const stats = computeStats(db, readState(name));
    console.log(renderDashboard(name, stats));
  } finally {
    db.close();
  }
}

/** 内部状態（未解決の矛盾・疑問・記憶の内訳）を覗く。--clear-contradictions で矛盾を一括解消。 */
function cmdInspect(args: string[]): void {
  requireCharacter(args[0], "inspect");
  const name = args[0];
  const { flags } = parseFlags(args.slice(1));
  const db = openDb(name);
  try {
    if (flags["clear-contradictions"] === true) {
      const n = resolveAllContradictions(db);
      console.log(`未解決の矛盾 ${n} 件を解消済みにしました。`);
      return;
    }
    const items = listOpenItems(db);
    const contradictions = items.filter((i) => i.kind === "contradiction");
    const questions = items.filter((i) => i.kind === "question");
    const s = computeStats(db, readState(name));

    console.log(`\n[${name}] 内部状態`);
    console.log(
      `  頭の中: しっかり${s.memory.solid} / うろ覚え${s.memory.fuzzy} / 忘れかけ${s.memory.fading}   気分: ${s.mood.name}`,
    );
    console.log(`\n  未解決の矛盾 (${contradictions.length})`);
    if (contradictions.length === 0) console.log("    なし");
    else contradictions.forEach((c) => console.log(`    - [${c.concept}] ${c.text}`));
    console.log(`\n  未解決の疑問 (${questions.length})`);
    if (questions.length === 0) console.log("    なし");
    else questions.forEach((q) => console.log(`    - [${q.concept}] ${q.text}`));
    console.log(
      `\n  ヒント: 該当概念を自信を持って教え直すと自動で解消されます。` +
        `\n  まとめて消すなら: teachmate inspect ${name} --clear-contradictions\n`,
    );
  } finally {
    db.close();
  }
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
    case "status":
      cmdStatus(rest);
      break;
    case "inspect":
      cmdInspect(rest);
      break;
    case "ingest":
      await cmdIngest(rest);
      break;
    case "nudge-check":
      await cmdNudgeCheck(rest);
      break;
    case "daemon":
      await cmdDaemon(rest);
      break;
    case "telegram":
      await cmdTelegram(rest);
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
