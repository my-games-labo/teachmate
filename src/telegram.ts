/**
 * Telegram Bot API の最小クライアント（送信のみ＋getUpdates）。
 * サーバー不要: PC から HTTP POST するだけで PC・スマホ両方に届く。
 * token は環境変数 TELEGRAM_BOT_TOKEN から渡す。
 */

const API = "https://api.telegram.org";

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
): Promise<void> {
  const res = await fetch(`${API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const data = (await res.json()) as TgResponse<unknown>;
  if (!data.ok) {
    throw new Error(`Telegram 送信失敗: ${data.description ?? res.status}`);
  }
}

export interface TgChat {
  chatId: string;
  name: string;
  lastText: string;
}

/** getUpdates から、ボットに話しかけてきた chat の一覧を取り出す（chat_id 確認用）。 */
export async function getTelegramChats(token: string): Promise<TgChat[]> {
  const res = await fetch(`${API}/bot${token}/getUpdates`);
  const data = (await res.json()) as TgResponse<
    { message?: { chat: { id: number; first_name?: string; title?: string; username?: string }; text?: string } }[]
  >;
  if (!data.ok) {
    throw new Error(`getUpdates 失敗: ${data.description ?? res.status}`);
  }
  const seen = new Map<string, TgChat>();
  for (const u of data.result ?? []) {
    const chat = u.message?.chat;
    if (!chat) continue;
    const id = String(chat.id);
    seen.set(id, {
      chatId: id,
      name: chat.first_name ?? chat.title ?? chat.username ?? "(不明)",
      lastText: u.message?.text ?? "",
    });
  }
  return [...seen.values()];
}
