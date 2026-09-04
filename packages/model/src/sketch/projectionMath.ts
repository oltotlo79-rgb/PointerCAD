/**
 * 投影・交差(FR-325、計画書 P4 §2.7・§0.a-0.11、タスク25)のうち、
 * カーネルを呼ばずに済む部分 — **鍵と覚え書き**。
 *
 * 曲線そのものは OCCT(`kernel/src/occt/makeProjection.ts` / `makeSection.ts`)が作るので、
 * ここが受け持つのはオフセット(`offsetMath.ts`)と同じ 2 つだけである。
 *
 * 1. **鍵**: 「もとの立体の段の鍵+投影する部分形状+作図面」から決まる文字列。
 *    **もとの立体の鍵をそのまま材料に混ぜる**ので、上流の立体が少しでも変われば
 *    投影の鍵も必ず変わり、作り直される(`part/cacheKey.ts` の鍵の連鎖と同じ考え方、
 *    NFR-PF-3)。作図面を混ぜるのは、同じ面でも投影先が変われば違う曲線になるため。
 * 2. **覚え書き**: 鍵から結果の曲線を引く入れ物(LRU)。スケッチの解決は純関数のままで、
 *    カーネルの往復は `part/recomputePart.ts` が受け持つ(§2.9)。
 *
 * オフセットと同じ形にそろえてあるので、2 つの覚え書きは同じ流儀で持ち回せる
 * (`recomputePart` の `PartRecomputeOptions`)。
 */

import { hash64, keyNumber } from '../part/cacheKey.js';
import { fingerprintKeyText } from '../geometry/subShapeRef.js';
import type { WorkPlane } from './planeMath.js';
import type { ProjectionSource, ResolvedCurve } from './types.js';
import type { Vec3 } from './vec3.js';

/** 鍵の材料(FR-325)。 */
export interface ProjectionKeyMaterial {
  /** もとの立体の段の鍵(`ResolvedSolidStep.key`)。上流の変化はここに現れる。 */
  readonly bodyKey: string;
  /** 立体の何を使うか(面・辺の指紋、または立体そのもの)。 */
  readonly source: ProjectionSource;
  /** 投影先・切り口の作図面。 */
  readonly plane: WorkPlane;
}

/** ベクトルを鍵の材料の文字列にする(`subShapeRef.ts` と同じ丸め方)。 */
function keyVec3Text(vector: Vec3): string {
  return `${keyNumber(vector[0])},${keyNumber(vector[1])},${keyNumber(vector[2])}`;
}

/**
 * 作図面を鍵の材料の文字列にする。第 2 軸は「法線 × 第 1 軸」で決まるので混ぜない
 * (`kernel/src/occt/makeProjection.ts` の `SketchPlaneFrame` が持つ 3 つと同じ)。
 * 作図面の id は混ぜない: 同じ位置・同じ向きの平面なら、id が違っても結果は同じで、
 * 作り直す理由が無いため。
 */
function planeKeyText(plane: WorkPlane): string {
  return (
    `origin=${keyVec3Text(plane.origin)}` +
    `;axisU=${keyVec3Text(plane.axisU)}` +
    `;normal=${keyVec3Text(plane.normal)}`
  );
}

/** 投影・交差のもとを鍵の材料の文字列にする。 */
function sourceKeyText(source: ProjectionSource): string {
  return source.kind === 'subShape'
    ? `subShape{${fingerprintKeyText(source.ref)}}`
    : `body{${source.bodyFeatureId}}`;
}

/**
 * 投影・交差 1 件の鍵。`offsetCacheKey` と同じ `hash64` を使うが、材料が別物なので
 * 別の関数にする(オフセットと同じ union に入れない、`offsetMath.ts` と同じ判断)。
 */
export function projectionCacheKey(material: ProjectionKeyMaterial): string {
  return hash64(
    `projection{body=${material.bodyKey}` +
      `;source=${sourceKeyText(material.source)}` +
      `;plane=${planeKeyText(material.plane)}}`,
  );
}

/**
 * 覚えておく件数の上限。オフセット(`OFFSET_CACHE_CAPACITY`)と同じ 64 にする。
 * 1 つの部品が持つ投影・交差はふつう数件で、鍵は上流が変わるたびに新しくなるため、
 * 「直前の何段階かの Undo が当たれば十分」という同じ見積もりが当てはまる。
 */
export const PROJECTION_CACHE_CAPACITY = 64;

/**
 * 計算し終えた投影・交差の曲線を鍵で引く入れ物(LRU)。
 * `OffsetCache` と同じ形にそろえてある(`offsetMath.ts` の注釈)。
 */
export interface ProjectionCache {
  /** 覚えていなければ null。 */
  get(key: string): readonly ResolvedCurve[] | null;
  set(key: string, curves: readonly ResolvedCurve[]): void;
  readonly size: number;
}

export function createProjectionCache(
  capacity: number = PROJECTION_CACHE_CAPACITY,
): ProjectionCache {
  const entries = new Map<string, readonly ResolvedCurve[]>();
  return {
    get(key): readonly ResolvedCurve[] | null {
      const found = entries.get(key);
      if (found === undefined) {
        return null;
      }
      // 使ったものはいちばん新しい位置へ移す(`shapeCache.ts` と同じ LRU の作り)。
      entries.delete(key);
      entries.set(key, found);
      return found;
    },
    set(key, curves): void {
      entries.delete(key);
      entries.set(key, curves);
      while (entries.size > capacity) {
        const oldest = entries.keys().next();
        if (oldest.done === true) {
          break;
        }
        entries.delete(oldest.value);
      }
    },
    get size(): number {
      return entries.size;
    },
  };
}
