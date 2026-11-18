/**
 * 板の族(パネルボード・ベースプレート。統括の決定 2026-11-18 13:2x の (3))の形: 幅 × 高さの長方形を板厚だけ押し出した箱。
 * 網目・パンチングの穴・中空の脚・気泡・表面材は作らない(族の行の簡略の印に出す)。原点は外形の中心。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import type { PartDocument } from '../../../part/types.js';
import { buildProfileSection, type ProfileLoops } from '../../standard/profileExtrusion.js';
import type { SteelProfilePoint, SteelProfileSegment } from '../../standard/steelSectionProfiles.js';

export interface PanelBoardDimensions {
  readonly width: number;
  readonly height: number;
  readonly thickness: number;
}

const positive = (...values: readonly number[]): boolean => values.every((value) => Number.isFinite(value) && value > 0);

/** 板の輪(幅 × 高さの長方形、外形の中心が原点)と面積。寸法が正でない時は null。 */
export function panelBoardProfile(dims: PanelBoardDimensions): (ProfileLoops & { readonly areaMm2: number }) | null {
  if (!positive(dims.width, dims.height, dims.thickness)) return null;
  const [x, y] = [dims.width / 2, dims.height / 2];
  const points: readonly SteelProfilePoint[] = [[-x, -y], [x, -y], [x, y], [-x, y]];
  const segments = points.map((from, index): SteelProfileSegment => ({ kind: 'line', from, to: points[(index + 1) % points.length] ?? from }));
  return { segments, holes: [], areaMm2: dims.width * dims.height };
}

/** 板の形(板厚を Z へ押し出す)。寸法が正でない時は null。 */
export function buildPanelBoardPart(dims: PanelBoardDimensions): PartDocument | null {
  const profile = panelBoardProfile(dims);
  return profile === null ? null : buildProfileSection(profile, expressionValueFromNumber(dims.thickness));
}

/**
 * 寸法が上限(資料のサイズ MAX)に収まるか。板は向きを変えて使えるので、幅と高さを入れ替えて収まってもよい。上限の無い行(null)は常に収まる。
 */
export function fitsPanelMax(width: number, height: number, max: readonly [number, number] | null): boolean {
  if (max === null) return true;
  const [a, b] = max;
  return (width <= a && height <= b) || (width <= b && height <= a);
}
