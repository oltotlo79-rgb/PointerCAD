/**
 * 資料 SF-1 のフレームの部品の形(簡略): T 溝用ナットの素材(棒材)の断面・丸ナット・端のキャップ。
 * 1 個の T 溝用ナットは、今ある汎用の形(`frameParts.ts` の buildSlotNutPart。つば+首+中央のめねじ)を行の値で使う。
 * - 棒材の断面: 頭(溝の中に入る広い部分。幅 hw・高さ H − nh)と首(溝の口に入る部分。幅 nw・高さ nh)の 2 つの長方形の T 形。
 *   頭の斜面は記入が無いので入れない(簡略)。原点は外形の中心、縦(Y)が高さ、首が上。
 * - 丸ナット: 軸が Z の円柱(径 D・長さ L、底が z = 0)に、軸が world の X の円柱の穴を 2 つ引く(穴の中心は z = e と e + p)。
 *   めねじは並目の谷の径の穴で表す(簡略の表し方)。
 * - 端のキャップ: 板だけ(外形 W × H、厚さ t を Z へ押し出す)。長方形は 4 隅に同じ半径の丸み(0 で直角)、L 形は同じ幅 a の腕 2 本
 *   (左の腕と下の腕)。取付けの脚と穴は入れない(簡略)。原点は外形の中心。
 * - 平板のブラケット(長方形と通し穴の格子)・平板の L・T・十字(直角の輪と通し穴)・フットベースの板(長方形と穴ごとの径の通し穴): 板の押し出しと穴。
 * - L 形のブラケット: L の断面(寝た脚と立つ脚は同じ厚さ)を幅だけ押し出し、各脚に軸が脚に垂直な円柱の穴の格子を引く。
 * - アジャスター: 皿の円柱と、おねじの呼びの径の円柱の和(ねじの山は入れない)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../../../part/createPartDocument.js';
import type { PartDocument, PrimitiveFeature } from '../../../part/types.js';
import { findMetricThread, metricThreadPitch, threadMinorDiameter } from '../../../thread/metricThread.js';
import type { FrameSectionBounds } from '../../frame/frameMembers.js';
import { buildProfileSection, type ProfileLoops } from '../../standard/profileExtrusion.js';
import { appendBoolean, appendCylinder, origin } from '../../standard/partPrimitives.js';
import type { SteelProfilePoint, SteelProfileSegment } from '../../standard/steelSectionProfiles.js';

export interface TSlotNutBarSection {
  readonly headWidth: number;
  readonly neckWidth: number;
  readonly neckHeight: number;
  readonly totalHeight: number;
}

export interface RoundNutDimensions {
  /** めねじの呼び(メートルねじの表の呼び)。 */
  readonly thread: string;
  readonly diameter: number;
  readonly length: number;
  /** 2 つの穴の中心の間。 */
  readonly holePitch: number;
  /** 底の端の面から 1 つ目の穴の中心まで。 */
  readonly holeOffset: number;
}

export interface FrameCapDimensions {
  readonly shape: 'rect' | 'l';
  readonly width: number;
  readonly height: number;
  readonly thickness: number;
  /** L 形の腕の幅(長方形は使わない)。 */
  readonly armWidth: number;
  /** 長方形の 4 隅の丸みの半径(0 で直角。L 形は使わない)。 */
  readonly cornerRadius: number;
}

const positive = (values: readonly number[]): boolean => values.every((value) => Number.isFinite(value) && value > 0);

function polygonLoop(points: readonly SteelProfilePoint[]): readonly SteelProfileSegment[] {
  return points.map((from, index): SteelProfileSegment => ({ kind: 'line', from, to: points[(index + 1) % points.length] ?? from }));
}

function barValid(section: TSlotNutBarSection): boolean {
  const { headWidth, neckWidth, neckHeight, totalHeight } = section;
  return positive([headWidth, neckWidth, neckHeight, totalHeight]) && neckWidth < headWidth && neckHeight < totalHeight;
}

