import { Turn, Judgment, CourseProposal } from "./llm.js";

/**
 * オフライン・デモ用のモック LLM。TEACHMATE_MOCK=1 で有効。
 * API キー無しで会話ループ・記憶の再登場・催促の配線を実演するための簡易応答。
 * 実際の理解判定や自然な会話は本物の Claude が必要。
 */

export function mockEnabled(): boolean {
  return process.env.TEACHMATE_MOCK === "1";
}

function lastUser(history: Turn[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") return history[i].content;
  }
  return "";
}

const KNOWN: [RegExp, string, string][] = [
  [/s3|エススリー/i, "S3", "ストレージ"],
  [/ebs/i, "EBS", "ストレージ"],
  [/ec2/i, "EC2", "コンピューティング"],
  [/iam/i, "IAM", "IAM"],
  [/可用性/, "可用性", "基礎"],
  [/耐久性/, "耐久性", "基礎"],
];

export function mockSpeak(system: string, history: Turn[]): string {
  // セットアップの導入
  if (/インタビュー|初回|顔合わせ/.test(system)) {
    return "はじめまして、ぼくと一緒に勉強してくれてありがとう！まずは……何を、何のために学びたいのか教えてくれる？";
  }
  // 再登場アジェンダが system にあれば、それを話題に切り出す
  const m = system.match(/\[(矛盾|復習|確認)\]\s*([^\s（(]+)/);
  if (m) {
    return `おはよう！実はさ、${m[2]} のことがまだ引っかかっていて……もう一度確認させてくれないかな？`;
  }
  return "今日もよろしく！ええと、S3 について教えてほしいんだけど、あれってどういうストレージなの？";
}

export function mockJudge(history: Turn[]): Judgment {
  const text = lastUser(history);
  const hit = KNOWN.find(([re]) => re.test(text));
  const concept = hit ? hit[1] : "概念";
  const domain = hit ? hit[2] : "未分類";

  // 「S3 は EC2 に付けるディスク」= よくある誤解
  const wrong = /s3/i.test(text) && /(ディスク|ebs|付ける|アタッチ)/i.test(text);

  if (wrong) {
    return {
      concept: "S3",
      domain: "ストレージ",
      understanding: 0.3,
      confidence: 0.3,
      characterBelief: "S3 は EC2 に付けるディスク（ブロックストレージ）だと思っている",
      reply:
        "えっ、S3 って EC2 に付けるディスクなんだ……？ でも公式には『オブジェクトストレージ』って書いてある気がして、ちょっと自信がないな。どっちが正しいんだろう？",
      contradiction:
        "ユーザーは S3 を『EC2に付けるディスク』と説明したが、公式ではオブジェクトストレージ。EC2に付けるのは EBS では？",
    };
  }

  const understood = text.length >= 15;
  return {
    concept,
    domain,
    understanding: understood ? 0.7 : 0.5,
    confidence: understood ? 0.65 : 0.5,
    characterBelief: `${concept}について: ${text}`,
    reply: understood
      ? `なるほど、${concept} のことが少し分かってきた気がする！ありがとう。`
      : `うーん、${concept} のこともう少し具体的に教えてくれる？まだピンと来ていなくて。`,
  };
}

export function mockInterview(system: string, history: Turn[]): CourseProposal {
  const themeMatch = system.match(/「([^」]+)」を(?:これから)?勉強/);
  const theme = themeMatch ? themeMatch[1] : "AWS認定 SAA";
  return {
    reply: `いいね！じゃあ「${theme}」を、まずは S3 などのストレージから、週3回・ふつうの催促で始めよう。この方針でいい？`,
    ready: true,
    theme,
    purpose: "資格試験の合格",
    goal: "主要サービスを説明できるようになる",
    scope: "SAA 出題範囲の主要サービス",
    domains: ["ストレージ", "コンピューティング", "IAM", "ネットワーク"],
    examDate: "",
    userLevel: "初学者",
    firstTopic: "S3",
    sessionsPerWeek: 3,
    nudgeStrength: "normal",
  };
}
