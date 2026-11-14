/**
 * ほかの要素や外の計算から作る曲線(オフセット FR-321・複製 FR-324・関数の曲線・投影と交差 FR-325)の
 * 解き方。
 *
 * どれも自分では形を計算しない。オフセット・関数・投影はカーネルや関数の計算が作った覚え書きを
 * **読むだけ**にして解決を純関数のまま保ち、覚え書きが無ければ保留(`pendingOffsets` /
 * `pendingProjections`)へ積む。頼むのは `recomputeSketch` の役目。複製はここまでに解決できた
 * 点・曲線を `copyMath.ts` で写す。結果は `resolveSketchState.ts` の記録へ書き込む。
 */

import { resolveCopyFeature } from './copyMath.js';
import { traceCurveChain } from './intersectionMath.js';
import { offsetCacheKey } from './offsetMath.js';
import {
  markConstruction,
  needsWorkPlane,
  recordCurveGroup,
  recordPoints,
  sketchError,
  type SketchFeatureStep,
  type SketchResolveState,
} from './resolveSketchState.js';
import type {
  OffsetContourShape,
  ResolvedCurve,
  SketchCopyFeature,
  SketchElementRef,
  SketchError,
  SketchFunctionCurveFeature,
  SketchOffsetFeature,
  SketchPlaneSectionFeature,
  SketchProjectedCurveFeature,
} from './types.js';
import { lengthVec3, normalizeVec3, SKETCH_TOLERANCE_MM, subVec3, type Vec3 } from './vec3.js';

type OffsetSourceOutcome =
  | { readonly ok: true; readonly curves: readonly ResolvedCurve[] }
  | { readonly ok: false; readonly error: SketchError };

/**
 * オフセット元(FR-321)の要素を、選んだ順に曲線の列へ広げる。
 *
 * 参照の解き方は面の境界(`resolveFace`)と同じ約束にそろえる: 単体の線・円弧・楕円・
 * スプラインはそのまま 1 本、矩形などの複数曲線フィーチャーは `index` を省けば全周、
 * 指定すれば n 番目だけ。点・点列は線ではないので選べない。
 */
function collectOffsetSource(
  featureId: string,
  source: readonly SketchElementRef[],
  curveByFeature: ReadonlyMap<string, ResolvedCurve>,
  curvesByFeature: ReadonlyMap<string, readonly ResolvedCurve[]>,
): OffsetSourceOutcome {
  if (source.length === 0) {
    return {
      ok: false,
      error: sketchError(featureId, 'tooFewPoints', 'ずらす線・円弧が選ばれていません。'),
    };
  }
  const curves: ResolvedCurve[] = [];
  for (const reference of source) {
    const single = curveByFeature.get(reference.featureId);
    if (single !== undefined) {
      curves.push(single);
      continue;
    }
    const group = curvesByFeature.get(reference.featureId);
    if (group === undefined) {
      return {
        ok: false,
        error: sketchError(
          featureId,
          'missingBase',
          `ずらすもとの線が見つかりません: ${reference.featureId}`,
        ),
      };
    }
    if (reference.index === undefined) {
      curves.push(...group);
      continue;
    }
    const selected = group[reference.index];
    if (selected === undefined) {
      return {
        ok: false,
        error: sketchError(
          featureId,
          'missingBase',
          `ずらすもとの線が見つかりません: ${reference.featureId}#${String(reference.index)}`,
        ),
      };
    }
    curves.push(selected);
  }
  return { ok: true, curves };
}

type ContourOutcome =
  | { readonly ok: true; readonly shape: OffsetContourShape }
  | { readonly ok: false; readonly error: SketchError };

/** 開いた輪郭の起点と進む向きをまとめる。向きが定まらなければ断る。 */
function openContour(
  featureId: string,
  startPoint: Vec3,
  towards: Vec3,
  normal: Vec3,
): ContourOutcome {
  const along = subVec3(towards, startPoint);
  if (lengthVec3(along) <= SKETCH_TOLERANCE_MM) {
    return {
      ok: false,
      error: sketchError(featureId, 'degenerate', 'ずらすもとの線の向きが定まりません。'),
    };
  }
  return {
    ok: true,
    shape: {
      closed: false,
      startPoint,
      startDirection: normalizeVec3(along),
      normal,
    },
  };
}

