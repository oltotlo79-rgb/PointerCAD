/**
 * E 形止め輪の簡略形状。内径 d・外径 D・厚さ t の輪を Z 軸の向きに作り、+X の側から切口幅 H の帯
 * (|y| < H / 2、x > 0)を切り取って口を開ける。三つ爪の形・角の丸みは入れない。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../../../part/createPartDocument.js';
import type { PartDocument, PrimitiveFeature } from '../../../part/types.js';
import { appendBoolean, appendRing, origin, withName } from '../../standard/partPrimitives.js';

export interface RetainingRingDimensions {
  readonly innerDiameter: number;
  readonly outerDiameter: number;
  /** 切口幅 H。 */
  readonly openingWidth: number;
  readonly thickness: number;
}

function dimensionsValid(dims: RetainingRingDimensions): boolean {
  return [dims.innerDiameter, dims.outerDiameter, dims.openingWidth, dims.thickness].every((value) => Number.isFinite(value) && value > 0)
    && dims.innerDiameter < dims.outerDiameter && dims.openingWidth < dims.innerDiameter;
}

export function buildRetainingRingPart(dims: RetainingRingDimensions, name: string): PartDocument | null {
  if (!dimensionsValid(dims)) return null;
  const ring = appendRing(createEmptyPartDocument(), dims.innerDiameter / 2, dims.outerDiameter / 2, dims.thickness);
  const length = dims.outerDiameter / 2 + dims.thickness;
  const created = createPrimitiveFeature(ring.document, 'box', origin(length / 2, 0, dims.thickness / 2));
  const box: PrimitiveFeature = { ...created, shape: { kind: 'box', sizeX: expressionValueFromNumber(length),
    sizeY: expressionValueFromNumber(dims.openingWidth), sizeZ: expressionValueFromNumber(dims.thickness * 2) } };
  const cut = appendBoolean(appendSolid(ring.document, box), 'subtract', ring.featureId, box.id);
  return withName(cut.document, name);
}

/** 半径 R の円のうち、|y| < h かつ x > 0 の部分の面積(h < R)。 */
function stripArea(radius: number, half: number): number {
  return half * Math.sqrt(radius ** 2 - half ** 2) + radius ** 2 * Math.asin(half / radius);
}

/** 形の台本どおりの体積(輪 − 切口の帯、mm³)。 */
export function retainingRingVolume(dims: RetainingRingDimensions): number | null {
  if (!dimensionsValid(dims)) return null;
  const inner = dims.innerDiameter / 2;
  const outer = dims.outerDiameter / 2;
  const half = dims.openingWidth / 2;
  return dims.thickness * (Math.PI * (outer ** 2 - inner ** 2) - (stripArea(outer, half) - stripArea(inner, half)));
}
