/**
 * 割りピンの簡略形状。頭(輪の部分)を外径 c・長さ b の円柱で z = −b〜0 に、脚を径 d・長さ ℓ の円柱で z = 0 から置き、
 * 和で 1 つにする(輪の穴・脚の割れ目・先の形は入れない)。
 */
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';

import { createEmptyPartDocument } from '../../../part/createPartDocument.js';
import type { PartDocument } from '../../../part/types.js';
import { appendBoolean, appendCylinder, withName } from '../../standard/partPrimitives.js';

export interface SplitPinDimensions {
  /** 脚の径 d。 */
  readonly diameter: number;
  /** 頭の外径 c。 */
  readonly headDiameter: number;
  /** 頭の長さ b(約)。 */
  readonly headLength: number;
}

function dimensionsValid(dims: SplitPinDimensions, length: number): boolean {
  return [dims.diameter, dims.headDiameter, dims.headLength, length].every((value) => Number.isFinite(value) && value > 0)
    && dims.diameter < dims.headDiameter;
}

export function buildSplitPinPart(dims: SplitPinDimensions, length: ExpressionValue, name: string): PartDocument | null {
  if (!dimensionsValid(dims, length.value)) return null;
  const head = appendCylinder(createEmptyPartDocument(), dims.headDiameter / 2, expressionValueFromNumber(dims.headLength),
    -dims.headLength);
  const leg = appendCylinder(head.document, dims.diameter / 2, length);
  return withName(appendBoolean(leg.document, 'union', head.feature.id, leg.feature.id).document, name);
}

/** 形の台本どおりの体積(頭の円柱 + 脚の円柱、mm³)。 */
export function splitPinVolume(dims: SplitPinDimensions, length: number): number | null {
  if (!dimensionsValid(dims, length)) return null;
  return Math.PI * (dims.headDiameter / 2) ** 2 * dims.headLength + Math.PI * (dims.diameter / 2) ** 2 * length;
}
