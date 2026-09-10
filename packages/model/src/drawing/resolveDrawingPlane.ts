import { drawingViewBasis, type DrawingDocument, type DrawingPlaneDefinition, type Vector3 } from '@pointercad/drawing';
import { evaluateExpression } from '@pointercad/expression';
import { resolvePlaneSpec, type PlaneOutcome, type PlaneResolveContext, type ResolvedPlane } from '../geometry/planeSpec.js';
import { analyzeParameters } from '../parameters/parameterTable.js';
import { WORK_PLANES } from '../sketch/planeMath.js';
import { resolveDimensionTarget, type DimensionResolveContext } from './dimensionTarget.js';

const contextForPoints = (points: readonly (Vector3 | null)[]): PlaneResolveContext => ({
  point: (reference) => reference.kind === 'point' ? points[Number(reference.pointId)] ?? null : null,
  axis: () => null,
  workPlane: (id) => id === 'xy' || id === 'xz' || id === 'yz' ? WORK_PLANES[id] : null,
  // 古い指紋へのフォールバックを許さない。参照する実形状は呼出し時点で解決する。
  subShape: () => null,
});

function planeThrough(points: readonly (Vector3 | null)[]): PlaneOutcome {
  return resolvePlaneSpec({ kind: 'threePoints', p1: { kind: 'point', pointId: '0' },
    p2: { kind: 'point', pointId: '1' }, p3: { kind: 'point', pointId: '2' } }, contextForPoints(points));
}

/** 図面の保存参照を解いてから、部品の切断と同じ平面検証へ渡す。 */
export function resolveDrawingPlane(definition: DrawingPlaneDefinition, document: DrawingDocument,
  context: DimensionResolveContext): PlaneOutcome {
  if (definition.kind === 'threePoints') {
    return planeThrough(definition.points.map((target) => {
      const point = resolveDimensionTarget(target, document, context);
      return point?.kind === 'point' ? point.point : null;
    }));
  }
  if (definition.kind === 'viewLine') {
    const view = document.views.find((item) => item.id === definition.sourceViewId);
    const basis = view === undefined ? null : drawingViewBasis({ normal: view.direction, xDir: view.xDir });
    if (basis === null || ![...definition.from, ...definition.to].every(Number.isFinite)) {
      return { ok: false, reason: 'missingPlane', message: '切断線を置く図が見つからないか、線の位置が正しくありません。' };
    }
    const point = (u: number, v: number): Vector3 => [
      context.modelCenter[0] + basis.x[0] * u + basis.y[0] * v,
      context.modelCenter[1] + basis.x[1] * u + basis.y[1] * v,
      context.modelCenter[2] + basis.x[2] * u + basis.y[2] * v,
    ];
    const a = point(...definition.from), b = point(...definition.to);
    return planeThrough([a, b, [a[0] + basis.normal[0], a[1] + basis.normal[1], a[2] + basis.normal[2]]]);
  }
  const expression = evaluateExpression(definition.offset.source, analyzeParameters(document.parameters, [definition.offset.source]));
  if (!expression.ok) return { ok: false, reason: 'invalidValue', message: '切断面の距離に使える数値や式を入力してください。' };
  if (definition.kind === 'workPlane') return resolvePlaneSpec({ kind: 'workPlane', planeId: definition.planeId,
    offset: expression.value }, contextForPoints([]));
  const resolved = resolveDimensionTarget(definition.target, document, context);
  if (resolved?.kind !== 'plane') return { ok: false, reason: 'notFlatFace', message: '参照している平らな面が見つかりません。面を選び直してください。' };
  // 解決済みの面を作図面として共有解決器へ渡す。部分形状参照の評価は上で一回だけ行う。
  const basis = drawingViewBasis({ normal: resolved.normal, xDir: Math.abs(resolved.normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0] });
  if (basis === null) return { ok: false, reason: 'notFlatFace', message: 'この面の向きを決められません。' };
  const plane: ResolvedPlane = { origin: resolved.point, normal: basis.normal, axisU: basis.x,
    axisV: [basis.normal[1] * basis.x[2] - basis.normal[2] * basis.x[1],
      basis.normal[2] * basis.x[0] - basis.normal[0] * basis.x[2], basis.normal[0] * basis.x[1] - basis.normal[1] * basis.x[0]] };
  return resolvePlaneSpec({ kind: 'workPlane', planeId: 'resolved-face', offset: expression.value },
    { ...contextForPoints([]), workPlane: (id) => id === 'resolved-face' ? plane : null });
}
