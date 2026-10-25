import { toSolidStepRequest } from './solidRequests.js';
import { keyMaterialFor } from '../part/solidPlanKeyMaterial.js';
import type { SolidStepPlan } from '../part/resolvePart.js';
import type { SolidBodyMesh, SolidRecomputeResult } from '@pointercad/kernel';
import { describe, expect, it } from 'vitest';

import { captureSolidRecomputeContext, readMeshJsAccounting, readMeshJsFinalAccounting, toSolidOutcome,
  toSolidRecomputeRequest } from './solidConversions.js';

function kernelBody(coordinateFrame?: SolidBodyMesh['coordinateFrame']): SolidBodyMesh {
  return {
    id: 'body-1',
    ...(coordinateFrame === undefined ? {} : { coordinateFrame }),
    positions: new Float32Array([0, 0, 0]),
    normals: new Float32Array([0, 0, 1]),
    indices: new Uint32Array([0, 0, 0]),
    edgePositions: new Float32Array([0, 0, 0, 1, 0, 0]),
    triangleCount: 1, faceCount: 0, edgeCount: 0,
    volume: 1, bodyKind: 'solid', faces: [], edges: [], vertices: [], threadMarks: [],
  };
}

function result(body: SolidBodyMesh): SolidRecomputeResult {
  return { bodies: [body], failures: [], cacheHits: 0, cancelled: false, appearanceMatches: [] };
}

describe('solid local display conversion', () => {
  it('forwards only an explicit valid budget and leaves ordinary requests in world coordinates', () => {
    const world = toSolidRecomputeRequest([], { generation: 4 });
    expect(world.localMesh).toBeUndefined();
    const localMesh = { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 64 * 1024 * 1024 };
    const local = toSolidRecomputeRequest([], { generation: 4, localMesh });
    expect(local.localMesh).toEqual(localMesh);
    expect(local.generation).toBe(world.generation);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 512 * 1024 * 1024 + 1])(
    'rejects an invalid live-byte limit %s before forming a request', maximumLiveMeshBytes => {
      expect(() => toSolidRecomputeRequest([], { localMesh: {
        maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes } })).toThrow(RangeError);
    });

  it('preserves local metadata on the body rather than inside the mesh or document', () => {
    const frame = { space: 'local' as const, origin: [1e9, -1e9, 0] as const,
      maximumFloat32ErrorMm: 1e-4 };
    const body = toSolidOutcome([], result(kernelBody(frame))).bodies[0];
    expect(body.coordinateFrame).toEqual(frame);
    expect(body.mesh.positions).toEqual(new Float32Array([0, 0, 0]));
    expect('coordinateFrame' in body.mesh).toBe(false);
    const legacy = toSolidOutcome([], result(kernelBody())).bodies[0];
    expect(legacy.coordinateFrame).toBeUndefined();
  });

  it('preserves separate result budgets and all original mesh arrays', () => {
    const capA = 64 * 1024 * 1024;
    const capB = 32 * 1024 * 1024;
    const first = kernelBody({ space: 'local', origin: [1e9, 0, 0],
      maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: capA });
    const second = { ...kernelBody({ space: 'local', origin: [-1e9, 0, 0],
      maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: capB }), id: 'body-2' };
    const bodies = toSolidOutcome([], { ...result(first), bodies: [first, second] }).bodies;
    expect(bodies.map((body) => body.coordinateFrame?.maximumLiveMeshBytes)).toEqual([capA, capB]);
    expect(bodies.map((body) => body.coordinateFrame?.origin)).toEqual([[1e9, 0, 0], [-1e9, 0, 0]]);
    expect(bodies.map((body) => body.featureId)).toEqual(['body-1', 'body-2']);
    expect(bodies[0].mesh.positions).toBe(first.positions);
    expect(bodies[1].mesh.edgePositions).toBe(second.edgePositions);
    expect(toSolidOutcome([], result(kernelBody())).bodies[0].coordinateFrame).toBeUndefined();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
    512 * 1024 * 1024 + 1])('rejects an invalid result budget %s', maximumLiveMeshBytes => {
    const forged = { space: 'local' as const, origin: [0, 0, 0] as const,
      maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes };
    expect(() => toSolidOutcome([], result(kernelBody(forged)))).toThrow(RangeError);
  });

  it('rejects a forged non-finite local frame instead of emitting unlabelled local data', () => {
    const forged = { space: 'local' as const, origin: [Number.NaN, 0, 0] as const,
      maximumFloat32ErrorMm: 1e-4 };
    expect(() => toSolidOutcome([], result(kernelBody(forged)))).toThrow(RangeError);
  });

  it('rejects a length-three local origin with a missing axis', () => {
    const origin: [number, number, number] = [1e9, -1e9, 0];
    Reflect.deleteProperty(origin, '1');
    expect(origin.length).toBe(3);
    expect(() => toSolidOutcome([], result(kernelBody({ space: 'local', origin,
      maximumFloat32ErrorMm: 1e-4 })))).toThrow(RangeError);
  });

  it('rejects an axis inherited from the origin prototype', () => {
    const origin: [number, number, number] = [1e9, -1e9, 0];
    Reflect.deleteProperty(origin, '1');
    Object.setPrototypeOf(origin, { 1: -1e9 });
    expect(origin[1]).toBe(-1e9);
    expect(() => toSolidOutcome([], result(kernelBody({ space: 'local', origin,
      maximumFloat32ErrorMm: 1e-4 })))).toThrow(RangeError);
  });
});

