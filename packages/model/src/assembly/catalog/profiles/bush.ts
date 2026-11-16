/**
 * ブシュ(すべり軸受の管)の形。内径・外径・長さの管を Z 軸の向きに作る(簡略形状: 巻きの継ぎ目・面取り・層は入れない)。
 */
import { createEmptyPartDocument } from '../../../part/createPartDocument.js';
import type { PartDocument } from '../../../part/types.js';
import { appendRing, withName } from '../../standard/partPrimitives.js';

export interface BushDimensions {
  readonly innerDiameter: number;
  readonly outerDiameter: number;
  readonly length: number;
}

/** 形が作れる寸法か(正の長さ、内径 < 外径)。 */
export function bushDimensionsValid(dims: BushDimensions): boolean {
  return [dims.innerDiameter, dims.outerDiameter, dims.length].every((value) => Number.isFinite(value) && value > 0)
    && dims.innerDiameter < dims.outerDiameter;
}

export function buildBushPart(dims: BushDimensions, name: string): PartDocument | null {
  if (!bushDimensionsValid(dims)) return null;
  const ring = appendRing(createEmptyPartDocument(), dims.innerDiameter / 2, dims.outerDiameter / 2, dims.length);
  return withName(ring.document, name);
}

/** 形の台本どおりの体積(mm³)。 */
export function bushVolume(dims: BushDimensions): number | null {
  return bushDimensionsValid(dims)
    ? Math.PI * ((dims.outerDiameter / 2) ** 2 - (dims.innerDiameter / 2) ** 2) * dims.length : null;
}
