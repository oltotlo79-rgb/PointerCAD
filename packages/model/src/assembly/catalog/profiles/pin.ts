/**
 * ピン(円柱)の形。径 d・長さ L の円柱を Z 軸の向きに作る(簡略形状: 両端の面取り c は形に入れない)。
 * 面取りを入れないので、どの正の長さでも形が成り立つ(長さの範囲は族の指定が決める)。
 */
import type { ExpressionValue } from '@pointercad/expression';

import { createEmptyPartDocument } from '../../../part/createPartDocument.js';
import type { PartDocument } from '../../../part/types.js';
import { appendCylinder, withName } from '../../standard/partPrimitives.js';

export function buildPinPart(diameter: number, length: ExpressionValue, name: string): PartDocument | null {
  if (!(Number.isFinite(diameter) && diameter > 0 && Number.isFinite(length.value) && length.value > 0)) return null;
  return withName(appendCylinder(createEmptyPartDocument(), diameter / 2, length).document, name);
}

/** 形の台本どおりの体積(mm³)。 */
export function pinVolume(diameter: number, length: number): number | null {
  return Number.isFinite(diameter) && diameter > 0 && Number.isFinite(length) && length > 0
    ? Math.PI * (diameter / 2) ** 2 * length : null;
}
