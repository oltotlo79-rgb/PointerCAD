import { exactExpressionValueFromNumber as n } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type AssemblyKernelBridge } from '../kernelBridge.js';
import { availableSheetBoundaryEdges } from './availableBoundaryEdges.js';
import { resolveSheetFlatOutline } from './flatOutline.js';
import { sheetLoopSignedArea } from './panelGeometry.js';
import { recomputeSheetFlat } from './recomputeSheetFlat.js';
import { resolveSheetRelief } from './resolveSheetRelief.js';
import { resolveSheetSeams } from './seamConnections.js';
import { sheetShapeKey } from './shapeKey.js';
import { closedSheetLoop } from './testing/closedSheetLoop.js';
import type { SheetReliefFeature } from './types.js';
import { unfoldSheetBody } from './unfoldSheetBody.js';

let bridge: AssemblyKernelBridge;
beforeAll(async () => { await loadOcctForNode(); bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode)); }, 180_000);
function fixture(seam: string, shape: SheetReliefFeature['shape'] = 'rectangle') {
  const body = closedSheetLoop(), edges = availableSheetBoundaryEdges(body, 'wall-0');
  if (!edges.ok) throw new Error(edges.message);
  const edge = edges.value.find((item) => item.from[0] === 20 && item.to[0] === 20);
  if (edge === undefined) throw new Error('幅方向の開放縁が必要です');
  const feature: SheetReliefFeature = { kind: 'sheetRelief', id: 'notch', name: '閉周回の切欠き', suppressed: false,
    targetFeatureId: 'tube', boundary: { panelId: 'wall-0', boundaryId: edge.id },
    position: n(20), width: n(4), depth: n(5), shape, seamConnectionIds: [seam] };
  return { body, feature };
}

describe('閉周回のリリーフと明示継ぎ目', () => {
  const cases = (['rectangle', 'slot'] as const).flatMap((shape) => [0,1,2,3].map((seam) => ({ shape, seam })));
  const flatCases = cases.flatMap(({ shape, seam }) => {
    const input = fixture(`corner-${seam}`, shape), resolved = resolveSheetRelief(input.feature, input.body);
    if (!resolved.ok) throw new Error(resolved.message);
    return resolved.value.body.panels.map((panel) => ({ shape, seam, fixedPanelId: panel.id }));
  });
  it.each(cases)(
    '$shape、継ぎ目$seamの曲げ形状で実材料を保ち、工具が継ぎ目を飛び越えない', async ({ shape, seam }) => {
      const input = fixture(`corner-${seam}`, shape), before = JSON.stringify(input.body);
      const result = resolveSheetRelief(input.feature, input.body); if (!result.ok) throw new Error(result.message);
      const id = `closed-relief-${shape}-${seam}`, { body, plan } = result.value;
      const panelRemoved = shape === 'rectangle' ? 20 : 12 + 2 * Math.PI;
      const foldedRemoved = seam === 0 ? panelRemoved : shape === 'rectangle' ? 20 + 400 / 19 : 78 * (6 + Math.PI) / 19;
      try {
        const folded = await bridge.recomputeSolids([{ featureId: id, name: id, plan, key: sheetShapeKey(plan), visible: true }], { partId: id, generation: 1 });
        expect(folded.failures).toEqual([]); expect(folded.bodies).toHaveLength(1);
        expect(folded.bodies[0].volume).toBeCloseTo(3200 + 320 * Math.PI - foldedRemoved, 5);
        const mapped = resolveSheetSeams(body, [`corner-${seam}`]); if (!mapped.ok) throw new Error(mapped.message);
        expect(mapped.value).toHaveLength(1);
      } finally { await bridge.releasePart(id); }
      expect(JSON.stringify(input.body)).toBe(before);
  });
  it.each(flatCases)('$shape、継ぎ目$seam・固定面$fixedPanelIdの展開で実材料と輪郭を保つ', async ({ shape, seam, fixedPanelId }) => {
    const input = fixture(`corner-${seam}`, shape), before = JSON.stringify(input.body);
    const result = resolveSheetRelief(input.feature, input.body); if (!result.ok) throw new Error(result.message);
    const id = `closed-flat-${shape}-${seam}-${fixedPanelId}`, { body } = result.value;
    const panelRemoved = shape === 'rectangle' ? 20 : 12 + 2 * Math.PI;
    const flatRemoved = panelRemoved * (seam === 0 ? 1 : 2);
    try {
      const flat = await recomputeSheetFlat(body, { sourceFeatureId: id, fixedPanelId, seamConnectionIds: [`corner-${seam}`] }, bridge,
        { partId: id, generation: 1 });
      if (!flat.ok) throw new Error(flat.message);
      expect(flat.body.volume).toBeCloseTo(3200 + 304 * Math.PI - flatRemoved, 5);
      const outline = await resolveSheetFlatOutline(bridge, flat.bodyKey, 2); if (!outline.ok) throw new Error(outline.message);
      expect(outline.value.loops).toHaveLength(1);
      expect(outline.value.loops.reduce((area, loop) => area + sheetLoopSignedArea(loop.curves, [0,0,1]), 0))
        .toBeCloseTo((3200 + 304 * Math.PI - flatRemoved) / 2, 5);
    } finally { await bridge.releasePart(id); }
    expect(JSON.stringify(input.body)).toBe(before);
  });
  it('二段の切欠き後も加工前の継ぎ目を追跡し、手前の加工を変えない', () => {
    const input = fixture('corner-3'), first = resolveSheetRelief(input.feature, input.body); if (!first.ok) throw new Error(first.message);
    const edges = availableSheetBoundaryEdges(first.value.body, 'wall-0'); if (!edges.ok) throw new Error(edges.message);
    const opposite = edges.value.find((edge) => edge.from[0] === 0 && edge.to[0] === 0); if (opposite === undefined) throw new Error('反対側の縁が必要です');
    const before = [...first.value.body.connectionAliases ?? []];
    const second = resolveSheetRelief({ ...input.feature, id: 'second', targetFeatureId: 'notch', position: n(0),
      boundary: { panelId: 'wall-0', boundaryId: opposite.id } }, first.value.body);
    if (!second.ok) throw new Error(second.message);
    const mapped = resolveSheetSeams(second.value.body, ['corner-3']); if (!mapped.ok) throw new Error(mapped.message);
    const previous = resolveSheetSeams(first.value.body, ['corner-3']); if (!previous.ok) throw new Error(previous.message);
    expect(mapped.value).not.toEqual(previous.value);
    expect(resolveSheetSeams(second.value.body, previous.value)).toEqual(mapped);
    expect(unfoldSheetBody(second.value.body, 'wall-0', ['corner-3']).ok).toBe(true);
    expect([...first.value.body.connectionAliases ?? []]).toEqual(before);
  });
  it('継ぎ目なし・存在しない継ぎ目・二重指定を理由付きで拒否する', () => {
    const input = fixture('corner-0'), before = JSON.stringify(input.body);
    for (const seamConnectionIds of [[], ['missing'], ['corner-0', 'corner-0']]) {
      const feature = { ...input.feature, seamConnectionIds };
      expect(resolveSheetRelief(feature, input.body).ok).toBe(false);
    }
    expect(JSON.stringify(input.body)).toBe(before);
  });
});
