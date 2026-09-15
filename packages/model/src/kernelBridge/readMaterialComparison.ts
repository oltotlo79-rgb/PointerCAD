import type { MaterialComparisonResult, MaterialDifferenceRegion } from './materialComparisonContracts.js';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const invalid = (): MaterialComparisonResult => ({ kind: 'failed', message: '形の比較結果を確認できませんでした。再度お試しください。' });

/** 通信で壊れた三角形や不完全な差分を、描画や「変更なし」の結果へ渡さない。 */
export function readMaterialComparison(value: unknown): MaterialComparisonResult {
  if (!record(value)) return invalid();
  if (value.kind === 'cancelled') return { kind: 'cancelled' };
  if (value.kind === 'failed') return typeof value.message === 'string' && value.message.length > 0 && value.message.length <= 4096
    ? { kind: 'failed', message: value.message } : invalid();
  if (value.kind !== 'compared' || !record(value.result)) return invalid();
  const result = value.result;
  if (!nonnegative(result.beforeVolume) || !nonnegative(result.afterVolume)) return invalid();
  let triangleTotal = 0;
  function region(item: unknown): MaterialDifferenceRegion | null {
    if (!record(item)) return null;
    if (item.kind === 'empty') return item.volume === 0 && item.mesh === null ? { kind: 'empty', volume: 0, mesh: null } : null;
    if (item.kind !== 'material' || !nonnegative(item.volume) || item.volume === 0 || !record(item.mesh)) return null;
    const { positions, normals, indices, triangleCount } = item.mesh;
    if (!(positions instanceof Float32Array) || !(normals instanceof Float32Array) || !(indices instanceof Uint32Array)
      || typeof triangleCount !== 'number' || !Number.isInteger(triangleCount) || triangleCount <= 0
      || triangleCount > 2_000_000 || (triangleTotal += triangleCount) > 2_000_000
      || indices.length !== triangleCount * 3 || positions.length < 9 || positions.length % 3 !== 0
      || positions.length > 18_000_000 || normals.length !== positions.length) return null;
    for (const coordinate of positions) if (!Number.isFinite(coordinate)) return null;
    for (const normal of normals) if (!Number.isFinite(normal)) return null;
    for (const index of indices) if (index >= positions.length / 3) return null;
    return { kind: 'material', volume: item.volume, mesh: { positions, normals, indices, triangleCount } };
  }
  const added = region(result.added), removed = region(result.removed), common = region(result.common);
  if (added === null || removed === null || common === null) return invalid();
  const conserved = (whole: number, first: number, second: number): boolean =>
    Math.abs(whole - first - second) <= Math.max(1e-9, whole * 1e-6);
  if (!conserved(result.beforeVolume, removed.volume, common.volume) || !conserved(result.afterVolume, added.volume, common.volume)) return invalid();
  return { kind: 'compared', result: { added, removed, common, beforeVolume: result.beforeVolume, afterVolume: result.afterVolume } };
}
