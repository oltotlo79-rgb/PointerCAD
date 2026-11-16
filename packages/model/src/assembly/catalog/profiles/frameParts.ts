/**
 * T スロットフレーム用の汎用の部品の簡略形状(E-04): 直角のブラケット・つなぎ板・T 溝用のナット。どれも寸法を式で入れる汎用の形で、
 * 規格や製造元の寸法ではない。面取り・座ぐり・位置決めの突起・丸みは入れない。
 * - 直角のブラケット: 作図面(xy)に L 形の断面(内の角を埋める直角三角形のリブ込み)を書いて幅 w だけ z へ押し出し、横の辺(y 向きの厚さ)と
 *   縦の辺(x 向きの厚さ)に 1 つずつ、幅の中央を通る円柱の穴を引く。
 * - つなぎ板: 長方形(中心が原点)に、長さの向きに中心で揃えた n 個の円の穴(内の輪)を書いて厚さ t だけ押し出す。
 * - T 溝用のナット: つばの直方体(l × wf × tf)と首の直方体(l × wn × (tf + hn)、底は z = 0)の和に、首の上面から通しのめねじ
 *   (下穴径は並目の谷の径、簡略の表し方)を開ける。
 */
import { exactExpressionValueFromNumber, expressionValueFromNumber } from '@pointercad/expression';

import { appendSolid, createEmptyPartDocument, createPrimitiveFeature, nextSolidId, nextSolidName } from '../../../part/createPartDocument.js';
import type { PartDocument, PrimitiveFeature, ThreadHoleFeature } from '../../../part/types.js';
import { findMetricThread, metricThreadPitch, threadMinorDiameter } from '../../../thread/metricThread.js';
import { buildProfileSection } from '../../standard/profileExtrusion.js';
import { appendBoolean, centerPoint, origin, planeFace } from '../../standard/partPrimitives.js';
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
function nutMinorDiameter(dims: SlotNutDimensions): number {
  const size = findMetricThread(dims.thread);
  return size === undefined ? NaN : threadMinorDiameter(size.diameter, metricThreadPitch(size, 'coarse'));
}

function nutValid(dims: SlotNutDimensions): boolean {
  const minor = nutMinorDiameter(dims);
  return positive([dims.flangeWidth, dims.length, dims.flangeThickness, dims.neckWidth, dims.neckHeight, minor])
    && dims.neckWidth < dims.flangeWidth && minor < dims.neckWidth && minor < dims.length;
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
  const center = centerPoint(united.document);
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
  return appendSolid(document, hole);
}

export function slotNutVolume(dims: SlotNutDimensions): number | null {
  if (!nutValid(dims)) return null;
  const height = dims.flangeThickness + dims.neckHeight;
  return dims.length * dims.flangeWidth * dims.flangeThickness + dims.length * dims.neckWidth * dims.neckHeight
    - circleArea(nutMinorDiameter(dims)) * height;
}
