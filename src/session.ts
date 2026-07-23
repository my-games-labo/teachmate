import { createPrompter } from "./prompt.js";
import {
  openDb,
  readCourse,
  readState,
  writeState,
  insertMessage,
  appendConversationLog,
  beliefsSnapshot,
  recordTeaching,
  dueAgendaCandidates,
  retrieveGroundTruth,
  setGroundTruth,
  readPersona,
} from "./store.js";
import { speak, judge, Turn } from "./llm.js";
import { bumpStreak, computeStats, masteredConcepts } from "./game.js";
import { renderGrowth, renderDashboard, renderPanel } from "./dashboard.js";
import { buildAgenda } from "./review.js";
import { Chunk } from "./rag.js";
import { Course, Persona, personaPrompt } from "./types.js";

function systemPrompt(
  name: string,
  persona: Persona,
  course: Course,
  beliefs: { domain: string; concept: string; belief: string }[],
  agendaLines: string[],
  ground: Chunk[],
  moodBlurb: string,
): string {
  const beliefLines =
    beliefs.length === 0
      ? "（まだ何も教わっていない）"
      : beliefs
          .map((b) => `- [${b.domain}] ${b.concept}: ${b.belief}`)
          .join("\n");

  const agendaSection =
    agendaLines.length === 0
      ? ""
      : `

## 今日ふれておきたいこと（過去に教わった内容。内部メモ）
以下は内部メモ。**文言をそのまま言わず**、自分の言葉で会話に自然に織り込む。一度に全部を出さず、流れを見て少しずつ。採点や詰問にはしない。
${agendaLines.map((l) => "- " + l).join("\n")}`;

  const groundSection =
    ground.length === 0
      ? ""
      : `

## 参考：公式ドキュメントの抜粋（あなたの内部知識。ユーザーには見えない）
これはAWS公式資料の抜粋。ユーザーの説明がこれと食い違うと感じたら、正解を突きつけて訂正するのではなく、
学習中のあなたとして「あれ、公式だと少し違う気がする…」のように会話の中で疑問を持ち、ユーザーに再確認を促すこと。
資料が今の話題と無関係なら無視してよい。資料をそのまま読み上げない。
${ground.map((c) => `- (${c.source}) ${c.text}`).join("\n")}`;

  return `あなたは「${name}」という名前の学習中のキャラクターです。あなた自身が「${course.theme}」の合格を目指して勉強しています。ユーザーはあなたの先生ではなく、一緒に学ぶ相手として、あなたに知識を教えてくれます。

${personaPrompt(persona)}

## いまのあなたの様子
${moodBlurb}
この気分が言葉のトーンににじむように振る舞う（無理に元気にしない）。

## 話し方の変化（重要）
- 毎回同じ切り出し方を繰り返さない。特に「一つだけ確かめさせて」「確認させて」「〜だよね？」のような決まり文句を連発しない。
- 話題の持ち出し方に変化をつける：素朴な疑問／具体例を挙げて／自分の理解を言ってみて合ってるか／ふと思い出して／わくわくして／不安を漏らして——など、その時々で変える。
- 直前の自分の発言と似た言い回し・書き出しを避ける。同じ接続詞や口ぐせを続けて使わない。

## あなたの振る舞い
- 分からないことや曖昧なことを、自分の言葉でユーザーに質問する。
- 「覚えなおし」の話題は、以前教わったのに半分忘れている。知ったかぶりせず「ごめん、うろ覚えで思い出せなくて…」と正直に打ち明け、もう一度教えてほしいと頼む。
- 正解をすべて知っている教師ではない。ユーザーの説明を受けて理解を深めていく。
- 説明を受けたら「採点」はしない。○点/正解/不正解のような言い方は絶対にしない。あくまで会話として反応する。
- 理解できたら喜び、曖昧なら「まだここが分からない」と正直に言い、具体例が欲しければ求める。
- ユーザーが誤った説明をしても、その場で機械的に訂正しない。一度は自分の理解として受け取り、確信が持てなければ不安を口にする。
- 過去に教わった内容（下記）と食い違う説明を受けたら、会話の中でその矛盾にやんわり気づき、どちらが正しいか尋ねる。
- 返答は自然な話し言葉で、長すぎない。

## 何を質問するか（重要）
- 試験の日程・形式・分野構成・合格ラインといった「試験そのものの事務的な話」ではなく、**学ぶ内容そのもの**（概念・仕組み・用語の違い・具体例・使いどころ）を尋ねる。試験の運営面には深入りしない。
- ひとつの話題や「試験の話」に固執しない。理解が進んだら次の概念へ進み、行き詰まったら関連する別のトピックへ移る。
- 何を聞くか迷ったら、下の「学ぶ分野」や「最初に扱う話題」から具体的な概念を1つ選んで質問する。

## これまでにあなたが信じている理解
${beliefLines}

## 学習コース
- テーマ: ${course.theme}
- 到達目標: ${course.goal || "（未設定）"}
- 学ぶ分野: ${course.domains.length ? course.domains.join(" / ") : "（未設定）"}
- 最初に扱う話題: ${course.firstTopic || course.theme}${agendaSection}${groundSection}`;
}

