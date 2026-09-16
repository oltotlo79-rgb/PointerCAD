import { describe, expect, it } from 'vitest';
import { readMaterialComparison } from './readMaterialComparison.js';

const empty = { kind: 'empty', volume: 0, mesh: null };
function reply() {
  return { kind: 'compared', result: { beforeVolume: 0, afterVolume: 1, removed: empty, common: empty,
    added: { kind: 'material', volume: 1, mesh: { triangleCount: 4,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
      normals: new Float32Array(12).fill(1), indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]) } } } };
}
describe('形の比較の返信を描画へ渡す前に確認する', () => {
  it('同じ形・空集合・追加を、体積と三角形を保って読み出す', () => {
    const input = reply(), result = readMaterialComparison(input);
    expect(result).toEqual(input);
    if (result.kind !== 'compared' || result.result.added.kind !== 'material') throw new Error('比較失敗');
    expect(result.result.added.mesh.positions).toBe(input.result.added.mesh.positions);
    expect(readMaterialComparison({ kind: 'compared', result: { beforeVolume: 0, afterVolume: 0, added: empty, removed: empty, common: empty } }).kind).toBe('compared');
    expect(readMaterialComparison({ kind: 'compared', result: { beforeVolume: 1, afterVolume: 1,
      added: empty, removed: empty, common: input.result.added } }).kind).toBe('compared');
  });
  it('途中の結果・体積の不整合・非有限値を「変更なし」として受け入れない', () => {
    const input = reply();
    for (const value of [null, { kind: 'compared', result: {} }, { kind: 'compared', result: { ...input.result, afterVolume: 2 } },
      { kind: 'compared', result: { ...input.result, removed: { ...empty, volume: 1 } } },
      { kind: 'compared', result: { ...input.result, afterVolume: Infinity } },
      { kind: 'compared', result: { ...input.result, added: { ...input.result.added, volume: -1 } } }]) {
      expect(readMaterialComparison(value).kind).toBe('failed');
    }
  });
  it('頂点の外を指す番号、途中の三角形、座標や法線のNaNを描画へ渡さない', () => {
    const input = reply(), mesh = input.result.added.mesh;
    const damaged = [
      { ...mesh, triangleCount: 3 }, { ...mesh, positions: [...mesh.positions] },
      { ...mesh, normals: new Float32Array(9) }, { ...mesh, indices: new Uint32Array(12).fill(4) },
      { ...mesh, positions: new Float32Array(12).fill(NaN) }, { ...mesh, normals: new Float32Array(12).fill(Infinity) },
    ];
    for (const geometry of damaged) expect(readMaterialComparison({ kind: 'compared', result: { ...input.result,
      added: { ...input.result.added, mesh: geometry } } }).kind).toBe('failed');
  });
  it('中止と実行失敗を区別し、未確認の異常な状態を成功にしない', () => {
    expect(readMaterialComparison({ kind: 'cancelled' })).toEqual({ kind: 'cancelled' });
    expect(readMaterialComparison({ kind: 'failed', message: '入力を読めません' })).toEqual({ kind: 'failed', message: '入力を読めません' });
    expect(readMaterialComparison({ kind: 'compared' }).kind).toBe('failed');
    expect(readMaterialComparison({ kind: { toString: () => 'cancelled' } }).kind).toBe('failed');
  });
});
