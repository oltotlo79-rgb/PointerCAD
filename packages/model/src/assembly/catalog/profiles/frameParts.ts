/**
 * T スロットフレーム用の汎用の部品の簡略形状(E-04): 直角のブラケット・つなぎ板・T 溝用のナット。どれも寸法を式で入れる汎用の形で、
 * 規格や製造元の寸法ではない。面取り・座ぐり・位置決めの突起・丸みは入れない。
 * - 直角のブラケット: 作図面(xy)に L 形の断面(内の角を埋める直角三角形のリブ込み)を書いて幅 w だけ z へ押し出し、横の辺(y 向きの厚さ)と
 *   縦の辺(x 向きの厚さ)に 1 つずつ、幅の中央を通る円柱の穴を引く。
 * - つなぎ板: 長方形(中心が原点)に、長さの向きに中心で揃えた n 個の円の穴(内の輪)を書いて厚さ t だけ押し出す。
 * - T 溝用のナット: つばの直方体(l × wf × tf)と首の直方体(l × wn × (tf + hn)、底は z = 0)の和に、首の上面から通しのめねじ
 *   (下穴径は並目の谷の径、簡略の表し方)を開ける。めねじは長さの中央か、端の面から holeOffset。止めねじの穴(setScrew)は
 *   並目の谷の径の円柱を引いて表す(資料の部品の形の拡張。汎用の族は使わない)。
 */
import { exactExpressionValueFromNumber, expressionValueFromNumber } from '@pointercad/expression';

import { exceedsMagnitude } from '../../../numericTolerance.js';
import {
  appendSolid, createEmptyPartDocument, createPrimitiveFeature, nextSolidId, nextSolidName, replaceSketch,
} from '../../../part/createPartDocument.js';
import type { PartDocument, PrimitiveFeature, ThreadHoleFeature } from '../../../part/types.js';
import { absoluteCoordinate, appendFeature, createPointFeature } from '../../../sketch/createSketchDocument.js';
import type { SketchPointFeature } from '../../../sketch/types.js';
import { findMetricThread, metricThreadPitch, threadMinorDiameter } from '../../../thread/metricThread.js';
import { buildProfileSection } from '../../standard/profileExtrusion.js';
import { activeSketch, appendBoolean, centerPoint, origin, planeFace } from '../../standard/partPrimitives.js';
import type { SteelProfilePoint, SteelProfileSegment } from '../../standard/steelSectionProfiles.js';

export interface AngleBracketDimensions {
  /** 横の辺の長さ a。 */
  readonly legA: number;
  /** 縦の辺の長さ b。 */
  readonly legB: number;
  /** 幅 w。 */
  readonly width: number;
  /** 厚さ t。 */
  readonly thickness: number;
  /** リブ(内の角から測った直角三角形の辺)e。0 で無し。 */
  readonly rib: number;
  /** 穴の径 dh。 */
  readonly holeDiameter: number;
  /** 穴の位置 p(角の外の面から穴の中心まで)。 */
  readonly holePosition: number;
}

export interface JoinPlateDimensions {
  readonly length: number;
  readonly width: number;
  readonly thickness: number;
  readonly holeDiameter: number;
  readonly holeCount: number;
  readonly holePitch: number;
}

export interface SlotNutDimensions {
  /** ねじの呼び(メートルねじの表の呼び)。 */
  readonly thread: string;
  readonly flangeWidth: number;
  readonly length: number;
  readonly flangeThickness: number;
  readonly neckWidth: number;
  readonly neckHeight: number;
  /** 長さの端の面から主のめねじの中心まで。省略は長さの中央(今までの形)。 */
  readonly holeOffset?: number;
  /** 止めねじの穴(呼びと、holeOffset と同じ端の面からの中心の位置)。省略は無し。並目の谷の径の通し穴で表す(簡略の表し方)。 */
  readonly setScrew?: { readonly thread: string; readonly offset: number };
}

const positive = (values: readonly number[]): boolean => values.every((value) => Number.isFinite(value) && value > 0);
const circleArea = (diameter: number): number => Math.PI * (diameter / 2) ** 2;

/** 点の並びを線分でつないだ閉じた輪。 */
function polygonLoop(points: readonly SteelProfilePoint[]): readonly SteelProfileSegment[] {
  return points.map((from, index): SteelProfileSegment => ({ kind: 'line', from, to: points[(index + 1) % points.length] ?? from }));
}