describe('dispatch-bound JS mesh reservation', () => {
  const reading = { status: 'known' as const, limitBytes: 1000, cacheActiveBytes: 130,
    cacheRetiredBytes: 110, cacheProtectedBytes: 240, retainedReplyBytes: 300,
    requestPeakReservedBytes: 1000 };
  const localMesh = { maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 1000 };
  const context = captureSolidRecomputeContext(toSolidRecomputeRequest([], {
    partId: 'part-A', generation: 7, localMesh,
  }));
  const local = () => kernelBody({ space: 'local', origin: [1e9, -1e9, 0],
    maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 1000 });
  // local(): 12 + 12 + 12 + 24 = 60 bytes in four whole buffers, displayed and replied once each.
  const final = { status: 'known' as const, limitBytes: 1000, cacheActiveBytes: 130,
    cacheRetiredBytes: 0, cacheProtectedBytes: 130, displayBackingBytes: 60, replyBackingBytes: 60,
    retainedBackingBytes: 190, replyCloneReservedBytes: 60 };
  const adoptable = () => ({ ...result(local()), meshJsAccounting: reading, meshJsFinalAccounting: final });

  it('keeps independent successful local bodies and failure diagnostics only with complete accounting', () => {
    const raw = { ...adoptable(), failures: [{ id: 'failed-shape', message: 'geometry failed' }] };
    const outcome = toSolidOutcome([], raw, [], context);
    expect(outcome.cancelled).toBe(false);
    expect(outcome.bodies.map(body => body.featureId)).toEqual(['body-1']);
    expect(outcome.bodies[0].mesh.positions).toBe(raw.bodies[0].positions);
    expect(outcome.failures).toEqual([{ featureId: 'failed-shape', message: 'geometry failed' }]);
    expect(outcome.meshJsAccounting).toEqual({ partId: 'part-A', generation: 7, reading, final });
    const cancelled = toSolidOutcome([], { ...raw, cancelled: true }, [], context);
    expect(cancelled.bodies).toEqual([]);
    expect(cancelled.meshJsAccounting).toBeUndefined();
  });

  it('does not let a feature failure bypass any local reply evidence', () => {
    const mixed = { ...adoptable(), failures: [{ id: 'failed-shape', message: 'geometry failed' }] };
    const invalid: SolidRecomputeResult[] = [
      { ...mixed, meshJsAccounting: undefined },
      { ...mixed, meshJsAccounting: { status: 'unknown', limitBytes: 1000, reason: 'missing-counts' } },
      { ...mixed, meshJsFinalAccounting: undefined },
      { ...mixed, meshJsFinalAccounting: { status: 'unknown', limitBytes: 1000, reason: 'callback-missing' } },
      { ...mixed, meshJsFinalAccounting: { ...final, replyCloneReservedBytes: 0 } },
      { ...mixed, meshJsFinalAccounting: { ...final, replyBackingBytes: 59, replyCloneReservedBytes: 59 } },
      { ...mixed, meshJsFinalAccounting: { ...final, cacheActiveBytes: 881, cacheProtectedBytes: 881,
        retainedBackingBytes: 941 } },
      { ...mixed, bodies: [] },
      { ...mixed, bodies: [kernelBody()] },
      { ...mixed, bodies: [{ ...local(), coordinateFrame: { space: 'local', origin: [NaN, 0, 0],
        maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 1000 } }] },
      { ...mixed, bodies: [{ ...local(), positions: new Float32Array(new ArrayBuffer(1024), 0, 3) }] },
      { ...mixed, failures: [{ id: 'body-1', message: 'body itself failed' }] },
    ];
    for (const raw of invalid) {
      const outcome = toSolidOutcome([], raw, [], context);
      expect(outcome.bodies).toEqual([]);
      expect(outcome.meshJsAccounting).toBeUndefined();
      expect(outcome.failures.map(failure => failure.message)).toEqual(raw.failures.map(failure => failure.message));
      expect(outcome.cancelled).toBe(false);
    }
  });

  it('uses independent cache/reply totals and includes clone only once', () => {
    const decoded = readMeshJsAccounting(reading, 1000);
    expect(decoded).toEqual(reading);
    expect(Object.isFrozen(decoded)).toBe(true);
    // 130 + 110 + 300 = 540. Protected 240 and the clone already in reply 300 are not added.
    const exact = { ...reading, limitBytes: 540, requestPeakReservedBytes: 540 };
    expect(readMeshJsAccounting(exact, 540)).toEqual(exact);
    expect(() => readMeshJsAccounting({ ...exact, limitBytes: 539,
      requestPeakReservedBytes: 539 }, 539)).toThrow(RangeError);
    expect(() => readMeshJsAccounting({ ...reading, cacheProtectedBytes: 241 }, 1000)).toThrow(RangeError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5, '0', undefined,
    Number.MAX_SAFE_INTEGER + 1])('rejects invalid byte count %s', cacheActiveBytes => {
    expect(() => readMeshJsAccounting({ ...reading, cacheActiveBytes }, 1000)).toThrow(RangeError);
  });

  it('rejects sums, peaks, fields, and bounds independently', () => {
    for (const forged of [
      { ...reading, cacheActiveBytes: Number.MAX_SAFE_INTEGER, cacheRetiredBytes: 1 },
      { ...reading, retainedReplyBytes: Number.MAX_SAFE_INTEGER },
      { ...reading, requestPeakReservedBytes: 539 },
      { ...reading, requestPeakReservedBytes: 1001 },
      { ...reading, limitBytes: 999 },
      { ...reading, status: 'maybe' },
      { ...reading, extraCloneBytes: 100 },
      null, undefined,
    ]) expect(() => readMeshJsAccounting(forged, 1000)).toThrow(RangeError);
    const inherited: unknown = Object.create(reading);
    expect(() => readMeshJsAccounting(inherited, 1000)).toThrow(RangeError);
  });

  it('retains unknown as unknown and forbids fabricated numeric zero fields', () => {
    const unknown = { status: 'unknown' as const, limitBytes: 1000, reason: 'callback-missing' as const };
    expect(readMeshJsAccounting(unknown, 1000)).toEqual(unknown);
    expect(() => readMeshJsAccounting({ ...unknown, cacheActiveBytes: 0 }, 1000)).toThrow(RangeError);
    expect(() => readMeshJsAccounting({ ...unknown, reason: 'not-a-reason' }, 1000)).toThrow(RangeError);
    expect(() => toSolidOutcome([], { ...result(local()), meshJsAccounting: unknown }, [], context))
      .toThrow('accounting is unknown');
  });

  it('captures immutable dispatch provenance and leaves historical local conversion intact', () => {
    localMesh.maximumLiveMeshBytes = 999;
    try {
      const outcome = toSolidOutcome([], adoptable(), [], context);
      expect(outcome.meshJsAccounting).toEqual({ partId: 'part-A', generation: 7, reading, final });
      expect(Object.isFrozen(outcome.meshJsAccounting)).toBe(true);
      expect(Object.isFrozen(outcome.meshJsAccounting?.final)).toBe(true);
      expect(outcome.bodies[0].mesh.positions).toHaveLength(3);
      const historical = toSolidOutcome([], result(local()));
      expect(historical.bodies[0].coordinateFrame?.maximumLiveMeshBytes).toBe(1000);
      expect(historical.meshJsAccounting).toBeUndefined();
    } finally { localMesh.maximumLiveMeshBytes = 1000; }
  });

  it('rejects missing sidecars, wrong frames, reply undercount, and hidden backing buffers', () => {
    expect(() => toSolidOutcome([], result(local()), [], context)).toThrow(RangeError);
    const wrong = kernelBody({ space: 'local', origin: [0, 0, 0],
      maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 999 });
    expect(() => toSolidOutcome([], { ...result(wrong), meshJsAccounting: reading }, [], context)).toThrow(RangeError);
    const imprecise = kernelBody({ space: 'local', origin: [0, 0, 0],
      maximumFloat32ErrorMm: 1e-3, maximumLiveMeshBytes: 1000 });
    expect(() => toSolidOutcome([], { ...result(imprecise), meshJsAccounting: reading }, [], context)).toThrow(RangeError);
    // 12 + 12 + 12 + 24 = 60 bytes, with another 60 already reserved for IPC.
    expect(() => toSolidOutcome([], { ...result(local()), meshJsAccounting: {
      ...reading, retainedReplyBytes: 119 } }, [], context)).toThrow('reply arrays exceed');
    const oversized = { ...local(), positions: new Float32Array(new ArrayBuffer(1024 * 1024), 0, 3) };
    expect(() => toSolidOutcome([], { ...result(oversized), meshJsAccounting: reading }, [], context))
      .toThrow('backing buffer');
    const world = captureSolidRecomputeContext(toSolidRecomputeRequest([], {}));
    expect(() => toSolidOutcome([], { ...result(local()), meshJsAccounting: reading }, [], world)).toThrow(RangeError);
    expect(toSolidOutcome([], result(kernelBody()), [], world).meshJsAccounting).toBeUndefined();
  });

  it('distinguishes a measured empty local result from an absent or unknown reading', () => {
    const empty: SolidRecomputeResult = { bodies: [], failures: [], cacheHits: 0, cancelled: false };
    const zero = { ...reading, cacheActiveBytes: 0, cacheRetiredBytes: 0, cacheProtectedBytes: 0,
      retainedReplyBytes: 0, requestPeakReservedBytes: 0 };
    const zeroFinal = { ...final, cacheActiveBytes: 0, cacheProtectedBytes: 0, displayBackingBytes: 0,
      replyBackingBytes: 0, retainedBackingBytes: 0, replyCloneReservedBytes: 0 };
    expect(toSolidOutcome([], { ...empty, meshJsAccounting: zero, meshJsFinalAccounting: zeroFinal }, [],
      context).meshJsAccounting?.reading).toEqual(zero);
    expect(() => toSolidOutcome([], empty, [], context)).toThrow(RangeError);
    expect(() => toSolidOutcome([], { ...empty, meshJsAccounting: zero }, [], context)).toThrow(RangeError);
  });

  it('reads the post-token union strictly and keeps unknown as unknown', () => {
    expect(readMeshJsFinalAccounting(final, 1000)).toEqual(final);
    expect(Object.isFrozen(readMeshJsFinalAccounting(final, 1000))).toBe(true);
    const unknown = { status: 'unknown' as const, limitBytes: 1000, reason: 'callback-missing' as const };
    expect(readMeshJsFinalAccounting(unknown, 1000)).toEqual(unknown);
    for (const forged of [
      { ...final, cacheProtectedBytes: 131 },
      { ...final, retainedBackingBytes: 129, cacheActiveBytes: 130 },
      { ...final, displayBackingBytes: 191 },
      { ...final, replyBackingBytes: 191, replyCloneReservedBytes: 191 },
      { ...final, retainedBackingBytes: 251 },
      { ...final, replyCloneReservedBytes: 0 },
      { ...final, replyCloneReservedBytes: 120 },
      { ...final, retainedBackingBytes: Number.MAX_SAFE_INTEGER },
      { ...final, cacheActiveBytes: Number.MAX_SAFE_INTEGER, cacheRetiredBytes: 1 },
      { ...final, limitBytes: 999 },
      { ...final, extraWorkerBytes: 0 },
      { ...final, status: 'maybe' },
      { ...unknown, retainedBackingBytes: 0 },
      { ...unknown, reason: 'missing-counts' },
      null, undefined,
    ]) expect(() => readMeshJsFinalAccounting(forged, 1000)).toThrow(RangeError);
    for (const value of [Number.NaN, -1, 0.5, '0', undefined, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => readMeshJsFinalAccounting({ ...final, displayBackingBytes: value }, 1000)).toThrow(RangeError);
    }
    const inherited: unknown = Object.create(final);
    expect(() => readMeshJsFinalAccounting(inherited, 1000)).toThrow(RangeError);
  });

  it('adopts a local reply only with a known post-token union bound to its arrays and limit', () => {
    expect(() => toSolidOutcome([], { ...result(local()), meshJsAccounting: reading }, [], context))
      .toThrow('final accounting limit is invalid or missing');
    expect(() => toSolidOutcome([], { ...adoptable(), meshJsFinalAccounting: { status: 'unknown',
      limitBytes: 1000, reason: 'overflow' } }, [], context)).toThrow('final accounting is unknown');
    for (const replyBackingBytes of [59, 61]) {
      expect(() => toSolidOutcome([], { ...adoptable(), meshJsFinalAccounting: { ...final,
        replyBackingBytes, replyCloneReservedBytes: replyBackingBytes } }, [], context))
        .toThrow('does not match the reply arrays');
    }
    // 821 + 60 + 60 = 941 retained, plus a 60-byte clone, is one byte over the 1000-byte limit.
    const atLimit = { ...final, cacheActiveBytes: 820, cacheProtectedBytes: 820, retainedBackingBytes: 940 };
    expect(toSolidOutcome([], { ...adoptable(), meshJsFinalAccounting: atLimit }, [], context)
      .meshJsAccounting?.final).toEqual(atLimit);
    expect(() => toSolidOutcome([], { ...adoptable(), meshJsFinalAccounting: { ...atLimit,
      cacheActiveBytes: 821, retainedBackingBytes: 941 } }, [], context)).toThrow('exceeds its limit');
    const world = captureSolidRecomputeContext(toSolidRecomputeRequest([], {}));
    expect(() => toSolidOutcome([], { ...result(kernelBody()), meshJsFinalAccounting: final }, [], world))
      .toThrow('World mesh request received a local reply');
  });

  it.each(['missing', 'unknown', 'known'] as const)(
    'preserves terminal facts without publishing partial local bodies or a %s receipt', accounting => {
      const partial = kernelBody({ space: 'local', origin: [Number.NaN, 0, 0],
        maximumFloat32ErrorMm: 1e-4, maximumLiveMeshBytes: 999 });
      const sidecar = accounting === 'missing' ? {} : { meshJsAccounting: accounting === 'known'
        ? reading : { status: 'unknown' as const, limitBytes: 1000, reason: 'overflow' as const } };
      for (const cancelled of [true, false]) {
        const failures = [{ id: 'failed-shape', message: 'local budget exhausted' }];
        const raw: SolidRecomputeResult = { ...result(partial), ...sidecar, cancelled, failures,
          cacheHits: 7, memory: { wasmHeapBytes: 91, wasmHeapLimitBytes: 100 } };
        const outcome = toSolidOutcome([], raw, [], context);
        expect(outcome.cancelled).toBe(cancelled);
        expect(outcome.bodies).toEqual([]);
        expect(outcome.failures).toEqual([{ featureId: 'failed-shape', message: 'local budget exhausted' }]);
        expect(outcome.cacheHits).toBe(7);
        expect(outcome.kernelMemory).toEqual({ usedBytes: 91, limitBytes: 100 });
        expect('meshJsAccounting' in outcome).toBe(false);
        expect(raw.bodies).toEqual([partial]);
        expect(raw.meshJsAccounting).toEqual(sidecar.meshJsAccounting);
      }
      const cancelled = toSolidOutcome([], { ...result(partial), ...sidecar, cancelled: true }, [], context);
      expect(cancelled.cancelled).toBe(true);
      expect(cancelled.failures).toEqual([]);
      expect(cancelled.bodies).toEqual([]);
      expect('meshJsAccounting' in cancelled).toBe(false);
    });

  it('keeps historical cancellation conversion and world terminal replies unchanged', () => {
    const raw = { ...result(local()), cancelled: true };
    const historical = toSolidOutcome([], raw);
    expect(historical.cancelled).toBe(true);
    expect(historical.bodies).toHaveLength(1);
    expect(historical.meshJsAccounting).toBeUndefined();
    const world = captureSolidRecomputeContext(toSolidRecomputeRequest([], {}));
    const outcome = toSolidOutcome([], { ...result(kernelBody()), cancelled: true }, [], world);
    expect(outcome.cancelled).toBe(true);
    expect(outcome.bodies).toHaveLength(1);
    expect(outcome.meshJsAccounting).toBeUndefined();
  });
});

it('carries authored hole producer proof into both actual kernel request and cache material', () => {
  const plan: SolidStepPlan = { kind: 'hole', targetKey: 'plate-key',
    face: { bodyFeatureId: 'plate', index: 0, fingerprint: { kind: 'face', surfaceKind: 'plane',
      area: 1200, position: [20, 15, 10], axis: [0, 0, 1], radius: null } },
    centers: [[10, 15, 10]], diameter: 6, depth: null, tiltAngle: 0, tiltAzimuth: 0,
    transforms: [{ translation: [0, 0, 0], rotationOrigin: [0, 0, 0], rotationAxis: [0, 0, 1], rotationAngle: 0 }],
    centerAnchors: [{ sketchId: 'centers', producer: { kind: 'grid-point', featureId: 'grid', row: 1, column: 2 } }],
    placementRoles: [{ kind: 'point-slot', slotId: 'slot-7', source: { kind: 'reference-point', featureId: 'source-A' } }],
    pointPlacementReferences: [{ slotId: 'slot-7', reference: { kind: 'point', pointId: 'source-A' } }],
  };
  const request = toSolidStepRequest({ featureId: 'holes', name: 'holes', key: 'hole-key', visible: true, plan });
  const material = keyMaterialFor(plan);
  if (request.step.kind !== 'hole' || material.kind !== 'hole') throw new Error('Missing hole bridge');
  const expectedCenters = [{ sketchId: 'centers', producer: { kind: 'grid-point', featureId: 'grid', row: 1, column: 2 } }];
  const expectedRoles = [{ kind: 'point-slot', slotId: 'slot-7', source: { kind: 'reference-point', featureId: 'source-A' } }];
  expect(request.step.centerAnchors).toEqual(expectedCenters);
  expect(request.step.placementRoles).toEqual(expectedRoles);
  expect(material.centerAnchors).toEqual(expectedCenters);
  expect(material.placementRoles).toEqual(expectedRoles);
  expect(material.pointPlacementReferences).toEqual([{ slotId: 'slot-7', reference: { kind: 'point', pointId: 'source-A' } }]);
  expect('pointPlacementReferences' in request.step).toBe(false);
});
