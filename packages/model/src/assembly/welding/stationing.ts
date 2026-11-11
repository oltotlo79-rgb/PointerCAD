/** 直線の溶接線に沿ったビードの区間割り。連続、または長さと間隔を区間ごとに変えた断続。純関数、長さは mm。 */

import { MAX_MOVABLE_COMPONENTS } from '../constraints/mateVariables.js';
import {
  type FilletWeldRejection, WELD_LENGTH_TOLERANCE_MM, type WeldSegmentSpec,
} from './types.js';

/**
 * 1 つの溶接が持てるビードの数の上限。ビードは 1 区間が 1 つの部品なので、組立が扱える部品の上限
 * (`MAX_MOVABLE_COMPONENTS` = 100、`mateVariables.ts` の変数の予算 600 ÷ 6)を超える数は作れない。
 * 配列を作る前にこの上限で断る。
 */
export const MAX_WELD_SEGMENTS = MAX_MOVABLE_COMPONENTS;

/**
 * 区間が当たりの辺の内側にあるかの唯一の規則。計画(`stationRejections`)と保存した台本の読み取り
 * (`filletWeldSegmentOptions`)が同じこの関数を使うので、計画が通った区間は必ず読み戻せる。
 * 始点は 0 以上(負は許容差の内でも認めない。保存の文字列に負の数を書かない)、長さは許容差より長く、
 * 終点は辺の長さ + 許容差まで。
 */
export function segmentWithinContact(start: number, length: number, contactLength: number): boolean {
  return Number.isFinite(start) && Number.isFinite(length) && Number.isFinite(contactLength)
    && start >= 0 && length > WELD_LENGTH_TOLERANCE_MM && start + length <= contactLength + WELD_LENGTH_TOLERANCE_MM;
}

/** 区間の数として受け付けるか(安全な整数、1 以上、上限以下)。 */
function acceptableCount(count: number): boolean {
  return Number.isSafeInteger(count) && count >= 1 && count <= MAX_WELD_SEGMENTS;
}

/**
 * 等間隔の断続ビード。`start` から、始点の間隔 `pitch` で長さ `length` のビードを `count` 本。
 * 有限でない値・整数でない本数・上限を超える本数は配列を作らずに `null`(端数を切り捨てない)。
 */
export function intermittentSegments(start: number, length: number, pitch: number, count: number): WeldSegmentSpec[] | null {
  if (!Number.isFinite(start) || !Number.isFinite(length) || !Number.isFinite(pitch) || !acceptableCount(count)) return null;
  return Array.from({ length: count }, (_, index) => ({ start: start + index * pitch, length }));
}

/**
 * 始点を決め、ビードの長さとその後の間隔を交互に並べる。間隔はちょうど「長さの数 − 1」個(足りない間隔を
 * 0 で補わない)。数が合わない・有限でない・上限を超える時は `null`。
 */
export function segmentsFromLengthsAndGaps(
  start: number, lengths: readonly number[], gaps: readonly number[],
): WeldSegmentSpec[] | null {
  if (!Number.isFinite(start) || !acceptableCount(lengths.length) || gaps.length !== lengths.length - 1
    || ![...lengths, ...gaps].every((value) => Number.isFinite(value))) return null;
  const out: WeldSegmentSpec[] = [];
  let station = start;
  lengths.forEach((length, index) => {
    out.push({ start: station, length });
    station += length + (gaps[index] ?? 0);
  });
  return out;
}

/** ビードが実際に覆う合計の長さ(確かめた後の区間は重ならない)。 */
export function occupiedLength(segments: readonly WeldSegmentSpec[]): number {
  return segments.reduce((sum, segment) => sum + segment.length, 0);
}

/**
 * 各区間が有限・`segmentWithinContact` を満たし・始点の昇順で、前の区間と重ならないこと
 * (端が接するのは許し、別のビードのまま)。区間の数は 1 以上 `MAX_WELD_SEGMENTS` 以下。
 */
export function stationRejections(
  segments: readonly WeldSegmentSpec[], contactLength: number,
): FilletWeldRejection[] {
  if (segments.length === 0) return [{ code: 'noSegments', detail: {} }];
  if (segments.length > MAX_WELD_SEGMENTS) {
    return [{ code: 'tooManySegments', detail: { count: segments.length, maximum: MAX_WELD_SEGMENTS } }];
  }
  const out: FilletWeldRejection[] = [];
  segments.forEach((segment, index) => {
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.length) || segment.length <= WELD_LENGTH_TOLERANCE_MM) {
      out.push({ code: 'invalidDimension', detail: { segment: index, start: segment.start, length: segment.length } });
      return;
    }
    if (!segmentWithinContact(segment.start, segment.length, contactLength)) {
      out.push({ code: 'segmentOutsideContact', detail: { segment: index, start: segment.start, length: segment.length, contactLength } });
    }
    const previous = index > 0 ? segments[index - 1] : undefined;
    if (previous !== undefined && Number.isFinite(previous.start) && Number.isFinite(previous.length)) {
      if (segment.start < previous.start - WELD_LENGTH_TOLERANCE_MM) {
        out.push({ code: 'segmentsUnordered', detail: { segment: index } });
      } else if (segment.start < previous.start + previous.length - WELD_LENGTH_TOLERANCE_MM) {
        out.push({ code: 'segmentsOverlap', detail: { segment: index, overlap: previous.start + previous.length - segment.start } });
      }
    }
  });
  return out;
}
