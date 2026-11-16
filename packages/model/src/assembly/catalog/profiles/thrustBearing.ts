/**
 * 単式スラスト玉軸受(平面座形)の簡略形状。Z 軸の向きに、下から軸軌道盤(内径 d・外径 d1)、玉の帯、
 * ハウジング軌道盤(内径 D1・外径 D)の 3 つの輪を重ねる(全高 T)。軌道盤の厚さと玉の帯の径は資料に無いので、
 * 寸法として名乗らない割合で描く(軌道盤は全高の 0.3 ずつ、玉の帯は全高の 0.4 で、径はラジアル軸受の玉の帯と同じ割合)。
 * 軌道溝・面取り・保持器は入れない。輪どうしは面で接するだけで、和を取らない。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import { createEmptyPartDocument } from '../../../part/createPartDocument.js';
import type { PartDocument } from '../../../part/types.js';
import { appendBoolean, appendCylinder, withName } from '../../standard/partPrimitives.js';

export interface ThrustBearingDimensions {
  /** 軸軌道盤の内径 d。 */
  readonly boreDiameter: number;
  /** ハウジング軌道盤の外径 D。 */
  readonly outsideDiameter: number;
  /** 全高 T。 */
  readonly height: number;
  /** 軸軌道盤の外径 d1(最大)。 */
  readonly shaftWasherOutsideDiameter: number;
  /** ハウジング軌道盤の内径 D1(最小)。 */
  readonly housingWasherBoreDiameter: number;
}

/** 軌道盤の厚さ(全高に対する割合)。 */
const WASHER_RATIO = 0.3;
/** 玉の帯の内外の端(内径・外径からの、径の方向の幅に対する割合)。 */
const BAND_RATIO = 0.38;

interface Layer {
  readonly inner: number;
  readonly outer: number;
  readonly z: number;
  readonly height: number;
}

/** 下から軸軌道盤・玉の帯・ハウジング軌道盤(半径と高さ)。 */
function layers(dims: ThrustBearingDimensions): readonly Layer[] {
  const washer = dims.height * WASHER_RATIO;
  const inner = dims.boreDiameter / 2;
  const outer = dims.outsideDiameter / 2;
  const radial = outer - inner;
  return [
    { inner, outer: dims.shaftWasherOutsideDiameter / 2, z: 0, height: washer },
    { inner: inner + radial * BAND_RATIO, outer: outer - radial * BAND_RATIO, z: washer, height: dims.height - 2 * washer },
    { inner: dims.housingWasherBoreDiameter / 2, outer, z: dims.height - washer, height: washer },
  ];
}

function dimensionsValid(dims: ThrustBearingDimensions): boolean {
  const values = [dims.boreDiameter, dims.outsideDiameter, dims.height, dims.shaftWasherOutsideDiameter,
    dims.housingWasherBoreDiameter];
  return values.every((value) => Number.isFinite(value) && value > 0)
    && dims.boreDiameter < dims.shaftWasherOutsideDiameter && dims.shaftWasherOutsideDiameter <= dims.outsideDiameter
    && dims.boreDiameter < dims.housingWasherBoreDiameter && dims.housingWasherBoreDiameter < dims.outsideDiameter;
}

function appendLayer(document: PartDocument, layer: Layer): PartDocument {
  const height = expressionValueFromNumber(layer.height);
  const outer = appendCylinder(document, layer.outer, height, layer.z);
  const inner = appendCylinder(outer.document, layer.inner, height, layer.z);
  return appendBoolean(inner.document, 'subtract', outer.feature.id, inner.feature.id).document;
}

export function buildThrustBearingPart(dims: ThrustBearingDimensions, name: string): PartDocument | null {
  if (!dimensionsValid(dims)) return null;
  return withName(layers(dims).reduce(appendLayer, createEmptyPartDocument()), name);
}

/** 形の台本どおりの体積(3 つの輪の和、mm³)。 */
export function thrustBearingVolume(dims: ThrustBearingDimensions): number | null {
  if (!dimensionsValid(dims)) return null;
  return layers(dims).reduce((sum, layer) => sum + Math.PI * (layer.outer ** 2 - layer.inner ** 2) * layer.height, 0);
}
