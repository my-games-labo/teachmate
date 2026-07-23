/**
 * 再登場アジェンダの構築（仕様書 第11章）。
 * 復習期日が来た概念・未解決の矛盾を、確信度・失敗回数・経過時間・矛盾の有無から
 * 重み付けし、条件付きのランダム性を加えて数件だけ選ぶ。
 * 「毎回すぐ全部指摘する」のではなく、重要なものを優先しつつ揺らぎを持たせる。
 */
import { understandingRetention } from "./game.js";

export interface AgendaCandidate {
  conceptId: number;
  domain: string;
  concept: string;
  confidence: number;
  understanding: number;
  wrongCount: number;
  lastReviewedAt: string | null;
  nextReviewAt: string | null;
  intervalDays: number;
  contradiction?: string; // 未解決の矛盾
  question?: string; // 未解決の疑問
}

export interface AgendaItem {
  candidate: AgendaCandidate;
  kind: "矛盾" | "覚えなおし" | "復習" | "確認";
  score: number;
  line: string;
}

function elapsedDays(from: string | null, nowMs: number): number {
  if (!from) return 0;
  return Math.max(0, (nowMs - Date.parse(from)) / 86400_000);
}

/**
 * @param rand 0..1 の乱数生成器（既定 Math.random）。テスト時に差し替え可能。
 */
export function buildAgenda(
  candidates: AgendaCandidate[],
  nowMs: number,
  maxItems = 2,
  rand: () => number = Math.random,
): AgendaItem[] {
  const scored: AgendaItem[] = candidates.map((c) => {
    const overdue = elapsedDays(c.nextReviewAt, nowMs);
    const sinceReview = elapsedDays(c.lastReviewedAt, nowMs);
    // 忘却度（0..1, 低いほど忘れている）
    const ret = understandingRetention(c.intervalDays, c.lastReviewedAt, nowMs);

    let score =
      overdue * 0.5 +
      (1 - c.confidence) * 1.5 +
      c.wrongCount * 1.0 +
      sinceReview * 0.1 +
      (1 - ret) * 2.0; // 忘れているほど優先
    if (c.contradiction) score += 1.2; // 矛盾は重め（ただし毎回独占しない程度）
    if (c.question) score += 0.5;

    // 条件付きランダム性: スコアに 0.7〜1.3 の揺らぎ
    score *= 0.7 + rand() * 0.6;

    const kind: AgendaItem["kind"] = c.contradiction
      ? "矛盾"
      : ret < 0.5
        ? "覚えなおし"
        : c.understanding < 0.5 || c.confidence < 0.5 || c.wrongCount > 0
          ? "復習"
          : "確認";

    // 文言は「意図」を示す内部メモ。キャラは自分の言葉で言い換える（決まり文句にしない）。
    let line: string;
    if (kind === "矛盾") {
      line = `[矛盾] ${c.concept}（${c.domain}）: 以前の説明と食い違う気がして、もやもやしている。手がかり: ${c.contradiction}`;
    } else if (kind === "覚えなおし") {
      line = `[覚えなおし] ${c.concept}（${c.domain}）: 前に教わったのに思い出せない。正直に忘れたと打ち明け、もう一度教わりたい`;
    } else if (kind === "復習") {
      line = `[復習] ${c.concept}（${c.domain}）: まだあやふや。いつもと違う角度（具体例・言い換え・自分の理解をぶつける等）で持ち出す${
        c.question ? `（引っかかっている点: ${c.question}）` : ""
      }`;
    } else {
      line = `[確認] ${c.concept}（${c.domain}）: 覚えているか、話の流れで自然に触れる`;
    }

    return { candidate: c, kind, score, line };
  });

  // 重い項目（矛盾・覚えなおし）は会話中せいぜい1件に絞り、蒸し返しすぎを防ぐ
  const sorted = scored.sort((a, b) => b.score - a.score);
  const picked: AgendaItem[] = [];
  let heavy = 0;
  for (const it of sorted) {
    const isHeavy = it.kind === "矛盾" || it.kind === "覚えなおし";
    if (isHeavy && heavy >= 1) continue;
    if (isHeavy) heavy++;
    picked.push(it);
    if (picked.length >= maxItems) break;
  }
  return picked;
}
