import * as readline from "node:readline";
import { stdin, stdout } from "node:process";

/**
 * 行入力プロンプタ。readline の async iterator を使うことで、
 * パイプ入力でも行を取りこぼさずに順に読める（readline/promises の
 * question をループで呼ぶと連続行を落とすことがあるため）。
 */
export function createPrompter() {
  const rl = readline.createInterface({ input: stdin });
  const it = rl[Symbol.asyncIterator]();
  return {
    /** プロンプトを表示して1行読む。EOF なら null。 */
    async ask(prompt: string): Promise<string | null> {
      stdout.write(prompt);
      const { value, done } = await it.next();
      return done ? null : (value as string);
    },
    close(): void {
      rl.close();
    },
  };
}
