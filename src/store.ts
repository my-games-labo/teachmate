import fs from "node:fs";
import Database from "better-sqlite3";
import {
  baseDir,
  characterDir,
  characterFile,
  characterExists,
  ensureDir,
} from "./paths.js";
import {
  Course,
  Settings,
  State,
  Persona,
  defaultCourse,
  defaultSettings,
  defaultState,
  defaultPersona,
} from "./types.js";
import { nextSchedule } from "./schedule.js";
import { AgendaCandidate } from "./review.js";
import { Chunk, retrieveTopChunks } from "./rag.js";

// ── JSON ファイル（course / settings / state）───────────────────────────

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export function readCourse(name: string): Course {
  return readJson<Course>(characterFile(name, "course.json"));
}
export function writeCourse(name: string, course: Course): void {
  writeJson(characterFile(name, "course.json"), course);
}
export function readSettings(name: string): Settings {
  return readJson<Settings>(characterFile(name, "settings.json"));
}
export function writeSettings(name: string, settings: Settings): void {
  writeJson(characterFile(name, "settings.json"), settings);
}
export function readState(name: string): State {
  return readJson<State>(characterFile(name, "state.json"));
}
export function writeState(name: string, state: State): void {
  writeJson(characterFile(name, "state.json"), state);
}
export function writePersona(name: string, persona: Persona): void {
  writeJson(characterFile(name, "persona.json"), persona);
}
/** 人格を読む。無ければ既定を作って保存（既存キャラにも自動付与）。 */
export function readPersona(name: string): Persona {
  const file = characterFile(name, "persona.json");
  if (!fs.existsSync(file)) {
    const p = defaultPersona(name);
    writePersona(name, p);
    return p;
  }
  return readJson<Persona>(file);
}

// ── knowledge.db（SQLite）──────────────────────────────────────────────
//
// 仕様書 第12章「内部で保持する知識」を分けて管理する:
//   - ground_truth        基準となる知識（RAG で埋める）
//   - user_explanations   ユーザーが教えた内容（元発言に近い形で保持）
//   - character_beliefs   キャラクターが信じている内容（独自解釈）
//   - knowledge_state     確信度・理解度・復習期日など（催促/再登場の駆動源）
//   - open_items          未解決の疑問・矛盾
//   - messages            会話履歴

const SCHEMA = `
CREATE TABLE IF NOT EXISTS concepts (
  id         INTEGER PRIMARY KEY,
  domain     TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(domain, name)
);

CREATE TABLE IF NOT EXISTS ground_truth (
  concept_id INTEGER PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  source     TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_explanations (
  id         INTEGER PRIMARY KEY,
  concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS character_beliefs (
  concept_id INTEGER PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE,
  belief     TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_state (
  concept_id      INTEGER PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE,
  confidence      REAL NOT NULL DEFAULT 0,   -- キャラクターの確信度 0..1
  understanding   REAL NOT NULL DEFAULT 0,   -- 理解度 0..1
  last_reviewed_at TEXT,
  next_review_at  TEXT,                       -- 催促/再登場の駆動源
  review_priority REAL NOT NULL DEFAULT 0,   -- 復習優先度（重要度×苦手さ）
  taught_count    INTEGER NOT NULL DEFAULT 0,
  applied_count   INTEGER NOT NULL DEFAULT 0,
  wrong_count     INTEGER NOT NULL DEFAULT 0,
  ease            REAL NOT NULL DEFAULT 2.5,  -- 間隔反復の ease
  interval_days   REAL NOT NULL DEFAULT 0,    -- 直近の間隔（日）
  reps            INTEGER NOT NULL DEFAULT 0  -- 連続成功回数
);

CREATE INDEX IF NOT EXISTS idx_knowledge_due
  ON knowledge_state(next_review_at);

CREATE TABLE IF NOT EXISTS open_items (
  id         INTEGER PRIMARY KEY,
  concept_id INTEGER NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK(kind IN ('question','contradiction')),
  text       TEXT NOT NULL,
  resolved   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  role       TEXT NOT NULL CHECK(role IN ('user','character','system')),
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- RAG 用: 取り込んだ公式ドキュメントのチャンク（基準知識の元資料）
CREATE TABLE IF NOT EXISTS doc_chunks (
  id         INTEGER PRIMARY KEY,
  source     TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/** 既存DBに後から追加した列を補う（開発中の軽量マイグレーション）。 */
function migrate(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(knowledge_state)`).all() as {
    name: string;
  }[];
  const have = new Set(cols.map((c) => c.name));
  if (!have.has("ease"))
    db.exec(`ALTER TABLE knowledge_state ADD COLUMN ease REAL NOT NULL DEFAULT 2.5`);
  if (!have.has("interval_days"))
    db.exec(
      `ALTER TABLE knowledge_state ADD COLUMN interval_days REAL NOT NULL DEFAULT 0`,
    );
  if (!have.has("reps"))
    db.exec(`ALTER TABLE knowledge_state ADD COLUMN reps INTEGER NOT NULL DEFAULT 0`);
}

