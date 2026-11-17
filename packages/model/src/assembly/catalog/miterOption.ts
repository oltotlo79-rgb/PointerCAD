/**
 * 長さを持つ溝つきアルミフレームの族の「留め」の欄と、留めで切った形・体積・質量の長さ(J-01 包み 5)。
 *
 * 欄は一括配置の留めの角だけが書く任意の欄(`optional`)で、保存に無ければ「切らない」として読み、切らない時は書き出さない。
 * 切らない部品は、形の台本の結果も保存の形も欄を足す前と同じ(形の台本の版は上げない。前の版は留めの欄を持つ部品を
 * 「保存の欄が合わない」で断り、黙って直角の形にしない)。
 *
 * 質量: 族が単位質量を持つ時は「単位質量 × 留めを引いた後の体積 ÷ 断面積」(断面の図心の位置での長さ。統括の決定 2026-11-17)。
 * 体積と断面積はどちらも簡略の形の物で、その比を行の単位質量(資料の値)に掛ける。外形の中心に対して対称な断面では
 * 「長い側の長さ − 留めの端ごとの h」と同じ値で、片側だけ溝の断面でも形の体積と合う。留めの無い時は長さそのまま(前と同じ値)。
 * 切断の一覧の材料の長さは長い側の長さ(切る前の棒の長さ)で、質量は部品表と同じ値を使う。
 */
import type { ExpressionValue } from '@pointercad/expression';

import type { PartDocument } from '../../part/types.js';
import { FRAME_MITERS, type FrameSectionBounds } from '../frame/frameMembers.js';
import { buildProfileSection, type ProfileLoops } from '../standard/profileExtrusion.js';
import { applyMiterCuts, miterEndsOf, miterFits, miteredVolume } from '../standard/profileMiter.js';
import type { CatalogOptionSpec } from './types.js';

const MITER_NONE = 'none';

/** 留めの欄(始点・終点)。選ぶ画面には出さない。 */
export const MITER_OPTION_SPECS: readonly CatalogOptionSpec[] = ['startMiter', 'endMiter'].map((key): CatalogOptionSpec => ({
  key, kind: 'choice', labelKey: `catalog.frame.${key}`, choices: [MITER_NONE, ...FRAME_MITERS], defaultValue: MITER_NONE, optional: true,
}));

/** 断面を長さだけ押し出し、留めの欄の端を切った形。切らない時は `buildProfileSection` のまま。作れない時は null。 */
export function buildMiteredSection(profile: ProfileLoops, length: ExpressionValue, bounds: FrameSectionBounds | null,
  values: Readonly<Record<string, string>>): PartDocument | null {
  return applyMiterCuts(buildProfileSection(profile, length), bounds, miterEndsOf(values), length.value);
}

/** 留めで切った形の体積(台本の期待値)。切らない時は 面積 × 長さ。 */
export function miteredSectionVolume(profile: ProfileLoops & { readonly areaMm2: number }, bounds: FrameSectionBounds | null,
  values: Readonly<Record<string, string>>, length: number): number | null {
  const cuts = miterEndsOf(values);
  if (cuts.length === 0) return profile.areaMm2 * length;
  return bounds === null || !miterFits(bounds, cuts, length) ? null : miteredVolume(profile, profile.areaMm2, bounds, cuts, length);
}

/**
 * 単位質量に掛ける長さ: 留めを引いた後の簡略の形の体積 ÷ 簡略の形の断面積(断面の図心の位置での長さ)。
 * 切らない時は長さのまま(割り算の端数を入れない)。作れない時は null。
 */
export function miteredMassLength(profile: (ProfileLoops & { readonly areaMm2: number }) | null, bounds: FrameSectionBounds | null,
  values: Readonly<Record<string, string>>, length: number): number | null {
  if (miterEndsOf(values).length === 0) return length;
  const volume = profile === null ? null : miteredSectionVolume(profile, bounds, values, length);
  return volume === null || profile === null || !(profile.areaMm2 > 0) ? null : volume / profile.areaMm2;
}
