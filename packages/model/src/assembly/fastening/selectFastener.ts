/**
 * 締結に使う規格部品の行と呼び長さの選択(EX-06)。数値は既存の寸法表だけから読む。
 *
 * - ねじ穴の時は呼び径とピッチの両方を穴に合わせる。
 * - 通し穴どうしの時は、確認済みの通し穴の根拠か、利用者が明示した呼びだけを使う
 *   (穴の径を丸めて近い呼びを推定しない)。
 * - 呼び長さは、ボルトの行ごとに渡された候補だけから選ぶ。全径に共通の未確認の一覧は
 *   使えるが、計画に「径ごとの有無が未確認」を残す。
 * - ねじ部の長さ b は、呼び長さ 125 以下なら寸法表の b1。125 を超える長さは、本体規格・並目で区分ごとの
 *   b の根拠(`hexBoltEvidence.ts`)がある呼びだけ選び、台本の長さの区分の版と同じ値を使う。
 *   それ以外(附属書JA・細目・根拠の無い呼び)は選ばず、欠けた事実として残す。
 */

import {
  findHexBolt, findHexNut, findPlainWasher, findSpringWasher, HEX_BOLT_NOMINAL_LENGTHS, HEX_BOLT_TABLE,
} from '../standard/fasteners.js';
import { hexBoltMainEvidence, hexBoltMainThreadLength, MISUMI_HEX_BOLT_SOURCE } from '../standard/hexBoltEvidence.js';
import type { FastenerDimensionSeries, HexBoltRow, HexNutRow } from '../standard/types.js';
import { findMetricThread, metricThreadPitch, type ThreadSeries } from '../../thread/metricThread.js';
import {
  type BoltedJointRejection, type BoltLengthAvailability, FASTENING_LENGTH_TOLERANCE_MM,
  type FasteningMissingFact, type FasteningWasherKind,
} from './types.js';

/** JIS B 1180 の b1 が適用される呼び長さの上限(mm)。 */
export const HEX_BOLT_B1_MAX_LENGTH = 125;

/**
 * 新しく置くボルトの形と同じねじ部の長さ(全長を超えない)。125mm を超えて区分ごとの b の根拠が無ければ
 * `null`(推定しない)。`buildStandardPart.ts` の長さの区分の版と同じ規則である。
 */
export function boltThreadLength(bolt: HexBoltRow, length: number, series: ThreadSeries = 'coarse'): number | null {
  if (length <= HEX_BOLT_B1_MAX_LENGTH) return Math.min(bolt.b1, length);
  const evidence = bolt.dimensionSeries === 'main' && series === 'coarse' ? hexBoltMainEvidence(bolt.size) : undefined;
  return evidence === undefined ? null : Math.min(hexBoltMainThreadLength(evidence, length), length);
}

export interface ThreadChoice {
  readonly nominal: string;
  readonly pitch: number;
  readonly series: ThreadSeries;
  readonly diameter: number;
}

export interface WasherChoice {
  readonly kind: FasteningWasherKind;
  readonly rowKey: string;
  readonly verified: boolean;
  readonly insideDiameter: number;
  readonly outsideDiameter: number;
  readonly thickness: number;
}

export interface LengthChoice {
  readonly length: number;
  /** 置くボルトの形と同じねじ部の長さ(`boltThreadLength`)。 */
  readonly threadLength: number;
  readonly basis: BoltLengthAvailability['basis'];
  readonly verified: boolean;
  readonly missingFacts: readonly FasteningMissingFact[];
}

export interface LengthLimits {
  readonly minimum: number;
  /** 止まり穴の底で決まる上限。無ければ `null`。 */
  readonly maximum: number | null;
  /**
   * 首下の円筒部(長さ − b)が終わってよい首下からの位置。ナットとねじの入口が合わせ面にある
   * ねじ穴では締め付け厚さ、入口が奥にある貫通ねじ穴では締め付け厚さ＋その深さ。
   */
  readonly gripLength: number;
}

/** ねじ穴の呼びとピッチから系列(並目・細目)を決める。表に無いピッチは断る。 */
export function threadChoiceFor(nominal: string, pitch: number): ThreadChoice | BoltedJointRejection {
  const row = findMetricThread(nominal);
  if (row === undefined) return { code: 'unknownThread', detail: { nominal } };
  for (const series of ['coarse', 'fine'] as const) {
    if (Math.abs(metricThreadPitch(row, series) - pitch) <= FASTENING_LENGTH_TOLERANCE_MM) {
      return { nominal, pitch: metricThreadPitch(row, series), series, diameter: row.diameter };
    }
  }
  return { code: 'pitchNotInCatalog', detail: { nominal, pitch } };
}

/** 利用者が明示した呼びと系列。表に無ければ断る。 */
export function explicitThreadChoice(nominal: string, series: ThreadSeries): ThreadChoice | BoltedJointRejection {
  const row = findMetricThread(nominal);
  if (row === undefined) return { code: 'unknownThread', detail: { nominal } };
  return { nominal, pitch: metricThreadPitch(row, series), series, diameter: row.diameter };
}

export function isRejection<T extends object>(value: T | BoltedJointRejection): value is BoltedJointRejection {
  return 'code' in value && 'detail' in value;
}

