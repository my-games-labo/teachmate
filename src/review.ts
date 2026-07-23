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
  maxItems = 3,
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

    let line: string;
    if (kind === "矛盾") {
      line = `[矛盾] ${c.concept}（${c.domain}）: 以前の説明と食い違う気がする。やんわり尋ねて確かめたい。手がかり: ${c.contradiction}`;
    } else if (kind === "覚えなおし") {
      line = `[覚えなおし] ${c.concept}（${c.domain}）: 前に教わったのに、うろ覚えで思い出せない。正直に「忘れちゃった」と言って、もう一度教えてほしいと頼む`;
    } else if (kind === "復習") {
      line = `[復習] ${c.concept}（${c.domain}）: まだ自信がない。具体例や言い換えで確認したい${
        c.question ? `（引っかかっている点: ${c.question}）` : ""
      }`;
    } else {
      line = `[確認] ${c.concept}（${c.domain}）: 覚えているか軽く確認したい`;
    }

    return { candidate: c, kind, score, line };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, maxItems);
}
