/** コース定義（仕様書 第5章）。初回会話で生成し、後から会話で更新できる。 */
export interface Course {
  theme: string; // 学習テーマ 例: "AWS認定 SAA"
  purpose: string; // 学習目的
  goal: string; // 到達目標
  scope: string; // 学習範囲
  domains: string[]; // 分野と学習順序
  examDate: string | null; // 期限または試験予定日 (ISO)
  userLevel: string; // ユーザーの現在の理解度
  firstTopic: string; // 最初に扱う話題
}

/** 学習頻度・通知・催促（第15章）。 */
export interface Settings {
  sessionsPerWeek: number; // 週何回学習するか
  notifyDays: number[]; // 通知する曜日 0=日..6=土
  notifyHour: number; // 通知時間帯（0-23, ローカル時刻）
  nudgeEnabled: boolean; // 催促の有無
  nudgeStrength: "soft" | "normal" | "firm"; // 催促の強さ
  quietHours: [number, number]; // 催促を出さない時間帯 [開始, 終了]
  telegramChatId: string | null; // 送信先。未設定なら送信しない
}

/** 揮発的でない実行状態。 */
export interface State {
  createdAt: string;
  lastActiveAt: string | null; // 最終学習日時
  lastNudgedAt: string | null; // 最終催促日時（二重催促防止）
  streak?: number; // 連続学習日数
  streakLastDay?: string | null; // 直近に学習した日（YYYY-MM-DD, ローカル）
  mockPassed?: number; // 模擬試験の合格回数
}

/** キャラクターの人格（口調・性格）。会話のブレを防ぐため永続化して毎回注入する。 */
export interface Persona {
  displayName: string; // 表示名（通常はキャラ名）
  firstPerson: string; // 一人称（例: わたし / ぼく / 俺）
  addressUser: string; // ユーザーの呼び方（例: 先輩 / あなた）
  speechStyle: string; // 口調
  personality: string; // 性格
  emoji: boolean; // 絵文字を使うか
}

export function defaultPersona(name: string): Persona {
  return {
    displayName: name,
    firstPerson: "わたし",
    addressUser: "先輩",
    speechStyle:
      "明るく素直な後輩口調。基本は敬語で、打ち解けるとときどきタメ口が出る。教科書的・AIアシスタント的な堅い説明口調にはならない。",
    personality:
      "好奇心旺盛でがんばり屋。分からないことは知ったかぶりせず正直に言う。少し甘えん坊で、褒められたり理解できたりすると素直に喜ぶ。",
    emoji: false,
  };
}

/** 人格をプロンプトに注入する共通の文面。 */
export function personaPrompt(p: Persona): string {
  return `## あなたの人格（最優先。毎回一貫させる）
- 名前: ${p.displayName}
- 一人称: ${p.firstPerson}
- ${p.addressUser ? `ユーザーの呼び方: ${p.addressUser}` : "ユーザーの呼び方は自然に"}
- 口調: ${p.speechStyle}
- 性格: ${p.personality}
- 絵文字: ${p.emoji ? "たまに使ってよい" : "使わない"}
理解度や気分が変わっても、この話し方・性格の個性は変えない。教科書的・AIアシスタント的な説明口調にならない。`;
}

export function defaultCourse(theme = "AWS認定 SAA"): Course {
  return {
    theme,
    purpose: "",
    goal: "",
    scope: "",
    domains: [],
    examDate: null,
    userLevel: "",
    firstTopic: "",
  };
}

export function defaultSettings(): Settings {
  return {
    sessionsPerWeek: 3,
    notifyDays: [1, 3, 5],
    notifyHour: 20,
    nudgeEnabled: true,
    nudgeStrength: "normal",
    quietHours: [22, 8],
    telegramChatId: null,
  };
}

export function defaultState(nowIso: string): State {
  return {
    createdAt: nowIso,
    lastActiveAt: null,
    lastNudgedAt: null,
    streak: 0,
    streakLastDay: null,
    mockPassed: 0,
  };
}
