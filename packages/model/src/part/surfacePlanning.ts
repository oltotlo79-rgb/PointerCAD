import type { FailureText } from '../failureText.js';
import type { AxisFrame } from '../geometry/planeSpec.js';
import type { Vec3 } from '../sketch/vec3.js';
import type { FaceOrigin } from '../geometry/subShapeOrigin.js';
import { degreesToRadians } from '../sketch/planeMath.js';
import type { ResolvedCurve, SketchDocument } from '../sketch/types.js';
import { failWith, partErrorWith, type PartError, type PartErrorCode, type PlanOutcome } from './partPlanningResult.js';
import { curveProfileNormal, findResolvedCurves, isPositiveFinite, MAX_REVOLVE_DEGREES,
  type CurveProfileContext, type ResolvedPartSketch } from './resolvedPlanGeometry.js';
import type { SurfaceShapePlan } from './solidStepPlan.js';
import { isSameSubShape, subShapeKindOf } from './subShapeRef.js';
import type { RevolveAxis, SurfaceFeature, SurfaceOperation } from './types.js';

interface SurfacePlanContext extends CurveProfileContext {
  readonly axis: (axis: RevolveAxis) => AxisFrame | null;
  readonly direction: (direction: Vec3, reversed: boolean) => Vec3;
}

function surfaceError(featureId: string, code: PartErrorCode, key: string,
  parameters: FailureText['parameters'] = {}): PartError {
  return partErrorWith(featureId, code, { key, parameters });
}

function surfaceFail(featureId: string, code: PartErrorCode, key: string,
  parameters: FailureText['parameters'] = {}): PlanOutcome {
  return failWith(featureId, code, { key, parameters });
}

export const MIN_THRU_SECTIONS = 2;

export const THRU_SECTIONS_TOO_FEW_TEXT: FailureText = { key: 'partError.thruSections.tooFew', parameters: {} };


/** 曲面の作り方を解決した結果。`targetKey` は `face` / `offset` のときだけ入る。 */
interface SurfaceShapeOutcomeValue {
  readonly shape: SurfaceShapePlan;
  readonly targetKey: string | null;
}

type SurfaceShapeOutcome =
  | { readonly ok: true; readonly value: SurfaceShapeOutcomeValue }
  | { readonly ok: false; readonly error: PartError };

/**
 * 曲面の作り方 6 種(FR-428)を段の欄へ直す。
 *
 * **種類ごとに材料が違う**——押し出し・回転・平面・ロフトはスケッチの曲線、
 * 面・オフセットは立体の面の指紋である。前者は座標まで解けるが、後者は指紋のまま渡し、
 * 選び直しはカーネルが行う(罫線面の `solidFace` とまったく同じ扱い)。
 * **どの作り方でも対象を消費しない**ので `consumed` を見ない。
 */
/** A single saved open arc is named independently of straight-line and closed-region producers. */
function surfaceArcOrigin(sketch: SketchDocument | undefined, ids: readonly string[],
  curves: readonly ResolvedCurve[]): Extract<SurfaceShapePlan, { kind: 'extrude' }>['curveProfileOrigin'] {
  if (sketch === undefined || ids.length !== 1 || curves.length !== 1) return undefined;
  const saved = sketch.features.filter(feature => feature.id === ids[0]), curve = curves[0];
  if (saved.length !== 1 || saved[0].kind !== 'arc' || saved[0].construction
    || curve.kind !== 'arc' || curve.featureId !== ids[0]
    || !Number.isFinite(curve.startAngle) || !Number.isFinite(curve.endAngle)
    || curve.startAngle < 0 || curve.endAngle < 0
    || curve.startAngle >= 2 * Math.PI || curve.endAngle >= 2 * Math.PI
    || curve.startAngle === curve.endAngle) return undefined;
  return { sketchId: sketch.id, curveFeatureId: ids[0], role: 'whole-curve' };
}

/** Open profiles have saved line owners, never a fabricated closed-face owner. */
function surfaceLineOrigins(sketch: SketchDocument | undefined, ids: readonly string[],
  curves: readonly ResolvedCurve[]): Extract<SurfaceShapePlan, { kind: 'extrude' }>['profileOrigins'] {
  if (sketch === undefined || ids.length < 1 || ids.length > 32 || curves.length !== ids.length
    || new Set(ids).size !== ids.length) return undefined;
  const anchors: Extract<FaceOrigin, { readonly kind: 'surface-side' }>['profile'][] = [];
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index], curve = curves[index];
    const saved = sketch.features.filter(feature => feature.id === id);
    if (saved.length !== 1 || saved[0].kind !== 'line' || saved[0].construction
      || curve.kind !== 'segment' || curve.featureId !== id) return undefined;
    anchors.push({ sketchId: sketch.id, lineFeatureId: id, role: 'whole-line' });
  }
  return anchors;
}

