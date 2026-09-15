import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { expressionValueFromNumber as value } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createShapeCache } from '../../../kernel/src/worker/shapeCache.js';
import type { CachedSolid } from '../../../kernel/src/worker/recomputeSolids.js';
import { createDirectMaterialComparisonBridge } from '../kernelBridge.js';
import { absoluteCoordinate } from '../sketch/createSketchDocument.js';
import { createEmptyPartDocument, createPrimitiveFeature } from './createPartDocument.js';
import { recomputePart } from './recomputePart.js';
import type { BooleanFeature, PartDocument, PrimitiveFeature } from './types.js';

const TIMEOUT_MS = 180_000;
beforeAll(async () => { await loadOcctForNode(); }, TIMEOUT_MS);
const releases: (() => Promise<void>)[] = [];
afterEach(async () => { for (const release of releases.splice(0)) await release(); });
function documents() {
  const empty = createEmptyPartDocument();
  const box: PrimitiveFeature = { ...createPrimitiveFeature(empty, 'box'), id: 'box', name: '台座',
    shape: { kind: 'box', sizeX: value(20), sizeY: value(20), sizeZ: value(20) } };
  const cylinder: PrimitiveFeature = { ...createPrimitiveFeature(empty, 'cylinder'), id: 'cylinder', name: '穴の工具',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, -11) },
    shape: { kind: 'cylinder', radius: value(3), height: value(22) } };
  const cut: BooleanFeature = { id: 'cut', name: '貫通穴', kind: 'boolean', suppressed: false,
    operation: 'subtract', targetFeatureId: box.id, toolFeatureId: cylinder.id };
  return { before: { ...empty, solids: [box] }, after: { ...empty, solids: [box, cylinder, cut] } };
}

describe('保存内容の再計算から形の比較まで実OCCTを通す', () => {
  it('同じ文書IDの穴開け前後を別所有者で保持し、消費した工具を材料へ数えない', async () => {
    const shapes = createShapeCache<CachedSolid>(16);
    const api = createKernelApi(loadOcctForNode, shapes), bridge = createDirectMaterialComparisonBridge(api);
    releases.push(async () => { await api.releasePart('comparison:before'); await api.releasePart('comparison:after'); bridge.dispose(); shapes.clear(); });
    const { before, after } = documents(), original = JSON.stringify([before, after]);
    async function keys(document: PartDocument, partId: string) {
      const resolved = new Map<string, string>();
      const result = await recomputePart(document, bridge, { partId, generation: 1,
        onResolved: part => { for (const step of part.steps) resolved.set(step.featureId, step.key); } });
      expect(result.errors).toEqual([]); expect(result.cancelled).toBe(false);
      expect(result.bodies).toHaveLength(1);
      return result.bodies.map(body => {
        const key = resolved.get(body.featureId); if (key === undefined) throw new Error('形の鍵がありません'); return key;
      });
    }
    expect(before.id).toBe(after.id);
    const oldKeys = await keys(before, 'comparison:before'), newKeys = await keys(after, 'comparison:after');
    const outcome = await bridge.compareMaterials(oldKeys, newKeys);
    expect(outcome.kind).toBe('compared');
    if (outcome.kind !== 'compared') throw new Error(JSON.stringify(outcome));
    const removed = Math.PI * 3 ** 2 * 20;
    expect(outcome.result.beforeVolume).toBeCloseTo(8000, 6);
    expect(outcome.result.afterVolume).toBeCloseTo(8000 - removed, 6);
    expect(outcome.result.removed.volume).toBeCloseTo(removed, 6);
    expect(outcome.result.added.kind).toBe('empty');
    expect(outcome.result.common.volume).toBeCloseTo(8000 - removed, 6);
    if (outcome.result.removed.kind !== 'material') throw new Error('削除した形がありません');
    const positions = outcome.result.removed.mesh.positions;
    const lower = [Infinity, Infinity, Infinity], upper = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < positions.length; index += 1) {
      const axis = index % 3; lower[axis] = Math.min(lower[axis], positions[index]); upper[axis] = Math.max(upper[axis], positions[index]);
    }
    expect(lower[2]).toBeCloseTo(-10, 5); expect(upper[2]).toBeCloseTo(10, 5);
    for (const axis of [0, 1]) { expect(lower[axis]).toBeGreaterThanOrEqual(-3.001); expect(upper[axis]).toBeLessThanOrEqual(3.001); }
    const reversed = await bridge.compareMaterials(newKeys, oldKeys);
    if (reversed.kind !== 'compared') throw new Error(JSON.stringify(reversed));
    expect(reversed.result.added.volume).toBeCloseTo(removed, 6); expect(reversed.result.removed.kind).toBe('empty');
    expect(JSON.stringify([before, after])).toBe(original);
    await api.releasePart('comparison:before'); await api.releasePart('comparison:after');
  }, TIMEOUT_MS);

  it('実際の部品所有者を計算待ち中に閉じても、比較の借用が終わるまで形を保持する', async () => {
    let waitForLoad: Promise<void> | null = null, resume: (() => void) | undefined;
    const shapes = createShapeCache<CachedSolid>(16);
    const api = createKernelApi(async () => { if (waitForLoad !== null) await waitForLoad; return loadOcctForNode(); }, shapes);
    const bridge = createDirectMaterialComparisonBridge(api);
    releases.push(async () => { await api.releasePart('owner'); bridge.dispose(); shapes.clear(); });
    const resolved = new Map<string, string>();
    const body = await recomputePart(documents().before, bridge, { partId: 'owner', generation: 1,
      onResolved: part => { for (const step of part.steps) resolved.set(step.featureId, step.key); } });
    expect(body.errors).toEqual([]); expect(body.bodies).toHaveLength(1);
    const key = resolved.get(body.bodies[0].featureId); if (key === undefined) throw new Error('形がありません');
    waitForLoad = new Promise<void>(resolve => { resume = resolve; });
    if (resume === undefined) throw new Error('読込み待ちがありません');
    const pending = bridge.compareMaterials([key], [key]);
    try {
      await api.releasePart('owner');
      expect(shapes.delete(key)).toBe(false);
    } finally {
      // 途中の照合が失敗しても、借用した実物を保持したまま検査を終えない。
      resume(); await pending;
    }
    const result = await pending;
    if (result.kind !== 'compared') throw new Error(JSON.stringify(result));
    expect(result.result.common.volume).toBeCloseTo(8000, 6);
    expect(result.result.added.kind).toBe('empty'); expect(result.result.removed.kind).toBe('empty');
    expect(shapes.delete(key)).toBe(true);
  }, TIMEOUT_MS);
});
