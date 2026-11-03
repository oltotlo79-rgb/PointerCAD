import { describe, expect, it } from 'vitest';
import type { SolidBody } from '@pointercad/model';
import { resolveSavedCadShellSettings } from './cadShellSavedAnalysis.js';
import type { CadTetraContext } from './cadTetraMesh.js';

const face = { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'sheet', role: 'top' } } as const;
const edge = { version: 1, shapeKind: 'edge', identity: { kind: 'box-edge', featureId: 'sheet', role: 'top-front' } } as const;
const vertex = { version: 1, shapeKind: 'vertex', identity: { kind: 'box-vertex', featureId: 'sheet', role: 'top-front-left' } } as const;
const faceKey = '{"bodyFeatureId":"sheet","origin":{"identity":{"featureId":"sheet","kind":"box-face","role":"top"},"shapeKind":"face","version":1}}';
const source = { kind: 'user-supplied', reference: 'example', condition: '20 C' } as const;
const saved = { schema: 'pointercad-shell-cad-analysis/1', id: 'shell-cad-analysis', source: { documentId: 'part' },
  geometry: { schema: 'pointercad-shell-cad-input/1', id: 'shell-cad', source: { documentId: 'part' },
    bodyFeatureId: 'sheet', midsurfaceFaces: [faceKey], thicknessMm: 2, offsetMm: 0 },
  material: { id: 'steel', youngMPa: 210000, poisson: 0.3, source },
  supports: [{ kind: 'edge', origin: edge, fixed: [true, false, true, false, true, false] },
    { kind: 'vertex', origin: vertex, fixed: [true, true, true, true, true, true] }],
  edgeLoads: [{ origin: edge, forceNPerMm: [1, -2, 3], momentNmmPerMm: [4, -5, 6] }],
  surface: { linearDeflection: 0.1, angularDeflection: 0.3, maximumNodes: 1000, maximumTriangles: 2000,
    minimumTriangleAreaMm2: 0, minimumAngleDeg: 1, maximumAspectRatio: 20 } };

function context(edgeIndex = 2, mode: 'ok' | 'missing' | 'merged' | 'duplicate' = 'ok'): CadTetraContext {
  const address = { kind: 'edge' as const, index: edgeIndex };
  const edgeBinding = mode === 'merged' ? { state: 'merged' as const, origin: edge, current: address,
    coOrigins: [edge, edge] as const } : mode === 'missing' ? { state: 'missing' as const, origin: edge,
      reason: 'history-missing' as const } : { state: 'unique' as const, origin: edge, current: address };
  const body: SolidBody = { featureId: 'sheet', bodyKind: 'shell', isValid: true, volume: 0,
    mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
      edgePositions: new Float32Array(), triangleCount: 0 }, threadMarks: [],
    faces: [{ index: 5, surfaceKind: 'plane', area: 1, centroid: [0, 0, 0], axis: [0, 0, 1], radius: null,
      triangleOffset: 0, triangleCount: 1 }],
    edges: [{ index: edgeIndex, curveKind: 'line', length: 1, start: [0, 0, 0], end: [1, 0, 0], radius: null,
      segmentOffset: 0, segmentCount: 0, midpoint: [0.5, 0, 0], axis: [1, 0, 0] }],
    vertices: [{ index: 7, position: [0, 0, 0] }], origins: { version: 1, state: 'tracked', bindings: [
      { state: 'unique', origin: face, current: { kind: 'face', index: 5 } }, edgeBinding,
      ...(mode === 'duplicate' ? [{ state: 'unique' as const, origin: edge, current: address }] : []),
      { state: 'unique', origin: vertex, current: { kind: 'vertex', index: 7 } }] } };
  return { documentId: 'part', revision: 3, body, steps: [{ featureId: 'sheet', key: 'sheet:3' }] };
}

describe('saved CAD shell input binding', () => {
  it('binds independent literal conditions and follows a changed current edge index', () => {
    const inputBefore = JSON.stringify(saved), first = context(), bodyBefore = JSON.stringify(first.body);
    const settings = resolveSavedCadShellSettings(first, saved);
    expect(settings.saved.thicknessMm).toBe(2); expect(settings.saved.offsetMm).toBe(0);
    expect(settings.saved.midsurfaceFaces).toEqual([faceKey]);
    expect(settings.material).toEqual({ id: 'steel', youngMPa: 210000, poisson: 0.3 });
    expect(settings.supports.map(item => item.kind)).toEqual(['edge', 'vertex']);
    expect(settings.supports[0].kind === 'edge' ? settings.supports[0].edge.index : -1).toBe(2);
    expect(settings.supports[1].kind === 'vertex' ? settings.supports[1].vertex.index : -1).toBe(7);
    expect(settings.supports[0].fixed).toEqual([true, false, true, false, true, false]);
    expect(settings.edgeLoads[0].forceNPerMm).toEqual([1, -2, 3]);
    expect(settings.edgeLoads[0].momentNmmPerMm).toEqual([4, -5, 6]);
    expect(settings.surface).toEqual({ linearDeflection: 0.1, angularDeflection: 0.3, maximumNodes: 1000,
      maximumTriangles: 2000, minimumTriangleAreaMm2: 0, minimumAngleDeg: 1, maximumAspectRatio: 20 });
    expect(resolveSavedCadShellSettings(context(9), saved).edgeLoads[0].edge.index).toBe(9);
    expect(JSON.stringify(saved)).toBe(inputBefore); expect(JSON.stringify(first.body)).toBe(bodyBefore);
  });
  it('rejects stale owners, missing/merged/duplicate proof, wrong kind and result injection', () => {
    expect(() => resolveSavedCadShellSettings({ ...context(), documentId: 'other' }, saved)).toThrow(/invalid-settings/u);
    expect(() => resolveSavedCadShellSettings({ ...context(), body: { ...context().body, featureId: 'other' } }, saved)).toThrow(/invalid-settings/u);
    for (const mode of ['missing', 'merged', 'duplicate'] as const)
      expect(() => resolveSavedCadShellSettings(context(2, mode), saved)).toThrow(/support-unresolved/u);
    const ctx = context();
    expect(() => resolveSavedCadShellSettings({ ...ctx, body: { ...ctx.body, faces: [] } }, saved)).toThrow(/midsurface-unresolved/u);
    const otherEdge = { ...edge, identity: { ...edge.identity, role: 'top-back' } };
    expect(() => resolveSavedCadShellSettings(ctx, { ...saved, edgeLoads: [{ ...saved.edgeLoads[0], origin: otherEdge }] })).toThrow(/load-unresolved/u);
    expect(() => resolveSavedCadShellSettings(context(), { ...saved, supports: [{ ...saved.supports[0], origin: face }] })).toThrow(/invalid-settings/u);
    expect(() => resolveSavedCadShellSettings(context(), { ...saved, result: {} })).toThrow(/invalid-settings/u);
    expect(() => resolveSavedCadShellSettings(context(), saved.geometry)).toThrow(/invalid-settings/u);
  });
});
