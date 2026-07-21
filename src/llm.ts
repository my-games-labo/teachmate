import Anthropic from "@anthropic-ai/sdk";
import { Settings } from "./types.js";
import { mockEnabled, mockSpeak, mockJudge, mockInterview } from "./mock.js";
import {
  cliComplete,
  extractJson,
  renderText,
  renderStructured,
  JUDGE_JSON_INSTRUCTION,
  INTERVIEW_JSON_INSTRUCTION,
} from "./cliProvider.js";

type Provider = "anthropic" | "claude-cli";
function provider(): Provider {
  return process.env.TEACHMATE_PROVIDER === "claude-cli" ? "claude-cli" : "anthropic";
}

/**
 * Claude ラッパー。会話生成と「理解判定（構造化出力）」を提供する。
 * モデルは既定 Sonnet 4.6、TEACHMATE_MODEL で上書き可能。
 */

const DEFAULT_MODEL = "claude-sonnet-4-6";

export function model(): string {
  return process.env.TEACHMATE_MODEL || DEFAULT_MODEL;
}

export type Turn = { role: "user" | "assistant"; content: string };

let cached: Anthropic | null = null;
function client(): Anthropic {
  if (cached) return cached;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY が未設定です。環境変数に API キーを設定してください。",
    );
  }
  cached = new Anthropic({ apiKey });
  return cached;
}

