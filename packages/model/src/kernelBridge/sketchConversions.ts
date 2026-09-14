/** スケッチのオフセット・投影・断面の依頼と結果を変換する。Workerの接続と実行は持たない。 */
import type {
  OffsetJoinType, PlaneCurve, SketchOffsetItem, SketchOffsetOutcome, SketchPlaneFrame,
  SketchProjectionItem, SketchProjectionOutcome, SketchSectionItem, Vec2Tuple,
} from '@pointercad/kernel';
import type { WorkPlane } from '../sketch/planeMath.js';
import type { OffsetCornerKind, ResolvedCurve } from '../sketch/types.js';
import { addVec3, scaleVec3, type Vec3 } from '../sketch/vec3.js';
import { toCurveSpec, fromCurveSpec } from './curveConversions.js';
import { toSubShapeQuery } from './subShapeQuery.js';
import type {
  SketchOffsetRequestItem, SketchOffsetEntry, SketchOffsetFailure, SketchOffsetResult,
  SketchProjectionRequestItem, SketchProjectionEntry, SketchProjectionFailure, SketchProjectionResult,
} from './sketchContracts.js';

/** 角の作り方(model の言葉)をカーネルの言葉へ直す。 */
function toJoinType(corner: OffsetCornerKind): OffsetJoinType {
  return corner === 'sharp' ? 'intersection' : 'arc';
}

/** オフセット 1 件の依頼をカーネルの言葉へ直す。 */
export function toOffsetItem(request: SketchOffsetRequestItem): SketchOffsetItem {
  return {
    id: request.featureId,
    curves: request.curves.map((curve) => toCurveSpec(curve)),
    distance: request.distance,
    joinType: toJoinType(request.corner),
  };
}

/** オフセットが返らなかったとき(カーネルが id を返さなかったとき)に付ける理由。 */
const MISSING_OFFSET_MESSAGE = 'カーネルからオフセットの結果が返りませんでした。';

/**
 * オフセットの結果を model の言葉へ詰め替える。
 * 頼んだのに結果も理由も返らなかった id は、理由を補って失敗として扱う(FR-504。
 * 面の詰め替え `toOutcome` と同じ書き方)。
 */
export function toOffsetResult(
  requests: readonly SketchOffsetRequestItem[],
  outcome: SketchOffsetOutcome,
): SketchOffsetResult {
  const results: SketchOffsetEntry[] = outcome.results.map((result) => ({
    featureId: result.id,
    contours: result.contours.map((contour) => ({
      curves: contour.curves.map((curve) => fromCurveSpec(curve, result.id)),
      closed: contour.closed,
    })),
  }));
  const failures: SketchOffsetFailure[] = outcome.failures.map((failure) => ({
    featureId: failure.id,
    message: failure.message,
  }));

  const reported = new Set<string>(results.map((result) => result.featureId));
  for (const failure of failures) {
    reported.add(failure.featureId);
  }
  for (const request of requests) {
    if (!reported.has(request.featureId)) {
      failures.push({ featureId: request.featureId, message: MISSING_OFFSET_MESSAGE });
    }
  }

  return { results, failures };
}

/* ------------------------------------------------------------------ *
 * 投影・交差の詰め替え(FR-325、P4 タスク25)
 * ------------------------------------------------------------------ */

/** 作図面の 2 次元座標をワールド座標へ戻す。第 2 軸は `WorkPlane.axisV`(= 法線 × 第 1 軸)。 */
function planePointToWorld(plane: WorkPlane, uv: Vec2Tuple): Vec3 {
  return addVec3(
    plane.origin,
    addVec3(scaleVec3(plane.axisU, uv[0]), scaleVec3(plane.axisV, uv[1])),
  );
}

/**
 * カーネルが返した作図面の上の曲線を、model の解決済みの曲線へ戻す(FR-325)。
 *
 * - 線分・円弧は形のまま残る(投影のほとんどの用途がここに入る。`makeProjection.ts`)。
 * - 点列(傾いた円・楕円・自由曲線)は**通過点のスプライン**として受ける。
 *   `ResolvedSpline` は通過点しか持たない型なので、そのまま詰められる
 *   (`fromCurveSpec` の注釈が予告していた「B スプラインが返る道」がこれ)。
 *
 * 円弧の角度は「第 1 軸から第 2 軸へ回る向きが正」で、`ResolvedArc` の約束と同じ
 * (`makeProjection.ts` の `PlaneArc` の注釈)。そのまま渡してよい。
 */
