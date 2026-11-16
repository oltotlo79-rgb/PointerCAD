/**
 * O リングの形。内径 d1・太さ d2 の円の断面の輪(トーラス)を Z 軸の向きに、z = 0〜d2 に置く(簡略形状: ばり・許容差は入れない)。
 * 中心の円の半径は (d1 + d2) / 2、断面の半径は d2 / 2。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../../../part/createPartDocument.js';
import type { PartDocument, PrimitiveFeature } from '../../../part/types.js';
import { origin, withName } from '../../standard/partPrimitives.js';

export interface ORingDimensions {
  /** 内径 d1。 */
  readonly innerDiameter: number;
  /** 太さ d2。 */
  readonly crossSection: number;
}

function dimensionsValid(dims: ORingDimensions): boolean {
  return [dims.innerDiameter, dims.crossSection].every((value) => Number.isFinite(value) && value > 0);
}

export function buildORingPart(dims: ORingDimensions, name: string): PartDocument | null {
  if (!dimensionsValid(dims)) return null;
  const empty = createEmptyPartDocument();
  const created = createPrimitiveFeature(empty, 'torus', origin(0, 0, dims.crossSection / 2));
  const feature: PrimitiveFeature = { ...created, shape: { kind: 'torus',
    majorRadius: expressionValueFromNumber((dims.innerDiameter + dims.crossSection) / 2),
    minorRadius: expressionValueFromNumber(dims.crossSection / 2) } };
  return withName(appendSolid(empty, feature), name);
}

/** 形の台本どおりの体積(2π² R r²、mm³)。作れない時は null。 */
export function oRingVolume(dims: ORingDimensions): number | null {
  if (!dimensionsValid(dims)) return null;
  return 2 * Math.PI ** 2 * ((dims.innerDiameter + dims.crossSection) / 2) * (dims.crossSection / 2) ** 2;
}
