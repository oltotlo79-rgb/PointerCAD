import type { OcctShapeHandle } from '../occt/makeBox.js';
import type { MeshJsFinalAccounting, ShapeCacheDiagnostics } from '../types.js';

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
  /** メッシュ byte 数を測る callback が生成時に明示されたか。0 byte の実測値とは区別する。 */
  readonly meshBytesMeasured: boolean;
  /** Explicit buffer identities were supplied; numeric-only legacy callbacks cannot prove alias ownership. */
  readonly meshBackingBytesMeasured?: boolean;
  /** Explicit collectors count whole buffers by identity; numeric-only callbacks retain the legacy entry totals. Protected is a subset. */
  readonly meshByteCounts:
    | { readonly status: 'known'; readonly activeBytes: number; readonly retiredBytes: number;
        readonly protectedBytes: number; readonly totalBytes: number }
    | { readonly status: 'unknown'; readonly reason: 'callback-missing' | 'callback-error'
        | 'invalid-byte-count' | 'overflow' };
  /** 今持っている件数。 */
  readonly size: number;
  /** 容量を超えて追い出した件数(累計)。上書きや retain / clear は数えない。 */
  readonly evictions: number;
  /** delete() を呼んだ延べ件数(追い出し・上書き・delete・retain・clear の合計)。 */
  readonly released: number;
}

export type MeshBufferSnapshot =
  | { readonly status: 'known'; readonly active: readonly ArrayBuffer[];
      readonly retired: readonly ArrayBuffer[]; readonly protected: readonly ArrayBuffer[] }
  | Extract<ShapeCacheStats['meshByteCounts'], { readonly status: 'unknown' }>;

/** Whole owning buffers, counted once. Shared or unbranded buffers are not supported by this admission contract. */
export function uniqueMeshBackingBuffers(buffers: Iterable<ArrayBufferLike>): readonly ArrayBuffer[] {
  const unique = new Set<ArrayBuffer>();
  for (const buffer of buffers) {
    if (!(buffer instanceof ArrayBuffer) || !Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 0) {
      throw new RangeError('Mesh backing buffer is unavailable');
    }
    // A detached buffer reports zero bytes but is not a measured empty buffer.
    try {
      new Uint8Array(buffer, 0, 0);
    } catch {
      throw new RangeError('Mesh backing buffer is detached');
    }
    unique.add(buffer);
  }
  return [...unique];
}

class MeshBackingBytesOverflowError extends RangeError {}

export function meshBackingBytes(buffers: Iterable<ArrayBufferLike>): number {
  let bytes = 0;
  for (const buffer of uniqueMeshBackingBuffers(buffers)) {
    bytes += buffer.byteLength;
    if (!Number.isSafeInteger(bytes)) throw new MeshBackingBytesOverflowError('Mesh backing byte count overflow');
  }
  return bytes;
}

/** Keeps an unsafe total distinct from an unavailable buffer when a caller reports `unknown`. */
export function meshBackingFailureReason(error: unknown): 'overflow' | 'invalid-byte-count' {
  return error instanceof MeshBackingBytesOverflowError ? 'overflow' : 'invalid-byte-count';
}

/**
 * Post-token Worker accounting over whole backing buffers: the cache snapshot, every part's
 * adopted display meshes and this reply are unioned so that each ArrayBuffer is counted once.
 * The reply clone is the receiving side's future copy and is reported beside, never inside,
 * the Worker-retained union. Metadata objects, WASM, native, GPU and RSS are not measured here.
 */
