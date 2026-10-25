import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createDirectKernelBridge, type SolidBody } from '../kernelBridge.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../part/createPartDocument.js';
import { recomputePart } from '../part/recomputePart.js';
import { absoluteCoordinate } from '../sketch/createSketchDocument.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from './createAssemblyDocument.js';
import { EMPTY_PART_LIBRARY } from './partLibrary.js';
import { resolveConstrainedAssembly } from './resolveConstrainedAssembly.js';
import type { AssemblyDocument } from './types.js';

function assemblyFor(reference: SubShapeRef): AssemblyDocument {
  return { ...createAssemblyDocument('assembly'),
    components: ['component-1', 'component-2'].map((id) => ({ id, name: id, source: { kind: 'part', partRef: 'part-1' },
      placement: DEFAULT_COMPONENT_PLACEMENT, fixed: true, visible: true, suppressed: false })),
    mates: [{ id: 'mate-1', name: 'parallel', kind: 'parallel', suppressed: false, flipped: false,
      value: expressionValueFromNumber(0), a: { kind: 'subShape', componentId: 'component-1', ref: reference },
      b: { kind: 'origin', componentId: 'component-2', element: 'xy' } }],
  };
}

describe('合致の自動参照採用', () => {
  it.each([false, true])('曖昧な面は候補逆順%sでも未解決にし、一意に戻れば解決する', (reverse) => {
    const document = assemblyFor({ bodyFeatureId: 'body', index: 99, fingerprint: {
      kind: 'face', surfaceKind: 'plane', area: 100, position: [0, 0, 0], axis: [0, 0, 1], radius: null } });
    const faces = [7, 19].map((index) => ({ index, surfaceKind: 'plane' as const, area: 100, centroid: [0, 0, 0] as const,
      axis: [0, 0, 1] as const, radius: null, triangleOffset: 0, triangleCount: 0 }));
    const body: SolidBody = { featureId: 'body', faces: reverse ? [...faces].reverse() : faces, edges: [], vertices: [], threadMarks: [],
      volume: 1000, isValid: true, mesh: { positions: new Float32Array([-10, -10, -10, 10, 10, 10]), normals: new Float32Array(),
        indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 } };
    const initial = createEmptyPartDocument();
    const part = appendSolid(initial, { ...createPrimitiveFeature(initial, 'box'), id: 'body' });
    const options = { library: { ...EMPTY_PART_LIBRARY, parts: new Map([['part-1', part]]) } };
    const saved = JSON.stringify(document);
    expect(resolveConstrainedAssembly(document, new Map([['part-1', [body]]]), options)).toMatchObject({ ok: false, reason: 'constraints' });
    expect(resolveConstrainedAssembly(document, new Map([['part-1', [{ ...body, faces: [faces[0]] }]]]), options).ok).toBe(true);
    expect(JSON.stringify(document)).toBe(saved);
  });

  it('実OCCTで上流の結合順が変わり番号と位置の対応が衝突すると、合致を未解決へ戻す', async () => {
    const oc = await loadOcctForNode(), bridge = createDirectKernelBridge(createKernelApi(() => Promise.resolve(oc)));
    try {
      let part = createEmptyPartDocument();
      for (const x of [0, 100]) {
        const feature = createPrimitiveFeature(part, 'box');
        part = appendSolid(part, { ...feature, origin: { kind: 'coordinate', value: absoluteCoordinate(x, 0, 0) },
          shape: { kind: 'box', sizeX: expressionValueFromNumber(20), sizeY: expressionValueFromNumber(30), sizeZ: expressionValueFromNumber(40) } });
      }
      const beforePart = appendSolid(part, { kind: 'boolean', id: 'body', name: 'joined', suppressed: false, operation: 'union',
        targetFeatureId: part.solids[0].id, toolFeatureId: part.solids[1].id });
      const afterPart = appendSolid(part, { kind: 'boolean', id: 'body', name: 'joined', suppressed: false, operation: 'union',
        targetFeatureId: part.solids[1].id, toolFeatureId: part.solids[0].id });
      const before = await recomputePart(beforePart, bridge), after = await recomputePart(afterPart, bridge);
      expect(before.errors).toEqual([]); expect(after.errors).toEqual([]);
      const top = before.bodies[0].faces.filter((face) => face.axis !== null && face.axis[2] > 0.999)
        .sort((a, b) => a.centroid[0] - b.centroid[0])[0];
      const reference: SubShapeRef = { bodyFeatureId: 'body', index: top.index, fingerprint: { kind: 'face', surfaceKind: top.surfaceKind,
        area: top.area, position: top.centroid, axis: top.axis, radius: top.radius } };
      const document = assemblyFor(reference), saved = JSON.stringify(document);
      const options = { library: { ...EMPTY_PART_LIBRARY, parts: new Map([['part-1', beforePart]]) } };
      expect(resolveConstrainedAssembly(document, new Map([['part-1', before.bodies]]), options).ok).toBe(true);
      expect(resolveConstrainedAssembly(document, new Map([['part-1', after.bodies]]), options)).toMatchObject({ ok: false, reason: 'constraints' });
      expect(JSON.stringify(document)).toBe(saved);
    } finally { bridge.dispose(); }
  });
});
