import { GameStats } from "./game.js";

/** 0..1 を幅 width のバーにする。 */
function bar(pct: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round(pct * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** 全角を2幅として概算した表示幅で右パディング。 */
function padDisplay(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - displayWidth(s)));
}

/** 表示幅 width の中央に置く（左右を空白で埋める）。 */
function centerDisplay(s: string, width: number): string {
  const pad = Math.max(0, width - displayWidth(s));
  const left = Math.floor(pad / 2);
  return " ".repeat(left) + s + " ".repeat(pad - left);
}

/** ダッシュボードを文字列にして返す。 */
export function renderDashboard(name: string, s: GameStats): string {
  const out: string[] = [];
  const flame = s.streak > 0 ? `🔥x${s.streak}日` : "🔥x0日";

  out.push("");
  out.push(`  ${name}   Lv.${s.level}   ${flame}   称号: ${s.title}`);
  out.push("");
  // キャラの箱: 顔＝いまの気分、右に成長ステージ／気分名
  out.push(`    ╔═══════════╗`);
  out.push(`    ║ ${centerDisplay(s.mood.face, 9)} ║   ${s.stage.name} / ${s.mood.name}`);
  out.push(`    ╚═══════════╝   XP ${bar(s.xpForNext ? s.xpInLevel / s.xpForNext : 1)} ${s.xpInLevel}/${s.xpForNext}`);
  out.push(`  ${name} の様子: ${s.mood.blurb}`);
  out.push("");

  // 頭の中（現在の記憶状態）
  out.push(`  頭の中`);
  const dots = (n: number) => "●".repeat(Math.min(n, 12));
  out.push(`    しっかり  ${padDisplay(dots(s.memory.solid), 12)}  ${s.memory.solid}`);
  out.push(`    うろ覚え  ${padDisplay(dots(s.memory.fuzzy), 12)}  ${s.memory.fuzzy}`);
  out.push(`    忘れかけ  ${padDisplay(dots(s.memory.fading), 12)}  ${s.memory.fading}`);
  if (s.contradictions > 0) {
    out.push(`    モヤモヤ  ${padDisplay("▲".repeat(Math.min(s.contradictions, 12)), 12)}  ${s.contradictions}  （未解決の矛盾）`);
  }
  out.push("");

  out.push(`  分野の習熟度（いま覚えている度合い）`);
  if (s.domains.length === 0) {
    out.push(`    （まだ何も教わっていません。teach で教え始めよう）`);
  } else {
    const shown = s.domains.slice(0, 8);
    const w = Math.max(...shown.map((d) => displayWidth(d.domain)));
    for (const d of shown) {
      out.push(
        `    ${padDisplay(d.domain, w)}  ${bar(d.mastery)} ${Math.round(d.mastery * 100)}%  (${d.count})`,
      );
    }
    if (s.domains.length > shown.length) {
      out.push(`    …ほか ${s.domains.length - shown.length} 分野`);
    }
  }
  out.push("");
  out.push(
    `  概念 ${s.conceptsTotal}個（うち習得 ${s.conceptsMastered}）   全体習熟 ${Math.round(
      s.overallMastery * 100,
    )}%   模擬試験 ${s.mockPassed}/${s.mockTotal}合格`,
  );
  out.push("");
  return out.join("\n");
}

function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return w;
}

/** セッション前後の差分から「今日の成長」を描く。 */
export function renderGrowth(
  name: string,
  before: GameStats,
  after: GameStats,
  newlyMastered: string[],
): string {
  const lines: string[] = ["", "── 今日の成長 ──"];
  const xpGain = after.xp - before.xp;

  if (xpGain > 0) lines.push(`  XP +${xpGain}`);
  if (newlyMastered.length > 0)
    lines.push(`  🆕 習得: ${newlyMastered.join("、")}`);
  if (after.level > before.level)
    lines.push(
      `  ⬆ レベルアップ！ Lv.${before.level} → Lv.${after.level}（${after.stage.name}）`,
    );
  if (after.title !== before.title)
    lines.push(`  🏅 称号「${after.title}」を獲得！`);
  if (after.streak > 0) lines.push(`  🔥 ${after.streak}日連続`);

  // 変化が XP だけ等で寂しいとき用の一言
  if (lines.length <= 3 && xpGain <= 0) lines.push(`  こつこつ継続中。`);

  lines.push(`  （詳しくは "status ${name}"）`);
  return lines.join("\n");
}
