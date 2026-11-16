/**
 * 圧縮コイルばねの形。今のばねのフィーチャー(`SpringFeature`、FR-414)で、Z 軸の向きの右巻きのらせんを作る
 * (簡略形状: 座巻き・端面の研削は入れない。今のばねのフィーチャーが座巻きを作らないため)。
 *
 * 入れる寸法は 線径 d・コイル平均径 D・自由長 L0・総巻数 Nt。らせん経路の軸方向の長さは L0 − d(線径のぶんを除く。
 * `SpringFeature.length` の決まり)、ピッチは (L0 − d) / Nt。
 * 形が成り立つ条件: 全て正、d < D(内径が正)、ピッチ > d(隣の巻きが重ならない)。強度・ばね定数は扱わない。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import { appendSolid, createEmptyPartDocument, nextSolidId, nextSolidName } from '../../../part/createPartDocument.js';
import type { PartDocument, SpringFeature } from '../../../part/types.js';
import { centerPoint, withName } from '../../standard/partPrimitives.js';

export interface CompressionSpringDimensions {
  readonly wireDiameter: number;
  readonly meanDiameter: number;
  readonly freeLength: number;
  readonly totalCoils: number;
}

/** らせんの軸方向の長さとピッチ。形が成り立たない時は null。 */
export function compressionSpringHelix(dims: CompressionSpringDimensions): { readonly length: number; readonly pitch: number } | null {
  const values = [dims.wireDiameter, dims.meanDiameter, dims.freeLength, dims.totalCoils];
  if (!values.every((value) => Number.isFinite(value) && value > 0) || dims.wireDiameter >= dims.meanDiameter) return null;
  const length = dims.freeLength - dims.wireDiameter;
  const pitch = length / dims.totalCoils;
  return length > 0 && pitch > dims.wireDiameter ? { length, pitch } : null;
}

export function buildCompressionSpringPart(dims: CompressionSpringDimensions, name: string): PartDocument | null {
  const helix = compressionSpringHelix(dims);
  if (helix === null) return null;
  const center = centerPoint(createEmptyPartDocument());
  const document = center.document;
  const feature: SpringFeature = {
    id: nextSolidId(document, 'spring'),
    name: nextSolidName(document, 'spring'),
    suppressed: false,
    kind: 'spring',
    origin: { sketchId: document.activeSketchId, pointFeatureId: center.point.id },
    axis: { kind: 'world', axis: 'z' },
    tiltAngle: expressionValueFromNumber(0),
    tiltAzimuth: expressionValueFromNumber(0),
    length: expressionValueFromNumber(helix.length),
    pitch: expressionValueFromNumber(helix.pitch),
    turns: expressionValueFromNumber(dims.totalCoils),
    derived: 'pitch',
    coilDiameter: expressionValueFromNumber(dims.meanDiameter),
    wireDiameter: expressionValueFromNumber(dims.wireDiameter),
    handedness: 'right',
  };
  return withName(appendSolid(document, feature), name);
}

/** 形の台本どおりの体積(mm³): 線の断面積 × らせん経路の長さ(Nt 巻き × 1 巻きの長さ √((πD)² + ピッチ²))。 */
export function compressionSpringVolume(dims: CompressionSpringDimensions): number | null {
  const helix = compressionSpringHelix(dims);
  if (helix === null) return null;
  return Math.PI * (dims.wireDiameter / 2) ** 2 * dims.totalCoils * Math.hypot(Math.PI * dims.meanDiameter, helix.pitch);
}
