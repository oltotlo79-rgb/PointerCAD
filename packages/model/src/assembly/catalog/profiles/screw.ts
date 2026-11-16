/**
 * 十字穴付き小ねじ(なべ・皿)と六角穴付きボルトの簡略形状。
 * 小ねじは頭を z < 0、軸を z ≥ 0 に置き、和で 1 つにする。
 * なべ: 頭は外径 dk・高さ k の円柱(丸みは入れない)、軸は呼び径 d・長さ ℓ(ℓ は頭の下から)。
 * 皿: 頭は上面の径 dk から軸の径 d へ高さ k で細くなる円すい台、軸は長さ ℓ − k(ℓ は頭の上面から。皿の角度は dk と k から
 * 決まり、呼びの 90° にはしない)。十字穴・ねじ先の形は入れず、外ねじは軸の全長に簡略の表し方で付ける。
 */
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';

import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../../../part/createPartDocument.js';
import type { PartDocument, PrimitiveFeature } from '../../../part/types.js';
import {
  appendBoolean, appendCylinder, appendExternalThread, appendExtrude, origin, regularPolygonProfile, withName,
} from '../../standard/partPrimitives.js';

export interface ScrewDimensions {
  /** ねじの呼び(例 M3)。 */
  readonly designation: string;
  /** 呼び径 d。 */
  readonly nominalDiameter: number;
  /** 並目のピッチ P。 */
  readonly pitch: number;
  /** 頭の径 dk(呼び＝最大)。 */
  readonly headDiameter: number;
  /** 頭の高さ k(呼び＝最大)。 */
  readonly headHeight: number;
}

export type ScrewHead = 'pan' | 'countersunk';

function dimensionsValid(dims: ScrewDimensions): boolean {
  return [dims.nominalDiameter, dims.pitch, dims.headDiameter, dims.headHeight].every((value) => Number.isFinite(value) && value > 0)
    && dims.nominalDiameter < dims.headDiameter;
}

/** 軸の長さ。皿は呼び長さが頭を含むので k を引く。作れない(0 以下)時は null。 */
function shaftLength(head: ScrewHead, dims: ScrewDimensions, length: ExpressionValue): ExpressionValue | null {
  if (head === 'pan') return length.value > 0 ? length : null;
  const value = length.value - dims.headHeight;
  return value > 0 ? expressionValueFromNumber(value) : null;
}

function appendCountersunkHead(document: PartDocument, dims: ScrewDimensions): { readonly document: PartDocument;
  readonly feature: PrimitiveFeature; } {
  const created = createPrimitiveFeature(document, 'cone', origin(0, 0, -dims.headHeight));
  const feature: PrimitiveFeature = {
    ...created,
    shape: { kind: 'cone', bottomRadius: expressionValueFromNumber(dims.headDiameter / 2),
      topRadius: expressionValueFromNumber(dims.nominalDiameter / 2), height: expressionValueFromNumber(dims.headHeight) },
  };
  return { document: appendSolid(document, feature), feature };
}

export function buildScrewPart(head: ScrewHead, dims: ScrewDimensions, length: ExpressionValue, name: string): PartDocument | null {
  const shaft = shaftLength(head, dims, length);
  if (!dimensionsValid(dims) || shaft === null) return null;
  const headFeature = head === 'pan'
    ? appendCylinder(createEmptyPartDocument(), dims.headDiameter / 2, expressionValueFromNumber(dims.headHeight), -dims.headHeight)
    : appendCountersunkHead(createEmptyPartDocument(), dims);
  const body = appendCylinder(headFeature.document, dims.nominalDiameter / 2, shaft);
  const threaded = appendExternalThread(body.document, body.feature, { nominal: dims.designation, pitch: dims.pitch,
    series: 'coarse', shaftLength: shaft, threadLength: shaft.value });
  const united = appendBoolean(threaded.document, 'union', headFeature.feature.id, threaded.feature.id);
  return withName(united.document, name);
}

export interface SocketHeadDimensions extends ScrewDimensions {
  /** 六角穴の二面幅 s(呼び)。 */
  readonly socketWidth: number;
  /** 六角穴の深さ t(最小)。 */
  readonly socketDepth: number;
  /** ねじ部の長さ b(参考)。 */
  readonly threadLength: number;
}

