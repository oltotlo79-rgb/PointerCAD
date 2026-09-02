import { beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from './loadOcct.node.js';

describe('Node での OCCT の読み込み', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
  let elapsedMs = 0;

  beforeAll(async () => {
    const startedAt = performance.now();
    oc = await loadOcctForNode();
    elapsedMs = performance.now() - startedAt;
  });

  it('OCCT のインスタンスが得られる', () => {
    expect(oc).toBeTypeOf('object');
  });

  it('箱を作るクラスが束縛されている', () => {
    expect(oc.BRepPrimAPI_MakeBox_2).toBeTypeOf('function');
  });

  it('テッセレーションに使うクラスが束縛されている', () => {
    expect(oc.BRepMesh_IncrementalMesh_2).toBeTypeOf('function');
    expect(oc.TopExp_Explorer_1).toBeTypeOf('function');
    expect(oc.TopLoc_Location_1).toBeTypeOf('function');
    expect(oc.Poly_Connect_2).toBeTypeOf('function');
    expect(oc.TColgp_Array1OfDir_2).toBeTypeOf('function');
    // 静的メソッドは呼ばずに参照すると @typescript-eslint/unbound-method が働くため、
    // 同じ判定を typeof で書く(toBeTypeOf('function') と等価)。
    expect(typeof oc.BRep_Tool.Triangulation).toBe('function');
    expect(typeof oc.StdPrs_ToolTriangulatedShape.Normal).toBe('function');
    expect(typeof oc.TopoDS.Face_1).toBe('function');
  });

  it('2回目の読み込みは同じインスタンスを返す', async () => {
    expect(await loadOcctForNode()).toBe(oc);
  });

  it('初期化の実測時間を記録する(上限は vitest.config.ts の testTimeout)', () => {
    // 数値そのものは環境差が大きいので上限判定はしない。統括への報告用に出力する。
    console.log(`OCCT 初期化時間: ${elapsedMs.toFixed(0)} ms`);
    expect(elapsedMs).toBeGreaterThan(0);
  });
});