/**
 * オフセット元の曲線の列が並んだ順につながっているかを確かめ、輪になっているか・
 * 開いているならどこからどちら向きにたどり始めるかを返す(FR-321)。
 *
 * たどり方は `resolveCurveLoop`(面の境界)と同じなので、歩き方そのものは
 * `intersectionMath.ts` の `traceCurveChain` に 1 つだけ置いてある(共通化した)。
 * 違うのは**閉じていなくてもよい**ところと、**1 本目を逆向きにたどってよい**ところで、
 * 開いた輪郭は片側へずらした 1 本の曲線になる(`makeOffsetWire.ts` の `IsOpenResult`)。
 *
 * 進む向きは 1 本目の**端から端への向き**(弦)で近似する。ずらした側の左右を見分ける
 * のに使うだけなので、接線との差が 90 度未満であれば判定は変わらない(半周までの
 * 円弧・楕円弧はこれを満たす)。
 */
function analyzeOffsetContour(
  featureId: string,
  curves: readonly ResolvedCurve[],
  normal: Vec3,
): ContourOutcome {
  // 1 本だけのときは `traceCurveChain` が「1 本で輪になるか」(全周の円・全周の楕円・
  // 閉じたスプライン)をそのまま答えるので、ここで分けなくてよい。
  const traced = traceCurveChain(curves, { allowReversedFirst: true });
  if (!traced.ok) {
    return {
      ok: false,
      error: sketchError(featureId, 'notClosed', '選んだ線・円弧の端がつながっていません。'),
    };
  }
  if (traced.chain.closed) {
    return { ok: true, shape: { closed: true } };
  }
  return openContour(featureId, traced.chain.start, traced.chain.afterFirst, normal);
}

/** 覚え書きから来た曲線に、いまのフィーチャーの id を付け直す。 */
function retagCurve(curve: ResolvedCurve, featureId: string): ResolvedCurve {
  switch (curve.kind) {
    case 'segment':
      return { ...curve, featureId };
    case 'arc':
      return { ...curve, featureId };
    case 'ellipse':
      return { ...curve, featureId };
    case 'spline':
      return { ...curve, featureId };
  }
}

/** 外で計算した曲線(オフセット・関数・投影の覚え書き)に id を付け直して記録する。 */
function recordRememberedCurves(
  state: SketchResolveState,
  feature: { readonly id: string; readonly construction: boolean },
  remembered: readonly ResolvedCurve[],
): void {
  const created = remembered.map((curve) => retagCurve(curve, feature.id));
  recordCurveGroup(state, feature.id, feature.construction, created);
}

/**
 * オフセット(FR-321)。左右の基準になる法線が要るので、作図面のあるスケッチだけで作れる
 * (3D スケッチでは断る)。形は鍵で覚え書きを引き、無ければ保留へ積む。
 */
export function resolveOffsetStep(feature: SketchOffsetFeature, step: SketchFeatureStep): void {
  const { plane, state } = step;
  if (plane === null) {
    state.errors.push(needsWorkPlane(feature.id, 'オフセット'));
    return;
  }
  const source = collectOffsetSource(
    feature.id,
    feature.source,
    state.curveByFeature,
    state.curvesByFeature,
  );
  if (!source.ok) {
    state.errors.push(source.error);
    return;
  }
  const distance = feature.distance.value;
  if (!Number.isFinite(distance) || distance < 0) {
    state.errors.push(
      sketchError(feature.id, 'invalidValue', 'ずらす距離は 0 以上の数で指定してください。'),
    );
    return;
  }
  const contour = analyzeOffsetContour(feature.id, source.curves, plane.normal);
  if (!contour.ok) {
    state.errors.push(contour.error);
    return;
  }
  const key = offsetCacheKey({
    curves: source.curves,
    distance,
    side: feature.side,
    corner: feature.corner,
  });
  const remembered = step.lookups.offsetCurves(key);
  if (remembered === null) {
    // まだ形が無いだけで失敗ではないので errors には入れない(投影・交差と同じ扱い)。
    state.pendingOffsets.push({
      featureId: feature.id,
      key,
      curves: source.curves,
      distance,
      side: feature.side,
      corner: feature.corner,
      contour: contour.shape,
    });
    return;
  }
  if (remembered.length === 0) {
    state.errors.push(sketchError(feature.id, 'degenerate', 'ずらした結果が空になりました。'));
    return;
  }
  recordRememberedCurves(state, feature, remembered);
}

