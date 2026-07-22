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
