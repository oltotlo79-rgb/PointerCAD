/**
 * キャスターの形(利用者の回答 2026-11-18 15:5x の (1)「車輪の形も作る」。設計は担当の wip/caster/design.md)。
 * 座標: 旋回の中心が原点、床が z = 0、+z が上、車輪の向き(進む向き)は x。
 * - 取付けの板: 外形 幅(x)× 奥行(y)× 厚さの箱。上の面が z = 全体の高さ。取付けの穴は板を通る円柱を引く(位置は板の中心から)。
 * - 取付けのねじ: おねじの呼びの径の円柱 × ねじの長さ。下の端が z = 全体の高さ(ねじの山は作らない)。
 * - 取付けを作らない行(差込みの軸の外径の記入が無い行): フォークの箱の上の端が全体の高さ(取付けの座の上の面)。軸は作らない(行の印)。
 * - フォーク: 決まった寸法だけから作る簡略の箱 1 つ。幅(y)は車輪の幅、x は −偏り − 径/4 から 径/4 まで、z は車輪の中心の高さから
 *   板の下の面(ねじの行は全体の高さ)まで。フォークの板の厚さ・曲げの形は記入が無いので作らない(行の簡略の印)。
 * - 車輪: 径 × 幅の円柱(軸は y)。中心は (−偏り, 0, 径/2)。
 * - 双輪(車輪が 2 つ): 車輪は 1 輪の幅の円柱 2 つで、y は すき間/2〜すき間/2 + 幅 と その反対。本体の箱は 2 輪の間だけ
 *   (y は ±(すき間/2 + t)、t = min(幅/4, 2) だけ両輪の内側へ食い込ませて 1 つの立体にする。面が接するだけの和を避ける)。x・z はフォークと同じ。
 * 旋回の向き・止めの機構・車輪の溝やゴムの形・軸受は作らない(行の簡略の印)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../../../part/createPartDocument.js';
import type { PartDocument, PrimitiveFeature } from '../../../part/types.js';
import { findMetricThread } from '../../../thread/metricThread.js';
import { appendBoolean, origin } from '../../standard/partPrimitives.js';

export type CasterMount =
  | { readonly kind: 'plate'; readonly width: number; readonly depth: number; readonly thickness: number;
    /** 取付けの穴(板の中心からの x・y と径)。 */
    readonly holes: readonly (readonly [number, number, number])[] }
  | { readonly kind: 'stem'; readonly thread: string; readonly length: number }
  /** 取付けの形を作らない(差込みの軸の外径の記入が無い)。全体の高さは取付けの座の上の面まで。 */
  | { readonly kind: 'none' };

export interface CasterDimensions {
  readonly wheelDiameter: number;
  readonly wheelWidth: number;
  /** 偏り(旋回の中心から車軸までの水平の距離。固定は 0)。 */
  readonly offset: number;
  /** 全体の高さ(床から取付けの面〔板の上の面・ねじの下の端・取付けを作らない行は座の上の面〕まで)。 */
  readonly height: number;
  readonly mount: CasterMount;
  /** 双輪の 2 輪の内側の面の間(すき間)。無ければ車輪は 1 つ。双輪の wheelWidth は 1 輪の幅。 */
  readonly twinGap?: number;
}

const positive = (...values: readonly number[]): boolean => values.every((value) => Number.isFinite(value) && value > 0);

/** フォークの箱の上の端(板の下の面か、ねじの行と取付けを作らない行は全体の高さ)。 */
function forkTop(dims: CasterDimensions): number {
  return dims.mount.kind === 'plate' ? dims.height - dims.mount.thickness : dims.height;
}

/** 双輪で本体の箱を両輪の内側へ食い込ませる幅。 */
function twinOverlap(dims: CasterDimensions): number {
  return Math.min(dims.wheelWidth / 4, 2);
}

/** フォーク(双輪は本体)の箱の y の幅の半分。 */
function boxHalfWidth(dims: CasterDimensions): number {
  return dims.twinGap === undefined ? dims.wheelWidth / 2 : dims.twinGap / 2 + twinOverlap(dims);
}

