import { expressionValueFromNumber as value } from '@pointercad/expression';
import { describe, expect, it, vi } from 'vitest';
import type { KernelBridge, SolidBody } from '../kernelBridge.js';
import type { CurrentOriginIndex } from '../geometry/subShapeOrigin.js';
import { createEmptyPartDocument } from '../part/createPartDocument.js';
import { resolvePart } from '../part/resolvePart.js';
import type { PartDocument } from '../part/types.js';
import { DEFAULT_WORK_PLANE_ID } from '../sketch/planeMath.js';
import { resolveHoleSchedule } from './resolveHoleSchedule.js';

describe('穴一覧の参照判定', () => {
  it.each([false, true])('意味起点の現面を候補逆順%sでも使い、履歴が不確かな時は旧面へ戻さない', async reverse => {
    const base = createEmptyPartDocument(), sketch = base.sketches[0];
    const origin = { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'box', role: 'top' } } as const;
    const document: PartDocument = { ...base, sketches: [{ ...sketch, features: [{ id: 'point-1', name: 'point', kind: 'point',
      planeId: DEFAULT_WORK_PLANE_ID, at: { mode: 'absolute', x: value(2), y: value(3), z: value(0) } }] }],
      solids: [{ id: 'hole-1', name: 'hole', kind: 'hole', suppressed: false, targetFeatureId: 'box',
        face: { bodyFeatureId: 'box', index: 99, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 100,
          position: [0, 0, 10], axis: [0, 0, 1], radius: null }, origin },
        centers: [{ sketchId: sketch.id, pointFeatureId: 'point-1' }],
        diameter: value(6), depth: { kind: 'through' }, tiltAngle: value(0), tiltAzimuth: value(0) }] };
    const oldFace = { index: 99, surfaceKind: 'plane' as const, area: 100, centroid: [0, 0, 10] as const,
      axis: [0, 0, 1] as const, radius: null, triangleOffset: 0, triangleCount: 0 };
    const faces = [oldFace, { ...oldFace, index: 7, area: 400, centroid: [0, 0, 30] as const }];
    const body: SolidBody = { featureId: 'box', faces: reverse ? [...faces].reverse() : faces, edges: [], vertices: [], threadMarks: [],
      volume: 12_000, isValid: true, mesh: { positions: new Float32Array([-10, -10, 0, 10, 10, 30]), normals: new Float32Array(),
        indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 },
      origins: { version: 1, state: 'tracked', bindings: [{ origin, state: 'unique', current: { kind: 'face', index: 7 } }] } };
    const recomputeSolids = vi.fn<KernelBridge['recomputeSolids']>(() => Promise.resolve({ bodies: [body], failures: [], cacheHits: 0, cancelled: false }));
    const frame = { datum: [0, 0, 0] as const, x: [1, 0, 0] as const, y: [0, 1, 0] as const };
    const saved = JSON.stringify(document), resolved = resolvePart(document);
    const result = await resolveHoleSchedule(document, resolved, { recomputeSolids }, frame, {});
    expect(result).toEqual({ ok: true, rows: [{ id: 'hole-1:hole:0', symbol: 'A1', x: 2, y: 3,
      center: [2, 3, 30], diameter: 6, depth: null, featureIds: ['hole-1'] }] });
    const unresolved: readonly CurrentOriginIndex[] = [
      { version: 1, state: 'tracked', bindings: [{ origin, state: 'split',
        candidates: [{ kind: 'face', index: 7 }, { kind: 'face', index: 99 }] }] },
      { version: 1, state: 'tracked', bindings: [{ origin, state: 'merged', current: { kind: 'face', index: 7 },
        coOrigins: [origin, { ...origin, identity: { ...origin.identity, role: 'bottom' } }] }] },
      { version: 1, state: 'tracked', bindings: [{ origin, state: 'missing', reason: 'deleted' }] },
      { version: 1, state: 'untracked', reason: 'imported' },
    ];
    for (const origins of unresolved) {
      recomputeSolids.mockResolvedValue({ bodies: [{ ...body, origins }], failures: [], cacheHits: 0, cancelled: false });
      expect(await resolveHoleSchedule(document, resolved, { recomputeSolids }, frame, {}))
        .toEqual({ ok: false, reason: 'missingFace', featureId: 'hole-1' });
    }
    expect(JSON.stringify(document)).toBe(saved);
  });

  it.each([false, true])('曖昧な面は候補逆順%sでも一覧値を生成せず、元の参照を保つ', async (reverse) => {
    const base = createEmptyPartDocument(), sketch = base.sketches[0];
    const document: PartDocument = { ...base, sketches: [{ ...sketch, features: [{ id: 'point-1', name: 'point', kind: 'point',
      planeId: DEFAULT_WORK_PLANE_ID, at: { mode: 'absolute', x: value(0), y: value(0), z: value(0) } }] }],
      solids: [{ id: 'hole-1', name: 'hole', kind: 'hole', suppressed: false, targetFeatureId: 'box',
        face: { bodyFeatureId: 'box', index: 99, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 100,
          position: [0, 0, 10], axis: [0, 0, 1], radius: null } }, centers: [{ sketchId: sketch.id, pointFeatureId: 'point-1' }],
        diameter: value(6), depth: { kind: 'through' }, tiltAngle: value(0), tiltAzimuth: value(0) }] };
    const faces = [7, 19].map((index) => ({ index, surfaceKind: 'plane' as const, area: 100, centroid: [0, 0, 10] as const,
      axis: [0, 0, 1] as const, radius: null, triangleOffset: 0, triangleCount: 0 }));
    const body: SolidBody = { featureId: 'box', faces: reverse ? [...faces].reverse() : faces, edges: [], vertices: [], threadMarks: [],
      volume: 1000, isValid: true, mesh: { positions: new Float32Array([-10, -10, 0, 10, 10, 20]), normals: new Float32Array(),
        indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0 } };
    const recomputeSolids = vi.fn<KernelBridge['recomputeSolids']>(() => Promise.resolve({ bodies: [body], failures: [], cacheHits: 0, cancelled: false }));
    const frame = { datum: [0, 0, 0] as const, x: [1, 0, 0] as const, y: [0, 1, 0] as const };
    const saved = JSON.stringify(document), resolved = resolvePart(document);
    expect(await resolveHoleSchedule(document, resolved, { recomputeSolids }, frame, {})).toMatchObject({ ok: false, reason: 'missingFace' });
    recomputeSolids.mockResolvedValue({ bodies: [{ ...body, faces: [faces[0]] }], failures: [], cacheHits: 0, cancelled: false });
    const unique = await resolveHoleSchedule(document, resolved, { recomputeSolids }, frame, {});
    expect(unique.ok).toBe(true);
    if (unique.ok) expect(unique.rows).toHaveLength(1);
    expect(JSON.stringify(document)).toBe(saved);
  });
});