export function openDb(name: string): Database.Database {
  const db = new Database(characterFile(name, "knowledge.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// ── セットアップ ────────────────────────────────────────────────────────

export function ensureBase(): void {
  ensureDir(baseDir());
}

/** キャラクターを新規作成する。既存なら例外。 */
export function createCharacter(
  name: string,
  nowIso: string,
  theme?: string,
): void {
  if (characterExists(name)) {
    throw new Error(`キャラクター "${name}" は既に存在します`);
  }
  ensureDir(characterDir(name));
  writeCourse(name, defaultCourse(theme));
  writeSettings(name, defaultSettings());
  writeState(name, defaultState(nowIso));
  writePersona(name, defaultPersona(name));
  // DB を初期化して閉じる（スキーマ作成のため）
  openDb(name).close();
}

// ── 知識の記録（会話ループから使う）────────────────────────────────────

export function insertMessage(
  db: Database.Database,
  role: "user" | "character" | "system",
  content: string,
  nowIso: string,
): void {
  db.prepare(
    `INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)`,
  ).run(role, content, nowIso);
}

/** 会話を人が読めるプレーンテキストログに常時追記する。 */
export function appendConversationLog(
  name: string,
  label: string,
  text: string,
  nowIso: string,
): void {
  const t = nowIso.slice(0, 19).replace("T", " ");
  fs.appendFileSync(
    characterFile(name, "conversation.log"),
    `[${t}] ${label}: ${text}\n`,
    "utf8",
  );
}

/** 会話ログの末尾 n 行を返す。 */
export function readConversationTail(name: string, n: number): string[] {
  const file = characterFile(name, "conversation.log");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-n);
}

/** 未解決の open_item（疑問・矛盾）一覧。inspect 用。 */
export function listOpenItems(
  db: Database.Database,
): { kind: string; text: string; concept: string; createdAt: string }[] {
  return db
    .prepare(
      `SELECT o.kind AS kind, o.text AS text, c.name AS concept, o.created_at AS createdAt
         FROM open_items o JOIN concepts c ON c.id = o.concept_id
        WHERE o.resolved = 0
        ORDER BY o.kind, o.created_at DESC`,
    )
    .all() as { kind: string; text: string; concept: string; createdAt: string }[];
}

/** 未解決の矛盾をまとめて解消扱いにする。件数を返す。 */
export function resolveAllContradictions(db: Database.Database): number {
  return db
    .prepare(`UPDATE open_items SET resolved = 1 WHERE kind = 'contradiction' AND resolved = 0`)
    .run().changes;
}

/** キャラクターが現在信じている内容の一覧（矛盾検出の文脈として渡す）。 */
export function beliefsSnapshot(
  db: Database.Database,
): { domain: string; concept: string; belief: string }[] {
  return db
    .prepare(
      `SELECT c.domain AS domain, c.name AS concept, b.belief AS belief
         FROM character_beliefs b
         JOIN concepts c ON c.id = b.concept_id
        ORDER BY b.updated_at DESC
        LIMIT 50`,
    )
    .all() as { domain: string; concept: string; belief: string }[];
}

function upsertConcept(
  db: Database.Database,
  domain: string,
  name: string,
  nowIso: string,
): number {
  db.prepare(
    `INSERT INTO concepts (domain, name, created_at) VALUES (?, ?, ?)
       ON CONFLICT(domain, name) DO NOTHING`,
  ).run(domain, name, nowIso);
  const row = db
    .prepare(`SELECT id FROM concepts WHERE domain = ? AND name = ?`)
    .get(domain, name) as { id: number };
  return row.id;
}

export interface TeachingRecord {
  domain: string;
  concept: string;
  explanationText: string; // ユーザーの元発言
  understanding: number;
  confidence: number;
  characterBelief: string;
  openQuestion?: string;
  contradiction?: string;
}

/** 未解決の open_item を同一 concept×kind で1件に集約（重複増殖を防ぐ）。 */
function upsertOpenItem(
  db: Database.Database,
  conceptId: number,
  kind: "question" | "contradiction",
  text: string,
  nowIso: string,
): void {
  const existing = db
    .prepare(
      `SELECT id FROM open_items WHERE concept_id = ? AND kind = ? AND resolved = 0`,
    )
    .get(conceptId, kind) as { id: number } | undefined;
  if (existing) {
    db.prepare(`UPDATE open_items SET text = ?, created_at = ? WHERE id = ?`).run(
      text,
      nowIso,
      existing.id,
    );
  } else {
    db.prepare(
      `INSERT INTO open_items (concept_id, kind, text, created_at) VALUES (?, ?, ?, ?)`,
    ).run(conceptId, kind, text, nowIso);
  }
}

/**
 * 1回の「教える」を全テーブルへ反映する（トランザクション）。
 * next_review_at は間隔反復（schedule.ts）で決める。
 */
export function recordTeaching(
  db: Database.Database,
  rec: TeachingRecord,
  nowIso: string,
): number {
  const tx = db.transaction((): number => {
    const conceptId = upsertConcept(db, rec.domain, rec.concept, nowIso);

    db.prepare(
      `INSERT INTO user_explanations (concept_id, text, created_at) VALUES (?, ?, ?)`,
    ).run(conceptId, rec.explanationText, nowIso);

    db.prepare(
      `INSERT INTO character_beliefs (concept_id, belief, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(concept_id) DO UPDATE SET belief = excluded.belief, updated_at = excluded.updated_at`,
    ).run(conceptId, rec.characterBelief, nowIso);

    // 直近の間隔反復パラメータを読み、次回スケジュールを計算する
    const prev = db
      .prepare(
        `SELECT ease, reps, interval_days AS intervalDays FROM knowledge_state WHERE concept_id = ?`,
      )
      .get(conceptId) as
      | { ease: number; reps: number; intervalDays: number }
      | undefined;

    const sched = nextSchedule({
      understanding: rec.understanding,
      confidence: rec.confidence,
      prevEase: prev?.ease ?? 2.5,
      prevReps: prev?.reps ?? 0,
      prevInterval: prev?.intervalDays ?? 0,
    });
    const nextReview = new Date(
      Date.parse(nowIso) + sched.intervalDays * 86400_000,
    ).toISOString();
    const priority = 1 - rec.understanding;
    const wrongInc = rec.understanding < 0.4 ? 1 : 0;

    db.prepare(
      `INSERT INTO knowledge_state
         (concept_id, confidence, understanding, last_reviewed_at, next_review_at,
          review_priority, taught_count, wrong_count, ease, interval_days, reps)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT(concept_id) DO UPDATE SET
         confidence = excluded.confidence,
         understanding = excluded.understanding,
         last_reviewed_at = excluded.last_reviewed_at,
         next_review_at = excluded.next_review_at,
         review_priority = excluded.review_priority,
         taught_count = knowledge_state.taught_count + 1,
         wrong_count = knowledge_state.wrong_count + excluded.wrong_count,
         ease = excluded.ease,
         interval_days = excluded.interval_days,
         reps = excluded.reps`,
    ).run(
      conceptId,
      rec.confidence,
      rec.understanding,
      nowIso,
      nextReview,
      priority,
      wrongInc,
      sched.ease,
      sched.intervalDays,
      sched.reps,
    );

    if (rec.openQuestion) upsertOpenItem(db, conceptId, "question", rec.openQuestion, nowIso);
    if (rec.contradiction)
      upsertOpenItem(db, conceptId, "contradiction", rec.contradiction, nowIso);

    // 自信を持って教え直せたら、その概念の未解決の疑問・矛盾を解消扱いにする
    if (rec.understanding >= 0.8 && rec.confidence >= 0.6 && !rec.contradiction) {
      db.prepare(
        `UPDATE open_items SET resolved = 1 WHERE concept_id = ? AND resolved = 0`,
      ).run(conceptId);
    }
    return conceptId;
  });
  return tx();
}

/**
 * 再登場アジェンダの候補を返す。
 * 復習期日が来た概念、または未解決の矛盾を持つ概念を対象にする。
 */
export function dueAgendaCandidates(
  db: Database.Database,
  nowIso: string,
): AgendaCandidate[] {
  const rows = db
    .prepare(
      `SELECT c.id AS conceptId, c.domain AS domain, c.name AS concept,
              k.confidence AS confidence, k.understanding AS understanding,
              k.wrong_count AS wrongCount, k.last_reviewed_at AS lastReviewedAt,
              k.next_review_at AS nextReviewAt, k.interval_days AS intervalDays
         FROM knowledge_state k
         JOIN concepts c ON c.id = k.concept_id
        WHERE (k.next_review_at IS NOT NULL AND k.next_review_at <= @now)
           OR EXISTS (
                SELECT 1 FROM open_items o
                 WHERE o.concept_id = c.id AND o.kind = 'contradiction' AND o.resolved = 0
              )`,
    )
    .all({ now: nowIso }) as Omit<AgendaCandidate, "contradiction" | "question">[];

  const open = db
    .prepare(
      `SELECT concept_id AS conceptId, kind, text FROM open_items WHERE resolved = 0`,
    )
    .all() as { conceptId: number; kind: string; text: string }[];

  const byConcept = new Map<number, { contradiction?: string; question?: string }>();
  for (const o of open) {
    const entry = byConcept.get(o.conceptId) ?? {};
    if (o.kind === "contradiction") entry.contradiction = o.text;
    if (o.kind === "question") entry.question = o.text;
    byConcept.set(o.conceptId, entry);
  }

  return rows.map((r) => ({ ...r, ...(byConcept.get(r.conceptId) ?? {}) }));
}

// ── RAG（基準知識の取り込みと検索）─────────────────────────────────────

/** ある source のチャンクを入れ替える（再取り込みで重複しないように）。 */
export function replaceDocChunks(
  db: Database.Database,
  source: string,
  chunks: string[],
  nowIso: string,
): void {
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM doc_chunks WHERE source = ?`).run(source);
    const ins = db.prepare(
      `INSERT INTO doc_chunks (source, text, created_at) VALUES (?, ?, ?)`,
    );
    for (const text of chunks) ins.run(source, text, nowIso);
  });
  tx();
}

export function countDocChunks(db: Database.Database): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM doc_chunks`).get() as { n: number }
  ).n;
}

/** query に関連する基準知識チャンクを上位 k 件返す。 */
export function retrieveGroundTruth(
  db: Database.Database,
  query: string,
  k = 3,
): Chunk[] {
  const rows = db
    .prepare(`SELECT source, text FROM doc_chunks`)
    .all() as Chunk[];
  if (rows.length === 0) return [];
  return retrieveTopChunks(rows, query, k).map((r) => r.chunk);
}

/** 概念の基準知識（判定に使った公式抜粋）を保存する（第12章）。 */
export function setGroundTruth(
  db: Database.Database,
  conceptId: number,
  text: string,
  source: string,
  nowIso: string,
): void {
  db.prepare(
    `INSERT INTO ground_truth (concept_id, text, source, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(concept_id) DO UPDATE SET
         text = excluded.text, source = excluded.source, updated_at = excluded.updated_at`,
  ).run(conceptId, text, source, nowIso);
}
