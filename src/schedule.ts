/**
 * 間隔反復（SM-2 の簡易版）。
 * 理解度から成績 q(0..5) を作り、次回復習までの間隔を決める。
 * 確信度が低いほど間隔を詰め、早めに再登場させる。
 */

export interface SchedInput {
  understanding: number; // 0..1
  confidence: number; // 0..1
  prevEase: number; // 直近の ease（初回は 2.5）
  prevReps: number; // 連続成功回数（初回は 0）
  prevInterval: number; // 直近の間隔（日, 初回は 0）
}

export interface SchedOutput {
  ease: number;
  reps: number;
  intervalDays: number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function nextSchedule(i: SchedInput): SchedOutput {
  const q = Math.round(clamp01(i.understanding) * 5); // 0..5
  let ease = i.prevEase > 0 ? i.prevEase : 2.5;
  let reps = i.prevReps > 0 ? i.prevReps : 0;
  let interval: number;

  if (q < 3) {
    // 理解が浅い → 連続成功をリセットし、半日後に再登場
    reps = 0;
    interval = 0.5;
  } else {
    reps += 1;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 3;
    else interval = Math.max(1, i.prevInterval) * ease;

    // ease 調整（SM-2）
    ease = ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
    if (ease < 1.3) ease = 1.3;
  }

  // 確信度が低いほど間隔を短縮（0.6〜1.0 倍）
  interval = interval * (0.6 + 0.4 * clamp01(i.confidence));

  return { ease, reps, intervalDays: interval };
}
