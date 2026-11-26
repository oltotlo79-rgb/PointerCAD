
import { curveSamplePoints } from '../sketch/curvePlaneSamples.js';
import type { ConstraintDiagnosis } from '../sketch/constraints/diagnose.js';
import { type WorkPlane, type WorkPlaneId } from '../sketch/planeMath.js';
import { fitPlaneNormal } from '../sketch/resolveSketch.js';
import type { ResolvedCurve, ResolvedSketch, SketchDocument, SketchError } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import type { SketchCurveRef } from './types.js';

export interface CurveProfileContext {
  readonly sketchDocuments: readonly SketchDocument[];
  readonly workPlane: (planeId: WorkPlaneId) => WorkPlane | null;
}

/** スケッチ1本ぶんの解決結果。再計算がこれへメッシュを足す。 */
export interface ResolvedPartSketch {
  readonly sketchId: string;
  readonly resolved: ResolvedSketch;
  /**
   * 拘束の診断(自由度・足しすぎ・矛盾。FR-313)。
   * **拘束が 1 つも無いスケッチと 3D スケッチでは null**(診断そのものを行わない)。
   */
  readonly diagnosis: ConstraintDiagnosis | null;
  /**
   * 拘束の失敗(FR-504)。`resolved.errors` とは別に持つ。分けているのは、
   * 拘束の失敗が「フィーチャーが作れなかった」ではなく「拘束が効かなかった」で、
   * 画面での出し方(どの拘束を指すか)が違うため。
   */
  readonly constraintErrors: readonly SketchError[];
}

/** 角度の上限(度)。全周を超える回転は受け付けない。 */
export const MAX_REVOLVE_DEGREES = 360;

/** 0 より大きい有限の数か。式が評価できなかった欄は value が NaN で来る(FR-504)。 */
export function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * スケッチの曲線フィーチャーの並び(`SketchCurveRef`)を解決済みの曲線へ直す。
 *
 * `ResolvedSketch.curvesByFeature` は「フィーチャー id → その形になった曲線」の表で、
 * 矩形・正多角形のように 1 つのフィーチャーが複数の曲線になるものも 1 つの束で引ける
 * (公開された表。同じ引き方を 2 通りに書かない)。
 *
 * **並びは書かれた順のまま**にする(経路は順につながっている前提。`SketchCurveRef` の注釈)。
 * 1 本でも引けなければ null を返し、呼び出し側が種類ごとの文言で断る(FR-504)。
 * 曲線 id が空の並びも null になる——「道筋を 1 本も選んでいない」は形が決まらないためである。
 */
export function findResolvedCurves(
  sketches: readonly ResolvedPartSketch[],
  reference: SketchCurveRef,
): readonly ResolvedCurve[] | null {
  const sketch = sketches.find((entry) => entry.sketchId === reference.sketchId);
  if (sketch === undefined) {
    return null;
  }
  const resolved = sketch.resolved;
  // **`curvesByFeature` に入るのは「1 フィーチャーが複数の曲線を生む」ものだけ**
  // (矩形・正多角形・長穴・オフセット・複製。`ResolvedSketch` の注釈)。線分・円弧・
  // 楕円・スプラインは種類ごとの配列にしか入らないので、そちらからも拾う。
  const singles: readonly ResolvedCurve[] = [
    ...resolved.segments,
    ...resolved.arcs,
    ...resolved.ellipses,
    ...resolved.splines,
  ];
  const curves: ResolvedCurve[] = [];
  for (const featureId of reference.curveIds) {
    const group = resolved.curvesByFeature.get(featureId);
    if (group !== undefined && group.length > 0) {
      curves.push(...group);
      continue;
    }
    const found = singles.filter((curve) => curve.featureId === featureId);
    if (found.length === 0) {
      return null;
    }
    curves.push(...found);
  }
  return curves.length === 0 ? null : curves;
}

/**
 * 開いた輪郭が乗っている平面の単位法線(リブ FR-420・曲面の押し出し FR-428)。
 *
 * まず座標から当てはめる(`fitPlaneNormal`)。**線分 1 本の輪郭は座標だけからは平面が
 * 決まらない**(直線を含む平面は無数にある)ので、そのときは輪郭をかいた**作図面**の
 * 法線を使う。作図面は保存形の `planeId` にあり、解決済みの曲線には残らないので
 * `CurveProfileContext.sketchDocuments` から引く。3D スケッチ(`free`)の線分 1 本のように
 * どちらでも決まらないときは null を返し、呼び出し側が理由をつけて断る(FR-504)。
 */
export function curveProfileNormal(
  reference: SketchCurveRef,
  curves: readonly ResolvedCurve[],
  context: CurveProfileContext,
): Vec3 | null {
  const fitted = fitPlaneNormal(curves.flatMap((curve) => curveSamplePoints(curve)));
  if (fitted !== null) {
    return fitted;
  }
  const sketch = context.sketchDocuments.find((entry) => entry.id === reference.sketchId);
  if (sketch === undefined) {
    return null;
  }
  const first = reference.curveIds[0];
  const feature = sketch.features.find((candidate) => candidate.id === first);
  if (feature === undefined) {
    return null;
  }
  const plane = context.workPlane(feature.planeId);
  return plane === null ? null : plane.normal;
}

