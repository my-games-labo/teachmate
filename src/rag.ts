/**
 * 軽量 RAG のコアロジック（埋め込み無し）。
 * ドキュメントをチャンク化し、語彙一致でスコアリングして検索する。
 * 日英混在に対応するため、英数トークンと日本語の文字 bigram を特徴量に使う。
 *
 * 将来、埋め込みベクトル検索（Voyage 等）に差し替える場合も、
 * retrieveTopChunks の入出力を保てば session/store 側は変更不要。
 */

export interface Chunk {
  source: string;
  text: string;
}

/** 段落境界でおよそ target 文字ずつに分割する。 */
export function chunkText(text: string, target = 600): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 1 > target) {
      chunks.push(cur);
      cur = "";
    }
    cur = cur ? cur + "\n" + p : p;
    if (cur.length >= target) {
      chunks.push(cur);
      cur = "";
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** 検索用の特徴量集合を作る（英数トークン＋日本語 bigram）。 */
export function extractFeatures(s: string): Set<string> {
  const lower = s.toLowerCase();
  const feats = new Set<string>();
  // 英数トークン（S3, ec2, iam, storage ...）
  for (const m of lower.matchAll(/[a-z0-9]{2,}/g)) feats.add(m[0]);
  // CJK は文字 bigram（単語分割なしで概ね一致が取れる）
  const cjkRuns = lower.match(/[぀-ヿ一-鿿ー]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      feats.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) feats.add(run.slice(i, i + 2));
  }
  return feats;
}

/** query に対して chunks を語彙一致でスコアリングし、上位 k 件を返す。 */
export function retrieveTopChunks(
  chunks: Chunk[],
  query: string,
  k = 3,
): { chunk: Chunk; score: number }[] {
  const qfeats = extractFeatures(query);
  if (qfeats.size === 0) return [];
  const scored = chunks.map((chunk) => {
    const cfeats = extractFeatures(chunk.text);
    let score = 0;
    for (const f of qfeats) if (cfeats.has(f)) score += 1;
    return { chunk, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
