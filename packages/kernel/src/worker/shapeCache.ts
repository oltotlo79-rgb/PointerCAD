import type { OcctShapeHandle } from '../occt/makeBox.js';

/**
 * キャッシュに預けられるものの最低条件。
 *
 * OCCT の形は JavaScript の回収の対象外なので、預ける側は
 * 「形そのもの」と「形を作るために確保した領域(maker 等)」の両方を
 * まとめて手放せる delete() を用意する(makeBox の OcctShapeHandle と同じ約束)。
 * キャッシュは中身を見ないため、この1つだけを条件にする。
 */
export interface ShapeCacheEntry {
  delete(): void;
}

/** キャッシュの働きぐあい。効き目の実測(NFR-PF-3)と取りこぼしの検知に使う。 */
export interface ShapeCacheStats {
  /** 今持っている件数。 */
  readonly size: number;
  /** 容量を超えて追い出した件数(累計)。上書きや retain / clear は数えない。 */
  readonly evictions: number;
  /** delete() を呼んだ延べ件数(追い出し・上書き・delete・retain・clear の合計)。 */
  readonly released: number;
}

/**
 * 鍵(文字列)から、作り済みの形を引くための入れ物。
 *
 * 最後に使ってから最も時間が経ったものから追い出す(LRU)。
 * get で当たった鍵は「今使った」ことになり、追い出されにくくなる。
 * has は覗くだけなので順番を変えない。
 */
export interface ShapeCache<T extends ShapeCacheEntry = OcctShapeHandle> {
  /** 取り出す。当たったら「今使った」ことにする。 */
  get(key: string): T | undefined;
  /**
   * 覚える。同じ鍵に別のものが入っていれば、古い方を delete() してから入れ替える
   * (二重に確保したまま行方不明にしないため)。容量を超えた分は古い順に追い出す。
   */
  set(key: string, entry: T): void;
  /** 持っているかだけを見る。順番は変えない。 */
  has(key: string): boolean;
  /** 1件を手放す。持っていれば delete() して true、持っていなければ false。 */
  delete(key: string): boolean;
  /**
   * 今回の依頼に出てきた鍵を渡す。**それ以外は全て** delete() して捨て、捨てた件数を返す。
   * 持っていない鍵が混じっていても無視する。
   */
  retain(liveKeys: Iterable<string>): number;
  /** 全部手放す。Worker を畳むときに呼ぶ。 */
  clear(): void;
  readonly size: number;
  /** 同時に持てる上限。作るときに決めて以後変わらない。 */
  readonly capacity: number;
  stats(): ShapeCacheStats;
}

/**
 * 同時に持っておく形の上限(件)。
 * Undo で1段戻したときに作り直さずに済ませるための余裕を含む(計画書 §2.5)。
 *
 * 256 件にしてある理由(2026-09-03 統括判断、`docs/報告記録.md` 07:20 の③):
 * - 要件 NFR-PF-3 が想定する部品は 100 フィーチャーで、Undo の段数は 200(FR-505)。
 *   両方を一度に覚えておける大きさに揃える。
 * - **64 件では 100 段の部品で命中が 0 件になる**(実測)。段を先頭から順に計算するため、
 *   64 件を超えたところで先頭の段が追い出され、次の再計算では追い出された段を作り直し、
 *   その作り直しがまた次の段を追い出す、という玉突きが起きて 1 件も当たらない。
 * - 形 1 つが抱えるのは OCCT の B-rep と三角形の並びで、100 段の実測で問題にならなかった。
 *   これ以上増やすと、使わない形を持ち続ける代償(要件§10 の LRU 破棄)が大きくなる。
 */
export const SHAPE_CACHE_CAPACITY = 256;

/**
 * 形のキャッシュを作る。OCCT には触れないので、預けるものの型は呼び出し側が決める。
 * 既定は makeBox 等が返す OcctShapeHandle({ shape, delete() })。
 */
export function createShapeCache<T extends ShapeCacheEntry = OcctShapeHandle>(
  capacity: number = SHAPE_CACHE_CAPACITY,
): ShapeCache<T> {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(`形状キャッシュの容量は 1 以上の整数である必要があります: ${capacity}`);
  }

  // Map は入れた順を覚えているので、追い出す順(古い→新しい)はこれ1つで足りる。
  // 使ったものは消して入れ直し、いちばん新しい位置へ移す。
  const entries = new Map<string, T>();
  let evictions = 0;
  let released = 0;

  function release(entry: T): void {
    entry.delete();
    released += 1;
  }

  /** 最も古く使われた鍵。空なら undefined。 */
  function oldestKey(): string | undefined {
    for (const key of entries.keys()) {
      return key;
    }
    return undefined;
  }

  function dropOldest(): void {
    const key = oldestKey();
    if (key === undefined) {
      return;
    }
    const entry = entries.get(key);
    entries.delete(key);
    if (entry !== undefined) {
      release(entry);
      evictions += 1;
    }
  }

  function touch(key: string, entry: T): void {
    entries.delete(key);
    entries.set(key, entry);
  }

  return {
    get(key: string): T | undefined {
      const entry = entries.get(key);
      if (entry === undefined) {
        return undefined;
      }
      touch(key, entry);
      return entry;
    },

    set(key: string, entry: T): void {
      const existing = entries.get(key);
      // 同じものを入れ直したときに解放してしまうと、使用中の形を壊すことになる。
      if (existing !== undefined && existing !== entry) {
        release(existing);
      }
      touch(key, entry);
      while (entries.size > capacity) {
        dropOldest();
      }
    },

    has(key: string): boolean {
      return entries.has(key);
    },

    delete(key: string): boolean {
      const entry = entries.get(key);
      if (entry === undefined) {
        return false;
      }
      entries.delete(key);
      release(entry);
      return true;
    },

    retain(liveKeys: Iterable<string>): number {
      const live = new Set(liveKeys);
      const doomed = Array.from(entries.keys()).filter((key) => !live.has(key));
      for (const key of doomed) {
        const entry = entries.get(key);
        entries.delete(key);
        if (entry !== undefined) {
          release(entry);
        }
      }
      return doomed.length;
    },

    clear(): void {
      const all = Array.from(entries.values());
      entries.clear();
      for (const entry of all) {
        release(entry);
      }
    },

    get size(): number {
      return entries.size;
    },

    capacity,

    stats(): ShapeCacheStats {
      return { size: entries.size, evictions, released };
    },
  };
}
