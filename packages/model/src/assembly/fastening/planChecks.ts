/**
 * 締結の計画の寸法の確かめ(EX-06): 穴とボルトのすきま、座面が穴を覆うか、長さの上下限。
 *
 * 座面径 dw は実行時の寸法表に無い。本体規格・並目で根拠のある呼びのボルトの頭だけ、根拠の dw の最小値
 * (`hexBoltEvidence.ts`)を使う。それ以外の頭とナット(座金なし)は二面幅 s を上限に使い、
 * 「座面径が未確認」を欠けた事実として残す(s より小さい穴でも dw を覆うとは保証しない)。
 */

import { hexBoltMainEvidence } from '../standard/hexBoltEvidence.js';
import type { HexBoltRow, HexNutRow } from '../standard/types.js';
import type { WorldHole } from './frames.js';
import type { LengthLimits, ThreadChoice, WasherChoice } from './selectFastener.js';
import {
  type BoltedJointRejection, type BoltedJointRequest, FASTENING_LENGTH_TOLERANCE_MM, type FasteningMissingFact,
} from './types.js';

export interface ClearanceInput {
  readonly thread: ThreadChoice;
  readonly bolt: HexBoltRow;
  readonly nut: HexNutRow | null;
  readonly head: WorldHole;
  readonly far: WorldHole;
  readonly headStack: readonly WasherChoice[];
  readonly nutStack: readonly WasherChoice[];
  readonly missing: Set<FasteningMissingFact>;
}

function holeDiameter(hole: WorldHole): number | null {
  const spec = hole.selection.hole;
  return spec.kind === 'clearance' ? spec.diameter : null;
}

function bearingRejections(
  hole: WorldHole, diameter: number, stack: readonly WasherChoice[], bearing: number, bearingVerified: boolean,
  input: ClearanceInput,
): BoltedJointRejection[] {
  const out: BoltedJointRejection[] = [];
  for (const washer of stack) {
    if (washer.insideDiameter <= input.thread.diameter + FASTENING_LENGTH_TOLERANCE_MM) {
      out.push({ code: 'washerDoesNotFit', detail: { rowKey: washer.rowKey, insideDiameter: washer.insideDiameter } });
    }
  }
  const adjacent = stack[0];
  if (adjacent !== undefined) {
    if (adjacent.outsideDiameter <= diameter + FASTENING_LENGTH_TOLERANCE_MM) {
      out.push({ code: 'holeLargerThanBearing', detail: { componentId: hole.component.id, diameter, bearing: adjacent.outsideDiameter } });
    }
    return out;
  }
  if (!bearingVerified) input.missing.add('bearingFaceDiameter');
  if (bearing <= diameter + FASTENING_LENGTH_TOLERANCE_MM) {
    out.push({ code: 'holeLargerThanBearing', detail: { componentId: hole.component.id, diameter, bearing } });
  }
  return out;
}

/**
 * ボルトの頭の座面径。本体規格・並目の根拠がある呼びは座面径 dw の最小値(確認済み)、
 * それ以外は二面幅 s を上限に使い、座面径は未確認のまま残す。
 */
function headBearing(input: ClearanceInput): { readonly value: number; readonly verified: boolean } {
  const evidence = input.bolt.dimensionSeries === 'main' && input.thread.series === 'coarse'
    ? hexBoltMainEvidence(input.bolt.size) : undefined;
  return evidence === undefined ? { value: input.bolt.s, verified: false } : { value: evidence.bearingDiameterMin, verified: true };
}

/** 通し穴がボルトより大きく、頭・ナット(または座金)より小さいこと。 */
export function clearanceRejections(input: ClearanceInput): BoltedJointRejection[] {
  const out: BoltedJointRejection[] = [];
  for (const hole of [input.head, input.far]) {
    const diameter = holeDiameter(hole);
    if (diameter !== null && diameter <= input.thread.diameter + FASTENING_LENGTH_TOLERANCE_MM) {
      out.push({ code: 'insufficientClearance', detail: { componentId: hole.component.id, diameter, bolt: input.thread.diameter } });
    }
  }
  if (out.length > 0) return out;
  const headDiameter = holeDiameter(input.head);
  if (headDiameter !== null) {
    const bearing = headBearing(input);
    out.push(...bearingRejections(input.head, headDiameter, input.headStack, bearing.value, bearing.verified, input));
  }
  const farDiameter = holeDiameter(input.far);
  if (farDiameter !== null && input.nut !== null) {
    // ナットの座面径の根拠はまだ無い。二面幅を上限に使い、未確認として残す。
    out.push(...bearingRejections(input.far, farDiameter, input.nutStack, input.nut.s, false, input));
  }
  return out;
}

/** 有限で下限以上(`allowZero` なら 0 を含む)の数だけを返す。それ以外は `null`。 */
function measured(value: number | undefined, allowZero: boolean): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return value > 0 || (allowZero && value === 0) ? value : null;
}

/**
 * 呼び長さの下限・上限。
 * - ナット: 締め付け厚さ＋ナットの高さ(mMax)＋指定した突き出し。
 * - ねじ穴: 締め付け厚さ＋指定したねじ込み長さ。止まり穴は有効なねじ部の底から指定のすきまを残す。
 */
export function lengthLimits(
  request: BoltedJointRequest, far: WorldHole, grip: number, nut: HexNutRow | null,
): LengthLimits | BoltedJointRejection {
  const hole = far.selection.hole;
  if (hole.kind === 'clearance') {
    if (nut === null) return { code: 'nutRowMissing', detail: { componentId: far.component.id } };
    const protrusion = measured(request.minimumProtrusion, true);
    if (protrusion === null) {
      return { code: 'protrusionRequired', detail: { value: request.minimumProtrusion ?? 'missing' } };
    }
    return { minimum: grip + nut.mMax + protrusion, maximum: null, gripLength: grip };
  }
  const engagement = measured(request.engagement, false);
  if (engagement === null) {
    return { code: 'engagementRequired', detail: { value: request.engagement ?? 'missing' } };
  }
  if (hole.kind === 'throughThreaded') {
    if (engagement > hole.threadLength + FASTENING_LENGTH_TOLERANCE_MM) {
      return { code: 'engagementExceedsThread', detail: { engagement, threadLength: hole.threadLength } };
    }
    // ねじ部が合わせ面から threadStart 奥で始まる穴では、ボルトのねじもそこまで届く必要がある。
    return { minimum: grip + hole.threadStart + engagement, maximum: null, gripLength: grip + hole.threadStart };
  }
  const bottomClearance = measured(request.blindBottomClearance, true);
  if (bottomClearance === null) {
    return { code: 'blindClearanceRequired', detail: { value: request.blindBottomClearance ?? 'missing' } };
  }
  const usable = hole.usableThreadDepth - bottomClearance;
  if (engagement > usable + FASTENING_LENGTH_TOLERANCE_MM) {
    return { code: 'blindBottoming', detail: { engagement, usable } };
  }
  return { minimum: grip + engagement, maximum: grip + usable, gripLength: grip };
}