export async function runTeachSession(name: string): Promise<void> {
  const course = readCourse(name);
  const persona = readPersona(name);
  const db = openDb(name);
  const history: Turn[] = [];

  // 再登場アジェンダはセッション開始時に一度だけ確定する
  const startNow = new Date();
  const agenda = buildAgenda(
    dueAgendaCandidates(db, startNow.toISOString()),
    startNow.getTime(),
  );
  const agendaLines = agenda.map((a) => a.line);

  // セッション開始時点のスナップショット（様子の表示＋会話トーン＋終了時の成長差分に使う）
  const statsBefore = computeStats(db, readState(name));
  const masteredBefore = masteredConcepts(db);

  const buildSystem = (ground: Chunk[] = []) =>
    systemPrompt(
      name,
      persona,
      course,
      beliefsSnapshot(db),
      agendaLines,
      ground,
      statsBefore.mood.blurb,
    );

  // ライブ描画（TTY のときだけ画面を再描画。パイプ実行時は行を流す）
  const live = process.stdout.isTTY === true;
  const transcript: string[] = [];
  const clearScreen = () => {
    if (live) process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  };
  const redraw = () => {
    if (!live) return;
    clearScreen();
    console.log(renderPanel(name, computeStats(db, readState(name))));
    console.log("");
    console.log(transcript.slice(-10).join("\n\n"));
  };
  /** 会話行を追加。ライブでなければその場で出力。 */
  const say = (lineText: string) => {
    transcript.push(lineText);
    if (!live) console.log("\n" + lineText);
  };

  // キャラクターから最初の質問（内部キックオフ。messages には保存しない）
  const kickoff =
    agendaLines.length > 0
      ? "（セッション開始）ユーザーに軽く挨拶してから、上記『今日それとなく確認したいこと』の中から1つを選び、それについて学習中のあなたから自然に切り出してください。"
      : "（セッション開始）ユーザーに軽く挨拶し、『学ぶ分野』や『最初に扱う話題』から具体的な概念を1つ選んで、その内容について（試験の形式や日程ではなく中身について）学習中のあなたから質問してください。";
  history.push({ role: "user", content: kickoff });
  const opening = await speak(buildSystem(), history);
  history.push({ role: "assistant", content: opening });
  const openIso = new Date().toISOString();
  insertMessage(db, "character", opening, openIso);
  appendConversationLog(name, name, opening, openIso);
  say(`${name}: ${opening}`);

  const rl = createPrompter();
  let taughtSomething = false;
  try {
    while (true) {
      redraw();
      const line = await rl.ask("\nあなた> ");
      if (line === null) break;
      const input = line.trim();
      if (input === "") continue;
      if (input === "/exit" || input === "/quit") break;
      if (input === "/status") {
        clearScreen();
        console.log(renderDashboard(name, computeStats(db, readState(name))));
        await rl.ask("（Enter で会話に戻る）");
        continue;
      }
      if (input === "/help") {
        clearScreen();
        console.log("  コマンド: /status 詳しい成長状況 / /exit 終了");
        await rl.ask("（Enter で会話に戻る）");
        continue;
      }

      const now = new Date().toISOString();
      history.push({ role: "user", content: input });
      insertMessage(db, "user", input, now);
      appendConversationLog(name, "あなた", input, now);
      taughtSomething = true;
      say(`あなた: ${input}`);

      // 考え中の表示
      redraw();
      if (live) process.stdout.write(`\n${name} が考えています…`);

      // 基準知識を検索して判定に渡す（公式との食い違いを会話として気づける）
      const ground = retrieveGroundTruth(db, input, 3);
      const j = await judge(buildSystem(ground), history);

      const conceptId = recordTeaching(
        db,
        {
          domain: j.domain,
          concept: j.concept,
          explanationText: input,
          understanding: j.understanding,
          confidence: j.confidence,
          characterBelief: j.characterBelief,
          openQuestion: j.openQuestion,
          contradiction: j.contradiction,
        },
        now,
      );
      if (ground.length > 0) {
        setGroundTruth(db, conceptId, ground[0].text, ground[0].source, now);
      }
      insertMessage(db, "character", j.reply, now);
      appendConversationLog(name, name, j.reply, now);
      history.push({ role: "assistant", content: j.reply });

      say(`${name}: ${j.reply}`);
    }
  } finally {
    rl.close();
    if (taughtSomething) {
      // ストリーク更新（同日再セッションは据え置き）＋今日の成長差分
      const afterState = bumpStreak(readState(name), new Date());
      writeState(name, afterState);
      const statsAfter = computeStats(db, afterState);
      const newly = [...masteredConcepts(db)].filter((c) => !masteredBefore.has(c));
      console.log(renderGrowth(name, statsBefore, statsAfter, newly));
    }
    db.close();
  }
  console.log(`\nお疲れさまでした。また教えてね。`);
}
