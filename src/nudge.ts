import { listCharacters } from "./paths.js";
import {
  openDb,
  readCourse,
  readSettings,
  readState,
  writeState,
  readPersona,
  dueAgendaCandidates,
} from "./store.js";
import { buildAgenda, AgendaItem } from "./review.js";
import { sendTelegram } from "./telegram.js";
import { speak } from "./llm.js";
import { Course, Settings, Persona, personaPrompt } from "./types.js";

const DAY = 86400_000;

export interface NudgeOptions {
  dryRun?: boolean; // 送信せず表示のみ
  force?: boolean; // 曜日/quiet/当日済み判定を無視（テスト用）
}

function inQuietHours(hour: number, [start, end]: [number, number]): boolean {
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const STRENGTH_TONE: Record<Settings["nudgeStrength"], string> = {
  soft: "とても控えめに、プレッシャーを与えないように",
  normal: "友達に軽く声をかけるくらいの調子で",
  firm: "少しだけ背中を押すように、でも責めない範囲で",
};

/** LLM が使えない/失敗した場合のテンプレート文面。 */
function templateNudge(name: string, agenda: AgendaItem[]): string {
  if (agenda.length === 0) {
    return "この前の続き、少しだけ教えてくれない？";
  }
  const top = agenda[0];
  if (top.kind === "矛盾") {
    return `${top.candidate.concept}のことでちょっと引っかかってるんだ。少し確認させてくれない？`;
  }
  return `${top.candidate.concept}のところ、まだ自信がなくて。少しだけ教えてくれないかな？`;
}

/** キャラクターの声で催促文を作る（API キーがあれば LLM、無ければテンプレート）。 */
async function craftNudge(
  name: string,
  persona: Persona,
  course: Course,
  settings: Settings,
  agenda: AgendaItem[],
): Promise<string> {
  const focus =
    agenda.length === 0
      ? "特に決まった話題はない。しばらく会えていないので、また教えてほしいと軽く誘う。"
      : agenda
          .slice(0, 2)
          .map((a) => `- ${a.kind}: ${a.candidate.concept}（${a.candidate.domain}）`)
          .join("\n");

  const system = `あなたは「${name}」という、${course.theme}を勉強中のキャラクターです。学習を一緒に進めてくれるユーザーに、短い催促メッセージ（プッシュ通知）を送ります。

${personaPrompt(persona)}

## メッセージの作り方
- ${STRENGTH_TONE[settings.nudgeStrength]}声をかける。
- 1〜2文、絵文字は使いすぎない。採点や命令口調は禁止。
- できれば「何のために」を添える（例: 次の模擬問題に進みたい、ここが不安、など）。
- メッセージ本文だけを出力する（名前や引用符で囲まない）。`;

  const instruction = `今日ユーザーに送る催促メッセージを1つ作ってください。今日触れたい内容:\n${focus}`;

  try {
    const text = await speak(system, [{ role: "user", content: instruction }]);
    return text.trim() || templateNudge(name, agenda);
  } catch {
    // LLM が使えない（キー無し・claude 未ログイン等）ときはテンプレへ
    return templateNudge(name, agenda);
  }
}

export interface NudgeResult {
  name: string;
  status: "sent" | "dry-run" | "unconfigured" | "skipped";
  message?: string;
  reason?: string;
}

/** 全キャラクターの催促を判定し、必要なら Telegram へ送信する。 */
export async function runNudgeCheck(opts: NudgeOptions = {}): Promise<NudgeResult[]> {
  const now = new Date();
  const results: NudgeResult[] = [];

  for (const name of listCharacters()) {
    const settings = readSettings(name);
    if (!settings.nudgeEnabled) {
      results.push({ name, status: "skipped", reason: "催促オフ" });
      continue;
    }

    if (!opts.force) {
      if (!settings.notifyDays.includes(now.getDay())) {
        results.push({ name, status: "skipped", reason: "通知曜日ではない" });
        continue;
      }
      if (inQuietHours(now.getHours(), settings.quietHours)) {
        results.push({ name, status: "skipped", reason: "quiet hours" });
        continue;
      }
      const st = readState(name);
      if (st.lastNudgedAt && sameLocalDay(new Date(st.lastNudgedAt), now)) {
        results.push({ name, status: "skipped", reason: "本日催促済み" });
        continue;
      }
    }

    const db = openDb(name);
    const agenda = buildAgenda(
      dueAgendaCandidates(db, now.toISOString()),
      now.getTime(),
    );
    db.close();

    // 復習材料が無くても、学習ペースより長く空いていれば軽く誘う
    const st = readState(name);
    const daysSinceActive = st.lastActiveAt
      ? (now.getTime() - Date.parse(st.lastActiveAt)) / DAY
      : Infinity;
    const cadenceGap = Math.ceil(7 / Math.max(1, settings.sessionsPerWeek));
    if (agenda.length === 0 && daysSinceActive < cadenceGap) {
      results.push({ name, status: "skipped", reason: "催促の必要なし" });
      continue;
    }

    const message = await craftNudge(
      name,
      readPersona(name),
      readCourse(name),
      settings,
      agenda,
    );

    if (opts.dryRun) {
      results.push({ name, status: "dry-run", message });
      continue;
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || !settings.telegramChatId) {
      results.push({
        name,
        status: "unconfigured",
        message,
        reason: "TELEGRAM_BOT_TOKEN か chatId が未設定",
      });
      continue;
    }

    await sendTelegram(token, settings.telegramChatId, message);
    st.lastNudgedAt = now.toISOString();
    writeState(name, st);
    results.push({ name, status: "sent", message });
  }

  return results;
}