/** 棒材の T 形の断面の輪と面積。形が成り立たない時は null。 */
export function tSlotNutBarProfile(section: TSlotNutBarSection): (ProfileLoops & { readonly areaMm2: number }) | null {
  if (!barValid(section)) return null;
  const { headWidth: hw, neckWidth: nw, neckHeight: nh, totalHeight: h } = section;
  const bottom = -h / 2;
  const shoulder = bottom + (h - nh);
  const segments = polygonLoop([[-hw / 2, bottom], [hw / 2, bottom], [hw / 2, shoulder], [nw / 2, shoulder], [nw / 2, h / 2],
    [-nw / 2, h / 2], [-nw / 2, shoulder], [-hw / 2, shoulder]]);
  return { segments, holes: [], areaMm2: hw * (h - nh) + nw * nh };
}

/** 棒材の断面の外形(原点が中心)。形が成り立たない時は null。 */
export function tSlotNutBarBounds(section: TSlotNutBarSection): FrameSectionBounds | null {
  if (!barValid(section)) return null;
  return { minX: -section.headWidth / 2, minY: -section.totalHeight / 2, maxX: section.headWidth / 2, maxY: section.totalHeight / 2 };
}

/** 並目の谷の径(ねじの呼びが表に無い時は NaN)。 */
function minorDiameter(thread: string): number {
  const size = findMetricThread(thread);
  return size === undefined ? NaN : threadMinorDiameter(size.diameter, metricThreadPitch(size, 'coarse'));
}

function roundNutValid(dims: RoundNutDimensions): boolean {
  const minor = minorDiameter(dims.thread);
  const r = minor / 2;
  return positive([dims.diameter, dims.length, dims.holePitch, dims.holeOffset, minor]) && minor < dims.diameter
    && dims.holeOffset - r > 0 && dims.holeOffset + dims.holePitch + r < dims.length && dims.holePitch > minor;
}

/**
 * 半径 R の円柱(軸 Z)と、半径 r の円柱の穴(軸 X、R の軸と交わる)が重なる体積。y = r·sinθ と置いた
 * ∫ 4·r²·cos²θ·√(R² − r²·sin²θ) dθ(−π/2〜π/2)をシンプソンの式で求める(被積分関数は滑らか)。
 */
function crossHoleVolume(bodyRadius: number, holeRadius: number): number {
  const steps = 400;
  const h = Math.PI / steps;
  const f = (theta: number): number => 4 * holeRadius ** 2 * Math.cos(theta) ** 2
    * Math.sqrt(bodyRadius ** 2 - holeRadius ** 2 * Math.sin(theta) ** 2);
  let sum = f(-Math.PI / 2) + f(Math.PI / 2);
  for (let index = 1; index < steps; index += 1) sum += (index % 2 === 1 ? 4 : 2) * f(-Math.PI / 2 + index * h);
  return sum * h / 3;
}

/** 丸ナットの形。形が成り立たない時(呼びが表に無い・穴が端からはみ出す)は null。 */
export function buildRoundNutPart(dims: RoundNutDimensions): PartDocument | null {
  if (!roundNutValid(dims)) return null;
  const radius = dims.diameter / 2;
  const minor = minorDiameter(dims.thread);
  const body = appendCylinder(createEmptyPartDocument(), radius, expressionValueFromNumber(dims.length));
  let current = body.document;
  let target = body.feature.id;
  for (const z of [dims.holeOffset, dims.holeOffset + dims.holePitch]) {
    // 穴の円柱は外形より 1 mm ずつ長くして、端の面が外形に接しない様にする。
    const created = createPrimitiveFeature(current, 'cylinder', origin(-radius - 1, 0, z), { kind: 'world', axis: 'x' });
    const hole: PrimitiveFeature = { ...created, shape: { kind: 'cylinder', radius: expressionValueFromNumber(minor / 2),
      height: expressionValueFromNumber(dims.diameter + 2) } };
    const subtracted = appendBoolean(appendSolid(current, hole), 'subtract', target, hole.id);
    current = subtracted.document;
    target = subtracted.feature.id;
  }
  return current;
}

