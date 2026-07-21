import { spawn } from "node:child_process";
import { Turn } from "./llm.js";

/**
 * Claude Code の `claude -p`（print モード）をサブプロセスで呼び、
 * 既存のログイン認証を再利用する LLM プロバイダ。
 * API キー不要。構造化出力はツール強制が使えないため JSON 指示＋パースで代替する。
 */

/** claude CLI にプロンプトを渡し、応答テキストを得る。 */
export function cliComplete(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // shell:true で claude(.cmd) を解決。args 配列＋shell の DEP0190 を避けるため
    // コマンドは単一文字列で渡す（モデル ID は env 由来で信頼できる）。
    const modelArg = process.env.TEACHMATE_MODEL
      ? ` --model ${process.env.TEACHMATE_MODEL}`
      : "";
    const child = spawn(`claude -p --output-format text${modelArg}`, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") {
        reject(
          new Error(
            "claude CLI が見つかりません。Claude Code をインストールしログインしてください。",
          ),
        );
      } else reject(e);
    });
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`claude CLI 失敗 (code ${code}): ${err.trim() || out.trim()}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** 応答テキストから最初の JSON オブジェクトを取り出してパースする。 */
export function extractJson<T = Record<string, unknown>>(text: string): T {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  if (start < 0) throw new Error("JSON が見つかりません: " + text.slice(0, 160));
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(t.slice(start, i + 1)) as T;
    }
  }
  throw new Error("JSON が閉じていません: " + text.slice(0, 160));
}

function transcript(history: Turn[]): string {
  return history
    .map((h) => `${h.role === "user" ? "ユーザー" : "あなた"}: ${h.content}`)
    .join("\n");
}

/** テキスト応答（発話生成）用プロンプト。 */
export function renderText(system: string, history: Turn[]): string {
  return `${system}

## これまでの会話
${transcript(history)}

## 指示
上記の流れを踏まえ、あなた（キャラクター）の次の発話だけを、説明や引用符なしで出力してください。`;
}

/** 構造化出力用プロンプト（instruction に JSON スキーマ説明を渡す）。 */
export function renderStructured(
  system: string,
  history: Turn[],
  instruction: string,
): string {
  return `${system}

## これまでの会話
${transcript(history)}

## 指示
${instruction}`;
}

export const JUDGE_JSON_INSTRUCTION = `直近のユーザーの説明に対するあなたの理解状態と会話返答を、次の形の JSON オブジェクト「だけ」で出力してください（前後に文章を書かない）。
{
  "concept": "ユーザーが今説明した中心概念の短い名前（例: S3, 可用性）",
  "domain": "その概念の分野（例: ストレージ）",
  "understanding": 0.0,
  "confidence": 0.0,
  "character_belief": "この説明を受けてあなたが今信じている理解。一人称・自分の言葉で",
  "reply": "会話返答。採点口調(正解/不正解/点数)は禁止。必要なら次の質問や具体例の要求、不安を含める",
  "open_question": "まだ残った疑問。無ければ空文字",
  "contradiction": "過去の説明や公式資料との食い違いに気づいた場合のみ書く。無ければ空文字"
}
understanding と confidence は 0〜1 の数値。`;

export const INTERVIEW_JSON_INSTRUCTION = `初回インタビューとして、現時点のコース案とあなたの次の発話を、次の形の JSON オブジェクト「だけ」で出力してください（前後に文章を書かない）。
{
  "reply": "あなたの次の発話。情報が足りなければ次の質問を1つだけ。十分揃ったら内容を要約して『この方針で始めていい？』と確認",
  "ready": false,
  "theme": "", "purpose": "", "goal": "", "scope": "",
  "domains": [],
  "exam_date": "",
  "user_level": "", "first_topic": "",
  "sessions_per_week": 3,
  "nudge_strength": "normal"
}
十分な情報が揃い確認段階なら ready を true にする。nudge_strength は soft|normal|firm。`;
