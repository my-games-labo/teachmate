/**
 * LLM を使わずに「記憶の再登場」パイプラインを検証する結合テスト。
 *   recordTeaching → 期日スケジューリング → dueAgendaCandidates → buildAgenda
 * 実行: npx tsx scripts/smoke-review.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const tmp = path.join(os.tmpdir(), "tm-smoke-" + process.pid);
fs.rmSync(tmp, { recursive: true, force: true });
process.env.TEACHMATE_HOME = tmp;

const {
  ensureBase,
  createCharacter,
  openDb,
  recordTeaching,
  dueAgendaCandidates,
  replaceDocChunks,
  retrieveGroundTruth,
} = await import("../src/store.js");
const { buildAgenda } = await import("../src/review.js");
const { chunkText } = await import("../src/rag.js");

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const DAY = 86400_000;

ensureBase();
createCharacter("t", iso(3 * DAY), "AWS認定 SAA");
const db = openDb("t");

// 2日前に、理解が浅く・矛盾ありの説明を記録（→ 期日はとうに過ぎ、再登場対象）
recordTeaching(
  db,
  {
    domain: "ストレージ",
    concept: "S3",
    explanationText: "S3はEC2に付けるディスク",
    understanding: 0.3,
    confidence: 0.4,
    characterBelief: "S3はEC2に付けるブロックストレージだと思っている",
    contradiction: "前はオブジェクトストレージと教わった気がする",
  },
  iso(2 * DAY),
);

// 直前に、よく理解できた説明を記録（→ 間隔が延び、まだ期日は来ない）
recordTeaching(
  db,
  {
    domain: "コンピューティング",
    concept: "EC2",
    explanationText: "EC2は仮想サーバー",
    understanding: 0.95,
    confidence: 0.9,
    characterBelief: "EC2はクラウド上の仮想サーバー",
  },
  iso(1000),
);

const now = new Date().toISOString();
const candidates = dueAgendaCandidates(db, now);
const names = candidates.map((c) => c.concept).sort();
console.log("due candidates:", names);

assert.ok(names.includes("S3"), "S3 は期日到来で再登場対象のはず");
assert.ok(!names.includes("EC2"), "EC2 は理解済みでまだ期日が来ないはず");

const s3 = candidates.find((c) => c.concept === "S3")!;
assert.ok(s3.contradiction, "S3 に未解決の矛盾が紐づくはず");

// 決定論的な乱数でアジェンダ生成
const agenda = buildAgenda(candidates, Date.now(), 3, () => 0.5);
console.log(
  "agenda:",
  agenda.map((a) => `(${a.kind}) ${a.candidate.concept}`),
);
const s3Item = agenda.find((a) => a.candidate.concept === "S3")!;
assert.equal(s3Item.kind, "矛盾", "S3 は矛盾として再登場するはず");
console.log("agenda line:", s3Item.line);

// ── RAG: 取り込み → 検索 ──────────────────────────────────────────────
const sampleDoc = path.join(import.meta.dirname, "..", "docs", "aws-sample.md");
const chunks = chunkText(fs.readFileSync(sampleDoc, "utf8"));
replaceDocChunks(db, "aws-sample.md", chunks, now);

const hits = retrieveGroundTruth(db, "S3はEC2に付けるディスクだよね？", 3);
console.log(
  "\nRAG hits:",
  hits.map((h) => h.text.slice(0, 24).replace(/\n/g, " ") + "…"),
);
assert.ok(hits.length > 0, "基準知識が検索できるはず");
assert.ok(
  hits.some((h) => h.text.includes("オブジェクトストレージ")),
  "S3クエリで公式のS3説明（オブジェクトストレージ）が上位に来るはず",
);
// 再取り込みで重複しないこと
replaceDocChunks(db, "aws-sample.md", chunks, now);
const after = retrieveGroundTruth(db, "S3", 100).length;
assert.equal(after, chunks.length, "再取り込みしても重複しないはず");

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n✅ 記憶の再登場＋RAG検索パイプライン: すべて検証OK");
