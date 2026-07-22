import Database from "better-sqlite3";
import { State } from "./types.js";

/**
 * ゲーム性の成長ロジック（仕様書 第13章）。
 * knowledge_state から派生的にレベル・分野別習熟度・称号・成長ステージを計算する。
 * 状態は保存せず毎回計算する（ストリークと模擬試験回数だけ state.json に持つ）。
 */

export interface DomainMastery {
  domain: string;
  mastery: number; // 0..1
  count: number;
}

export interface Stage {
  name: string;
  face: string;
}

export interface GameStats {
  level: number;
  xp: number;
  xpInLevel: number;
  xpForNext: number;
  overallMastery: number;
  domains: DomainMastery[];
  conceptsTotal: number;
  conceptsMastered: number;
  streak: number;
  title: string;
  stage: Stage;
  mockPassed: number;
  mockTotal: number;
}

/** 「大分野（小分野）」を大分野に丸める。表記ゆれ吸収のため trim も行う。 */
export function normalizeDomain(d: string): string {
  return d.split(/[（(]/)[0].trim() || d.trim();
}

/** ローカル時刻の YYYY-MM-DD。 */
export function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const STAGES: { min: number; name: string; face: string }[] = [
  { min: 1, name: "たまご", face: "(-.-)" },
  { min: 3, name: "ひよこ", face: "(o.o)" },
  { min: 5, name: "みならい", face: "(^-^)" },
  { min: 8, name: "いちにんまえ", face: "(^o^)" },
  { min: 12, name: "たつじん", face: "(*o*)" },
  { min: 18, name: "でんせつ", face: "(`o´)b" },
];

function stageForLevel(level: number): Stage {
  let s = STAGES[0];
  for (const st of STAGES) if (level >= st.min) s = st;
  return { name: s.name, face: s.face };
}

// レベル曲線: 累積 XP = 50 * (level-1)^2（後半ほど必要量が増える）
function xpForLevel(level: number): number {
  return 50 * (level - 1) * (level - 1);
}
function levelForXp(xp: number): number {
  return Math.floor(Math.sqrt(xp / 50)) + 1;
}

interface Row {
  domain: string;
  understanding: number;
  confidence: number;
  taught_count: number;
  applied_count: number;
}

export function computeStats(db: Database.Database, state: State): GameStats {
  const rows = db
    .prepare(
      `SELECT c.domain AS domain, k.understanding, k.confidence,
              k.taught_count, k.applied_count
         FROM knowledge_state k JOIN concepts c ON c.id = k.concept_id`,
    )
    .all() as Row[];

  // XP: 教えた回数・理解×確信・応用回数から
  let xp = 0;
  for (const r of rows) {
    xp += r.taught_count * 8;
    xp += Math.round(r.understanding * r.confidence * 20);
    xp += r.applied_count * 12;
  }
  const level = levelForXp(xp);
  const xpInLevel = xp - xpForLevel(level);
  const xpForNext = xpForLevel(level + 1) - xpForLevel(level);

  // 分野別習熟度（その分野の概念の理解度の平均）。
  // LLM が「大分野（小分野）」の形で細かく返すことがあるので括弧以降を落として束ねる。
  const byDomain = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    const key = normalizeDomain(r.domain);
    const e = byDomain.get(key) ?? { sum: 0, n: 0 };
    e.sum += r.understanding;
    e.n += 1;
    byDomain.set(key, e);
  }
  const domains: DomainMastery[] = [...byDomain.entries()]
    .map(([domain, e]) => ({ domain, mastery: e.sum / e.n, count: e.n }))
    .sort((a, b) => b.mastery - a.mastery);

  const conceptsTotal = rows.length;
  const conceptsMastered = rows.filter((r) => r.understanding >= 0.8).length;
  const overallMastery =
    conceptsTotal === 0
      ? 0
      : rows.reduce((s, r) => s + r.understanding, 0) / conceptsTotal;

  // 称号（達成した中で最も高いもの）
  const top = domains[0];
  const titleRules: { ok: boolean; name: string }[] = [
    { ok: conceptsTotal >= 1, name: "見習いの教え手" },
    { ok: conceptsMastered >= 3, name: "若手の教え手" },
    { ok: !!top && top.mastery >= 0.8 && top.count >= 2, name: `${top?.domain}の伝道師` },
    { ok: overallMastery >= 0.6 && conceptsTotal >= 10, name: "熟練の教え手" },
  ];
  const achieved = titleRules.filter((t) => t.ok);
  const title = achieved.length ? achieved[achieved.length - 1].name : "駆け出し";

  return {
    level,
    xp,
    xpInLevel,
    xpForNext,
    overallMastery,
    domains,
    conceptsTotal,
    conceptsMastered,
    streak: state.streak ?? 0,
    title,
    stage: stageForLevel(level),
    mockPassed: state.mockPassed ?? 0,
    mockTotal: 5,
  };
}

/** セッション実施を反映してストリークを更新した新しい state を返す。 */
export function bumpStreak(state: State, now: Date): State {
  const today = localDay(now);
  const yesterday = localDay(new Date(now.getTime() - 86400_000));
  let streak = state.streak ?? 0;
  if (state.streakLastDay === today) {
    // 同日中の再セッションは据え置き
  } else if (state.streakLastDay === yesterday) {
    streak += 1;
  } else {
    streak = 1;
  }
  return { ...state, streak, streakLastDay: today, lastActiveAt: now.toISOString() };
}