/** 車輪の円柱の y の始まり(1 輪は 1 つ、双輪は 2 つ)。 */
function wheelStarts(dims: CasterDimensions): readonly number[] {
  return dims.twinGap === undefined ? [-dims.wheelWidth / 2] : [dims.twinGap / 2, -dims.twinGap / 2 - dims.wheelWidth];
}

/**
 * 形が成り立つか(寸法が正、車輪が取付けの面より下に収まる、穴が板の内でフォークに掛からず重ならない、穴を引く円柱が車輪に届かない、
 * ねじの呼びが表にある)。
 */
export function casterValid(dims: CasterDimensions): boolean {
  const { wheelDiameter: d, wheelWidth: w, offset: e, height: h, mount, twinGap } = dims;
  // 車輪は取付けの面(板の下の面・ねじの下の端)より下に収まる(車輪と板が重ならず、体積の式を保つ)。
  if (!positive(d, w, h) || !(Number.isFinite(e) && e >= 0) || !(d < forkTop(dims))) return false;
  if (twinGap !== undefined && !positive(twinGap)) return false;
  if (mount.kind === 'none') return true;
  if (mount.kind === 'stem') return findMetricThread(mount.thread) !== undefined && positive(mount.length);
  const { width, depth, thickness, holes } = mount;
  if (!positive(width, depth, thickness) || !(thickness < h)) return false;
  const half = boxHalfWidth(dims);
  // 穴はフォークの箱の上(x −e − d/4〜d/4・y ±箱の幅の半分)に掛からない(穴を引く円柱がフォークを削らない。体積の式を保つ)。
  const clearOfFork = (x: number, y: number, size: number): boolean => {
    const dx = Math.max(-e - d / 4 - x, 0, x - d / 4);
    const dy = Math.max(-half - y, 0, y - half);
    return Math.hypot(dx, dy) > size / 2;
  };
  // 穴を引く円柱は板の下 1 まで届くので、車輪の上の端がそこより下か、穴が車輪の真上に無い事(車輪を削らない。体積の式を保つ)。
  const clearOfWheels = (x: number, y: number, size: number): boolean => d < forkTop(dims) - 1 || wheelStarts(dims).every((start) => {
    const dx = Math.max(-e - d / 2 - x, 0, x + e - d / 2);
    const dy = Math.max(start - y, 0, y - start - w);
    return Math.hypot(dx, dy) > size / 2;
  });
  // 穴が板の内に収まる(左右・前後の両方の辺から離れる。手書きの絶対値の比べを使わず、両側を比べる)。
  const inside = (center: number, size: number, extent: number): boolean => -extent / 2 < center - size / 2 && center + size / 2 < extent / 2;
  return holes.every(([x, y, size], index) => positive(size) && inside(x, size, width) && inside(y, size, depth)
    && clearOfFork(x, y, size) && clearOfWheels(x, y, size)
    && holes.every(([ox, oy, other], at) => at === index || Math.hypot(ox - x, oy - y) > (size + other) / 2));
}

function box(document: PartDocument, center: readonly [number, number, number], size: readonly [number, number, number]): PrimitiveFeature {
  const created = createPrimitiveFeature(document, 'box', origin(center[0], center[1], center[2]));
  return { ...created, shape: { kind: 'box', sizeX: expressionValueFromNumber(size[0]), sizeY: expressionValueFromNumber(size[1]),
    sizeZ: expressionValueFromNumber(size[2]) } };
}

function cylinder(document: PartDocument, start: readonly [number, number, number], axis: 'y' | 'z', radius: number, length: number): PrimitiveFeature {
  const created = createPrimitiveFeature(document, 'cylinder', origin(start[0], start[1], start[2]), { kind: 'world', axis });
  return { ...created, shape: { kind: 'cylinder', radius: expressionValueFromNumber(radius), height: expressionValueFromNumber(length) } };
}

/** 足して合わせる(1 つ目は形の始まり)。 */
function unite(document: PartDocument, target: string | null, feature: PrimitiveFeature): { readonly document: PartDocument; readonly id: string } {
  const added = appendSolid(document, feature);
  if (target === null) return { document: added, id: feature.id };
  const joined = appendBoolean(added, 'union', target, feature.id);
  return { document: joined.document, id: joined.feature.id };
}