export function boltRowFor(thread: ThreadChoice, series: FastenerDimensionSeries): HexBoltRow | BoltedJointRejection {
  const row = findHexBolt(thread.nominal, series);
  return row ?? { code: 'boltRowMissing', detail: { nominal: thread.nominal, dimensionSeries: series } };
}

export function nutRowFor(thread: ThreadChoice, series: FastenerDimensionSeries): HexNutRow | BoltedJointRejection {
  const row = findHexNut(thread.nominal, series);
  return row ?? { code: 'nutRowMissing', detail: { nominal: thread.nominal, dimensionSeries: series } };
}

export function washerFor(kind: FasteningWasherKind, nominal: string): WasherChoice | BoltedJointRejection {
  if (kind === 'plainWasher') {
    const row = findPlainWasher(nominal);
    return row === undefined ? { code: 'washerRowMissing', detail: { kind, nominal } } : {
      kind, rowKey: row.key, verified: row.verified,
      insideDiameter: row.d1, outsideDiameter: row.d2, thickness: row.thickness,
    };
  }
  const row = findSpringWasher(nominal);
  return row === undefined ? { code: 'washerRowMissing', detail: { kind, nominal } } : {
    kind, rowKey: row.key, verified: row.verified,
    insideDiameter: row.insideDiameter, outsideDiameter: row.outsideDiameter, thickness: row.thickness,
  };
}

/**
 * 既存の全径共通の呼び長さの一覧を、ボルトの行1つの候補として包む。
 * `verified: false` と `globalUnverifiedList` を付け、径ごとの有無を確認済みとは扱わない。
 */
export function globalUnverifiedLengthAvailability(boltRowKey: string): BoltLengthAvailability {
  return {
    boltRowKey, lengths: [...HEX_BOLT_NOMINAL_LENGTHS], basis: 'globalUnverifiedList', verified: false,
    source: 'docs/standards/jis/hex-bolt-jis-b-1180.json nominalLengths (nominalLengthsVerified=false)',
  };
}

/**
 * 本体規格・並目の六角ボルトの、径ごとの推奨呼び長さ(ミスミの JIS B 1180:2014 抜粋。`hexBoltEvidence.ts`)。
 * 実行時の寸法表の本体規格の行と、ねじ部の長さ b が一致する呼びだけを確認済みとして返す
 * (表どうしの食い違いを黙って採らない)。附属書JA・細目ねじには使わない。
 */
export function verifiedMainLengthAvailability(): BoltLengthAvailability[] {
  return HEX_BOLT_TABLE.flatMap((row) => {
    const evidence = row.dimensionSeries === 'main' ? hexBoltMainEvidence(row.size) : undefined;
    if (evidence === undefined || evidence.threadLength.upTo125 !== row.b1) return [];
    return [{ boltRowKey: row.key, lengths: evidence.recommendedLengths, basis: 'perDiameterEvidence' as const,
      verified: true, source: MISUMI_HEX_BOLT_SOURCE, threadSeries: 'coarse' as const }];
  });
}

/**
 * 呼び長さを候補から選ぶ。下限以上・上限以下で、首下の円筒部(長さ − b)が締め付け厚さの中で
 * 終わる(ねじがナット・ねじ穴へ届く)最小の長さ。
 */
export function selectBoltLength(
  bolt: HexBoltRow,
  availability: readonly BoltLengthAvailability[],
  limits: LengthLimits,
  series: ThreadSeries = 'coarse',
): LengthChoice | BoltedJointRejection {
  // 並べた順に、ねじの系列が合う最初の根拠を使う(確認済みの根拠を先に並べる)。
  const entry = availability.find((candidate) => candidate.boltRowKey === bolt.key
    && (candidate.threadSeries === undefined || candidate.threadSeries === series));
  if (entry === undefined) return { code: 'lengthAvailabilityMissing', detail: { boltRowKey: bolt.key } };
  const missing = new Set<FasteningMissingFact>();
  if (entry.basis === 'globalUnverifiedList' || !entry.verified) missing.add('perDiameterLengthAvailability');
  const sorted = [...entry.lengths].filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  let shankBeyondGrip = false;
  for (const length of sorted) {
    if (length < limits.minimum - FASTENING_LENGTH_TOLERANCE_MM) continue;
    if (limits.maximum !== null && length > limits.maximum + FASTENING_LENGTH_TOLERANCE_MM) break;
    const thread = boltThreadLength(bolt, length, series);
    if (thread === null) {
      missing.add('threadLengthAbove125');
      break;
    }
    if (length - thread > limits.gripLength + FASTENING_LENGTH_TOLERANCE_MM) {
      shankBeyondGrip = true;
      // b increases at 125/200mm; a later candidate can have a shorter unthreaded shank.
      continue;
    }
    return { length, threadLength: thread, basis: entry.basis, verified: entry.verified, missingFacts: [...missing] };
  }
  return {
    code: 'noStandardLengthFits',
    detail: {
      boltRowKey: bolt.key, minimum: limits.minimum, maximum: limits.maximum ?? 'none',
      reason: shankBeyondGrip ? 'shankBeyondGrip' : missing.has('threadLengthAbove125') ? 'threadLengthAbove125' : 'noCandidate',
    },
  };
}
