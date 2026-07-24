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

/** 内部状態から導く「気分」＝キャラの見た目の状態。 */
export interface Mood {
  name: string;
  face: string;
  blurb: string;
}

export interface GameStats {
  level: number;
  xp: number;
  xpInLevel: number;
  xpForNext: number;
  overallMastery: number; // 減衰後（いま覚えている度合い）
  domains: DomainMastery[]; // 減衰後
  conceptsTotal: number;
  conceptsMastered: number; // 累積の到達（減衰しない実績）
  streak: number;
  title: string;
  stage: Stage;
  mockPassed: number;
  mockTotal: number;
  // 頭の中（現在の記憶状態）
  memory: { solid: number; fuzzy: number; fading: number };
  contradictions: number;
  mood: Mood;
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

// ── 忘却曲線（compute-on-read の減衰）──────────────────────────────
// 保存値は書き換えず、読むときに「経過時間」で減衰させて“いま覚えている度合い”を出す。
// ゲーム層（status/催促/気分）の裏方。会話をバカっぽくしないよう、減衰は控えめにする。
const RETAIN_FLOOR = 0.35; // 理解は簡単には消えない（残る下限）
const STAB_BASE_DAYS = 10; // 一度教えただけでも約2週間は大きく崩れない
const STAB_MULT = 3; // 反復するほど（interval が伸びるほど）忘れにくくなる

/** 記憶の安定度（日）。よく反復したほど大きい。 */
function stabilityDays(intervalDays: number): number {
  return Math.max(STAB_BASE_DAYS, intervalDays * STAB_MULT);
}

function retention(elapsedDays: number, stability: number): number {
  return Math.exp(-Math.max(0, elapsedDays) / Math.max(0.5, stability));
}

/** 理解の保持率 0..1（1=よく覚えている, 低い=忘れかけ）。アジェンダの覚えなおし判定に使う。 */
export function understandingRetention(
  intervalDays: number,
  lastReviewedAt: string | null,
  nowMs: number,
): number {
  if (!lastReviewedAt) return 1;
  const elapsedDays = (nowMs - Date.parse(lastReviewedAt)) / 86400_000;
  return retention(elapsedDays, stabilityDays(intervalDays));
}

/** 理解度を経過時間で緩やかに減衰させる（下限あり）。 */
function decay(
  understanding: number,
  intervalDays: number,
  elapsedDays: number,
): number {
  const rU = retention(elapsedDays, stabilityDays(intervalDays));
  return understanding * (RETAIN_FLOOR + (1 - RETAIN_FLOOR) * rU);
}

function moodOf(
  total: number,
  memory: { solid: number; fuzzy: number; fading: number },
  contradictions: number,
): Mood {
  if (total === 0)
    return { name: "まっさら", face: "(・ω・)", blurb: "まだ何も教わっていない。まっさらな状態。" };
  const f = (n: number) => n / total;
  // 矛盾は「割合が目立つとき」だけ気分を支配する（少数なら気にしすぎない）
  if (contradictions / total >= 0.15)
    return { name: "こんがらがり", face: "(@_@)", blurb: "教わった内容の食い違いが多くて、頭がこんがらがっている。" };
  if (f(memory.fading) >= 0.4)
    return { name: "そわそわ", face: "(・_・;)", blurb: "だいぶ忘れかけていて、そわそわしている。" };
  if (f(memory.fuzzy) >= 0.4)
    return { name: "うろ覚え", face: "(._.?)", blurb: "うろ覚えが多くて、少し自信がなさそう。" };
  if (f(memory.solid) >= 0.6)
    return { name: "ごきげん", face: "(^o^)", blurb: "しっかり覚えていて、調子が良さそう。" };
  return { name: "ぼちぼち", face: "(・v・)", blurb: "ぼちぼち。まだ固めきれていない知識もある。" };
}

interface Row {
  domain: string;
  understanding: number;
  confidence: number;
  taught_count: number;
  applied_count: number;
  interval_days: number;
  last_reviewed_at: string | null;
}

export function computeStats(
  db: Database.Database,
  state: State,
  now: Date = new Date(),
): GameStats {
  const rows = db
    .prepare(
      `SELECT c.domain AS domain, k.understanding, k.confidence,
              k.taught_count, k.applied_count, k.interval_days, k.last_reviewed_at
         FROM knowledge_state k JOIN concepts c ON c.id = k.concept_id`,
    )
    .all() as Row[];
  const nowMs = now.getTime();

  // XP（累積の実績なので減衰させない）: 教えた回数・理解×確信・応用回数から
  let xp = 0;
  for (const r of rows) {
    xp += r.taught_count * 8;
    xp += Math.round(r.understanding * r.confidence * 20);
    xp += r.applied_count * 12;
  }
  const level = levelForXp(xp);
  const xpInLevel = xp - xpForLevel(level);
  const xpForNext = xpForLevel(level + 1) - xpForLevel(level);

  // 各概念の「いま覚えている度合い」を忘却曲線で計算
  const eff = rows.map((r) => {
    const elapsedDays = r.last_reviewed_at
      ? (nowMs - Date.parse(r.last_reviewed_at)) / 86400_000
      : 0;
    return decay(r.understanding, r.interval_days, elapsedDays);
  });

  // 分野別習熟度（減衰後）。「大分野（小分野）」は括弧以降を落として束ねる。
  const byDomain = new Map<string, { sum: number; n: number }>();
  rows.forEach((r, i) => {
    const key = normalizeDomain(r.domain);
    const e = byDomain.get(key) ?? { sum: 0, n: 0 };
    e.sum += eff[i];
    e.n += 1;
    byDomain.set(key, e);
  });
  const domains: DomainMastery[] = [...byDomain.entries()]
    .map(([domain, e]) => ({ domain, mastery: e.sum / e.n, count: e.n }))
    .sort((a, b) => b.mastery - a.mastery);

  const conceptsTotal = rows.length;
  const conceptsMastered = rows.filter((r) => r.understanding >= 0.8).length;
  const overallMastery =
    conceptsTotal === 0 ? 0 : eff.reduce((s, v) => s + v, 0) / conceptsTotal;

  // 頭の中（現在の記憶状態）を分類
  const memory = { solid: 0, fuzzy: 0, fading: 0 };
  for (const v of eff) {
    if (v >= 0.7) memory.solid++;
    else if (v >= 0.4) memory.fuzzy++;
    else memory.fading++;
  }
  const contradictions = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM open_items WHERE kind='contradiction' AND resolved=0`,
      )
      .get() as { n: number }
  ).n;
  const mood = moodOf(conceptsTotal, memory, contradictions);

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
    memory,
    contradictions,
    mood,
  };
}

/** 現在「習得済み（理解度0.8以上）」の概念名の集合。成長差分の判定に使う。 */
export function masteredConcepts(db: Database.Database): Set<string> {
  const rows = db
    .prepare(
      `SELECT c.name AS name FROM knowledge_state k
         JOIN concepts c ON c.id = k.concept_id
        WHERE k.understanding >= 0.8`,
    )
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
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
