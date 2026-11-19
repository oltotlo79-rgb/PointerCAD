/**
 * ねじ込み式管継手(エルボ・チーズ・ソケット。K-28)の簡略形状。部品の座標の原点は継手の中心(ソケットは一方の端面の中心)。
 *
 * - エルボ(90°): +X と +Z へ伸びる腕の円柱(中心から端面まで A、外径 outerDiameter)と、角の球(同じ径)の和から、各端面から中心まで
 *   ねじの谷の径(管用テーパねじの基準径の位置の谷の径 d1)の穴を引く。
 * - チーズ(同径): −X・+X・+Z の 3 本の腕。
 * - ソケット(同径): 長さ L・外径 outerDiameter の輪(内は d1)。軸は +Z。
 * 帯・リブ・面取り・ねじの山とテーパは作らない(行の注と部品表の「簡略形状」)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../../../part/createPartDocument.js';
import type { PartDocument, PrimitiveFeature } from '../../../part/types.js';
import { appendBoolean, appendRing, origin, withName } from '../../standard/partPrimitives.js';

export interface PipeFittingDimensions {
  /** エルボ・チーズの中心から端面まで A、ソケットの長さ L(mm)。 */
  readonly length: number;
  /** 腕・輪の外径(mm)。 */
  readonly outerDiameter: number;
  /** ねじの谷の径 d1(mm。穴の径)。 */
  readonly boreDiameter: number;
}

export type PipeFittingKind = 'elbow' | 'tee' | 'socket';

/** 腕の向き(継手の中心から外へ)。 */
type ArmDirection = '+x' | '-x' | '+z';

const ARMS: Readonly<Record<Exclude<PipeFittingKind, 'socket'>, readonly ArmDirection[]>> = { elbow: ['+x', '+z'], tee: ['-x', '+x', '+z'] };

function dimensionsValid(dims: PipeFittingDimensions): boolean {
  return [dims.length, dims.outerDiameter, dims.boreDiameter].every((value) => Number.isFinite(value) && value > 0)
    && dims.boreDiameter < dims.outerDiameter && dims.outerDiameter / 2 < dims.length;
}

/** 腕の向きの円柱(−X の腕は、端面 x = −A から +X へ伸ばす)。 */
function armCylinder(document: PartDocument, direction: ArmDirection, radius: number, length: number):
{ readonly document: PartDocument; readonly feature: PrimitiveFeature } {
  const start = direction === '-x' ? origin(-length, 0, 0) : origin(0, 0, 0);
  const created = createPrimitiveFeature(document, 'cylinder', start, { kind: 'world', axis: direction === '+z' ? 'z' : 'x' });
  const feature: PrimitiveFeature = { ...created,
    shape: { kind: 'cylinder', radius: expressionValueFromNumber(radius), height: expressionValueFromNumber(length) } };
  return { document: appendSolid(document, feature), feature };
}

function sphere(document: PartDocument, radius: number): { readonly document: PartDocument; readonly feature: PrimitiveFeature } {
  const created = createPrimitiveFeature(document, 'sphere', origin(0, 0, 0));
  const feature: PrimitiveFeature = { ...created, shape: { kind: 'sphere', radius: expressionValueFromNumber(radius) } };
  return { document: appendSolid(document, feature), feature };
}

/** エルボ・チーズ: 腕の円柱と角の球の和 − 腕ごとの穴。 */
function buildArmed(kind: Exclude<PipeFittingKind, 'socket'>, dims: PipeFittingDimensions): PartDocument {
  const corner = sphere(createEmptyPartDocument(), dims.outerDiameter / 2);
  let document = corner.document;
  let targetId = corner.feature.id;
  for (const direction of ARMS[kind]) {
    const arm = armCylinder(document, direction, dims.outerDiameter / 2, dims.length);
    const united = appendBoolean(arm.document, 'union', targetId, arm.feature.id);
    document = united.document;
    targetId = united.feature.id;
  }
  for (const direction of ARMS[kind]) {
    const bore = armCylinder(document, direction, dims.boreDiameter / 2, dims.length);
    const cut = appendBoolean(bore.document, 'subtract', targetId, bore.feature.id);
    document = cut.document;
    targetId = cut.feature.id;
  }
  return document;
}

/** 継手の形。寸法が作れない時は null。 */
export function buildPipeFittingPart(kind: PipeFittingKind, dims: PipeFittingDimensions, name: string): PartDocument | null {
  if (!dimensionsValid(dims)) return null;
  if (kind === 'socket') {
    return withName(appendRing(createEmptyPartDocument(), dims.boreDiameter / 2, dims.outerDiameter / 2, dims.length).document, name);
  }
  return withName(buildArmed(kind, dims), name);
}

/**
 * 直交する 2 本の円柱(半径 r)の、両方の軸の正の側だけ(エルボ)・一方の正の側だけ(チーズ)の重なりの体積。2 本の円柱の重なり
 * (直交する円柱の共通部分)の全体は 16r³/3 で、エルボはその 1/4、チーズは 1/2。
 */
function crossingOverlap(kind: Exclude<PipeFittingKind, 'socket'>, radius: number): number {
  return (kind === 'elbow' ? 4 : 8) * radius ** 3 / 3;
}

/**
 * 形の台本どおりの体積(mm³。中心から端面まで A は外径の半分より長い)。
 * - エルボ: 腕 2 本(各 πR²A)− 腕の重なり(4R³/3)+ 球のうち腕の外の 1/4(πR³/3)。穴は 2 本(各 πr²A)− 重なり(4r³/3)。
 * - チーズ: X の通しの腕(πR²·2A)と +Z の腕(πR²A)− 重なり(8R³/3)。球は X の腕の中に入る。穴も同じ形(r で)。
 * - ソケット: π(R² − r²)L。
 */
export function pipeFittingVolume(kind: PipeFittingKind, dims: PipeFittingDimensions): number | null {
  if (!dimensionsValid(dims)) return null;
  const outer = dims.outerDiameter / 2, inner = dims.boreDiameter / 2;
  if (kind === 'socket') return Math.PI * (outer ** 2 - inner ** 2) * dims.length;
  const arms = ARMS[kind].length;
  const shell = (radius: number): number => arms * Math.PI * radius ** 2 * dims.length - crossingOverlap(kind, radius);
  const corner = kind === 'elbow' ? Math.PI * outer ** 3 / 3 : 0;
  return shell(outer) + corner - shell(inner);
}
