/**
 * 六角穴付き止めねじ(くぼみ先・平先・棒先・とがり先)の簡略形状。
 * 軸(呼び径 d)を z = 0 から置き、上面(z = 0)から二面幅 s・深さ t の六角穴を掘る。外ねじは軸の全長に簡略の表し方で付ける。
 * - くぼみ先・平先: 軸は長さ ℓ の円柱だけ(先のくぼみ・面取りは入れない。くぼみの径 dz・先の径 dp は行の寸法として持つ)。
 * - 棒先: 軸は長さ ℓ − z、その先に径 dp・長さ z の円柱(棒先の丸みは入れない)。
 * - とがり先: 軸は長さ ℓ − h、その先に径 d から先の径 dt へ細くなる円すい台。円すいの角度 γ と d・dt から
 *   h = (d − dt) / 2 / tan(γ / 2) とする(規格の γ は谷の径より先の部分に当てる物だが、谷の径は資料に数が無いので、
 *   円すいの面を外径まで延ばした形にする)。
 * 六角穴の口元の丸み・面取り、キリ加工の底は入れない。
 */
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';

import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../../../part/createPartDocument.js';
import type { PartDocument, PrimitiveFeature } from '../../../part/types.js';
import {
  appendBoolean, appendCylinder, appendExternalThread, appendExtrude, origin, regularPolygonProfile, withName,
} from '../../standard/partPrimitives.js';

/** 先の形(棒先は径と長さ、とがり先は先の径と円すいの角度)。 */
export type SetScrewPoint =
  | { readonly kind: 'plain' }
  | { readonly kind: 'dog'; readonly diameter: number; readonly length: number }
  | { readonly kind: 'cone'; readonly tipDiameter: number; readonly angleDegrees: number };

export interface SetScrewDimensions {
  /** ねじの呼び(例 M3)。 */
  readonly designation: string;
  /** 呼び径 d。 */
  readonly nominalDiameter: number;
  /** 並目のピッチ P。 */
  readonly pitch: number;
  /** 六角穴の二面幅 s(呼び)。 */
  readonly socketWidth: number;
  /** 六角穴の深さ t(最小。長さで 1 欄・2 欄を選んだ後の値)。 */
  readonly socketDepth: number;
  readonly point: SetScrewPoint;
}

/** 先の部分の長さ(平らな先は 0、棒先は z、とがり先は円すい台の高さ)。 */
function pointLength(dims: SetScrewDimensions): number {
  const point = dims.point;
  if (point.kind === 'plain') return 0;
  if (point.kind === 'dog') return point.length;
  return (dims.nominalDiameter - point.tipDiameter) / 2 / Math.tan(point.angleDegrees * Math.PI / 360);
}

function pointValid(dims: SetScrewDimensions): boolean {
  const point = dims.point;
  if (point.kind === 'plain') return true;
  if (point.kind === 'dog') {
    return [point.diameter, point.length].every((value) => Number.isFinite(value) && value > 0) && point.diameter < dims.nominalDiameter;
  }
  return Number.isFinite(point.tipDiameter) && point.tipDiameter > 0 && point.tipDiameter < dims.nominalDiameter
    && Number.isFinite(point.angleDegrees) && point.angleDegrees > 0 && point.angleDegrees < 180;
}

/** 軸(先を除く)の長さ。寸法が正しくない、または軸が六角穴より短い時は null。 */
function bodyLength(dims: SetScrewDimensions, length: number): number | null {
  const valid = [dims.nominalDiameter, dims.pitch, dims.socketWidth, dims.socketDepth, length]
    .every((value) => Number.isFinite(value) && value > 0) && dims.socketWidth < dims.nominalDiameter && pointValid(dims);
  if (!valid) return null;
  const body = length - pointLength(dims);
  return body > dims.socketDepth ? body : null;
}

/** 軸の先に棒先・とがり先を足して和で 1 つにする(平らな先は軸のまま)。 */
function appendPoint(document: PartDocument, dims: SetScrewDimensions, shaftId: string, body: number): { readonly document: PartDocument;
  readonly id: string; } {
  const point = dims.point;
  if (point.kind === 'plain') return { document, id: shaftId };
  let added: { readonly document: PartDocument; readonly feature: PrimitiveFeature };
  if (point.kind === 'dog') {
    added = appendCylinder(document, point.diameter / 2, expressionValueFromNumber(point.length), body);
  } else {
    const created = createPrimitiveFeature(document, 'cone', origin(0, 0, body));
    const feature: PrimitiveFeature = { ...created, shape: { kind: 'cone',
      bottomRadius: expressionValueFromNumber(dims.nominalDiameter / 2), topRadius: expressionValueFromNumber(point.tipDiameter / 2),
      height: expressionValueFromNumber(pointLength(dims)) } };
    added = { document: appendSolid(document, feature), feature };
  }
  const union = appendBoolean(added.document, 'union', shaftId, added.feature.id);
  return { document: union.document, id: union.feature.id };
}

export function buildSetScrewPart(dims: SetScrewDimensions, length: ExpressionValue, name: string): PartDocument | null {
  const body = bodyLength(dims, length.value);
  if (body === null) return null;
  const bodyValue = dims.point.kind === 'plain' ? length : expressionValueFromNumber(body);
  const shaft = appendCylinder(createEmptyPartDocument(), dims.nominalDiameter / 2, bodyValue);
  const threaded = appendExternalThread(shaft.document, shaft.feature, { nominal: dims.designation, pitch: dims.pitch,
    series: 'coarse', shaftLength: bodyValue, threadLength: body });
  const united = appendPoint(threaded.document, dims, threaded.feature.id, body);
  const socket = regularPolygonProfile(united.document, 6, dims.socketWidth / 2);
  const tool = appendExtrude(socket.document, socket.profile, expressionValueFromNumber(dims.socketDepth));
  return withName(appendBoolean(tool.document, 'subtract', united.id, tool.feature.id).document, name);
}

/** 形の台本どおりの体積(軸 + 先 − 六角穴、mm³)。作れない時は null。 */
export function setScrewVolume(dims: SetScrewDimensions, length: number): number | null {
  const body = bodyLength(dims, length);
  if (body === null) return null;
  const hexagonArea = 6 * (dims.socketWidth / 2) ** 2 * Math.tan(Math.PI / 6);
  return Math.PI * (dims.nominalDiameter / 2) ** 2 * body + pointVolume(dims) - hexagonArea * dims.socketDepth;
}

function pointVolume(dims: SetScrewDimensions): number {
  const point = dims.point;
  if (point.kind === 'plain') return 0;
  if (point.kind === 'dog') return Math.PI * (point.diameter / 2) ** 2 * point.length;
  const big = dims.nominalDiameter / 2;
  const small = point.tipDiameter / 2;
  return Math.PI * pointLength(dims) / 3 * (big ** 2 + big * small + small ** 2);
}
