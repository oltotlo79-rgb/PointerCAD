/**
 * 段の並びで表す部品(2 冊目のパイプ形のフレームのキャップとフット。統括の決定 2026-11-17 19:1x・19:2x)の形。
 * 中心の線(部品の Z)のまわりに、円柱か四角の柱の段を z = 0 から順に積み、段の中の穴(記入のある径だけ)を抜き、おねじは呼びの径の円柱を
 * 一番上の段の上に立てる(ねじの山は入れない)。記入の無い段・めねじ・付属品のボルトは作らない(行の簡略の印に出す)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../../../part/createPartDocument.js';
import type { PartDocument, PrimitiveFeature } from '../../../part/types.js';
import { findMetricThread } from '../../../thread/metricThread.js';
import { appendBoolean, appendCylinder, origin } from '../../standard/partPrimitives.js';

/** 段 1 つ(mm)。bore は段を通す中の穴の径(無ければ null)。 */
export type StackSegment =
  | { readonly shape: 'circle'; readonly diameter: number; readonly height: number; readonly bore: number | null }
  | { readonly shape: 'square'; readonly width: number; readonly depth: number; readonly height: number; readonly bore: number | null };

export interface StackedPartDimensions {
  readonly segments: readonly StackSegment[];
  /** 一番上の段の上に立てるおねじ(呼びと長さ)。無ければ null。 */
  readonly thread: { readonly size: string; readonly length: number } | null;
}

const positive = (...values: readonly number[]): boolean => values.every((value) => Number.isFinite(value) && value > 0);

/** 段の一番細い所(円は径、四角は幅と奥行の小さい方)。 */
function narrowest(segment: StackSegment): number {
  return segment.shape === 'circle' ? segment.diameter : Math.min(segment.width, segment.depth);
}

function segmentValid(segment: StackSegment): boolean {
  const sized = segment.shape === 'circle' ? positive(segment.diameter, segment.height) : positive(segment.width, segment.depth, segment.height);
  return sized && (segment.bore === null || (positive(segment.bore) && segment.bore < narrowest(segment)));
}

function stackValid(dims: StackedPartDimensions): boolean {
  const top = dims.segments[dims.segments.length - 1];
  if (top === undefined || !dims.segments.every(segmentValid)) return false;
  if (dims.thread === null) return true;
  const size = findMetricThread(dims.thread.size);
  return size !== undefined && positive(dims.thread.length) && size.diameter < narrowest(top) && top.bore === null;
}

function appendBox(document: PartDocument, width: number, depth: number, height: number, z: number):
{ readonly document: PartDocument; readonly feature: PrimitiveFeature } {
  const created = createPrimitiveFeature(document, 'box', origin(0, 0, z + height / 2));
  const feature: PrimitiveFeature = { ...created, shape: { kind: 'box', sizeX: expressionValueFromNumber(width), sizeY: expressionValueFromNumber(depth),
    sizeZ: expressionValueFromNumber(height) } };
  return { document: appendSolid(document, feature), feature };
}

/** 段の並びの部品の形(段ごとの円柱・四角の柱の和、中の穴を引き、おねじの円柱を足す)。形が成り立たない時は null。 */
export function buildStackedPart(dims: StackedPartDimensions): PartDocument | null {
  if (!stackValid(dims)) return null;
  let document = createEmptyPartDocument();
  let body: string | null = null;
  let z = 0;
  for (const segment of dims.segments) {
    const added = segment.shape === 'circle'
      ? appendCylinder(document, segment.diameter / 2, expressionValueFromNumber(segment.height), z)
      : appendBox(document, segment.width, segment.depth, segment.height, z);
    document = added.document;
    let piece = added.feature.id;
    if (segment.bore !== null) {
      const bore = appendCylinder(document, segment.bore / 2, expressionValueFromNumber(segment.height), z);
      const cut = appendBoolean(bore.document, 'subtract', piece, bore.feature.id);
      document = cut.document;
      piece = cut.feature.id;
    }
    if (body === null) {
      body = piece;
    } else {
      const joined = appendBoolean(document, 'union', body, piece);
      document = joined.document;
      body = joined.feature.id;
    }
    z += segment.height;
  }
  const size = dims.thread === null ? undefined : findMetricThread(dims.thread.size);
  if (dims.thread !== null && size !== undefined && body !== null) {
    const rod = appendCylinder(document, size.diameter / 2, expressionValueFromNumber(dims.thread.length), z);
    document = appendBoolean(rod.document, 'union', body, rod.feature.id).document;
  }
  return document;
}

/** 段の並びの部品の体積(段の体積 − 中の穴 + おねじの円柱)。形が成り立たない時は null。 */
export function stackedPartVolume(dims: StackedPartDimensions): number | null {
  if (!stackValid(dims)) return null;
  const segments = dims.segments.reduce((sum, segment) => {
    const area = segment.shape === 'circle' ? Math.PI * segment.diameter ** 2 / 4 : segment.width * segment.depth;
    const bore = segment.bore === null ? 0 : Math.PI * segment.bore ** 2 / 4;
    return sum + (area - bore) * segment.height;
  }, 0);
  const size = dims.thread === null ? undefined : findMetricThread(dims.thread.size);
  const rod = dims.thread === null || size === undefined ? 0 : Math.PI * size.diameter ** 2 / 4 * dims.thread.length;
  return segments + rod;
}

/** 段の並びの部品の高さ(段の高さの和 + おねじの長さ)。 */
export function stackedPartHeight(dims: StackedPartDimensions): number {
  return dims.segments.reduce((sum, segment) => sum + segment.height, 0) + (dims.thread?.length ?? 0);
}
