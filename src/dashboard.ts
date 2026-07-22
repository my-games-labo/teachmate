import { GameStats } from "./game.js";

/** 0..1 を幅 width のバーにする。 */
function bar(pct: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round(pct * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** 全角を2幅として概算した表示幅で右パディング。 */
function padDisplay(s: string, width: number): string {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0xff ? 2 : 1;
  return s + " ".repeat(Math.max(0, width - w));
}

/** ダッシュボードを文字列にして返す。 */
export function renderDashboard(name: string, s: GameStats): string {
  const out: string[] = [];
  const flame = s.streak > 0 ? `🔥x${s.streak}日` : "🔥x0日";

  out.push("");
  out.push(`  ${name}   Lv.${s.level}   ${flame}   称号: ${s.title}`);
  out.push("");
  out.push(`    ╔═════════╗`);
  out.push(`    ║  ${padDisplay(s.stage.face, 5)}  ║   ${s.stage.name}`);
  out.push(`    ╚═════════╝   XP ${bar(s.xpForNext ? s.xpInLevel / s.xpForNext : 1)} ${s.xpInLevel}/${s.xpForNext}`);
  out.push("");

  out.push(`  分野の習熟度`);
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
