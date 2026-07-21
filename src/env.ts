import fs from "node:fs";
import path from "node:path";
import { baseDir } from "./paths.js";

/**
 * 依存無しの軽量 .env ローダ。
 * タスクスケジューラから起動される nudge-check でも API キー等を読めるように、
 * 既存の環境変数を上書きしない形で KEY=VALUE を読み込む。
 * 探索順: カレントの .env → ~/.teachmate/.env
 */
export function loadEnv(): void {
  for (const file of [path.join(process.cwd(), ".env"), path.join(baseDir(), ".env")]) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
}