function socketDimensionsValid(dims: SocketHeadDimensions): boolean {
  return dimensionsValid(dims) && [dims.socketWidth, dims.socketDepth, dims.threadLength].every((value) => Number.isFinite(value)
    && value > 0) && dims.socketWidth < dims.headDiameter && dims.socketDepth < dims.headHeight;
}

/**
 * 六角穴付きボルトの簡略形状。頭(外径 dk・高さ k の円柱)を z = 0〜k に置き、頭の上面(z = 0)から二面幅 s・深さ t の
 * 六角穴を掘り、軸(呼び径 d・長さ ℓ)を z = k から伸ばす。外ねじは軸の終わりの側から min(ℓ, b) を簡略の表し方で付ける。
 * 頭の面取り・ローレット・首下の丸み・ねじ先の形は入れない。
 */
export function buildSocketHeadScrewPart(dims: SocketHeadDimensions, length: ExpressionValue, name: string): PartDocument | null {
  if (!socketDimensionsValid(dims) || length.value <= 0) return null;
  const head = appendCylinder(createEmptyPartDocument(), dims.headDiameter / 2, expressionValueFromNumber(dims.headHeight));
  const body = appendCylinder(head.document, dims.nominalDiameter / 2, length, dims.headHeight);
  const threaded = appendExternalThread(body.document, body.feature, { nominal: dims.designation, pitch: dims.pitch,
    series: 'coarse', shaftLength: length, threadLength: Math.min(length.value, dims.threadLength), shaftBase: dims.headHeight });
  const united = appendBoolean(threaded.document, 'union', head.feature.id, threaded.feature.id);
  const socket = regularPolygonProfile(united.document, 6, dims.socketWidth / 2);
  const tool = appendExtrude(socket.document, socket.profile, expressionValueFromNumber(dims.socketDepth));
  return withName(appendBoolean(tool.document, 'subtract', united.feature.id, tool.feature.id).document, name);
}

/**
 * 六角穴付き皿ボルトの簡略形状。頭は上面の径 dk(理論寸法)から軸の径 d へ高さ k で細くなる円すい台を z = 0〜k に置き
 * (dk と k が規格の理論寸法なら皿の角度は 90°)、頭の上面(z = 0)から六角穴を掘り、軸(長さ ℓ − k。呼び長さ ℓ は頭を含む)を
 * z = k から伸ばす。外ねじは軸の終わりの側から min(ℓ − k, b)。頭の外周の面取りは入れない。ℓ が k 以下なら作らない。
 */
export function buildCountersunkSocketScrewPart(dims: SocketHeadDimensions, length: ExpressionValue, name: string): PartDocument | null {
  const shaftValue = length.value - dims.headHeight;
  if (!socketDimensionsValid(dims) || !(shaftValue > 0)) return null;
  const empty = createEmptyPartDocument();
  const created = createPrimitiveFeature(empty, 'cone', origin(0, 0, 0));
  const cone: PrimitiveFeature = { ...created, shape: { kind: 'cone', bottomRadius: expressionValueFromNumber(dims.headDiameter / 2),
    topRadius: expressionValueFromNumber(dims.nominalDiameter / 2), height: expressionValueFromNumber(dims.headHeight) } };
  const shaft = expressionValueFromNumber(shaftValue);
  const body = appendCylinder(appendSolid(empty, cone), dims.nominalDiameter / 2, shaft, dims.headHeight);
  const threaded = appendExternalThread(body.document, body.feature, { nominal: dims.designation, pitch: dims.pitch,
    series: 'coarse', shaftLength: shaft, threadLength: Math.min(shaftValue, dims.threadLength), shaftBase: dims.headHeight });
  const united = appendBoolean(threaded.document, 'union', cone.id, threaded.feature.id);
  const socket = regularPolygonProfile(united.document, 6, dims.socketWidth / 2);
  const tool = appendExtrude(socket.document, socket.profile, expressionValueFromNumber(dims.socketDepth));
  return withName(appendBoolean(tool.document, 'subtract', united.feature.id, tool.feature.id).document, name);
}

