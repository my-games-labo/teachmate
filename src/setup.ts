import { createPrompter } from "./prompt.js";
import {
  readCourse,
  writeCourse,
  readSettings,
  writeSettings,
  readPersona,
} from "./store.js";
import { speak, interviewCourse, CourseProposal, Turn } from "./llm.js";
import { Course, Settings, Persona, personaPrompt } from "./types.js";

/**
 * 初回セットアップ会話（仕様書 第6章）。
 * 設定ウィザードではなく、キャラクターとの会話で必要事項を聞き取り、
 * コース定義を生成 → ユーザー確認 → course.json / settings.json に保存する。
 */

/** コースが既に埋まっているか（調整モードにするか）。 */
export function isPopulated(c: Course): boolean {
  return !!(c.purpose || c.goal || c.scope || c.domains.length || c.firstTopic);
}

function setupSystem(
  name: string,
  persona: Persona,
  theme: string,
  editing: boolean,
  currentSummary?: string,
): string {
  const head = `あなたは「${name}」という、「${theme}」を勉強しているキャラクターです。学習を一緒に進めてくれるユーザーと、学習方針を決める（見直す）会話をします。

${personaPrompt(persona)}`;

  if (editing) {
    return `${head}

## いまは「調整」モード
すでに学習コースが決まっています（下記）。**最初から全部を聞き直さないでください。**
- まずユーザーに現在の方針を短く要約して見せ、「変えたいところはある？」と尋ねる。
- ユーザーが挙げた変更点だけを反映し、触れられなかった項目は今の内容をそのまま維持する。
- 変更が一通り済んだら、更新後の方針を要約して「これでいい？」と確認する（この時 ready=true）。
- 温かく、簡潔に。長文にしない。

## 現在のコース
${currentSummary ?? "（不明）"}`;
  }

  return `${head}最初の顔合わせとして学習方針をインタビューします。

## やり方
- フォームの読み上げではなく、自然な会話で聞く。質問は一度に1つだけ。
- 次のことを順に把握する: 何を学びたいか / 何のためか / いつまでに・どこまで / 試験や期限 / 今どのくらい分かるか / 週にどれくらい学べるか / 催促はどの程度ほしいか。
- ユーザーが「おまかせ」なら、${theme} の一般的な範囲・順序を提案してよい。
- 一通り揃ったら、集めた内容を短く要約し「この方針で始めていい？」と確認する（この時 ready=true）。
- 温かく、簡潔に。長文にしない。`;
}

function applyProposal(
  course: Course,
  settings: Settings,
  p: CourseProposal,
): { course: Course; settings: Settings } {
  const c: Course = {
    ...course,
    theme: p.theme || course.theme,
    purpose: p.purpose ?? course.purpose,
    goal: p.goal ?? course.goal,
    scope: p.scope ?? course.scope,
    domains: p.domains && p.domains.length > 0 ? p.domains : course.domains,
    examDate: p.examDate ? p.examDate : course.examDate,
    userLevel: p.userLevel ?? course.userLevel,
    firstTopic: p.firstTopic ?? course.firstTopic,
  };
  const s: Settings = {
    ...settings,
    sessionsPerWeek:
      typeof p.sessionsPerWeek === "number" && p.sessionsPerWeek > 0
        ? Math.round(p.sessionsPerWeek)
        : settings.sessionsPerWeek,
    nudgeStrength: p.nudgeStrength ?? settings.nudgeStrength,
  };
  return { course: c, settings: s };
}

function summarize(c: Course, s: Settings): string {
  return [
    `  テーマ: ${c.theme}`,
    `  目的: ${c.purpose || "（未設定）"}`,
    `  到達目標: ${c.goal || "（未設定）"}`,
    `  範囲: ${c.scope || "（未設定）"}`,
    `  分野順: ${c.domains.length ? c.domains.join(" → ") : "（未設定）"}`,
    `  試験日: ${c.examDate || "（なし）"}`,
    `  現在の理解度: ${c.userLevel || "（未設定）"}`,
    `  最初の話題: ${c.firstTopic || "（未設定）"}`,
    `  学習頻度: 週${s.sessionsPerWeek}回 / 催促: ${s.nudgeStrength}`,
  ].join("\n");
}

export async function runSetupSession(name: string): Promise<void> {
  let course = readCourse(name);
  let settings = readSettings(name);
  const persona = readPersona(name);
  const editing = isPopulated(course);
  const history: Turn[] = [];
  const system = () =>
    setupSystem(name, persona, course.theme, editing, summarize(course, settings));

  console.log(
    editing
      ? `\n${name} の学習コースを見直します（変えたいところだけ言えばOK）。`
      : `\n${name} との初回セットアップを始めます。`,
  );
  console.log(`（中断は /exit）\n`);

  const kickoff = editing
    ? "（調整セッション開始）ユーザーに挨拶し、現在の学習コースを短く要約して見せてから、「変えたいところはある？」と尋ねてください。最初から全部は聞き直さないこと。"
    : "（セッション開始）はじめての顔合わせです。ユーザーに挨拶し、まず「何を学びたいか／何のために学ぶか」を、あなたから自然に尋ねてください。";
  history.push({ role: "user", content: kickoff });
  const opening = await speak(system(), history);
  history.push({ role: "assistant", content: opening });
  console.log(`${name}: ${opening}\n`);

  const rl = createPrompter();
  let confirming = false;
  let pending: { course: Course; settings: Settings } | null = null;

  try {
    while (true) {
      const line = await rl.ask("あなた> ");
      if (line === null) break;
      const input = line.trim();
      if (input === "") continue;
      if (input === "/exit" || input === "/quit") {
        console.log("セットアップを中断しました（保存していません）。");
        return;
      }

      // 確認待ち中の y/n 応答
      if (confirming && pending) {
        if (/^(y|yes|はい|ok|うん|いいよ)$/i.test(input)) {
          writeCourse(name, pending.course);
          writeSettings(name, pending.settings);
          console.log(`\nコースを保存しました。${name} に教え始められます（teachmate teach ${name}）。`);
          return;
        }
        // それ以外は修正指示として会話継続
        confirming = false;
        pending = null;
      }

      history.push({ role: "user", content: input });
      const p = await interviewCourse(system(), history);
      history.push({ role: "assistant", content: p.reply });

      const applied = applyProposal(course, settings, p);
      course = applied.course;
      settings = applied.settings;

      console.log(`\n${name}: ${p.reply}\n`);

      if (p.ready) {
        console.log("── この方針でよろしいですか？（y で保存 / それ以外は修正を伝えてください）");
        console.log(summarize(course, settings));
        console.log("");
        confirming = true;
        pending = applied;
      }
    }
  } finally {
    rl.close();
  }
}