/** 丸ナットの体積(円柱 − 横の穴 2 つ)。形が成り立たない時は null。 */
export function roundNutVolume(dims: RoundNutDimensions): number | null {
  if (!roundNutValid(dims)) return null;
  const radius = dims.diameter / 2;
  return Math.PI * radius ** 2 * dims.length - 2 * crossHoleVolume(radius, minorDiameter(dims.thread) / 2);
}

function capValid(dims: FrameCapDimensions): boolean {
  if (!positive([dims.width, dims.height, dims.thickness])) return false;
  if (dims.shape === 'l') return positive([dims.armWidth]) && dims.armWidth < dims.width && dims.armWidth < dims.height;
  return Number.isFinite(dims.cornerRadius) && dims.cornerRadius >= 0 && 2 * dims.cornerRadius < Math.min(dims.width, dims.height);
}

/** 4 隅に半径 rc の丸みのある長方形の輪(反時計回り。rc = 0 は直角)。 */
function roundedRectangle(width: number, height: number, rc: number): readonly SteelProfileSegment[] {
  const x = width / 2;
  const y = height / 2;
  if (rc === 0) return polygonLoop([[-x, -y], [x, -y], [x, y], [-x, y]]);
  const corner = (cx: number, cy: number, start: number): SteelProfileSegment => ({ kind: 'arc',
    from: [cx + rc * Math.cos(start), cy + rc * Math.sin(start)], to: [cx + rc * Math.cos(start + Math.PI / 2), cy + rc * Math.sin(start + Math.PI / 2)],
    center: [cx, cy], radius: rc, startAngle: start, endAngle: start + Math.PI / 2 });
  return [
    { kind: 'line', from: [-x + rc, -y], to: [x - rc, -y] }, corner(x - rc, -y + rc, -Math.PI / 2),
    { kind: 'line', from: [x, -y + rc], to: [x, y - rc] }, corner(x - rc, y - rc, 0),
    { kind: 'line', from: [x - rc, y], to: [-x + rc, y] }, corner(-x + rc, y - rc, Math.PI / 2),
    { kind: 'line', from: [-x, y - rc], to: [-x, -y + rc] }, corner(-x + rc, -y + rc, Math.PI),
  ];
}

/** キャップの板の輪と面積。形が成り立たない時は null。 */
export function frameCapProfile(dims: FrameCapDimensions): (ProfileLoops & { readonly areaMm2: number }) | null {
  if (!capValid(dims)) return null;
  const { width: w, height: h } = dims;
  if (dims.shape === 'l') {
    const a = dims.armWidth;
    const segments = polygonLoop([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, -h / 2 + a], [-w / 2 + a, -h / 2 + a], [-w / 2 + a, h / 2],
      [-w / 2, h / 2]]);
    return { segments, holes: [], areaMm2: w * a + (h - a) * a };
  }
  const rc = dims.cornerRadius;
  return { segments: roundedRectangle(w, h, rc), holes: [], areaMm2: w * h - (4 - Math.PI) * rc ** 2 };
}

export interface FlatPlateDimensions {
  readonly length: number;
  readonly width: number;
  readonly thickness: number;
  /** 4 隅の面取り C(0 で直角)。 */
  readonly chamfer: number;
  readonly holeDiameter: number;
  /** 板の左の端からの穴の中心の位置の列。 */
  readonly holesX: readonly number[];
  /** 板の下の端からの穴の中心の位置の列。穴は holesX × holesY の格子。 */
  readonly holesY: readonly number[];
}

function plateValid(dims: FlatPlateDimensions): boolean {
  const r = dims.holeDiameter / 2;
  return positive([dims.length, dims.width, dims.thickness, dims.holeDiameter]) && Number.isFinite(dims.chamfer) && dims.chamfer >= 0
    && 2 * dims.chamfer < Math.min(dims.length, dims.width) && dims.holesX.length > 0 && dims.holesY.length > 0
    && dims.holesX.every((x) => x - r > 0 && x + r < dims.length) && dims.holesY.every((y) => y - r > 0 && y + r < dims.width);
}

