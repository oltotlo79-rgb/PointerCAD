/** 面取りの欄と決め方を、既存の値と既定値の規約に従って書き戻す。 */
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  DEFAULT_CHAMFER_ANGLE_DEGREES,
  DEFAULT_CHAMFER_DISTANCE_MM,
  type ChamferFeature,
  type ChamferSize,
  type SolidFeature,
} from '@pointercad/model';
import type { SolidFieldKey } from './solidPropertyContracts.js';

export function setChamferField(
  feature: ChamferFeature,
  key: SolidFieldKey,
  value: ExpressionValue,
): SolidFeature {
  switch (feature.size.kind) {
    case 'equal':
      return key === 'chamferDistance' ? { ...feature, size: { kind: 'equal', distance: value } } : feature;
    case 'twoDistances':
      if (key === 'chamferDistance') {
        return { ...feature, size: { ...feature.size, distance1: value } };
      }
      if (key === 'chamferDistance2') {
        return { ...feature, size: { ...feature.size, distance2: value } };
      }
      return feature;
    case 'distanceAngle':
      if (key === 'chamferDistance') {
        return { ...feature, size: { ...feature.size, distance: value } };
      }
      if (key === 'chamferAngle') {
        return { ...feature, size: { ...feature.size, angle: value } };
      }
      return feature;
  }
}

/** もとの決め方から距離(1つ目)を引き継ぎ、2つ目は既定値で作り直す(§0.a-0.18)。 */
function convertChamferSize(size: ChamferSize, kind: ChamferSize['kind']): ChamferSize {
  const distance = size.kind === 'twoDistances' ? size.distance1 : size.distance;
  switch (kind) {
    case 'equal':
      return { kind: 'equal', distance };
    case 'twoDistances':
      return {
        kind: 'twoDistances',
        distance1: distance,
        distance2: expressionValueFromNumber(DEFAULT_CHAMFER_DISTANCE_MM),
      };
    case 'distanceAngle':
      return {
        kind: 'distanceAngle',
        distance,
        angle: expressionValueFromNumber(DEFAULT_CHAMFER_ANGLE_DEGREES),
      };
  }
}

/** C面取りの決め方を変える。C面取り以外・同じ決め方なら同じものを返す。 */
export function setChamferMode(feature: SolidFeature, kind: ChamferSize['kind']): SolidFeature {
  if (feature.kind !== 'chamfer' || feature.size.kind === kind) {
    return feature;
  }
  return { ...feature, size: convertChamferSize(feature.size, kind) };
}
