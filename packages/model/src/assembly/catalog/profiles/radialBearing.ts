/**
 * 呼び番号を持つラジアル転がり軸受の簡略形状。今の深溝玉軸受(`buildStandardPart.ts` の `buildBearing`)と同じ割合で、
 * 内径 d・外径 D・幅 B の間に、内輪・転動体の帯・外輪の 3 つの輪を Z 軸の向きに作る
 * (接触角・面取り・保持器・シールは入れない。輪どうしは離して置き、和を取らない)。
 */
import { createEmptyPartDocument } from '../../../part/createPartDocument.js';
import type { PartDocument } from '../../../part/types.js';
import { appendRing, withName } from '../../standard/partPrimitives.js';

export interface RadialBearingDimensions {
  readonly boreDiameter: number;
  readonly outsideDiameter: number;
  readonly width: number;
}

/** 内輪・外輪の肉厚(径の方向の幅に対する割合)。 */
const RING_RATIO = 0.22;
/** 転動体の帯の内外の端(内径・外径からの、径の方向の幅に対する割合)。 */
const BAND_RATIO = 0.38;

/** [内半径, 外半径] の 3 つの輪(内輪・転動体の帯・外輪)。 */
function ringRadii(dims: RadialBearingDimensions): readonly (readonly [number, number])[] {
  const inner = dims.boreDiameter / 2;
  const outer = dims.outsideDiameter / 2;
  const radial = outer - inner;
  return [[inner, inner + radial * RING_RATIO], [inner + radial * BAND_RATIO, outer - radial * BAND_RATIO],
    [outer - radial * RING_RATIO, outer]];
}

function dimensionsValid(dims: RadialBearingDimensions): boolean {
  return [dims.boreDiameter, dims.outsideDiameter, dims.width].every((value) => Number.isFinite(value) && value > 0)
    && dims.boreDiameter < dims.outsideDiameter;
}

export function buildRadialBearingPart(dims: RadialBearingDimensions, name: string): PartDocument | null {
  if (!dimensionsValid(dims)) return null;
  const document = ringRadii(dims).reduce((current, [inner, outer]) => appendRing(current, inner, outer, dims.width).document,
    createEmptyPartDocument());
  return withName(document, name);
}

/** 形の台本どおりの体積(3 つの輪の和、mm³)。 */
export function radialBearingVolume(dims: RadialBearingDimensions): number | null {
  if (!dimensionsValid(dims)) return null;
  return ringRadii(dims).reduce((sum, [inner, outer]) => sum + Math.PI * (outer ** 2 - inner ** 2) * dims.width, 0);
}
