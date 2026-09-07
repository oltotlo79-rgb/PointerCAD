import type { OcctShapeHandle } from '../occt/makeBox.js';
import type { ShapeCacheDiagnostics } from '../types.js';

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
export interface ShapeCacheStats extends ShapeCacheDiagnostics {
  /** 今持っている件数。 */
  readonly size: number;
  /** 容量を超えて追い出した件数(累計)。上書きや retain / clear は数えない。 */
  readonly evictions: number;
  /** delete() を呼んだ延べ件数(追い出し・上書き・delete・retain・clear の合計)。 */
  readonly released: number;
}

/** キャッシュ自身が発行・照合する使用中保護の印。所有権は移さない。 */
export type AcquireToken = symbol;

/** 再計算だけを包む既存の ShapeCache と、寿命を管理する側の口を分ける。 */
export interface AcquiringShapeCache<T extends ShapeCacheEntry> extends ShapeCache<T> {
  /** 未作成の鍵も予約できる。同じ token 内の重複は 1 回と数える。 */
  acquire(keys: Iterable<string>): AcquireToken;
  /** 最後の確保が外れた鍵は LRU 対象へ戻る。二重 release は何もしない。 */
  release(token: AcquireToken): void;
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
   * 覚える。同じ鍵の旧形は delete() する。確保中なら最後の release まで旧形の解放を待つ。
   * 容量を超えた分は未確保のものから古い順に追い出す。
   */
  set(key: string, entry: T): void;
  /** 持っているかだけを見る。順番は変えない。 */
  has(key: string): boolean;
  /** 1件を手放す。未保持または確保中なら false。 */
  delete(key: string): boolean;
  /**
   * 今回の依頼に出てきた鍵を渡す。それ以外の未確保の形を捨て、捨てた件数を返す。
   * 持っていない鍵が混じっていても無視する。
   */
  retain(liveKeys: Iterable<string>): number;
  /** 全部手放し token を無効化する。job 終了後に呼ぶ。確保が残っていれば診断へ記録。 */
  clear(): void;
  readonly size: number;
  /** 同時に持つ形の予算。保護対象だけで超える場合は診断し、数値自体は変えない。 */
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
  meshBytesOf: (entry: T) => number = () => 0,
): AcquiringShapeCache<T> {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(`形状キャッシュの容量は 1 以上の整数である必要があります: ${capacity}`);
  }

  // Map は入れた順を覚えているので、追い出す順(古い→新しい)はこれ1つで足りる。
  // 使ったものは消して入れ直し、いちばん新しい位置へ移す。
  const entries = new Map<string, T>();
  const references = new Map<string, number>();
  const tokens = new Map<AcquireToken, ReadonlySet<string>>();
  // 同じ鍵へ上書きされても、貸した旧形を最後の確保が外れるまでは解放しない。
  const retired = new Map<string, T[]>();
  let evictions = 0;
  let released = 0;
  let clearWithActiveTokensCount = 0;

  function disposeEntry(entry: T): void {
    entry.delete();
    released += 1;
  }

  /** 未確保のうち最も古く使われた鍵。対象が無ければ undefined。 */
  function oldestKey(): string | undefined {
    for (const key of entries.keys()) {
      if (!references.has(key)) {
        return key;
      }
    }
    return undefined;
  }

  function dropOldest(): boolean {
    const key = oldestKey();
    if (key === undefined) {
      return false;
    }
    const entry = entries.get(key);
    entries.delete(key);
    if (entry !== undefined) {
      disposeEntry(entry);
      evictions += 1;
    }
    return true;
  }

  function trim(): void {
    const retiredCount = Array.from(retired.values()).reduce((count, old) => count + old.length, 0);
    while (entries.size + retiredCount > capacity && dropOldest()) {
      // 保護対象だけになったら超過を許し、stats の診断で呼び手へ知らせる。
    }
  }

  function touch(key: string, entry: T): void {
    entries.delete(key);
    entries.set(key, entry);
  }

  return {
    acquire(keys): AcquireToken {
      const unique = new Set(keys);
      const token = Symbol('shape-cache-acquire');
      tokens.set(token, unique);
      for (const key of unique) {
        references.set(key, (references.get(key) ?? 0) + 1);
      }
      return token;
    },

    release(token): void {
      const keys = tokens.get(token);
      if (keys === undefined) {
        return;
      }
      tokens.delete(token);
      for (const key of keys) {
        const remaining = (references.get(key) ?? 0) - 1;
        if (remaining > 0) {
          references.set(key, remaining);
        } else {
          references.delete(key);
          const old = retired.get(key) ?? [];
          retired.delete(key);
          for (const entry of old) {
            disposeEntry(entry);
          }
        }
      }
      trim();
    },

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
        if (references.has(key)) {
          const old = retired.get(key) ?? [];
          old.push(existing);
          retired.set(key, old);
        } else {
          disposeEntry(existing);
        }
      }
      // 以前貸した形を再び現行に戻した場合も、同じ実体を二重解放しない。
      const old = retired.get(key);
      if (old !== undefined) {
        retired.set(key, old.filter((value) => value !== entry));
      }
      touch(key, entry);
      trim();
    },

    has(key: string): boolean {
      return entries.has(key);
    },

    delete(key: string): boolean {
      const entry = entries.get(key);
      if (entry === undefined || references.has(key)) {
        return false;
      }
      entries.delete(key);
      disposeEntry(entry);
      return true;
    },

    retain(liveKeys: Iterable<string>): number {
      const live = new Set(liveKeys);
      const doomed = Array.from(entries.keys()).filter((key) => !live.has(key) && !references.has(key));
      for (const key of doomed) {
        const entry = entries.get(key);
        entries.delete(key);
        if (entry !== undefined) {
          disposeEntry(entry);
        }
      }
      return doomed.length;
    },

    clear(): void {
      if (tokens.size > 0) {
        clearWithActiveTokensCount += 1;
      }
      const all = [...entries.values(), ...Array.from(retired.values()).flat()];
      entries.clear();
      retired.clear();
      references.clear();
      tokens.clear();
      for (const entry of all) {
        disposeEntry(entry);
      }
    },

    get size(): number {
      return entries.size;
    },

    capacity,

    stats(): ShapeCacheStats {
      const all = [...entries.values(), ...Array.from(retired.values()).flat()];
      const protectedOverBudget = Math.max(0, all.length - capacity);
      const diagnostics: string[] = [];
      if (protectedOverBudget > 0) {
        diagnostics.push('保護対象だけで予算超過');
      }
      if (clearWithActiveTokensCount > 0) {
        diagnostics.push('確保が残った状態で clear が呼ばれました');
      }
      return {
        size: entries.size, evictions, released,
        shapeCount: all.length,
        protectedKeyCount: references.size,
        meshBytes: all.reduce((total, entry) => total + meshBytesOf(entry), 0),
        protectedOverBudget,
        clearWithActiveTokensCount,
        diagnostics,
      };
    },
  };
}