/** 中心 (x, y)・径 d の円の輪(反時計回りの半円 2 つ)。 */
function circleLoop(x: number, y: number, diameter: number): readonly SteelProfileSegment[] {
  const r = diameter / 2;
  return [
    { kind: 'arc', from: [x + r, y], to: [x - r, y], center: [x, y], radius: r, startAngle: 0, endAngle: Math.PI },
    { kind: 'arc', from: [x - r, y], to: [x + r, y], center: [x, y], radius: r, startAngle: Math.PI, endAngle: 2 * Math.PI },
  ];
}

function bracketValid(dims: AngleBracketDimensions): boolean {
  const { legA: a, legB: b, width: w, thickness: t, rib: e, holeDiameter: dh, holePosition: p } = dims;
  return positive([a, b, w, t, dh, p]) && Number.isFinite(e) && e >= 0 && t < a && t < b && dh < w && p - dh / 2 > t + e
    && p + dh / 2 < a && p + dh / 2 < b;
}

/** 幅の中央を通る円柱の穴を 1 つ引く(軸は world の x か y、底は辺の外の面)。 */
function subtractHole(document: PartDocument, targetId: string, at: readonly [number, number, number], axis: 'x' | 'y',
  dims: AngleBracketDimensions): { readonly document: PartDocument; readonly id: string } {
  const created = createPrimitiveFeature(document, 'cylinder', origin(at[0], at[1], at[2]), { kind: 'world', axis });
  const hole: PrimitiveFeature = { ...created, shape: { kind: 'cylinder', radius: expressionValueFromNumber(dims.holeDiameter / 2),
    height: expressionValueFromNumber(dims.thickness) } };
  const subtracted = appendBoolean(appendSolid(document, hole), 'subtract', targetId, hole.id);
  return { document: subtracted.document, id: subtracted.feature.id };
}

export function buildAngleBracketPart(dims: AngleBracketDimensions): PartDocument | null {
  if (!bracketValid(dims)) return null;
  const { legA: a, legB: b, width: w, thickness: t, rib: e, holePosition: p } = dims;
  const corner: readonly SteelProfilePoint[] = e > 0 ? [[t + e, t], [t, t + e]] : [[t, t]];
  const profile = { segments: polygonLoop([[0, 0], [a, 0], [a, t], ...corner, [t, b], [0, b]]), holes: [] };
  const body = buildProfileSection(profile, expressionValueFromNumber(w));
  const bodyId = body.solids.at(-1)?.id;
  if (bodyId === undefined) return null;
  const first = subtractHole(body, bodyId, [p, 0, w / 2], 'y', dims);
  return subtractHole(first.document, first.id, [0, p, w / 2], 'x', dims).document;
}

export function angleBracketVolume(dims: AngleBracketDimensions): number | null {
  if (!bracketValid(dims)) return null;
  const { legA: a, legB: b, width: w, thickness: t, rib: e, holeDiameter: dh } = dims;
  return (a * t + (b - t) * t + e ** 2 / 2) * w - 2 * circleArea(dh) * t;
}

function plateValid(dims: JoinPlateDimensions): boolean {
  const { length: l, width: w, thickness: t, holeDiameter: dh, holeCount: n, holePitch: q } = dims;
  return positive([l, w, t, dh, q]) && Number.isInteger(n) && n >= 1 && dh < w && (n < 2 || q > dh) && (n - 1) * q + dh < l;
}

export function buildJoinPlatePart(dims: JoinPlateDimensions): PartDocument | null {
  if (!plateValid(dims)) return null;
  const { length: l, width: w, holeDiameter: dh, holeCount: n, holePitch: q } = dims;
  const outer = polygonLoop([[-l / 2, -w / 2], [l / 2, -w / 2], [l / 2, w / 2], [-l / 2, w / 2]]);
  const holes = Array.from({ length: n }, (_, index) => circleLoop(-(n - 1) * q / 2 + index * q, 0, dh));
  return buildProfileSection({ segments: outer, holes }, expressionValueFromNumber(dims.thickness));
}

export function joinPlateVolume(dims: JoinPlateDimensions): number | null {
  if (!plateValid(dims)) return null;
  return (dims.length * dims.width - dims.holeCount * circleArea(dims.holeDiameter)) * dims.thickness;
}

/** 並目の谷の径(ねじの呼びが表に無い時は NaN)。 */
function minorDiameterOf(thread: string): number {
  const size = findMetricThread(thread);
  return size === undefined ? NaN : threadMinorDiameter(size.diameter, metricThreadPitch(size, 'coarse'));
}

function nutMinorDiameter(dims: SlotNutDimensions): number {
  return minorDiameterOf(dims.thread);
}

