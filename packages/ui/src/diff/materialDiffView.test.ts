import { describe, expect, it } from 'vitest';
import type { MaterialComparisonGeometry, MaterialDifferenceRegion } from '@pointercad/model';
import { materialDiffBounds, selectedMaterialRegions } from './materialDiffView.js';

function region(positions: number[]): MaterialDifferenceRegion {
  return { kind: 'material', volume: 1, mesh: { positions: new Float32Array(positions), normals: new Float32Array(positions.length),
    indices: new Uint32Array([0, 1, 2]), triangleCount: 1 } };
}
const empty = { kind: 'empty', volume: 0, mesh: null } as const;
describe('形の差を元の位置と共通の視点で表示する', () => {
  it('離れた追加と削除を同じ中心へ移動せず、選択しても入力の配列を保持する', () => {
    const added = region([100, 0, 0, 102, 0, 0, 100, 2, 1]);
    const removed = region([-100, 0, 0, -98, 0, 0, -100, 2, 1]);
    const result: MaterialComparisonGeometry = { added, removed, common: empty, beforeVolume: 1, afterVolume: 1 };
    expect(materialDiffBounds(result)).toEqual({ center: [1, 1, 0.5], span: 202 });
    expect(selectedMaterialRegions(result, 'removed')).toEqual([{ name: 'removed', region: removed }]);
    expect(selectedMaterialRegions(result, 'removed')[0].region).toBe(removed);
    expect(selectedMaterialRegions(result, 'common')).toEqual([]);
    expect(selectedMaterialRegions(result, 'all').map(item => item.name)).toEqual(['added', 'removed']);
    if (removed.kind !== 'material') throw new Error('前提不正');
    expect([...removed.mesh.positions]).toEqual([-100, 0, 0, -98, 0, 0, -100, 2, 1]);
  });
  it('空集合や表示不能な数値には架空の原点立体を作らない', () => {
    const result = { added: empty, removed: empty, common: empty, beforeVolume: 0, afterVolume: 0 };
    expect(materialDiffBounds(result)).toBeNull();
    expect(materialDiffBounds({ ...result, added: region([NaN, 0, 0, 1, 0, 0, 0, 1, 0]) })).toBeNull();
    expect(materialDiffBounds({ ...result, added: region([1, 1, 1, 1, 1, 1, 1, 1, 1]) })).toBeNull();
  });
});
