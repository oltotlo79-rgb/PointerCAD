/** 古い読み手が面の穴を捨てないよう、保存形式の境界で断る。 */
import type { PartDocument } from '@pointercad/model';
import { isRecord, isUnknownArray } from './guards.js';

export function hasSketchFaceHolesField(document: unknown): boolean {
  if (!isRecord(document) || !isUnknownArray(document['sketches'])) return false;
  return document['sketches'].some(sketch => isRecord(sketch) && isUnknownArray(sketch['features'])
    && sketch['features'].some(feature => isRecord(feature) && feature['kind'] === 'face' && Object.hasOwn(feature, 'holes')));
}

export function assertSketchFaceHolesVersion(document: PartDocument): void {
  if (document.schemaVersion >= 23) return;
  if (document.sketches.some(sketch => sketch.features.some(feature => feature.kind === 'face' && (feature.holes?.length ?? 0) > 0))) {
    throw new RangeError('穴つきの面を保存するには保存形式の版23が必要です。');
  }
}
