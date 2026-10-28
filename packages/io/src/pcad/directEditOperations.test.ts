import { expressionValueFromNumber as ev } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature, createHoleTranslateFeature, createFaceRotateFeature,
  createDirectKernelBridge, createSubShapeReference, resolveSubShapeReference, recomputePart, resolvePart,
  absoluteCoordinate, type SubShapeRef } from '@pointercad/model';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { createShapeCache } from '../../../kernel/src/worker/shapeCache.js';
import { solidMeshBuffers, type CachedSolid } from '../../../kernel/src/worker/recomputeSolids.js';
import { buildEx18DirectSeed, directFaceReference, directPlanarFace, directImportedBrep } from '../../../model/src/part/ex18RouteBuildersDirect.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { emptyPcadAttachments, readPcadFile, writePcadFile } from './pcadFile.js';
import { readSolidFeature, serializeSolidFeature } from './codecs/solid.js';

const TIMEOUT = 180_000;
const SAVED_AT = '2026-10-26T00:00:00.000Z';
beforeAll(loadOcctForNode, TIMEOUT);
const face: SubShapeRef = { bodyFeatureId: 'base', index: 0,
  fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1200, position: [20, 15, 8], axis: [0, 0, 1], radius: null } };
const hinge: SubShapeRef = { bodyFeatureId: 'base', index: 0,
  fingerprint: { kind: 'edge', curveKind: 'line', length: 40, position: [20, 0, 8], axis: [1, 0, 0], radius: null } };
const common = { id: 'edit', name: 'edit', targetFeatureId: 'base', face };
const hole = createHoleTranslateFeature({ ...common, translation: [ev(2), ev(0), ev(0)] });
const rotation = createFaceRotateFeature({ ...common, hinge, angle: ev(5) });