export function finalMeshJsAccounting(
  snapshot: MeshBufferSnapshot,
  displayBuffers: Iterable<ArrayBufferLike>,
  replyBuffers: Iterable<ArrayBufferLike>,
  limitBytes: number,
  hiddenBuffers: Iterable<ArrayBufferLike> = [],
): MeshJsFinalAccounting {
  if (snapshot.status === 'unknown') return { status: 'unknown', limitBytes, reason: snapshot.reason };
  try {
    const display = uniqueMeshBackingBuffers(displayBuffers);
    const reply = uniqueMeshBackingBuffers(replyBuffers);
    const hidden = uniqueMeshBackingBuffers(hiddenBuffers);
    const cacheActiveBytes = meshBackingBytes(snapshot.active);
    const cacheRetiredBytes = meshBackingBytes(snapshot.retired);
    const cacheProtectedBytes = meshBackingBytes(snapshot.protected);
    const displayBackingBytes = meshBackingBytes(display);
    const replyBackingBytes = meshBackingBytes(reply);
    const retainedBackingBytes = meshBackingBytes([...snapshot.active, ...snapshot.retired,
      ...display, ...hidden, ...reply]);
    // Structured clone copies each distinct reply buffer once, whole, on the receiving side.
    const replyCloneReservedBytes = replyBackingBytes;
    if (!Number.isSafeInteger(retainedBackingBytes + replyCloneReservedBytes)) {
      return { status: 'unknown', limitBytes, reason: 'overflow' };
    }
    return { status: 'known', limitBytes, cacheActiveBytes, cacheRetiredBytes, cacheProtectedBytes,
      displayBackingBytes, replyBackingBytes, retainedBackingBytes, replyCloneReservedBytes };
  } catch (error) {
    return { status: 'unknown', limitBytes, reason: meshBackingFailureReason(error) };
  }
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
  /** Worker-local identities only, not an IPC diagnostic. Omitted on legacy/custom cache implementations. */
  meshBufferSnapshot?(): MeshBufferSnapshot;
  /** Current ownership/protection mutation epoch; unavailable on historical custom caches. */
  meshOwnershipEpoch?(): number | null;
  /** Actual failed release backings. Undefined means no internal release failure was recorded. */
  failedReleaseBuffers?(token: AcquireToken): readonly ArrayBuffer[] | undefined;
  cleanupFailureCount?(): number;
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
  meshBytesOf?: (entry: T) => number,
  meshBuffersOf?: (entry: T) => readonly ArrayBufferLike[],
): AcquiringShapeCache<T> {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error(`形状キャッシュの容量は 1 以上の整数である必要があります: ${capacity}`);
  }
  const meshBytesMeasured = meshBytesOf !== undefined || meshBuffersOf !== undefined;
  const meshBackingBytesMeasured = meshBuffersOf !== undefined;

  // Map は入れた順を覚えているので、追い出す順(古い→新しい)はこれ1つで足りる。
  // 使ったものは消して入れ直し、いちばん新しい位置へ移す。
  const entries = new Map<string, T>();
  const references = new Map<string, number>();
  const tokens = new Map<AcquireToken, ReadonlySet<string>>();
  // 同じ鍵へ上書きされても、貸した旧形を最後の確保が外れるまでは解放しない。
  const retired = new Map<string, T[]>();
  // Opaque native delete may have partially succeeded. Never invoke it a second time.
  const failedEntries = new Map<T, unknown>();
  const failedReleases = new Map<AcquireToken, { readonly entries: ReadonlySet<T>; readonly error: unknown }>();
  let ownershipEpoch = 0;
  const changed = (): void => { ownershipEpoch = Number.isSafeInteger(ownershipEpoch + 1) ? ownershipEpoch + 1 : Number.NaN; };
  let retiredCount = 0;
  let evictions = 0;
  let released = 0;
  let clearWithActiveTokensCount = 0;

  function disposeEntry(entry: T): void {
    if (failedEntries.has(entry)) throw failedEntries.get(entry);
    try { entry.delete(); released += 1; }
    catch (error) { failedEntries.set(entry, error); changed(); throw error; }
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
    while (entries.size + retiredCount > capacity && dropOldest()) {
      // 保護対象だけになったら超過を許し、stats の診断で呼び手へ知らせる。
    }
  }

  function touch(key: string, entry: T): void {
    entries.delete(key);
    entries.set(key, entry);
  }

  function meshBufferSnapshot(): MeshBufferSnapshot {
    if (meshBuffersOf === undefined) return { status: 'unknown', reason: 'callback-missing' };
    const all = new Set([...entries.values(), ...Array.from(retired.values()).flat(), ...failedEntries.keys()]);
    const measured = new Map<T, readonly ArrayBuffer[]>();
    for (const entry of all) {
      let buffers: readonly ArrayBufferLike[];
      try { buffers = meshBuffersOf(entry); }
      catch { return { status: 'unknown', reason: 'callback-error' }; }
      try { measured.set(entry, uniqueMeshBackingBuffers(buffers)); }
      catch { return { status: 'unknown', reason: 'invalid-byte-count' }; }
    }
    const active = new Set<ArrayBuffer>();
    const held = new Set<ArrayBuffer>();
    const protectedBuffers = new Set<ArrayBuffer>();
    for (const [key, entry] of entries) {
      const buffers = measured.get(entry);
      if (buffers === undefined) return { status: 'unknown', reason: 'invalid-byte-count' };
      for (const buffer of buffers) {
        active.add(buffer);
        if (references.has(key)) protectedBuffers.add(buffer);
      }
    }
    for (const entry of new Set([...Array.from(retired.values()).flat(), ...failedEntries.keys()])) {
      const buffers = measured.get(entry);
      if (buffers === undefined) return { status: 'unknown', reason: 'invalid-byte-count' };
      for (const buffer of buffers) {
        held.add(buffer);
        protectedBuffers.add(buffer);
      }
    }
    const exclusiveRetired = [...held].filter(buffer => !active.has(buffer));
    try {
      meshBackingBytes([...active, ...exclusiveRetired]);
      meshBackingBytes(protectedBuffers);
    } catch (error) {
      return { status: 'unknown', reason: error instanceof MeshBackingBytesOverflowError
        ? 'overflow' : 'invalid-byte-count' };
    }
    return { status: 'known', active: [...active], retired: exclusiveRetired, protected: [...protectedBuffers] };
  }

  return {
    meshBufferSnapshot,
    cleanupFailureCount: () => failedEntries.size,
    failedReleaseBuffers(token) {
      const failed = failedReleases.get(token);
      if (failed === undefined) return undefined;
      if (meshBuffersOf === undefined) throw new Error("Failed release backing collector unavailable");
      return uniqueMeshBackingBuffers([...failed.entries].flatMap(entry => [...meshBuffersOf(entry)]));
    },
    meshOwnershipEpoch: () => Number.isSafeInteger(ownershipEpoch) ? ownershipEpoch : null,
    acquire(keys): AcquireToken {
      changed();
      const unique = new Set(keys);
      const token = Symbol('shape-cache-acquire');
      tokens.set(token, unique);
      for (const key of unique) {
        references.set(key, (references.get(key) ?? 0) + 1);
      }
      return token;
    },

    release(token): void {
      const previous = failedReleases.get(token);
      if (previous !== undefined) throw previous.error;
      const keys = tokens.get(token);
      if (keys === undefined) return;
      changed();
      // Decrement protection exactly once. Every destructor is attempted at most once.
      tokens.delete(token);
      const failures: unknown[] = [];
      const failed = new Set<T>();
      for (const key of keys) {
        const remaining = (references.get(key) ?? 0) - 1;
        if (remaining > 0) references.set(key, remaining);
        else {
          references.delete(key);
          const old = retired.get(key) ?? [];
          retired.delete(key); retiredCount -= old.length;
          for (const entry of new Set(old)) {
            try { disposeEntry(entry); }
            catch (error) { failed.add(entry); failures.push(error); }
          }
        }
      }
      const previouslyFailed = new Set(failedEntries.keys());
      try { trim(); }
      catch (error) {
        failures.push(error);
        for (const [entry, cause] of failedEntries) {
          if (!previouslyFailed.has(entry) || cause === error) failed.add(entry);
        }
      }
      if (failures.length > 0) {
        const error = new AggregateError(failures, 'Shape cache release partially failed');
        failedReleases.set(token, { entries: failed, error });
        throw error;
      }
    },

    get(key: string): T | undefined {
      const entry = entries.get(key);
      if (entry === undefined || failedEntries.has(entry)) {
        return undefined;
      }
      touch(key, entry);
      return entry;
    },

    set(key: string, entry: T): void {
      changed();
      const existing = entries.get(key);
      // 同じものを入れ直したときに解放してしまうと、使用中の形を壊すことになる。
      if (existing !== undefined && existing !== entry) {
        if (references.has(key)) {
          const old = retired.get(key) ?? [];
          old.push(existing);
          retired.set(key, old);
          retiredCount += 1;
        } else {
          disposeEntry(existing);
        }
      }
      // 以前貸した形を再び現行に戻した場合も、同じ実体を二重解放しない。
      const old = retired.get(key);
      if (old !== undefined) {
        const remaining = old.filter((value) => value !== entry);
        retiredCount -= old.length - remaining.length;
        if (remaining.length === 0) retired.delete(key);
        else retired.set(key, remaining);
      }
      touch(key, entry);
      trim();
    },

    has(key: string): boolean {
      const entry = entries.get(key);
      return entry !== undefined && !failedEntries.has(entry);
    },

    delete(key: string): boolean {
      const entry = entries.get(key);
      if (entry === undefined || references.has(key)) {
        return false;
      }
      changed();
      entries.delete(key);
      disposeEntry(entry);
      return true;
    },

    retain(liveKeys: Iterable<string>): number {
      const live = new Set(liveKeys);
      changed();
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
      changed();
      if (tokens.size > 0) {
        clearWithActiveTokensCount += 1;
      }
      const all = [...new Set([...entries.values(), ...Array.from(retired.values()).flat(), ...failedEntries.keys()])];
      entries.clear();
      retired.clear();
      retiredCount = 0;
      references.clear();
      tokens.clear();
      const failures: unknown[] = [];
      for (const entry of all) {
        try { disposeEntry(entry); } catch (error) { failures.push(error); }
      }
      if (failures.length > 0) throw new AggregateError(failures, "Shape cache clear partially failed");
    },

    get size(): number {
      return entries.size;
    },

    capacity,

    stats(): ShapeCacheStats {
      const all = [...new Set([...entries.values(), ...Array.from(retired.values()).flat(), ...failedEntries.keys()])];
      const protectedOverBudget = Math.max(0, all.length - capacity);
      const diagnostics: string[] = [];
      if (failedEntries.size > 0) diagnostics.push('実native返却失敗の所有者を隔離保持しています');
      if (protectedOverBudget > 0) {
        diagnostics.push('保護対象だけで予算超過');
      }
      if (clearWithActiveTokensCount > 0) {
        diagnostics.push('確保が残った状態で clear が呼ばれました');
      }
      type ByteCounts = ShapeCacheStats['meshByteCounts'];
      let meshByteCounts: ByteCounts = { status: 'unknown', reason: 'callback-missing' };
      let legacyMeshBytes = 0;
      if (meshBytesOf !== undefined) {
        const measured = new Map<T, number>();
        let reason: 'callback-error' | 'invalid-byte-count' | 'overflow' | undefined;
        for (const entry of all) {
          if (measured.has(entry)) continue;
          try {
            const bytes = meshBytesOf(entry);
            if (!Number.isSafeInteger(bytes) || bytes < 0) {
              reason = 'invalid-byte-count';
              break;
            }
            measured.set(entry, bytes);
          } catch {
            reason = 'callback-error';
            break;
          }
        }
        if (reason === undefined) {
          const active = new Set(entries.values());
          const held = new Set([...Array.from(retired.values()).flat(), ...failedEntries.keys()]);
          const protectedEntries = new Set<T>(held);
          for (const [key, entry] of entries) {
            if (references.has(key)) protectedEntries.add(entry);
          }
          const sum = (items: Iterable<T>): number => {
            let bytes = 0;
            for (const entry of items) {
              const entryBytes = measured.get(entry);
              if (entryBytes === undefined) return Number.NaN;
              bytes += entryBytes;
              if (!Number.isSafeInteger(bytes)) return Number.NaN;
            }
            return bytes;
          };
          const activeBytes = sum(active);
          const retiredBytes = sum(Array.from(held).filter(entry => !active.has(entry)));
          const protectedBytes = sum(protectedEntries);
          const totalBytes = activeBytes + retiredBytes;
          legacyMeshBytes = sum(all);
          meshByteCounts = [activeBytes, retiredBytes, protectedBytes, totalBytes]
            .every(Number.isSafeInteger)
            ? { status: 'known', activeBytes, retiredBytes, protectedBytes, totalBytes }
            : { status: 'unknown', reason: 'overflow' };
        } else {
          meshByteCounts = { status: 'unknown', reason };
        }
      }
      // Preserve the old scalar diagnostic, but use explicit whole-buffer ownership for admission.
      if (meshBuffersOf !== undefined && (meshByteCounts.status === 'known'
        || meshByteCounts.reason === 'callback-missing')) {
        const snapshot = meshBufferSnapshot();
        if (snapshot.status === 'unknown') meshByteCounts = snapshot;
        else {
          const activeBytes = meshBackingBytes(snapshot.active);
          const retiredBytes = meshBackingBytes(snapshot.retired);
          const protectedBytes = meshBackingBytes(snapshot.protected);
          meshByteCounts = { status: 'known', activeBytes, retiredBytes, protectedBytes,
            totalBytes: meshBackingBytes([...snapshot.active, ...snapshot.retired]) };
          if (meshBytesOf === undefined) legacyMeshBytes = activeBytes + retiredBytes;
        }
      }
      return {
        size: entries.size, evictions, released,
        shapeCount: all.length,
        protectedKeyCount: references.size,
        // Legacy scalar remains for existing diagnostics; local admission uses the discriminant.
        meshBytes: meshByteCounts.status === 'known' ? legacyMeshBytes
          : meshByteCounts.reason === 'callback-missing' ? 0 : Number.NaN,
        meshBytesMeasured,
        meshBackingBytesMeasured,
        meshByteCounts,
        protectedOverBudget,
        clearWithActiveTokensCount,
        diagnostics,
      };
    },
  };
}