/**
 * 複製(FR-324)。「もとを id で参照する 1 フィーチャー」なので、ここまでに解決できた
 * 点・曲線をそのまま写す(`copyMath.ts` の注釈)。点の複製と曲線の複製は同時に起きない
 * (`collectCopySource` が混在を断る)。
 */
export function resolveCopyFeatureStep(feature: SketchCopyFeature, step: SketchFeatureStep): void {
  const { state } = step;
  const copied = resolveCopyFeature(
    feature,
    step.plane,
    step.context,
    {
      curveByFeature: state.curveByFeature,
      curvesByFeature: state.curvesByFeature,
      pointsByFeature: state.pointsByFeature,
    },
    step.lookups.workPlane,
  );
  if (!copied.ok) {
    state.errors.push(copied.error);
    return;
  }
  if (copied.points.length > 0) {
    markConstruction(state, feature.id, feature.construction);
    recordPoints(state, feature.id, copied.points);
    return;
  }
  recordCurveGroup(state, feature.id, feature.construction, copied.curves);
}

/**
 * 関数の曲線。関数の計算が済み XYZ の範囲で切った曲線だけを受け取る。無いか空なら断り、
 * 古い点が「直前の点」のまま残らないよう取り消す。
 */
export function resolveFunctionCurveStep(
  feature: SketchFunctionCurveFeature,
  step: SketchFeatureStep,
): void {
  const { state } = step;
  const remembered = step.lookups.functionCurves(feature.id);
  if (remembered == null || remembered.length === 0) {
    state.previous = null;
    state.errors.push(sketchError(feature.id, 'invalidValue', remembered == null
      ? '関数の再計算が完了していません。'
      : '指定したXYZの範囲に曲線がありません。'));
    return;
  }
  recordRememberedCurves(state, feature, remembered);
}

/**
 * 投影・交差(FR-325)。投影先・切り口は作図面そのものなので、3D スケッチ(作図面なし)では
 * 作れない。形はフィーチャーの id で覚え書きを引き、無ければ保留へ積む。
 */
export function resolveProjectionStep(
  feature: SketchProjectedCurveFeature | SketchPlaneSectionFeature,
  step: SketchFeatureStep,
): void {
  const { plane, state } = step;
  if (plane === null) {
    state.errors.push(
      needsWorkPlane(feature.id, feature.kind === 'projectedCurve' ? '投影' : '交差'),
    );
    return;
  }
  const remembered = step.lookups.projectedCurves(feature.id);
  if (remembered === null) {
    // まだ形が無いだけで失敗ではないので errors には入れない(オフセットと同じ扱い)。
    state.pendingProjections.push({
      featureId: feature.id,
      source:
        feature.kind === 'projectedCurve'
          ? { kind: 'subShape', ref: feature.source }
          : { kind: 'body', bodyFeatureId: feature.targetFeatureId },
      plane,
    });
    return;
  }
  if (remembered.length === 0) {
    // 交差は「交わらなければ 0 本」が正しい結果なので、ここで理由を出して断る
    // (カーネルは例外を投げない。`makeSection.ts` の決め)。
    state.errors.push(
      sketchError(
        feature.id,
        'degenerate',
        feature.kind === 'projectedCurve'
          ? '投影しても線になりませんでした。作図面の向きを見直してください。'
          : '立体と作図面が交わりません。作図面の位置を見直してください。',
      ),
    );
    return;
  }
  recordRememberedCurves(state, feature, remembered);
}
