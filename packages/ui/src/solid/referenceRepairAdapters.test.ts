import { createEmptySketchDocument, type MathGeometryQuantity, type PartDocument, type SubShapeRef } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { repairFixture } from './referenceRepairFixture.js';
import { partRepairSlots } from './referenceRepairSlots.js';
import { repairMath } from './referenceRepairMath.js';
import { repairPlane } from './referenceRepairGeometry.js';
import { drawingRepairSlots } from './referenceRepairDrawing.js';
import { createDrawingDocument } from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';

describe('保存欄を指定する型付きadapter', () => {
  it('同じ参照値を使う加工・測定・スケッチでも一つの欄だけ置換し、原式と他方を保持する', () => {
    const { document: base, reference } = repairFixture();
    if (reference.fingerprint.kind !== 'edge') throw new Error('辺が必要');
    const vertex: SubShapeRef = { bodyFeatureId: 'base', index: 12, fingerprint: { kind: 'vertex', position: [1, 2, 3] } };
    const sketch = createEmptySketchDocument();
    const document: PartDocument = { ...base, sketches: [{ ...sketch, features: [{ id: 'point', name: '相対点', kind: 'point', planeId: 'xy',
      at: { mode: 'relative', base: { kind: 'subShape', ref: vertex }, dx: expressionValueFromNumber(1), dy: expressionValueFromNumber(2), dz: expressionValueFromNumber(3) } }] }],
    mathGeometry: [{ id: 'length', documentId: base.id, name: '測定した長さ', tolerance: { linearMm: 1e-7, angularRadians: 1e-9 },
      quantity: { kind: 'length', curve: { kind: 'edge', reference: { ...reference, fingerprint: reference.fingerprint } } } }] };
    const slots = partRepairSlots(document);
    expect(slots.map(slot => slot.consumer)).toEqual(['machining', 'sketch', 'dimension']);
    const saved = JSON.stringify(document), selected = slots.find(slot => slot.consumer === 'dimension');
    if (selected === undefined) throw new Error('測定欄が必要');
    const next = selected.replace({ ...reference, index: 2 });
    expect(next.solids).toBe(document.solids);
    expect(next.sketches).toBe(document.sketches);
    expect(next.mathGeometry?.[0].quantity).toMatchObject({ curve: { reference: { index: 2 } } });
    expect(JSON.stringify(document)).toBe(saved);
    const point = slots.find(slot => slot.consumer === 'sketch');
    if (point === undefined) throw new Error('点の欄が必要');
    expect(point.replace({ ...vertex, index: 4 }).sketches[0].features[0]).toMatchObject({ at: { base: { ref: { index: 4 } }, dx: expressionValueFromNumber(1) } });
  });
  it('平面の点と辺の欄を分離し、直線条件を記録する', () => {
    const { reference } = repairFixture(), calls: [string, string | undefined][] = [];
    const original = { kind: 'pointAndEdge' as const, mode: 'containing' as const, point: { kind: 'subShape' as const, ref: reference }, edge: reference };
    const next = repairPlane(original, (ref, field, requirement) => {
      calls.push([field, requirement]); return field === 'edge' ? { ...ref, index: 8 } : ref;
    });
    expect(calls).toEqual([['point', undefined], ['edge', 'line']]);
    expect(next).toEqual({ ...original, edge: { ...reference, index: 8 } });
  });
  it('測定値の反対側を保持し、違う部分形状の種類へ強制変換しない', () => {
    const { reference } = repairFixture();
    if (reference.fingerprint.kind !== 'edge') throw new Error('辺が必要');
    const edge = { kind: 'edge' as const, reference: { ...reference, fingerprint: reference.fingerprint } };
    const quantity: MathGeometryQuantity = { kind: 'shape-distance', first: edge, second: edge };
    expect(repairMath(quantity, (ref, field) => field === 'first' ? { ...ref, index: 8 } : ref)).toMatchObject({
      first: { reference: { index: 8 } }, second: { reference },
    });
    expect(repairMath(quantity, () => ({ bodyFeatureId: 'wrong', index: 3, fingerprint: { kind: 'vertex', position: [0, 0, 0] } }))).toEqual(quantity);
  });
  it('二面の中央平面を持つデータムの片側だけを直し、ソース・配置・文字位置を保持する', () => {
    const { reference } = repairFixture();
    const target = { kind: 'subShape' as const, sourceRef: 'source', componentId: 'occurrence', viewId: 'front', ref: reference };
    const document = { ...createDrawingDocument('公差', { sourceRef: 'source', sourceKind: 'part', fileName: 'source.pcad', path: '', contentHash: 'hash', importedAt: '' }),
      datums: [{ id: 'datum', label: 'A', feature: { kind: 'medianPlane' as const, targets: [target, target] as const },
        position: [10, 20] as const, height: 3.5, layerId: 'layer-5' }] };
    const slots = drawingRepairSlots(document);
    expect(slots).toHaveLength(2);
    expect(slots[0]).toMatchObject({ sourceRef: 'source', componentId: 'occurrence' });
    const next = slots[1].replace({ ...reference, index: 7 });
    expect(next.datums[0]).toEqual({ ...document.datums[0], feature: { kind: 'medianPlane', targets: [target, { ...target, ref: { ...reference, index: 7 } }] } });
  });
});