/** 円の輪(反時計回りの半円 2 つ)。 */
function circleAt(x: number, y: number, diameter: number): readonly SteelProfileSegment[] {
  const r = diameter / 2;
  return [
    { kind: 'arc', from: [x + r, y], to: [x - r, y], center: [x, y], radius: r, startAngle: 0, endAngle: Math.PI },
    { kind: 'arc', from: [x - r, y], to: [x + r, y], center: [x, y], radius: r, startAngle: Math.PI, endAngle: 2 * Math.PI },
  ];
}

/**
 * 平板のブラケットの輪(外形 L × W、4 隅の面取り C、通し穴の格子)と面積。原点は外形の中心(穴の位置は左・下の端から測るので、
 * 中心の座標へは − L/2・− W/2 を足して置く)。形が成り立たない時は null。
 */
export function flatPlateProfile(dims: FlatPlateDimensions): (ProfileLoops & { readonly areaMm2: number }) | null {
  if (!plateValid(dims)) return null;
  const x = dims.length / 2;
  const y = dims.width / 2;
  const c = dims.chamfer;
  const outline: readonly SteelProfilePoint[] = c === 0 ? [[-x, -y], [x, -y], [x, y], [-x, y]]
    : [[-x + c, -y], [x - c, -y], [x, -y + c], [x, y - c], [x - c, y], [-x + c, y], [-x, y - c], [-x, -y + c]];
  const holes = dims.holesX.flatMap((hx) => dims.holesY.map((hy) => circleAt(hx - x, hy - y, dims.holeDiameter)));
  const count = dims.holesX.length * dims.holesY.length;
  return { segments: polygonLoop(outline), holes,
    areaMm2: dims.length * dims.width - 2 * c ** 2 - count * Math.PI * dims.holeDiameter ** 2 / 4 };
}

/** 平板のブラケットの形(厚さ t を Z へ押し出し、穴を引く)。形が成り立たない時は null。 */
export function buildFlatPlatePart(dims: FlatPlateDimensions): PartDocument | null {
  const profile = flatPlateProfile(dims);
  return profile === null ? null : buildProfileSection(profile, expressionValueFromNumber(dims.thickness));
}

/** キャップの板の形(厚さ t を Z へ押し出す)。形が成り立たない時は null。 */
export function buildFrameCapPart(dims: FrameCapDimensions): PartDocument | null {
  const profile = frameCapProfile(dims);
  return profile === null ? null : buildProfileSection(profile, expressionValueFromNumber(dims.thickness));
}

export interface ShapedPlateDimensions {
  /** 直角だけの輪の外形の頂点(外形の左下が原点、時計回り)。 */
  readonly outline: readonly (readonly [number, number])[];
  readonly thickness: number;
  readonly holeDiameter: number;
  /** 穴の中心(外形の左下からの x・y)。 */
  readonly holes: readonly (readonly [number, number])[];
}

/** 輪の符号つきの面積(線分だけの輪)。 */
function polygonArea(points: readonly (readonly [number, number])[]): number {
  return points.reduce((sum, [x1, y1], index) => {
    const [x2, y2] = points[(index + 1) % points.length] ?? [x1, y1];
    return sum + (x1 * y2 - x2 * y1) / 2;
  }, 0);
}

