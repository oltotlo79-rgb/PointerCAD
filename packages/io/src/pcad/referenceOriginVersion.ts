/** Refuse new saved identity fields under an older document schema. */
import { isRecord, isUnknownArray } from './guards.js';

function savedSubShapeRef(value: Record<string, unknown>): boolean {
  return typeof value['bodyFeatureId'] === 'string'
    && typeof value['index'] === 'number'
    && isRecord(value['fingerprint']);
}

function savedCanvas(value: Record<string, unknown>): boolean {
  return typeof value['imageId'] === 'string' && typeof value['plane'] === 'string'
    && typeof value['id'] === 'string';
}

/** All part, assembly and drawing reference families share this structural saved-ref boundary. */
export function assertReferenceOriginVersion(document: unknown, schemaVersion: number): void {
  if (schemaVersion >= 18) return;
  const pending: unknown[] = [document];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== 'object' || current === null || seen.has(current)) continue;
    seen.add(current);
    if (isUnknownArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    if (!isRecord(current)) continue;
    if (savedSubShapeRef(current) && Object.hasOwn(current, 'origin')) {
      throw new RangeError('意味起点を保存するには保存形式の版18が必要です。');
    }
    if (savedCanvas(current) && Object.hasOwn(current, 'rectification')) {
      throw new RangeError('下絵の四隅補正を保存するには保存形式の版18が必要です。');
    }
    for (const value of Object.values(current)) pending.push(value);
  }
}
