import { isRecord, isUnknownArray } from './guards.js';

/** JSON.parseは1e999をInfinityにするため、型だけでなく全数値を確認する。 */
export function hasOnlyFiniteJsonNumbers(value: unknown): boolean {
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'number' && !Number.isFinite(current)) return false;
    if (typeof current !== 'object' || current === null || visited.has(current)) continue;
    visited.add(current);
    if (isUnknownArray(current)) {
      for (const item of current) pending.push(item);
    } else if (isRecord(current)) {
      for (const item of Object.values(current)) pending.push(item);
    }
  }
  return true;
}

/** 現行で導出専用と分かっている欄。将来版の未知の指定と区別する。 */
function derivedField(path: readonly string[], key: string, value: unknown): boolean {
  if (['derivedWidth', 'derivedHeight', 'projectionCache', 'tessellation', 'brep', 'mesh', 'resolvedViews', 'renderItems', 'viewFrames'].includes(key)) return true;
  if (path.length === 2 && path[0] === 'views' && path[1] === '*') {
    return ['projectedLines', 'projectedCurves', 'curves', 'cuttingCurves', 'breakCurves', 'hatchCurves', 'centerCurves', 'cuttingAreas'].includes(key)
      || ((key === 'visible' || key === 'hidden') && isUnknownArray(value));
  }
  if (['datums', 'gdtFrames', 'weldSymbols'].includes(path[0] ?? '')) {
    if (['resolvedFeature', 'shapeKeys', 'paperPoint', 'valueMm', 'rowWidths', 'compartmentWidths', 'renderElements', 'issues'].includes(key)) return true;
  }
  return path.length === 2 && path[0] === 'dimensions' && path[1] === '*'
    && ['value', 'measuredValue', 'resolvedValue', 'geometry', 'progressive'].includes(key);
}

/**
 * 型を検査して作り直した保存形へ、未知の指定だけを戻す。cleanは新規オブジェクト。
 * 型の既知欄をraw値で上書きしない。__proto__も通常のデータ欄として保つ。
 */
export function preserveDrawingJsonFields<T>(source: unknown, clean: T, path: readonly string[] = []): T {
  if (isUnknownArray(source) && isUnknownArray(clean)) {
    clean.forEach((value, index) => preserveDrawingJsonFields(source[index], value, [...path, '*']));
    return clean;
  }
  if (!isRecord(source) || !isRecord(clean)) return clean;
  for (const key of Object.keys(clean)) {
    preserveDrawingJsonFields(source[key], clean[key], [...path, key]);
  }
  for (const key of Object.keys(source).sort()) {
    if (Object.hasOwn(clean, key) || derivedField(path, key, source[key])) continue;
    Object.defineProperty(clean, key, { value: structuredClone(source[key]), enumerable: true, configurable: true, writable: true });
  }
  return clean;
}
