/**
 * Undo / Redo のスタック(計画書 docs/plans/P2-ソリッド基礎.md §2.7、§0.a-0.13、FR-505、NFR-UX-3)。
 *
 * 文書は不変(変更のたびに新しい値を作る)なので、スナップショットをそのまま
 * 積むだけで済む(複製しない)。ジェネリクスにしており PartDocument に縛らない
 * (検査が書きやすく、将来アセンブリにも使える)。
 *
 * 1回の確定操作 = 1段、上限 UNDO_LIMIT 段(FR-505「既定 200 段以上」)。
 * 同じフィーチャーの同じ欄への連続した変更(例: 式の1文字ずつの書き換え)は
 * UNDO_COALESCE_MS 以内なら1段にまとめる(まとめないと Ctrl+Z が1文字ずつ
 * 戻ってしまう)。視点・選択・ホバー・道具の切替はここでは扱わない
 * (文書が変わらないので呼び出し側が pushUndo 自体を呼ばない前提)。
 */

/** Undo の上限段数(FR-505、§0.a-0.13)。超えたら最も古い段を捨てる。 */
export const UNDO_LIMIT = 200;

/** 同じ欄への連続した変更を1段にまとめる時間(ミリ秒、§0.a-0.13)。 */
export const UNDO_COALESCE_MS = 800;

export interface UndoStack<T> {
  readonly past: readonly T[];
  readonly present: T;
  readonly future: readonly T[];
  /** 直前の変更をまとめる鍵。null なら次の変更は必ず別の段になる。 */
  readonly coalesceKey: string | null;
  /** 直前の変更の時刻(ミリ秒)。 */
  readonly coalesceAt: number;
}

export interface PushUndoOptions {
  /** 同じ鍵の変更が UNDO_COALESCE_MS 以内に続いたら1段にまとめる。 */
  readonly coalesceKey?: string;
  /** 検査で時刻を固定するための口。既定は Date.now()。 */
  readonly now?: number;
}

/** 新しいスタックを作る。過去も未来も空。 */
export function createUndoStack<T>(present: T): UndoStack<T> {
  return { past: [], present, future: [], coalesceKey: null, coalesceAt: 0 };
}

/**
 * 新しい値を積む。`next` が現在の `present` と同じ(`===`)なら何もしない
 * (同じ文書を積まない)。新しい値を積むと `future` は必ず空になる。
 *
 * `options.coalesceKey` が直前に積んだときの鍵と同じで、かつ
 * `options.now`(既定 `Date.now()`。`Date.now()` を直接呼ぶのはここだけ)が
 * 直前の時刻から `UNDO_COALESCE_MS` 以内なら、新しい段を作らず現在の段の
 * `present` だけを差し替える。`undo` の直後は `coalesceKey` が `null` に
 * 戻るため、直後に同じ鍵で積んでも束ねない。
 */
export function pushUndo<T>(stack: UndoStack<T>, next: T, options?: PushUndoOptions): UndoStack<T> {
  if (next === stack.present) {
    return stack;
  }
  const now = options?.now ?? Date.now();
  const coalesceKey = options?.coalesceKey ?? null;
  const canCoalesce =
    coalesceKey !== null &&
    stack.coalesceKey === coalesceKey &&
    now - stack.coalesceAt <= UNDO_COALESCE_MS;

  if (canCoalesce) {
    return { ...stack, present: next, coalesceAt: now };
  }

  const extendedPast = [...stack.past, stack.present];
  const past =
    extendedPast.length > UNDO_LIMIT
      ? extendedPast.slice(extendedPast.length - UNDO_LIMIT)
      : extendedPast;
  return { past, present: next, future: [], coalesceKey, coalesceAt: now };
}

/** 1段戻す。過去が無ければ同じスタックをそのまま返す(例外にしない)。 */
export function undo<T>(stack: UndoStack<T>): UndoStack<T> {
  if (stack.past.length === 0) {
    return stack;
  }
  const previous = stack.past[stack.past.length - 1];
  const past = stack.past.slice(0, -1);
  return { past, present: previous, future: [stack.present, ...stack.future], coalesceKey: null, coalesceAt: 0 };
}

/** 1段進める。未来が無ければ同じスタックをそのまま返す(例外にしない)。 */
export function redo<T>(stack: UndoStack<T>): UndoStack<T> {
  if (stack.future.length === 0) {
    return stack;
  }
  const [next, ...rest] = stack.future;
  return { past: [...stack.past, stack.present], present: next, future: rest, coalesceKey: null, coalesceAt: 0 };
}

export function canUndo<T>(stack: UndoStack<T>): boolean {
  return stack.past.length > 0;
}

export function canRedo<T>(stack: UndoStack<T>): boolean {
  return stack.future.length > 0;
}
