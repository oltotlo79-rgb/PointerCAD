import type { OrbitState } from './cameraMath.js';

/*
 * 「直前の視点へ戻る」の視点の履歴(設計 2-3、B-08c)。視点を変える操作 1 つ(ドラッグ・ホイールやキーの連続・
 * ビューキューブの遷移・ホーム・全体を表示)の前の視点を 1 つずつ積み、戻る時は新しい物から取り出す。
 * 続けて戻ると、さらに前へ戻る。戻した視点そのものは積まない(戻る・戻るで 2 つの視点を往復しない)。
 */

/** 戻れる視点の数。超えたら古い物から捨てる。 */
export const VIEW_HISTORY_LIMIT = 20;
/** これより短い間隔で続く視点の変化は、1 つの操作(1 回のドラッグ・連続したホイール・キーの繰り返し・遷移)とみなす。 */
export const VIEW_STEP_GAP_MS = 400;

interface ViewHistory {
  /** 視点を変える直前に呼ぶ。前の変化から VIEW_STEP_GAP_MS 以上空いていれば、今の視点を 1 つ積む。 */
  beforeChange(current: OrbitState): void;
  /** 直前の視点を取り出す(今と同じ視点は飛ばす)。無ければ null。取り出した後の最初の変化は新しい操作として積む。 */
  takePrevious(current: OrbitState): OrbitState | null;
  size(): number;
}

function sameOrbit(a: OrbitState, b: OrbitState): boolean {
  const up = (orbit: OrbitState) => orbit.up ?? [0, 0, 1];
  return a.azimuth === b.azimuth && a.elevation === b.elevation && a.distance === b.distance
    && a.target.every((value, axis) => value === b.target[axis]) && up(a).every((value, axis) => value === up(b)[axis])
    && (a.zoom ?? 1) === (b.zoom ?? 1);
}

export function createViewHistory(now: () => number): ViewHistory {
  const entries: OrbitState[] = [];
  let lastChange = Number.NEGATIVE_INFINITY;
  return {
    beforeChange: (current) => {
      const at = now();
      const last = entries[entries.length - 1];
      if (at - lastChange >= VIEW_STEP_GAP_MS && (last === undefined || !sameOrbit(last, current))) {
        entries.push(current);
        if (entries.length > VIEW_HISTORY_LIMIT) entries.shift();
      }
      lastChange = at;
    },
    takePrevious: (current) => {
      let previous = entries.pop();
      while (previous !== undefined && sameOrbit(previous, current)) previous = entries.pop();
      lastChange = Number.NEGATIVE_INFINITY;
      return previous ?? null;
    },
    size: () => entries.length,
  };
}