/** 主のめねじの中心の x(原点は長さの中央。holeOffset が無ければ 0)。 */
function holeCenterX(dims: SlotNutDimensions): number {
  return dims.holeOffset === undefined ? 0 : dims.holeOffset - dims.length / 2;
}

/** 長さの端の面から offset の穴(径 d)が、長さの内に収まるか。 */
function insideLength(offset: number, diameter: number, length: number): boolean {
  return Number.isFinite(offset) && offset - diameter / 2 > 0 && offset + diameter / 2 < length;
}

function nutValid(dims: SlotNutDimensions): boolean {
  const minor = nutMinorDiameter(dims);
  const base = positive([dims.flangeWidth, dims.length, dims.flangeThickness, dims.neckWidth, dims.neckHeight, minor])
    && dims.neckWidth < dims.flangeWidth && minor < dims.neckWidth && minor < dims.length;
  if (!base) return false;
  const mainOffset = dims.holeOffset ?? dims.length / 2;
  if (!insideLength(mainOffset, minor, dims.length)) return false;
  if (dims.setScrew === undefined) return true;
  const screwMinor = minorDiameterOf(dims.setScrew.thread);
  // 止めねじの穴は長さの内に収まり、首より細く、主のめねじと重ならない。
  return positive([screwMinor]) && screwMinor < dims.neckWidth && insideLength(dims.setScrew.offset, screwMinor, dims.length)
    && exceedsMagnitude(dims.setScrew.offset - mainOffset, (minor + screwMinor) / 2);
}

/** 作図面に (x, 0, 0) の点を足す(めねじの中心)。 */
function pointAt(document: PartDocument, x: number): { readonly document: PartDocument; readonly point: SketchPointFeature } {
  let sketch = activeSketch(document);
  const point = createPointFeature(sketch, absoluteCoordinate(x, 0, 0));
  sketch = appendFeature(sketch, point);
  return { document: replaceSketch(document, sketch), point };
}

function appendBox(document: PartDocument, sizes: readonly [number, number, number], centerZ: number): {
  readonly document: PartDocument; readonly feature: PrimitiveFeature; } {
  const created = createPrimitiveFeature(document, 'box', origin(0, 0, centerZ));
  const feature: PrimitiveFeature = { ...created, shape: { kind: 'box', sizeX: expressionValueFromNumber(sizes[0]),
    sizeY: expressionValueFromNumber(sizes[1]), sizeZ: expressionValueFromNumber(sizes[2]) } };
  return { document: appendSolid(document, feature), feature };
}

export function buildSlotNutPart(dims: SlotNutDimensions): PartDocument | null {
  const size = findMetricThread(dims.thread);
  if (!nutValid(dims) || size === undefined) return null;
  const height = dims.flangeThickness + dims.neckHeight;
  const flange = appendBox(createEmptyPartDocument(), [dims.length, dims.flangeWidth, dims.flangeThickness], dims.flangeThickness / 2);
  const neck = appendBox(flange.document, [dims.length, dims.neckWidth, height], height / 2);
  const united = appendBoolean(neck.document, 'union', flange.feature.id, neck.feature.id);
  const center = dims.holeOffset === undefined ? centerPoint(united.document) : pointAt(united.document, holeCenterX(dims));
  const document = center.document;
  const pitch = metricThreadPitch(size, 'coarse');
  const hole: ThreadHoleFeature = {
    id: nextSolidId(document, 'threadHole'),
    name: nextSolidName(document, 'threadHole'),
    suppressed: false,
    kind: 'threadHole',
    targetFeatureId: united.feature.id,
    face: planeFace(united.feature.id, dims.length * dims.neckWidth, height),
    centers: [{ sketchId: document.activeSketchId, pointFeatureId: center.point.id }],
    designation: size.designation,
    series: 'coarse',
    pitch: expressionValueFromNumber(pitch),
    drillDiameter: exactExpressionValueFromNumber(threadMinorDiameter(size.diameter, pitch)),
    depth: { kind: 'through' },
    threadLength: expressionValueFromNumber(height),
    representation: 'simplified',
    tiltAngle: expressionValueFromNumber(0),
    tiltAzimuth: expressionValueFromNumber(0),
  };
  const threaded = appendSolid(document, hole);
  return dims.setScrew === undefined ? threaded : subtractSetScrew(threaded, hole.id, dims.setScrew, dims.length, height);
}

