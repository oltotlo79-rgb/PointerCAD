/**
 * 平行キー(両角)の簡略形状。幅 b(Y)・高さ h(Z)・長さ ℓ(X)の直方体を、原点から +X に置く(面取りは入れない)。
 */
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';

import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../../../part/createPartDocument.js';
import type { PartDocument, PrimitiveFeature } from '../../../part/types.js';
import { origin, withName } from '../../standard/partPrimitives.js';

export function buildKeyPart(width: number, height: number, length: ExpressionValue, name: string): PartDocument | null {
  if (![width, height, length.value].every((value) => Number.isFinite(value) && value > 0)) return null;
  const empty = createEmptyPartDocument();
  const created = createPrimitiveFeature(empty, 'box', origin(length.value / 2, 0, height / 2));
  const box: PrimitiveFeature = { ...created, shape: { kind: 'box', sizeX: length, sizeY: expressionValueFromNumber(width),
    sizeZ: expressionValueFromNumber(height) } };
  return withName(appendSolid(empty, box), name);
}

/** 形の台本どおりの体積(b × h × ℓ、mm³)。 */
export function keyVolume(width: number, height: number, length: number): number | null {
  return [width, height, length].every((value) => Number.isFinite(value) && value > 0) ? width * height * length : null;
}