export function fromPlaneCurve(
  curve: PlaneCurve,
  plane: WorkPlane,
  featureId: string,
): ResolvedCurve {
  switch (curve.kind) {
    case 'segment':
      return {
        kind: 'segment',
        featureId,
        from: planePointToWorld(plane, curve.from),
        to: planePointToWorld(plane, curve.to),
      };
    case 'arc':
      return {
        kind: 'arc',
        featureId,
        center: planePointToWorld(plane, curve.center),
        normal: plane.normal,
        xAxis: plane.axisU,
        radius: curve.radius,
        startAngle: curve.startAngle,
        endAngle: curve.endAngle,
      };
    case 'polyline':
      return {
        kind: 'spline',
        featureId,
        mode: 'interpolate',
        points: curve.points.map((point) => planePointToWorld(plane, point)),
        closed: curve.closed,
      };
  }
}

/** 作図面を kernel の言葉へ直す。第 2 軸は kernel が「法線 × 第 1 軸」で作り直す。 */
function toPlaneFrame(plane: WorkPlane): SketchPlaneFrame {
  return { origin: plane.origin, axisU: plane.axisU, normal: plane.normal };
}

/** 投影の依頼をカーネルの言葉へ直す。 */
export function toProjectionItem(request: SketchProjectionRequestItem): SketchProjectionItem {
  return {
    id: request.featureId,
    shapeKey: request.bodyKey,
    subShape: request.source === null ? null : toSubShapeQuery(request.source),
    plane: toPlaneFrame(request.plane),
  };
}

/** 交差の依頼をカーネルの言葉へ直す(切るのは立体そのものなので指紋は渡さない)。 */
export function toSectionItem(request: SketchProjectionRequestItem): SketchSectionItem {
  return {
    id: request.featureId,
    ...(request.curveToleranceMm === undefined ? {} : { curveToleranceMm: request.curveToleranceMm }),
    shapeKey: request.bodyKey,
    plane: toPlaneFrame(request.plane),
  };
}

/** 投影・交差が返らなかったとき(カーネルが id を返さなかったとき)に付ける理由。 */
const MISSING_PROJECTION_MESSAGE = 'カーネルから投影・交差の結果が返りませんでした。';

/**
 * 投影・交差の結果を model の言葉へ詰め替える。
 * 頼んだのに結果も理由も返らなかった id は理由を補って失敗にする(`toOffsetResult` と同じ)。
 */
export function toProjectionResult(
  requests: readonly SketchProjectionRequestItem[],
  outcome: SketchProjectionOutcome,
): SketchProjectionResult {
  const planeByFeature = new Map(requests.map((request) => [request.featureId, request.plane]));
  const preciseFeatures = new Set(requests.filter((request) => request.curveToleranceMm !== undefined).map((request) => request.featureId));
  const results: SketchProjectionEntry[] = [];
  const failures: SketchProjectionFailure[] = outcome.failures.map((failure) => ({
    featureId: failure.id,
    message: failure.message,
  }));

  for (const result of outcome.results) {
    const plane = planeByFeature.get(result.id);
    if (plane === undefined) {
      // 頼んでいない id が返ることは無いが、返ってきても黙って捨てず理由を残す。
      failures.push({ featureId: result.id, message: MISSING_PROJECTION_MESSAGE });
      continue;
    }
    results.push({
      featureId: result.id,
      curves: result.curves.flatMap((curve) => {
        if (curve.kind !== 'polyline' || !preciseFeatures.has(result.id)) return [fromPlaneCurve(curve, plane, result.id)];
        // 精密出力の折線を補間スプラインへ読み替えない。受け取った弦をそのまま保持する。
        return curve.points.slice(0, curve.closed ? undefined : -1).map((point, index) => fromPlaneCurve({
          kind: 'segment', from: point, to: curve.points[(index + 1) % curve.points.length],
        }, plane, result.id));
      }),
    });
  }

  const reported = new Set<string>(results.map((result) => result.featureId));
  for (const failure of failures) {
    reported.add(failure.featureId);
  }
  for (const request of requests) {
    if (!reported.has(request.featureId)) {
      failures.push({ featureId: request.featureId, message: MISSING_PROJECTION_MESSAGE });
    }
  }

  return { results, failures };
}
