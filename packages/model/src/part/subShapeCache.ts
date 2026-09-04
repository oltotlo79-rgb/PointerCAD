/**
 * 立体の面・辺・頂点の参照を「いまの形」で選び直して覚えておく入れ物
 * (FR-325、FR-328〜330 の上流追従。計画書 P4 §2.6・§2.7、タスク25)。
 *
 * ## なぜ要るのか
 *
 * 3D スケッチの点(FR-330)・任意の作業平面(FR-328)・基準ジオメトリ(FR-329)は、
 * 立体の面・辺・頂点を**指紋つきの参照**(`SubShapeRef`)で指す。指紋は「選んだ瞬間」の
 * 位置・向き・大きさなので、上流の押し出しを 10 → 20 に変えると古くなる。
 * これまで(タスク9・10)は指紋の位置をそのまま使っていたため、**上流を変えても
 * 参照した点が動かなかった**(タスク10 の申し送り)。
 *
 * ## どうやって追従させるか
 *
 * 解決(`resolvePart`)は OCCT を呼ばない純関数なので、選び直しの結果はここへ置いて
 * 解決の側からは**読むだけ**にする(オフセット・投影の覚え書きと同じ流儀)。
 * 実際の選び直しは `recomputePart` が、カーネルから返ったボディの一覧を使って
 * `refresh` で行う。採点は kernel の純関数(`matchFace` 等)が正本で、
 * `kernelBridge.ts` の `selectSubShape` 越しに呼ぶ(model から kernel を直接呼ばない)。
 *
 * ## 覚えるのは「聞かれたもの」だけ
 *
 * 文書のどこに `SubShapeRef` があるかを別途走査すると、種類が増えるたびに走査も
 * 増やすことになる(取りこぼしが起きる)。そこで**解決のときに聞かれた参照を覚えておき、
 * それだけを選び直す**。聞かれていない参照は、選び直しても誰も使わない。
 */

import { subShapeFromFingerprint, type ResolvedSubShape } from '../geometry/planeSpec.js';
import { fingerprintKeyText, type SubShapeRef } from '../geometry/subShapeRef.js';
import { selectSubShape, type SolidBody } from '../kernelBridge.js';
import type { Vec3 } from '../sketch/vec3.js';

/** 選び直しの結果を覚えておく入れ物。`OffsetCache` / `ProjectionCache` と同じ流儀。 */
export interface SubShapeCache {
  /**
   * 解決の口。`ResolvePartOptions.subShape` へそのまま渡せる形。
   * 覚えていればその値、覚えていなければ保存された指紋の位置・向きを返す。
   * **聞かれた参照は覚えておく**(次の `refresh` の対象になる)。
   */
  resolve(reference: SubShapeRef): ResolvedSubShape | null;
  /**
   * いまのボディの一覧から選び直して覚え直す。**答えが 1 つでも変わったら true**。
   * 呼び出し側(`recomputePart`)はそのときだけ解決をやり直す。
   *
   * 一覧に無いボディ(消費されて画面に出ない立体など)の参照はそのままにする。
   * 選び直せないだけで、保存された指紋を使う従来の振る舞いは残る(FR-504)。
   */
  refresh(bodies: readonly SolidBody[]): boolean;
  /** いま覚えている参照の数(検査と実測のため)。 */
  readonly size: number;
}

/** 位置・向きが同じとみなす差(mm)。丸めの揺れで「変わった」と誤判定しないための幅。 */
const SAME_VALUE_EPSILON = 1e-9;

function sameVec3(a: Vec3 | null, b: Vec3 | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    Math.abs(a[0] - b[0]) <= SAME_VALUE_EPSILON &&
    Math.abs(a[1] - b[1]) <= SAME_VALUE_EPSILON &&
    Math.abs(a[2] - b[2]) <= SAME_VALUE_EPSILON
  );
}

/** 選び直しの結果が実質同じか。違えば解決をやり直す価値がある。 */
function sameSubShape(a: ResolvedSubShape | null, b: ResolvedSubShape | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.kind === b.kind &&
    a.surfaceKind === b.surfaceKind &&
    a.curveKind === b.curveKind &&
    sameVec3(a.position, b.position) &&
    sameVec3(a.axis, b.axis)
  );
}

export function createSubShapeCache(): SubShapeCache {
  /** 解決のときに聞かれた参照(鍵 → 参照)。 */
  const asked = new Map<string, SubShapeRef>();
  /** 選び直した結果(鍵 → 値。null は「指紋に合う形が無い」)。 */
  const values = new Map<string, ResolvedSubShape | null>();

  return {
    resolve(reference): ResolvedSubShape | null {
      const key = fingerprintKeyText(reference);
      asked.set(key, reference);
      if (values.has(key)) {
        return values.get(key) ?? null;
      }
      return subShapeFromFingerprint(reference);
    },

    refresh(bodies): boolean {
      const byFeature = new Map(bodies.map((body) => [body.featureId, body]));
      let changed = false;
      for (const [key, reference] of asked) {
        const body = byFeature.get(reference.bodyFeatureId);
        if (body === undefined) {
          continue;
        }
        const next = selectSubShape(body, reference);
        const previous = values.has(key)
          ? (values.get(key) ?? null)
          : subShapeFromFingerprint(reference);
        values.set(key, next);
        if (!sameSubShape(previous, next)) {
          changed = true;
        }
      }
      return changed;
    },

    get size(): number {
      return asked.size;
    },
  };
}