describe('direct edit persistence', () => {
  it.each([hole, rotation])('preserves all saved fields and excludes derived geometry for $kind', feature => {
    const saved = serializeSolidFeature(feature);
    expect(saved).toEqual(feature);
    expect(readSolidFeature(saved, 'solid')).toEqual({ ok: true, value: feature });
    expect(Object.keys(saved).sort()).toEqual((feature.kind === 'holeTranslate'
      ? ['id', 'name', 'kind', 'suppressed', 'targetFeatureId', 'face', 'translation']
      : ['id', 'name', 'kind', 'suppressed', 'targetFeatureId', 'face', 'hinge', 'angle']).sort());
  });
  it('rejects unknown kind, missing fields, wrong references and nonnumeric values', () => {
    expect(readSolidFeature({ ...hole, kind: 'unknown-direct' }, 'solid').ok).toBe(false);
    expect(readSolidFeature({ ...hole, translation: undefined }, 'solid').ok).toBe(false);
    expect(readSolidFeature({ ...rotation, hinge: face }, 'solid').ok).toBe(false);
    expect(readSolidFeature({ ...hole, face: { ...face, bodyFeatureId: 'other' } }, 'solid').ok).toBe(false);
    expect(readSolidFeature({ ...rotation, angle: { source: 'bad', value: 'bad', display: '' } }, 'solid').ok).toBe(false);
    expect(readSolidFeature({ ...rotation, angle: { source: 'bad', value: null, display: '' } }, 'solid').ok).toBe(false);
    expect(readSolidFeature({ ...hole, translation: [ev(Infinity), ev(0), ev(0)] }, 'solid').ok).toBe(false);
  });
  it('keeps faceOffset serialization byte-for-byte in its original field order', () => {
    const original = { id: 'offset', kind: 'faceOffset', name: 'offset', suppressed: false,
      targetFeatureId: 'base', face, offset: ev(5) } as const;
    expect(JSON.stringify(serializeSolidFeature(original))).toBe(JSON.stringify(original));
    expect(readSolidFeature(original, 'solid')).toEqual({ ok: true, value: original });
  });
  it.each(['holeTranslate', 'faceRotate'] as const)('%s JSON and ZIP reopen on cold bridges to the same native geometry', async kind => {
    const cache = createShapeCache<CachedSolid>(128, undefined, entry => solidMeshBuffers(entry.mesh));
    const api = createKernelApi(loadOcctForNode, cache);
    const bridge = createDirectKernelBridge(api);
    try {
      const empty = createEmptyPartDocument();
      const box = { ...createPrimitiveFeature(empty, 'box'), origin: { kind: 'coordinate' as const, value: absoluteCoordinate(20, 15, 4) },
        shape: { kind: 'box' as const, sizeX: ev(40), sizeY: ev(30), sizeZ: ev(8) } };
      let seed = kind === 'holeTranslate' ? await buildEx18DirectSeed('A', bridge)
        : { part: appendSolid(empty, box), targetId: box.id };
      expect((await recomputePart(seed.part, bridge)).errors).toEqual([]);
      const sourceKey = resolvePart(seed.part).steps.find(step => step.featureId === seed.targetId)?.key;
      if (sourceKey === undefined) throw new Error('missing export key');
      const exported = await api.exportShapes({ format: 'step', bodies: [{ bodyKey: sourceKey, name: null, color: null }] });
      if (exported.format !== 'step') throw new Error('wrong export');
      const imported = (await api.importShape({ format: 'step', bytes: exported.bytes })).bodies[0];
      if (imported.bodyKind === 'mesh') throw new Error('wrong import');
      seed = directImportedBrep(imported.brepBytes, 'direct.step', exported.bytes.byteLength);
      const built = await recomputePart(seed.part, bridge, { importedShapes: seed.importedShapes });
      expect(built.errors).toEqual([]);
      const target = built.bodies[0];
      const picked = kind === 'holeTranslate' ? target.faces.find(item => item.surfaceKind === 'cylinder')
        : directPlanarFace(target, [0, 0, 1], 8);
      if (picked === undefined) throw new Error('missing edit face');
      const input = { id: 'saved-edit', name: 'saved-edit', targetFeatureId: target.featureId, face: directFaceReference(target, picked) };
      const edge = target.edges.find(item => item.curveKind === 'line'
        && Math.hypot(item.midpoint[0] - 20, item.midpoint[1], item.midpoint[2] - 8) < 1e-6);
      if (edge === undefined) throw new Error('missing edge');
      const hingeRef: SubShapeRef = createSubShapeReference(target, 'edge', edge.index) ?? {
        bodyFeatureId: target.featureId, index: edge.index, fingerprint: { kind: 'edge', curveKind: edge.curveKind,
          length: edge.length, position: edge.midpoint, axis: edge.axis, radius: edge.radius } };
      expect(resolveSubShapeReference(target, hingeRef).status).toBe('matched');
      const feature = kind === 'holeTranslate' ? createHoleTranslateFeature({ ...input,
        translation: [{ ...ev(2), source: '1+1' }, ev(0), ev(0)] })
        : createFaceRotateFeature({ ...input, hinge: hingeRef, angle: { ...ev(5), source: '10/2' } });
      const document = appendSolid(seed.part, feature);
      const baseline = await recomputePart(document, bridge, { importedShapes: seed.importedShapes });
      expect(baseline.errors).toEqual([]);
      const json = parseDocument(serializeDocument(document, { savedAt: SAVED_AT }));
      const zip = readPcadFile(writePcadFile(document, { savedAt: SAVED_AT,
        attachments: { ...emptyPcadAttachments(), shapes: seed.importedShapes ?? new Map() } }));
      if (!json.ok || !zip.ok) throw new Error('failed persistence round trip');
      for (const reopened of [{ document: json.document, shapes: seed.importedShapes },
        { document: zip.document, shapes: zip.attachments.shapes }]) {
        expect(reopened.document.solids.at(-1)).toEqual(feature);
        const coldCache = createShapeCache<CachedSolid>(128, undefined, entry => solidMeshBuffers(entry.mesh));
        const coldApi = createKernelApi(loadOcctForNode, coldCache);
        const cold = createDirectKernelBridge(coldApi);
        try {
          const result = await recomputePart(reopened.document, cold, { importedShapes: reopened.shapes });
          expect(result.errors).toEqual([]);
          expect(result.cacheHits).toBe(0);
          const expected = kind === 'holeTranslate' ? 9600 - 72 * Math.PI : 9600 + 18000 * Math.tan(Math.PI / 36);
          expect(Math.abs(result.bodies[0].volume - expected) / expected).toBeLessThanOrEqual(1e-9);
          expect(result.bodies[0].volume).toBe(baseline.bodies[0].volume);
          if (kind === 'holeTranslate') {
            const cylinder = result.bodies[0].faces.find(item => item.surfaceKind === 'cylinder');
            if (cylinder === undefined) throw new Error('missing restored hole');
            expect(Math.hypot(cylinder.centroid[0] - 12, cylinder.centroid[1] - 15)).toBeLessThanOrEqual(1e-6);
          } else {
            const top = result.bodies[0].faces.find(item => item.axis !== null && item.axis[2] > 0.9);
            if (top === undefined || top.axis === null) throw new Error('missing restored top');
            expect(Math.abs(Math.atan2(-top.axis[1], top.axis[2]) - Math.PI / 36)).toBeLessThanOrEqual(1e-8);
          }
        } finally { await coldApi.releasePart('part:current'); coldCache.clear(); cold.dispose(); }
      }
    } finally { await api.releasePart('part:current'); cache.clear(); bridge.dispose(); }
  }, TIMEOUT);
});
