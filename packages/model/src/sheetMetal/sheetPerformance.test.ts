import { expectWithinBudget } from '@pointercad/test-utils';
import { exactExpressionValueFromNumber as n } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type AssemblyKernelBridge } from '../kernelBridge.js';
import { recomputePart, type PartRecomputeResult } from '../part/recomputePart.js';
import { resolvePart } from '../part/resolvePart.js';
import { recomputeSheetFlat } from './recomputeSheetFlat.js';
import { sheetPerformanceFixture, U_BRACKET_VOLUME } from './testing/sheetPerformanceFixture.js';

let bridge: AssemblyKernelBridge;
const document = sheetPerformanceFixture(), owner = 'sheet-performance-100';
let cold: PartRecomputeResult;
beforeAll(async () => {
  const start = performance.now();
  await loadOcctForNode();
  process.stdout.write(`[実測] 板金性能・OCCT初期化: ${(performance.now() - start).toFixed(1)} ms（計算本体から分離）\n`);
  bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
}, 180_000);
afterAll(async () => { await bridge.releasePart(owner); await bridge.releasePart('sheet-performance-flat'); });

describe.sequential('P10 板金100段の実OCCT性能と部分更新', () => {
  it('異なる座標の25個のU板を100段全再計算し、5秒以内で独立した体積と一致する', async () => {
    expect(document.solids).toHaveLength(100);
    const stages: { id: string; at: number }[] = [];
    const start = performance.now();
    cold = await recomputePart(document, bridge, { partId: owner, generation: 1,
      onProgress: (progress) => { stages.push({ id: progress.featureId, at: performance.now() }); } });
    const elapsed = performance.now() - start;
    const totals = new Map<string, number>();
    for (const [i, stage] of stages.entries()) {
      const kind = stage.id.split('-')[0];
      totals.set(kind, (totals.get(kind) ?? 0) + ((stages[i + 1]?.at ?? start + elapsed) - stage.at));
    }
    console.log('[描画診断] 板金の段別時間', { beforeKernelMs: (stages[0]?.at ?? start) - start, stages: Object.fromEntries(totals) });
    process.stdout.write(`[実測] 板金100段全再計算: ${elapsed.toFixed(1)} ms / 上限5000ms / cache ${cold.cacheHits}\n`);
    expect(cold.errors).toEqual([]); expect(cold.cancelled).toBe(false);
    expect(cold.cacheHits).toBe(0); expect(cold.bodies).toHaveLength(25);
    for (const body of cold.bodies) {
      const index = Number(body.featureId.split('-')[1]);
      expect(body.volume).toBeCloseTo(U_BRACKET_VOLUME, 5);
      expect(Math.min(...body.vertices.map((vertex) => vertex.position[0]))).toBeCloseTo((index % 5) * 100, 7);
      expect(Math.max(...body.vertices.map((vertex) => vertex.position[0]))).toBeCloseTo((index % 5) * 100 + 50, 7);
      expect(Math.min(...body.vertices.map((vertex) => vertex.position[1]))).toBeCloseTo(Math.floor(index / 5) * 100 - 5, 7);
    }
    expectWithinBudget(elapsed, 5000, '板金100段全再計算');
  });
  it('末尾の切欠き深さだけを変えると99段を再利用し、500ms以内で1個だけ変化する', async () => {
    const last = document.solids.at(-1); if (last?.kind !== 'sheetRelief') throw new Error('末尾に切欠きが必要です');
    const changed = { ...document, solids: [...document.solids.slice(0, -1), { ...last, depth: n(6) }] };
    const start = performance.now();
    const result = await recomputePart(changed, bridge, { partId: owner, generation: 2 });
    const elapsed = performance.now() - start;
    process.stdout.write(`[実測] 板金100段の末尾編集: ${elapsed.toFixed(1)} ms / 上限500ms / cache ${result.cacheHits}\n`);
    expect(result.errors).toEqual([]); expect(result.cacheHits).toBe(99); expect(result.bodies).toHaveLength(25);
    for (const body of result.bodies) expect(body.volume).toBeCloseTo(U_BRACKET_VOLUME - (body.featureId === last.id ? 156 / 19 : 0), 5);
    expectWithinBudget(elapsed, 500, '板金100段の末尾編集');
    for (const body of cold.bodies) expect(body.volume).toBeCloseTo(U_BRACKET_VOLUME, 5);
  });
  it('Undo相当の元文書へ戻すと100段を再利用し、展開でも切欠きと2曲げを保持する', async () => {
    const restored = await recomputePart(document, bridge, { partId: owner, generation: 3 });
    expect(restored.errors).toEqual([]); expect(restored.cacheHits).toBe(100);
    for (const body of restored.bodies) expect(body.volume).toBeCloseTo(U_BRACKET_VOLUME, 5);
    const source = resolvePart(document).sheetMetalBodies?.get('relief-24');
    if (source === undefined) throw new Error('最後のU板が必要です');
    const flat = await recomputeSheetFlat(source, { sourceFeatureId: 'relief-24', fixedPanelId: source.panels[0].id, seamConnectionIds: [] },
      bridge, { partId: 'sheet-performance-flat', generation: 1 });
    if (!flat.ok) throw new Error(flat.message);
    expect(flat.body.volume).toBeCloseTo(7000 + 380 * Math.PI - 40, 5);
  });
});
