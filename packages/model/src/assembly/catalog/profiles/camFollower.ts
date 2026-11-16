/**
 * カムフォロア(スタッド形)の形。外輪の円柱(外径 D・幅 C)と、スタッドの円柱(径 d・外輪の面から全長 B1)を
 * Z 軸の向きに重ね、和で 1 つにする(簡略形状: 側板・ころ・油穴・ねじ山は入れない)。
 * スタッドは外輪の中を通して z=0 から作り(外輪と重ねて和を取る。面だけで接する和を避ける)、
 * 体積は 外輪 + 外輪の外に出たスタッド(長さ B1 − C)になる。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import { createEmptyPartDocument } from '../../../part/createPartDocument.js';
import type { PartDocument } from '../../../part/types.js';
import { appendBoolean, appendCylinder, withName } from '../../standard/partPrimitives.js';

export interface CamFollowerDimensions {
  /** 外輪の外径 D。 */
  readonly outsideDiameter: number;
  /** 外輪の幅 C。 */
  readonly ringWidth: number;
  /** スタッドの径 d。 */
  readonly studDiameter: number;
  /** 全長 B1(外輪の面からスタッドの端まで)。 */
  readonly overallLength: number;
}

/** 形が作れる寸法か(正、d < D、C < B1)。 */
export function camFollowerDimensionsValid(dims: CamFollowerDimensions): boolean {
  return [dims.outsideDiameter, dims.ringWidth, dims.studDiameter, dims.overallLength]
    .every((value) => Number.isFinite(value) && value > 0)
    && dims.studDiameter < dims.outsideDiameter && dims.ringWidth < dims.overallLength;
}

export function buildCamFollowerPart(dims: CamFollowerDimensions, name: string): PartDocument | null {
  if (!camFollowerDimensionsValid(dims)) return null;
  const ring = appendCylinder(createEmptyPartDocument(), dims.outsideDiameter / 2,
    expressionValueFromNumber(dims.ringWidth));
  const stud = appendCylinder(ring.document, dims.studDiameter / 2, expressionValueFromNumber(dims.overallLength));
  const joined = appendBoolean(stud.document, 'union', ring.feature.id, stud.feature.id);
  return withName(joined.document, name);
}

/** 形の台本どおりの体積(mm³)。 */
export function camFollowerVolume(dims: CamFollowerDimensions): number | null {
  if (!camFollowerDimensionsValid(dims)) return null;
  return Math.PI * (dims.outsideDiameter / 2) ** 2 * dims.ringWidth
    + Math.PI * (dims.studDiameter / 2) ** 2 * (dims.overallLength - dims.ringWidth);
}
