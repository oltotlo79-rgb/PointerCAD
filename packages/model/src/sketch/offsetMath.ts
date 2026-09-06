/**
 * オフセット(FR-321、計画書 P4 §2.5・§0.a-0.10・§0.a-0.22、タスク15)のうち、
 * カーネルを呼ばずに済む部分。
 *
 * オフセットの曲線そのものは OCCT(`kernel/src/occt/makeOffsetWire.ts`)が作るので、
 * ここが受け持つのは次の 3 つだけ。
 *
 * 1. **鍵**: 「元の曲線+距離+側+角」から決まる文字列。同じ入力なら同じ鍵になり、
 *    上流が変われば必ず変わる(`part/cacheKey.ts` の鍵の連鎖と同じ考え方、NFR-PF-3)。
 * 2. **覚え書き**: 鍵から結果の曲線を引く入れ物(LRU)。スケッチの解決は純関数のままで、
 *    カーネルの往復は `recomputeSketch.ts` が受け持つ(§2.9)。
 * 3. **側の判定**: 出来上がった輪郭が、頼んだ側(内/外、開いた曲線では左/右)に
 *    乗っているかを測る。
 *
 * **距離の符号について(2026-09-04 に Node で実測)。**
 * `BRepOffsetAPI_MakeOffset` の符号つき距離は、**閉じた輪郭では向きにも平面にもよらず
 * 「正が外側・負が内側」**だった(40×30 の矩形を反時計回り・時計回りの両方で、XY 面・
 * XZ 面・傾いた面のいずれでも、+5 で面積 1200 → 2000、−5 で 1200 → 600)。だから
 * 閉じた輪郭は `closedOffsetDistance` の一行で決められる。
 * **開いた曲線は違う。** OCCT は輪郭から平面を自分で見つけ、その平面の法線の向きを
 * 作図面とは無関係に選ぶ(実測: XY 面の折れ線では +Z、XZ 面の折れ線では +Y を選び、
 * 基準面 `xz` の法線 (0,−1,0) とは逆だった)。予測に頼ると環境や形で崩れるので、
 * **一度計算してから結果の側を測り、違っていれば符号を反転して頼み直す**
 * (`recomputeSketch.ts`)。1 回目で当たれば往復は 1 回で済む。
 */

import { hash64, keyCurveList, keyNumber, type KeyCurve } from '../part/cacheKey.js';
import type { OffsetCornerKind, OffsetSide, ResolvedCurve } from './types.js';
import {
  crossVec3,
  distanceVec3,
  dotVec3,
  lengthVec3,
  normalizeVec3,
  SKETCH_TOLERANCE_MM,
  subVec3,
  type Vec3,
} from './vec3.js';

/** 鍵の材料(FR-321)。距離は**大きさ**で、向きは `side` が決める。 */
export interface OffsetKeyMaterial {
  /** オフセット元の曲線。並んだ順につながっていること。 */
  readonly curves: readonly KeyCurve[];
  /** 距離の大きさ(mm、0 以上)。 */
  readonly distance: number;
  readonly side: OffsetSide;
  readonly corner: OffsetCornerKind;
}

/**
 * オフセット 1 件の鍵。`cacheKeyFor`(立体の段)と同じ `hash64` を使うが、
 * 立体の段の材料(`SolidStepKeyMaterial`)とは別物なので union には入れない
 * (オフセットは立体の段ではなくスケッチの中の話で、混ぜると網羅 switch が
 * 意味を持たない枝を抱えるため)。
 */
export function offsetCacheKey(material: OffsetKeyMaterial): string {
  return hash64(
    `offset{curves=${keyCurveList(material.curves)}` +
      `;distance=${keyNumber(material.distance)}` +
      `;side=${material.side};corner=${material.corner}}`,
  );
}

/**
 * 閉じた輪郭の符号つき距離。実測(このファイル冒頭)により、
 * 輪郭の向き・平面によらず正が外側になる。
 */
