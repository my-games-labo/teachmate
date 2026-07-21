import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * teachmate のデータ配置。
 * 既定は ~/.teachmate。TEACHMATE_HOME で上書き可能（テストや別マシン用）。
 *
 *   <base>/
 *     characters/
 *       <name>/
 *         course.json        コース定義（仕様書 第5章）
 *         settings.json      学習頻度・通知・催促の強さ（第15章）
 *         state.json         last_active / last_nudged_at 等
 *         knowledge.db       概念ごとの状態（第12章）＋ next_review_at
 */

export function baseDir(): string {
  const override = process.env.TEACHMATE_HOME;
  if (override && override.trim() !== "") return path.resolve(override);
  return path.join(os.homedir(), ".teachmate");
}

export function charactersDir(): string {
  return path.join(baseDir(), "characters");
}

export function characterDir(name: string): string {
  return path.join(charactersDir(), name);
}

export function characterFile(name: string, file: string): string {
  return path.join(characterDir(name), file);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function characterExists(name: string): boolean {
  return fs.existsSync(characterDir(name));
}

/** package.json を持つディレクトリ（リポジトリ/インストール先ルート）を探す。 */
export function repoRoot(): string {
  let dir = import.meta.dirname; // 実行時は .../src か .../dist
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function listCharacters(): string[] {
  const dir = charactersDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}
