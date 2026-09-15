/** 曲面の方式と寸法を、表示処理に依存せず元の式と参照を保持して書き戻す。 */
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  DEFAULT_SURFACE_ANGLE_DEGREES, DEFAULT_SURFACE_DISTANCE_MM, DEFAULT_SURFACE_OFFSET_MM,
  type SurfaceFeature, type SurfaceOperation, type SolidFeature, type SketchCurveRef,
} from '@pointercad/model';
import type { SolidFieldKey } from './solidPropertyContracts.js';

export function setSurfaceField(
  feature: SurfaceFeature,
  key: SolidFieldKey,
  value: ExpressionValue,
): SolidFeature {
  const { operation } = feature;
  if (operation.kind === 'extrude' && key === 'surfaceDistance') {
    return { ...feature, operation: { ...operation, distance: value } };
  }
  if (operation.kind === 'revolve' && key === 'surfaceAngle') {
    return { ...feature, operation: { ...operation, angle: value } };
  }
  if (operation.kind === 'offset' && key === 'surfaceOffset') {
    return { ...feature, operation: { ...operation, distance: value } };
  }
  return feature;
}

export function setSurfaceOperationKind(feature: SolidFeature, value: string): SolidFeature {
  if (feature.kind !== 'surface') {
    return feature;
  }
  const { operation } = feature;
  if (operation.kind === 'extrude' || operation.kind === 'revolve' || operation.kind === 'planar') {
    const profile = surfaceProfileOf(operation);
    switch (value) {
      case 'extrude':
        return {
          ...feature,
          operation: {
            kind: 'extrude',
            profile,
            distance: expressionValueFromNumber(DEFAULT_SURFACE_DISTANCE_MM),
            reversed: false,
          },
        };
      case 'revolve':
        return {
          ...feature,
          operation: {
            kind: 'revolve',
            profile,
            axis: { kind: 'world', axis: 'z' },
            angle: expressionValueFromNumber(DEFAULT_SURFACE_ANGLE_DEGREES),
            reversed: false,
          },
        };
      case 'planar':
        return { ...feature, operation: { kind: 'planar', profile } };
      default:
        return feature;
    }
  }
  if (operation.kind === 'face' && value === 'offset') {
    return {
      ...feature,
      operation: {
        kind: 'offset',
        targetFeatureId: operation.targetFeatureId,
        face: operation.face,
        distance: expressionValueFromNumber(DEFAULT_SURFACE_OFFSET_MM),
      },
    };
  }
  if (operation.kind === 'offset' && value === 'face') {
    return {
      ...feature,
      operation: {
        kind: 'face',
        targetFeatureId: operation.targetFeatureId,
        face: operation.face,
      },
    };
  }
  return feature;
}

/** 輪郭から作る 3 つの作り方が共通して持つ輪郭。 */
function surfaceProfileOf(
  operation: Extract<SurfaceOperation, { kind: 'extrude' | 'revolve' | 'planar' }>,
): SketchCurveRef {
  return operation.profile;
}