/** プレーンテキスト応答（キャラクターの発話生成に使う）。 */
export async function speak(system: string, history: Turn[]): Promise<string> {
  if (mockEnabled()) return mockSpeak(system, history);
  if (provider() === "claude-cli") return cliComplete(renderText(system, history));
  const res = await client().messages.create({
    model: model(),
    max_tokens: 1024,
    system,
    messages: history,
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return text;
}

/** 理解判定の構造化結果（仕様書 第8・9・12章）。 */
export interface Judgment {
  concept: string; // ユーザーが説明した中心概念の短い名前
  domain: string; // 分野
  understanding: number; // 0..1 キャラがどれだけ理解できたか
  confidence: number; // 0..1 キャラの確信度
  characterBelief: string; // 説明を受けてキャラが今信じている理解（一人称）
  reply: string; // キャラクターの会話返答（採点口調は禁止）
  openQuestion?: string; // 未解決の疑問
  contradiction?: string; // 過去の説明との矛盾に気づいた場合
}

const JUDGMENT_TOOL: Anthropic.Tool = {
  name: "record_understanding",
  description:
    "ユーザーの説明を受けたキャラクターの理解状態と会話返答を記録する。必ずこのツールを1回呼ぶ。",
  input_schema: {
    type: "object",
    properties: {
      concept: {
        type: "string",
        description: "ユーザーが今説明した中心概念の短い名前（例: S3, 可用性, IAMロール）",
      },
      domain: { type: "string", description: "その概念が属する分野（例: ストレージ, IAM）" },
      understanding: {
        type: "number",
        description: "0..1。キャラクターがどれだけ理解できたか。曖昧な説明なら低め。",
      },
      confidence: {
        type: "number",
        description: "0..1。キャラクターの確信度。誤りを受け取った場合は低くなりやすい。",
      },
      character_belief: {
        type: "string",
        description:
          "この説明を受けてキャラクターが今信じている理解。キャラクター視点の一人称・自分の言葉で。ユーザーの説明の丸写しにしない。",
      },
      reply: {
        type: "string",
        description:
          "キャラクターの会話返答。理解の度合いを会話として自然に表現する。採点口調（正解/不正解/○点）は禁止。必要なら次の質問・具体例の要求・不安の吐露を含める。",
      },
      open_question: {
        type: "string",
        description: "まだ分からず残った疑問があれば書く。なければ空文字。",
      },
      contradiction: {
        type: "string",
        description:
          "過去にユーザーが教えた内容との食い違いに気づいた場合のみ、その矛盾を書く。なければ空文字。",
      },
    },
    required: [
      "concept",
      "domain",
      "understanding",
      "confidence",
      "character_belief",
      "reply",
    ],
  },
};

/** 初回セットアップ会話で組み立てるコース案（仕様書 第6章）。 */
export interface CourseProposal {
  reply: string; // キャラクターの次の発話（未完了なら次の質問、完了なら確認の要約）
  ready: boolean; // 必要な情報が揃ったか
  theme?: string;
  purpose?: string;
  goal?: string;
  scope?: string;
  domains?: string[];
  examDate?: string; // ISO 日付 or ""
  userLevel?: string;
  firstTopic?: string;
  sessionsPerWeek?: number;
  nudgeStrength?: Settings["nudgeStrength"];
}

const COURSE_TOOL: Anthropic.Tool = {
  name: "propose_course",
  description:
    "初回インタビューの現時点の内容から学習コース案を更新し、キャラクターの次の発話を返す。毎ターン必ず1回呼ぶ。",
  input_schema: {
    type: "object",
    properties: {
      reply: {
        type: "string",
        description:
          "キャラクターの次の発話。まだ情報が足りなければ次の質問を1つだけ。十分揃ったら、集めた内容を短く要約し『この方針で始めていい？』と確認する。",
      },
      ready: {
        type: "boolean",
        description: "学習を始めるのに十分な情報が揃い、ユーザーの確認を待つ段階なら true。",
      },
      theme: { type: "string", description: "学習テーマ（例: AWS認定 SAA）" },
      purpose: { type: "string", description: "学習目的" },
      goal: { type: "string", description: "到達目標" },
      scope: { type: "string", description: "学習範囲" },
      domains: {
        type: "array",
        items: { type: "string" },
        description: "学習分野を学ぶ順に並べたもの",
      },
      exam_date: { type: "string", description: "試験日/期限（YYYY-MM-DD）。無ければ空文字。" },
      user_level: { type: "string", description: "ユーザーの現在の理解度" },
      first_topic: { type: "string", description: "最初に扱う話題" },
      sessions_per_week: { type: "number", description: "週あたりの学習回数の希望" },
      nudge_strength: {
        type: "string",
        enum: ["soft", "normal", "firm"],
        description: "催促の強さの希望",
      },
    },
    required: ["reply", "ready"],
  },
};

/** 構造化入力を CourseProposal に写す。 */
function mapProposal(input: Record<string, unknown>): CourseProposal {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const strength = str(input.nudge_strength);
  return {
    reply: str(input.reply) ?? "",
    ready: input.ready === true,
    theme: str(input.theme),
    purpose: str(input.purpose),
    goal: str(input.goal),
    scope: str(input.scope),
    domains: Array.isArray(input.domains)
      ? input.domains.filter((d): d is string => typeof d === "string")
      : undefined,
    examDate: str(input.exam_date),
    userLevel: str(input.user_level),
    firstTopic: str(input.first_topic),
    sessionsPerWeek:
      typeof input.sessions_per_week === "number" ? input.sessions_per_week : undefined,
    nudgeStrength:
      strength === "soft" || strength === "normal" || strength === "firm"
        ? strength
        : undefined,
  };
}

/** 初回インタビューの1ターン（現時点のコース案とキャラの発話を返す）。 */
export async function interviewCourse(
  system: string,
  history: Turn[],
): Promise<CourseProposal> {
  if (mockEnabled()) return mockInterview(system, history);
  if (provider() === "claude-cli") {
    const out = await cliComplete(
      renderStructured(system, history, INTERVIEW_JSON_INSTRUCTION),
    );
    return mapProposal(extractJson(out));
  }
  const res = await client().messages.create({
    model: model(),
    max_tokens: 1024,
    system,
    messages: history,
    tools: [COURSE_TOOL],
    tool_choice: { type: "tool", name: COURSE_TOOL.name },
  });
  const block = res.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!block) throw new Error("コース案の構造化出力が得られませんでした");
  return mapProposal(block.input as Record<string, unknown>);
}

/** 構造化入力（ツール input / CLI の JSON）を Judgment に写す。 */
function mapJudgment(input: Record<string, unknown>): Judgment {
  const clamp = (v: unknown) =>
    Math.max(0, Math.min(1, typeof v === "number" ? v : 0));
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    concept: str(input.concept) || "（不明）",
    domain: str(input.domain) || "（未分類）",
    understanding: clamp(input.understanding),
    confidence: clamp(input.confidence),
    characterBelief: str(input.character_belief),
    reply: str(input.reply),
    openQuestion: str(input.open_question) || undefined,
    contradiction: str(input.contradiction) || undefined,
  };
}

/** ユーザーの説明を理解判定し、会話返答を生成する。 */
export async function judge(system: string, history: Turn[]): Promise<Judgment> {
  if (mockEnabled()) return mockJudge(history);
  if (provider() === "claude-cli") {
    const out = await cliComplete(
      renderStructured(system, history, JUDGE_JSON_INSTRUCTION),
    );
    return mapJudgment(extractJson(out));
  }
  const res = await client().messages.create({
    model: model(),
    max_tokens: 1024,
    system,
    messages: history,
    tools: [JUDGMENT_TOOL],
    tool_choice: { type: "tool", name: JUDGMENT_TOOL.name },
  });
  const block = res.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!block) throw new Error("理解判定の構造化出力が得られませんでした");
  return mapJudgment(block.input as Record<string, unknown>);
}