/** 六角穴付き皿ボルトの形の台本どおりの体積(円すい台 + 軸 − 六角穴、mm³)。作れない時は null。 */
export function countersunkSocketScrewVolume(dims: SocketHeadDimensions, length: number): number | null {
  const shaftValue = length - dims.headHeight;
  if (!socketDimensionsValid(dims) || !Number.isFinite(length) || !(shaftValue > 0)) return null;
  const big = dims.headDiameter / 2;
  const small = dims.nominalDiameter / 2;
  const hexagonArea = 6 * (dims.socketWidth / 2) ** 2 * Math.tan(Math.PI / 6);
  return Math.PI * dims.headHeight / 3 * (big ** 2 + big * small + small ** 2) + Math.PI * small ** 2 * shaftValue
    - hexagonArea * dims.socketDepth;
}

export interface HexBoltDimensions {
  readonly designation: string;
  readonly nominalDiameter: number;
  readonly pitch: number;
  /** 二面幅 s。 */
  readonly acrossFlats: number;
  /** 頭の高さ k。 */
  readonly headHeight: number;
}

function hexBoltValid(dims: HexBoltDimensions, length: number, threadLength: number): boolean {
  return [dims.nominalDiameter, dims.pitch, dims.acrossFlats, dims.headHeight, length, threadLength]
    .every((value) => Number.isFinite(value) && value > 0) && dims.nominalDiameter < dims.acrossFlats;
}

/**
 * 六角ボルトの簡略形状(今の規格部品の六角ボルトと同じ置き方)。頭は二面幅 s・高さ k の六角柱を z = −k〜0 に、
 * 軸(呼び径 d・長さ ℓ)を z = 0 から伸ばし、和で 1 つにする。外ねじは軸の終わりの側から min(ℓ, b)。面取り・座面は入れない。
 */
export function buildHexBoltPart(dims: HexBoltDimensions, length: ExpressionValue, threadLength: number, name: string): PartDocument | null {
  if (!hexBoltValid(dims, length.value, threadLength)) return null;
  const profile = regularPolygonProfile(createEmptyPartDocument(), 6, dims.acrossFlats / 2);
  const head = appendExtrude(profile.document, profile.profile, expressionValueFromNumber(dims.headHeight), true);
  const shaft = appendCylinder(head.document, dims.nominalDiameter / 2, length);
  const threaded = appendExternalThread(shaft.document, shaft.feature, { nominal: dims.designation, pitch: dims.pitch,
    series: 'coarse', shaftLength: length, threadLength: Math.min(length.value, threadLength) });
  return withName(appendBoolean(threaded.document, 'union', head.feature.id, threaded.feature.id).document, name);
}

/** 六角ボルトの形の台本どおりの体積(六角柱 + 軸、mm³)。作れない時は null。 */
export function hexBoltVolume(dims: HexBoltDimensions, length: number, threadLength: number): number | null {
  if (!hexBoltValid(dims, length, threadLength)) return null;
  return 6 * (dims.acrossFlats / 2) ** 2 * Math.tan(Math.PI / 6) * dims.headHeight + Math.PI * (dims.nominalDiameter / 2) ** 2 * length;
}

/** 六角穴付きボルトの形の台本どおりの体積(頭 + 軸 − 六角穴、mm³)。作れない時は null。 */
export function socketHeadScrewVolume(dims: SocketHeadDimensions, length: number): number | null {
  if (!socketDimensionsValid(dims) || !Number.isFinite(length) || length <= 0) return null;
  const hexagonArea = 6 * (dims.socketWidth / 2) ** 2 * Math.tan(Math.PI / 6);
  return Math.PI * (dims.headDiameter / 2) ** 2 * dims.headHeight + Math.PI * (dims.nominalDiameter / 2) ** 2 * length
    - hexagonArea * dims.socketDepth;
}

/** 形の台本どおりの体積(mm³)。作れない時は null。 */
export function screwVolume(head: ScrewHead, dims: ScrewDimensions, length: number): number | null {
  if (!Number.isFinite(length)) return null;
  const shaft = shaftLength(head, dims, expressionValueFromNumber(length));
  if (!dimensionsValid(dims) || shaft === null) return null;
  const big = dims.headDiameter / 2;
  const small = dims.nominalDiameter / 2;
  const headVolume = head === 'pan' ? Math.PI * big ** 2 * dims.headHeight
    : Math.PI * dims.headHeight / 3 * (big ** 2 + big * small + small ** 2);
  return headVolume + Math.PI * small ** 2 * shaft.value;
}