/** 止めねじの穴: 並目の谷の径の円柱(軸 Z)を、底の面の 1 mm 下から上の面の 1 mm 上まで引く(端の面が外形に接しない様に)。 */
function subtractSetScrew(document: PartDocument, targetId: string, setScrew: NonNullable<SlotNutDimensions['setScrew']>, length: number,
  height: number): PartDocument {
  const created = createPrimitiveFeature(document, 'cylinder', origin(setScrew.offset - length / 2, 0, -1));
  const radius = expressionValueFromNumber(minorDiameterOf(setScrew.thread) / 2);
  const screw: PrimitiveFeature = { ...created, shape: { kind: 'cylinder', radius, height: expressionValueFromNumber(height + 2) } };
  return appendBoolean(appendSolid(document, screw), 'subtract', targetId, screw.id).document;
}

export function slotNutVolume(dims: SlotNutDimensions): number | null {
  if (!nutValid(dims)) return null;
  const height = dims.flangeThickness + dims.neckHeight;
  const screw = dims.setScrew === undefined ? 0 : circleArea(minorDiameterOf(dims.setScrew.thread)) * height;
  return dims.length * dims.flangeWidth * dims.flangeThickness + dims.length * dims.neckWidth * dims.neckHeight
    - circleArea(nutMinorDiameter(dims)) * height - screw;
}

/**
 * ジョイントバー(溝に先に入れる T 形の断面の棒に、めねじが幾つか並ぶ部品)の包む形(統括の決定 2026-11-18 07:5x)。首の高さ(頭の厚さ)の寸法線が
 * 資料に無いので、T の断面を作らず、頭の幅 × 全厚の箱で包む(行の簡略の印に出す)。めねじは箱の上の面から通す(ThreadHoleFeature、表し方は簡略)。
 */
export interface JointBarDimensions {
  /** 長さ(溝の向き)。 */
  readonly length: number;
  /** 頭の幅(箱の幅)。 */
  readonly width: number;
  /** 全厚(頭の底の面から首の上の面まで。箱の高さ)。 */
  readonly thickness: number;
  /** めねじの呼び。 */
  readonly thread: string;
  /** 長さの端の面から各めねじの中心まで(小さい順)。 */
  readonly holeOffsets: readonly number[];
}

function jointBarValid(dims: JointBarDimensions): boolean {
  const minor = minorDiameterOf(dims.thread);
  if (!positive([dims.length, dims.width, dims.thickness, minor]) || !(minor < dims.width) || dims.holeOffsets.length === 0) return false;
  // めねじは長さの内に収まり、隣のめねじと重ならない。
  return dims.holeOffsets.every((offset, index) => insideLength(offset, minor, dims.length)
    && (index === 0 || offset - (dims.holeOffsets[index - 1] ?? NaN) > minor));
}

/** ジョイントバーの形(箱と、並んだめねじ)。形が成り立たない時は null。 */
export function buildJointBarPart(dims: JointBarDimensions): PartDocument | null {
  const size = findMetricThread(dims.thread);
  if (!jointBarValid(dims) || size === undefined) return null;
  const box = appendBox(createEmptyPartDocument(), [dims.length, dims.width, dims.thickness], dims.thickness / 2);
  let document = box.document;
  const points: SketchPointFeature[] = [];
  for (const offset of dims.holeOffsets) {
    const added = pointAt(document, offset - dims.length / 2);
    document = added.document;
    points.push(added.point);
  }
  const pitch = metricThreadPitch(size, 'coarse');
  const hole: ThreadHoleFeature = {
    id: nextSolidId(document, 'threadHole'),
    name: nextSolidName(document, 'threadHole'),
    suppressed: false,
    kind: 'threadHole',
    targetFeatureId: box.feature.id,
    face: planeFace(box.feature.id, dims.length * dims.width, dims.thickness),
    centers: points.map((point) => ({ sketchId: document.activeSketchId, pointFeatureId: point.id })),
    designation: size.designation,
    series: 'coarse',
    pitch: expressionValueFromNumber(pitch),
    drillDiameter: exactExpressionValueFromNumber(threadMinorDiameter(size.diameter, pitch)),
    depth: { kind: 'through' },
    threadLength: expressionValueFromNumber(dims.thickness),
    representation: 'simplified',
    tiltAngle: expressionValueFromNumber(0),
    tiltAzimuth: expressionValueFromNumber(0),
  };
  return appendSolid(document, hole);
}

/** ジョイントバーの体積(箱 − めねじの数 × 谷の径の円 × 全厚)。形が成り立たない時は null。 */
export function jointBarVolume(dims: JointBarDimensions): number | null {
  if (!jointBarValid(dims)) return null;
  return dims.length * dims.width * dims.thickness - dims.holeOffsets.length * circleArea(minorDiameterOf(dims.thread)) * dims.thickness;
}