function resolveSurfaceShape(
  featureId: string,
  operation: Exclude<SurfaceOperation, { kind: 'offsetBody' | 'blend' }>,
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
  context: SurfacePlanContext,
): SurfaceShapeOutcome {
  switch (operation.kind) {
    case 'extrude': {
      const profile = findResolvedCurves(sketches, operation.profile);
      if (profile === null) {
        return {
          ok: false,
          error: surfaceError(featureId, 'missingProfile', 'partError.surface.missingProfile', { sketchId: operation.profile.sketchId, curveIds: operation.profile.curveIds.join(', ') }),
        };
      }
      // 掃く向きは輪郭の平面の法線(リブと同じ引き方。線分 1 本なら作図面から取る)。
      const normal = curveProfileNormal(operation.profile, profile, context);
      if (normal === null) {
        return {
          ok: false,
          error: surfaceError(featureId, 'notPlanar', 'partError.surface.notPlanar'),
        };
      }
      const distance = operation.distance.value;
      if (!isPositiveFinite(distance)) {
        return {
          ok: false,
          error: surfaceError(featureId, 'invalidValue', 'partError.surface.extrudeDistance'),
        };
      }
      const curveProfileOrigin = surfaceArcOrigin(
        context.sketchDocuments.find(sketch => sketch.id === operation.profile.sketchId),
        operation.profile.curveIds, profile);
      const profileOrigins = surfaceLineOrigins(
        context.sketchDocuments.find(sketch => sketch.id === operation.profile.sketchId),
        operation.profile.curveIds, profile);
      return {
        ok: true,
        value: {
          shape: {
            kind: 'extrude',
            profile,
            ...(profileOrigins === undefined ? {} : { profileOrigins }),
            ...(curveProfileOrigin === undefined ? {} : { curveProfileOrigin }),
            direction: context.direction(normal, operation.reversed),
            distance,
          },
          targetKey: null,
        },
      };
    }
    case 'revolve': {
      const profile = findResolvedCurves(sketches, operation.profile);
      if (profile === null) {
        return {
          ok: false,
          error: surfaceError(featureId, 'missingProfile', 'partError.surface.missingProfile', { sketchId: operation.profile.sketchId, curveIds: operation.profile.curveIds.join(', ') }),
        };
      }
      const degrees = operation.angle.value;
      if (!Number.isFinite(degrees) || degrees <= 0 || degrees > MAX_REVOLVE_DEGREES) {
        return {
          ok: false,
          error: surfaceError(
            featureId,
            'invalidValue',
            'partError.revolve.angle',
          ),
        };
      }
      const frame = context.axis(operation.axis);
      if (frame === null) {
        return {
          ok: false,
          error: surfaceError(featureId, 'missingProfile', 'partError.revolve.missingAxis'),
        };
      }
      return {
        ok: true,
        value: {
          shape: {
            kind: 'revolve',
            profile,
            axisOrigin: frame.origin,
            axisDirection: context.direction(frame.direction, operation.reversed),
            angle: degreesToRadians(degrees),
          },
          targetKey: null,
        },
      };
    }
    case 'planar': {
      const profile = findResolvedCurves(sketches, operation.profile);
      if (profile === null) {
        return {
          ok: false,
          error: surfaceError(featureId, 'missingProfile', 'partError.surface.missingProfile', { sketchId: operation.profile.sketchId, curveIds: operation.profile.curveIds.join(', ') }),
        };
      }
      // Same saved-line owner rule as the open-profile extrusion (non-construction line features only);
      // circles, arcs and splines get no anchors and stay untracked in the kernel.
      const profileOrigins = surfaceLineOrigins(
        context.sketchDocuments.find(sketch => sketch.id === operation.profile.sketchId),
        operation.profile.curveIds, profile);
      return { ok: true, value: { shape: { kind: 'planar', profile,
        ...(profileOrigins === undefined ? {} : { profileOrigins }) }, targetKey: null } };
    }
    case 'loft': {
      if (operation.sections.length < MIN_THRU_SECTIONS) {
        return {
          ok: false,
          error: partErrorWith(featureId, 'missingProfile', THRU_SECTIONS_TOO_FEW_TEXT),
        };
      }
      const sections: (readonly ResolvedCurve[])[] = [];
      for (const reference of operation.sections) {
        const curves = findResolvedCurves(sketches, reference);
        if (curves === null) {
          return {
            ok: false,
            error: surfaceError(featureId, 'missingProfile', 'partError.surface.missingProfile', { sketchId: reference.sketchId, curveIds: reference.curveIds.join(', ') }),
          };
        }
        sections.push(curves);
      }
      return {
        ok: true,
        value: { shape: { kind: 'loft', sections, ruled: operation.ruled }, targetKey: null },
      };
    }
    case 'face':
    case 'offset': {
      if (subShapeKindOf(operation.face) !== 'face') {
        return {
          ok: false,
          error: surfaceError(featureId, 'invalidValue', 'partError.surface.notFace', { bodyFeatureId: operation.face.bodyFeatureId, index: String(operation.face.index) }),
        };
      }
      const targetKey = bodyKeys.get(operation.targetFeatureId);
      if (targetKey === undefined) {
        return {
          ok: false,
          error: surfaceError(featureId, 'missingBody', 'partError.surface.missingBody', { bodyFeatureId: operation.targetFeatureId }),
        };
      }
      if (operation.kind === 'face') {
        // **消費しない**ので `consumed` は見ない。鍵は連鎖のために持つ。
        return {
          ok: true,
          value: { shape: { kind: 'face', face: operation.face }, targetKey },
        };
      }
      const distance = operation.distance.value;
      // 距離 0 では元の面と同じ形になる。
      if (!Number.isFinite(distance) || distance === 0) {
        return {
          ok: false,
          error: surfaceError(featureId, 'invalidValue', 'partError.surface.offsetZero'),
        };
      }
      return {
        ok: true,
        value: { shape: { kind: 'offset', face: operation.face, distance }, targetKey },
      };
    }
  }
}