export function closedOffsetDistance(distance: number, side: OffsetSide): number {
  return side === 'outside' ? distance : -distance;
}

/** 覚えておく件数の上限。これを超えたら古いものから捨てる。 */
export const OFFSET_CACHE_CAPACITY = 64;

/**
 * 計算し終えたオフセットの曲線を鍵で引く入れ物(LRU)。
 *
 * スケッチの解決(`resolveSketch`)は純関数のままにしたいので、カーネルの結果は
 * ここへ置いて解決の側から**読むだけ**にする。無ければ「まだ計算していない」として
 * `ResolvedSketch.pendingOffsets` へ積まれ、`recomputeSketch` がカーネルへ頼む。
 */
export interface OffsetCache {
  /** 覚えていなければ null。 */
  get(key: string): readonly ResolvedCurve[] | null;
  set(key: string, curves: readonly ResolvedCurve[]): void;
  /**
   * 覚えていることを全部忘れる。**文書を丸ごと差し替えるとき(新規・開く・復元)に呼ぶ。**
   * 鍵は元の曲線の形から作るので前の文書の値が誤って当たることは無いが、
   * 前の部品の分を新しい部品のあいだ抱え続ける理由も無い(`SubShapeCache.clear` と
   * 同じ口でまとめて呼べるように、3 つの覚え書きで形をそろえる)。
   */
  clear(): void;
  readonly size: number;
}

export function createOffsetCache(capacity: number = OFFSET_CACHE_CAPACITY): OffsetCache {
  const entries = new Map<string, readonly ResolvedCurve[]>();
  return {
    get(key): readonly ResolvedCurve[] | null {
      const found = entries.get(key);
      if (found === undefined) {
        return null;
      }
      // 引いたものを新しい側へ回して、よく使うものが残るようにする。
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
          return;
        }
        entries.delete(oldest.value);
      }
    },
    clear(): void {
      entries.clear();
    },
    get size(): number {
      return entries.size;
    },
  };
}

/**
 * 出来上がった輪郭が、進む向きから見てどちら側に乗っているかを測る(開いた曲線用)。
 *
 * 上向きを `normal`、進む向きを `direction` とすると、**左は `normal × direction`**。
 * 例: 上が +Z、進む向きが +X なら左は +Y になる。ずれの向きが左なら `outside`、
 * 右なら `inside`(開いた曲線での約束。閉じた輪郭では内/外そのもの)。
 *
 * どちらとも言えない(ずれが左右の向きとほぼ直交する)ときは null を返す。
 * 呼び出し側は「測れなかった」として頼み直さない。
 */
export function offsetSideOf(
  displacement: Vec3,
  direction: Vec3,
  normal: Vec3,
): OffsetSide | null {
  if (lengthVec3(direction) <= SKETCH_TOLERANCE_MM || lengthVec3(normal) <= SKETCH_TOLERANCE_MM) {
    return null;
  }
  const left = crossVec3(normalizeVec3(normal), normalizeVec3(direction));
  if (lengthVec3(left) <= SKETCH_TOLERANCE_MM) {
    return null;
  }
  const projection = dotVec3(displacement, normalizeVec3(left));
  if (Math.abs(projection) <= SKETCH_TOLERANCE_MM) {
    return null;
  }
  return projection > 0 ? 'outside' : 'inside';
}

/**
 * 元の輪郭の起点から見た、出来上がった輪郭のずれ。
 *
 * 出来上がった輪郭は元と同じ向きにたどられて返る(実測)。それでも取り違えないよう、
 * **起点に近いほうの端**を選んでずれを測る。
 */
export function offsetDisplacement(
  startPoint: Vec3,
  resultStart: Vec3,
  resultEnd: Vec3,
): Vec3 {
  const toStart = distanceVec3(startPoint, resultStart);
  const toEnd = distanceVec3(startPoint, resultEnd);
  return subVec3(toStart <= toEnd ? resultStart : resultEnd, startPoint);
}