/** キャスターの形。成り立たない時は null。 */
export function buildCasterPart(dims: CasterDimensions): PartDocument | null {
  if (!casterValid(dims)) return null;
  const { wheelDiameter: d, wheelWidth: w, offset: e, height: h, mount } = dims;
  const start = createEmptyPartDocument();
  let wheels: { readonly document: PartDocument; readonly id: string | null } = { document: start, id: null };
  for (const y of wheelStarts(dims)) wheels = unite(wheels.document, wheels.id, cylinder(wheels.document, [-e, y, d / 2], 'y', d / 2, w));
  const top = forkTop(dims);
  // フォーク(双輪は本体)の箱: x は −e − d/4〜d/4(中心 −e/2・長さ e + d/2)、y は ±箱の幅の半分、z は車輪の中心の高さ〜上の端。
  let step = unite(wheels.document, wheels.id, box(wheels.document, [-e / 2, 0, (top + d / 2) / 2], [e + d / 2, 2 * boxHalfWidth(dims), top - d / 2]));
  if (mount.kind === 'plate') {
    step = unite(step.document, step.id, box(step.document, [0, 0, h - mount.thickness / 2], [mount.width, mount.depth, mount.thickness]));
    for (const [x, y, diameter] of mount.holes) {
      const hole = cylinder(step.document, [x, y, h - mount.thickness - 1], 'z', diameter / 2, mount.thickness + 2);
      const subtracted = appendBoolean(appendSolid(step.document, hole), 'subtract', step.id, hole.id);
      step = { document: subtracted.document, id: subtracted.feature.id };
    }
    return step.document;
  }
  if (mount.kind === 'none') return step.document;
  const size = findMetricThread(mount.thread);
  return size === undefined ? null : unite(step.document, step.id, cylinder(step.document, [0, 0, h], 'z', size.diameter / 2, mount.length)).document;
}

/**
 * 半径 R の円の上半分(中心の高さより上)のうち、中心からの横の距離が u1〜u2 の部分の面積(u1 ≤ u2、両方 −R〜R に切り詰める)。
 * ∫√(R² − u²) du = (u√(R² − u²) + R² asin(u/R)) / 2。
 */
export function upperHalfDiskArea(radius: number, u1: number, u2: number): number {
  const clip = (value: number): number => Math.min(radius, Math.max(-radius, value));
  const primitive = (u: number): number => (u * Math.sqrt(Math.max(0, radius * radius - u * u)) + radius * radius * Math.asin(u / radius)) / 2;
  const [a, b] = [clip(u1), clip(u2)];
  return b > a ? primitive(b) - primitive(a) : 0;
}

/**
 * キャスターの体積(車輪〔双輪は 2 つ〕+ フォーク〔双輪は本体〕の箱 − 車輪と重なる所 + 板 − 穴、またはねじの円柱。取付けを作らない行は足さない)。
 * 成り立たない時は null。
 */
export function casterVolume(dims: CasterDimensions): number | null {
  if (!casterValid(dims)) return null;
  const { wheelDiameter: d, wheelWidth: w, offset: e, mount } = dims;
  const radius = d / 2;
  const wheel = Math.PI * radius * radius * w * wheelStarts(dims).length;
  const fork = (e + d / 2) * 2 * boxHalfWidth(dims) * (forkTop(dims) - radius);
  // フォークの箱(x は −e − d/4〜d/4、z は車輪の中心より上)と車輪の重なり。車輪の中心からの横の距離に直して、上半分の円の面積 × 重なる幅
  // (1 輪は車輪の幅、双輪は食い込みの幅 t の 2 輪ぶん)。
  const overlap = upperHalfDiskArea(radius, -d / 4, e + d / 4) * (dims.twinGap === undefined ? w : 2 * twinOverlap(dims));
  if (mount.kind === 'plate') {
    const holes = mount.holes.reduce((sum, [, , size]) => sum + Math.PI * (size / 2) ** 2, 0);
    return wheel + fork - overlap + (mount.width * mount.depth - holes) * mount.thickness;
  }
  if (mount.kind === 'none') return wheel + fork - overlap;
  const size = findMetricThread(mount.thread);
  return size === undefined ? null : wheel + fork - overlap + Math.PI * (size.diameter / 2) ** 2 * mount.length;
}