function planBlend(featureId: string, operation: Extract<SurfaceOperation, { kind: 'blend' }>,
  bodyKeys: ReadonlyMap<string, string>): PlanOutcome {
  const { a, b, flipB } = operation;
  if (subShapeKindOf(a) !== 'edge' || subShapeKindOf(b) !== 'edge' || isSameSubShape(a, b)) {
    return surfaceFail(featureId, 'invalidValue', 'partError.surface.blendEdges');
  }
  const sourceA = bodyKeys.get(a.bodyFeatureId), sourceB = bodyKeys.get(b.bodyFeatureId);
  if (sourceA === undefined || sourceB === undefined) return surfaceFail(featureId, 'missingBody', 'partError.surface.missingBody');
  const weightA = operation.weightA.value, weightB = operation.weightB.value;
  if (![weightA, weightB].every(weight => Number.isFinite(weight) && weight > 0)) {
    return surfaceFail(featureId, 'invalidValue', 'partError.surface.blendWeights');
  }
  return { ok: true, plan: { kind: 'blend', a: { sourceKey: sourceA, query: a }, b: { sourceKey: sourceB, query: b },
    weightA, weightB, flipB } };
}

/**
 * 曲面(FR-428)。**閉じた立体ではなく面だけのボディ**を作る。
 * **どの作り方でも対象を消費しない**(面を貸した立体はそのまま画面に残る)。
 */
export function planSurface(
  feature: SurfaceFeature,
  sketches: readonly ResolvedPartSketch[],
  bodyKeys: ReadonlyMap<string, string>,
  context: SurfacePlanContext,
): PlanOutcome {
  if (feature.operation.kind === 'blend') return planBlend(feature.id, feature.operation, bodyKeys);
  if (feature.operation.kind === 'offsetBody') {
    const targetKey = bodyKeys.get(feature.operation.targetFeatureId);
    if (targetKey === undefined) return surfaceFail(feature.id, 'missingBody', 'partError.surface.missingBody', { bodyFeatureId: feature.operation.targetFeatureId });
    const distance = feature.operation.distance.value;
    if (!Number.isFinite(distance) || distance === 0) return surfaceFail(feature.id, 'invalidValue', 'partError.surface.offsetZero');
    return { ok: true, plan: { kind: 'offsetBody', targetKey, distance } };
  }
  const outcome = resolveSurfaceShape(feature.id, feature.operation, sketches, bodyKeys, context);
  if (!outcome.ok) {
    return outcome;
  }
  return {
    ok: true,
    plan: { kind: 'surface', shape: outcome.value.shape, targetKey: outcome.value.targetKey },
  };
}