/** 平板の L・T・十字の輪(外形の中心が原点)と面積。頂点が 4 つ未満・厚さや穴の径が 0 以下の時は null。 */
export function shapedPlateProfile(dims: ShapedPlateDimensions): (ProfileLoops & { readonly areaMm2: number }) | null {
  if (dims.outline.length < 4 || !positive([dims.thickness, dims.holeDiameter])) return null;
  const xs = dims.outline.map(([x]) => x);
  const ys = dims.outline.map(([, y]) => y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const points: readonly SteelProfilePoint[] = dims.outline.map(([x, y]): SteelProfilePoint => [x - cx, y - cy]);
  const holes = dims.holes.map(([x, y]) => circleAt(x - cx, y - cy, dims.holeDiameter));
  return { segments: polygonLoop(points), holes,
    areaMm2: Math.abs(polygonArea(dims.outline)) - dims.holes.length * Math.PI * dims.holeDiameter ** 2 / 4 };
}

/** 平板の L・T・十字の形(厚さ t を Z へ押し出し、穴を引く)。 */
export function buildShapedPlatePart(dims: ShapedPlateDimensions): PartDocument | null {
  const profile = shapedPlateProfile(dims);
  return profile === null ? null : buildProfileSection(profile, expressionValueFromNumber(dims.thickness));
}

export interface AngleBracketCatalogDimensions {
  /** 寝た脚 a の長さ(角の外の面から、x 向き)。 */
  readonly legA: number;
  /** 立つ脚 b の長さ(角の外の面から、y 向き)。 */
  readonly legB: number;
  /** 幅(z 向き)。 */
  readonly width: number;
  /** 板の厚さ(立つ脚も同じ。簡略)。 */
  readonly thickness: number;
  readonly holeDiameter: number;
  readonly alongA: readonly number[];
  readonly acrossA: readonly number[];
  readonly alongB: readonly number[];
  readonly acrossB: readonly number[];
}

function bracketValid(dims: AngleBracketCatalogDimensions): boolean {
  const { legA, legB, width, thickness: t, holeDiameter } = dims;
  const r = holeDiameter / 2;
  const fits = (along: readonly number[], length: number): boolean => along.every((value) => t < value - r && value + r < length);
  const across = (values: readonly number[]): boolean => values.every((value) => r < value && value + r < width);
  return positive([legA, legB, width, t, holeDiameter]) && t < legA && t < legB && fits(dims.alongA, legA) && fits(dims.alongB, legB)
    && across(dims.acrossA) && across(dims.acrossB);
}

/** 円柱の穴を 1 つ引く(軸は world の x か y。脚の外の面の 1 mm 外から、厚さ + 2 mm)。 */
function subtractLegHole(document: PartDocument, targetId: string, at: readonly [number, number, number], axis: 'x' | 'y', radius: number,
  depth: number): { readonly document: PartDocument; readonly id: string } {
  const created = createPrimitiveFeature(document, 'cylinder', origin(at[0], at[1], at[2]), { kind: 'world', axis });
  const hole: PrimitiveFeature = { ...created, shape: { kind: 'cylinder', radius: expressionValueFromNumber(radius),
    height: expressionValueFromNumber(depth) } };
  const subtracted = appendBoolean(appendSolid(document, hole), 'subtract', targetId, hole.id);
  return { document: subtracted.document, id: subtracted.feature.id };
}

/**
 * L 形のブラケットの形: 作図面(xy)に L の断面(寝た脚 a は y 0〜t、立つ脚 b は x 0〜t)を書いて幅だけ z へ押し出し、
 * 寝た脚には軸が y、立つ脚には軸が x の穴を、角の外の面からの位置 × 幅の端からの位置の格子で引く。
 */
export function buildAngleBracketCatalogPart(dims: AngleBracketCatalogDimensions): PartDocument | null {
  if (!bracketValid(dims)) return null;
  const { legA, legB, width, thickness: t, holeDiameter } = dims;
  const outline = polygonLoop([[0, 0], [legA, 0], [legA, t], [t, t], [t, legB], [0, legB]]);
  let document = buildProfileSection({ segments: outline, holes: [] }, expressionValueFromNumber(width));
  let target = document.solids[0]?.id ?? '';
  const holes: readonly (readonly [readonly [number, number, number], 'x' | 'y'])[] = [
    ...dims.alongA.flatMap((x) => dims.acrossA.map((z): readonly [readonly [number, number, number], 'x' | 'y'] => [[x, -1, z], 'y'])),
    ...dims.alongB.flatMap((y) => dims.acrossB.map((z): readonly [readonly [number, number, number], 'x' | 'y'] => [[-1, y, z], 'x'])),
  ];
  for (const [at, axis] of holes) {
    const next = subtractLegHole(document, target, at, axis, holeDiameter / 2, t + 2);
    document = next.document;
    target = next.id;
  }
  return document;
}

/** L 形のブラケットの体積((a + b − t)·t·幅 − 穴の数·π·r²·t)。形が成り立たない時は null。 */
export function angleBracketCatalogVolume(dims: AngleBracketCatalogDimensions): number | null {
  if (!bracketValid(dims)) return null;
  const holes = dims.alongA.length * dims.acrossA.length + dims.alongB.length * dims.acrossB.length;
  return (dims.legA + dims.legB - dims.thickness) * dims.thickness * dims.width - holes * Math.PI * (dims.holeDiameter / 2) ** 2 * dims.thickness;
}

export interface FootBaseDimensions {
  readonly width: number;
  readonly depth: number;
  readonly thickness: number;
  /** 穴(外形の左下からの x・y と径)。 */
  readonly holes: readonly (readonly [number, number, number])[];
}

/** フットベース・アジャスターベースの板の輪(外形の中心が原点)と面積。穴が板からはみ出す時は null。 */
export function footBaseProfile(dims: FootBaseDimensions): (ProfileLoops & { readonly areaMm2: number }) | null {
  const { width: w, depth: d } = dims;
  const fits = dims.holes.every(([x, y, size]) => size > 0 && size / 2 < x && x + size / 2 < w && size / 2 < y && y + size / 2 < d);
  if (!positive([w, d, dims.thickness]) || !fits) return null;
  return { segments: polygonLoop([[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]),
    holes: dims.holes.map(([x, y, size]) => circleAt(x - w / 2, y - d / 2, size)),
    areaMm2: w * d - dims.holes.reduce((sum, [, , size]) => sum + Math.PI * size ** 2 / 4, 0) };
}

/** フットベース・アジャスターベースの板の形(厚さ t を Z へ押し出し、穴を引く)。 */
export function buildFootBasePart(dims: FootBaseDimensions): PartDocument | null {
  const profile = footBaseProfile(dims);
  return profile === null ? null : buildProfileSection(profile, expressionValueFromNumber(dims.thickness));
}

export interface AdjusterDimensions {
  readonly thread: string;
  readonly padDiameter: number;
  readonly padThickness: number;
  readonly threadLength: number;
}

function adjusterValid(dims: AdjusterDimensions): boolean {
  const size = findMetricThread(dims.thread);
  return size !== undefined && positive([dims.padDiameter, dims.padThickness, dims.threadLength]) && size.diameter < dims.padDiameter;
}

/** アジャスターの形: 皿の円柱(z 0〜t)と、その上のおねじの呼びの径の円柱(ねじの山は入れない)の和。 */
export function buildAdjusterPart(dims: AdjusterDimensions): PartDocument | null {
  const size = findMetricThread(dims.thread);
  if (size === undefined || !adjusterValid(dims)) return null;
  const pad = appendCylinder(createEmptyPartDocument(), dims.padDiameter / 2, expressionValueFromNumber(dims.padThickness));
  const rod = appendCylinder(pad.document, size.diameter / 2, expressionValueFromNumber(dims.threadLength), dims.padThickness);
  return appendBoolean(rod.document, 'union', pad.feature.id, rod.feature.id).document;
}

/** アジャスターの体積(皿 + 呼びの径の円柱)。形が成り立たない時は null。 */
export function adjusterVolume(dims: AdjusterDimensions): number | null {
  const size = findMetricThread(dims.thread);
  if (size === undefined || !adjusterValid(dims)) return null;
  return Math.PI * (dims.padDiameter / 2) ** 2 * dims.padThickness + Math.PI * (size.diameter / 2) ** 2 * dims.threadLength;
}
