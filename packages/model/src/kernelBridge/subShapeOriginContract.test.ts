import { describe, expect, it } from 'vitest';
import type { SubShapeOrigin as KernelOrigin, CurrentOriginIndex as KernelIndex } from '@pointercad/kernel';
import type { SubShapeOrigin as DrawingOrigin, CurrentOriginIndex as DrawingIndex } from '@pointercad/drawing';
import type { SubShapeOrigin as ModelOrigin, CurrentOriginIndex as ModelIndex } from '../geometry/subShapeOrigin.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { fingerprintKeyText, isSameSubShape } from '../geometry/subShapeRef.js';
import type { SolidBody } from './solidContracts.js';
import { resolveSubShapeReference } from './referenceResolution.js';

const canonical = { version: 1, shapeKind: 'face', identity: {
  kind: 'extrude-side', featureId: 'saved-extrude', profile: {
    sketchId: 'sketch', faceFeatureId: 'region', lineFeatureId: 'line-1', role: 'whole-line',
  },
} } as const satisfies KernelOrigin;

// These assignments fail compilation if any layer's closed DTO drifts.
const kernel: KernelOrigin = canonical;
const model: ModelOrigin = kernel;
const drawing: DrawingOrigin = model;
const backToKernel: KernelOrigin = drawing;
const backToModel: ModelOrigin = backToKernel;
const backToDrawing: DrawingOrigin = backToModel;

const canonicalIndex: KernelIndex = { version: 1, state: 'tracked', bindings: [
  { origin: canonical, state: 'unique', current: { kind: 'face', index: 3 } },
] };
const modelIndex: ModelIndex = canonicalIndex;
const drawingIndex: DrawingIndex = modelIndex;
const backToKernelIndex: KernelIndex = drawingIndex;
const cylinderCanonicals = [
  { version: 1, shapeKind: 'face', identity: { kind: 'cylinder-face', featureId: 'cylinder-1', role: 'side' } },
  { version: 1, shapeKind: 'face', identity: { kind: 'cylinder-face', featureId: 'cylinder-1', role: 'start' } },
  { version: 1, shapeKind: 'face', identity: { kind: 'cylinder-face', featureId: 'cylinder-1', role: 'end' } },
  { version: 1, shapeKind: 'edge', identity: { kind: 'cylinder-edge', featureId: 'cylinder-1', role: 'start-ring' } },
  { version: 1, shapeKind: 'edge', identity: { kind: 'cylinder-edge', featureId: 'cylinder-1', role: 'end-ring' } },
  { version: 1, shapeKind: 'edge', identity: { kind: 'cylinder-edge', featureId: 'cylinder-1', role: 'seam' } },
  { version: 1, shapeKind: 'vertex', identity: { kind: 'cylinder-vertex', featureId: 'cylinder-1', role: 'seam-start' } },
  { version: 1, shapeKind: 'vertex', identity: { kind: 'cylinder-vertex', featureId: 'cylinder-1', role: 'seam-end' } },
] as const satisfies readonly KernelOrigin[];
const kernelCylinders: readonly KernelOrigin[] = cylinderCanonicals;
const modelCylinders: readonly ModelOrigin[] = kernelCylinders;
const drawingCylinders: readonly DrawingOrigin[] = modelCylinders;
const backToKernelCylinders: readonly KernelOrigin[] = drawingCylinders;

describe('3層の意味起点DTO契約', () => {
  it('円筒の面3・辺3・頂点2の保存identityを3鏡で受け渡す', () => {
    expect(backToKernelCylinders).toEqual(cylinderCanonicals);
    expect(new Set(cylinderCanonicals.map(origin => JSON.stringify(origin))).size).toBe(8);
    expect(cylinderCanonicals.map(origin => origin.shapeKind)).toEqual([
      'face', 'face', 'face', 'edge', 'edge', 'edge', 'vertex', 'vertex',
    ]);
  });
  it('同じcanonical JSONを相互に受け渡し、保存feature IDと現在body IDを分ける', () => {
    expect(JSON.stringify(kernel)).toBe(JSON.stringify(model));
    expect(JSON.stringify(model)).toBe(JSON.stringify(drawing));
    expect(JSON.stringify(drawing)).toBe(JSON.stringify(backToDrawing));
    expect(backToKernelIndex).toEqual(canonicalIndex);
    const ref: SubShapeRef = { bodyFeatureId: 'current-body', index: 3,
      fingerprint: { kind: 'face', surfaceKind: 'plane', area: 200,
        position: [5, 10, 0], axis: [0, 0, 1], radius: null }, origin: canonical };
    expect(ref.bodyFeatureId).toBe('current-body');
    expect(ref.origin?.identity.featureId).toBe('saved-extrude');
    expect(JSON.parse(JSON.stringify(ref))).toMatchObject({ origin: canonical });
    const legacy: SubShapeRef = { bodyFeatureId: 'current-body', index: 3, fingerprint: ref.fingerprint };
    expect(legacy.origin).toBeUndefined();
    expect(isSameSubShape(ref, legacy)).toBe(false);
    expect(fingerprintKeyText(ref)).not.toBe(fingerprintKeyText(legacy));
    const different: SubShapeRef = { ...ref, origin: { version: 1, shapeKind: 'face',
      identity: { kind: 'box-face', featureId: 'another-feature', role: 'top' } } };
    expect(isSameSubShape(ref, different)).toBe(false);
    expect(fingerprintKeyText(ref)).not.toBe(fingerprintKeyText(different));
    const reordered: SubShapeRef = { ...different, origin: { identity: {
      role: 'top', featureId: 'another-feature', kind: 'box-face',
    }, shapeKind: 'face', version: 1 } };
    expect(isSameSubShape(different, reordered)).toBe(true);
    expect(fingerprintKeyText(different)).toBe(fingerprintKeyText(reordered));
  });
});

const holeCanonical = { version: 1, shapeKind: 'face', identity: { kind: 'hole-face', featureId: 'hole-producer',
  center: { sketchId: 'sketch-1', producer: { kind: 'grid-point', featureId: 'grid', row: 2, column: 3 } },
  placement: { kind: 'point-slot', slotId: 'slot-9', source: { kind: 'sketch-point', anchor: {
    sketchId: 'placements', producer: { kind: 'point', featureId: 'placement-point' },
  } } }, stage: 'bore', role: 'wall',
} } as const satisfies KernelOrigin;
const modelHole: ModelOrigin = holeCanonical;
const drawingHole: DrawingOrigin = modelHole;
const kernelHole: KernelOrigin = drawingHole;
it('keeps the hole producer and persisted placement source closed across all three DTO owners', () => {
  expect(kernelHole).toEqual(holeCanonical);
  expect(drawingHole).toEqual(modelHole);
});


it('preserves a saved phi6 fingerprint while current hole origin resolves phi8 across the model boundary', () => {
  const saved: SubShapeRef = { bodyFeatureId: 'hole-producer', index: 2, origin: modelHole,
    fingerprint: { kind: 'face', surfaceKind: 'cylinder', area: 60 * Math.PI,
      position: [20, 15, 5], axis: [0, 0, 1], radius: 3 } };
  const savedJson = JSON.stringify(saved);
  // DTO-only boundary fixture; actual OCCT shape/volume/rims are checked by makeHole.test.ts.
  const current: SolidBody = { featureId: 'hole-producer', mesh: {
    positions: new Float32Array([0, 0, 0, 40, 30, 10]), normals: new Float32Array(),
    indices: new Uint32Array(), edgePositions: new Float32Array(), triangleCount: 0,
  }, volume: 12000 - 160 * Math.PI, isValid: true, edges: [], vertices: [], threadMarks: [],
    faces: [{ index: 7, surfaceKind: 'cylinder', area: 80 * Math.PI, centroid: [20, 15, 5],
      axis: [0, 0, 1], axisOrigin: [20, 15, 10], radius: 4, triangleOffset: 0, triangleCount: 0 }],
    origins: { version: 1, state: 'tracked', bindings: [{ origin: kernelHole,
      state: 'unique', current: { kind: 'face', index: 7 } }] } };
  const match = resolveSubShapeReference(current, saved);
  expect(match.status).toBe('matched');
  if (match.status !== 'matched') throw new Error('Current semantic DTO wall unavailable');
  expect(match.match.basis).toBe('semantic');
  expect(match.match.reference).toMatchObject({ index: 7, origin: holeCanonical,
    fingerprint: { radius: 4 } });
  expect(match.match.geometry).toMatchObject({ kind: 'face', surfaceKind: 'cylinder', radius: 4 });
  expect(match.originalReference).toBe(saved);
  const foreign = { ...holeCanonical, identity: { ...holeCanonical.identity, featureId: 'foreign-hole' } };
  expect(resolveSubShapeReference(current, { ...saved, origin: foreign }).status).toBe('missing');
  if (saved.fingerprint.kind !== 'face') throw new Error('Saved DTO fingerprint must be a face');
  const high: SubShapeRef = { ...saved, index: 7, fingerprint: { ...saved.fingerprint, radius: 4 } };
  const states: readonly (ModelIndex | undefined)[] = [undefined,
    { version: 1, state: 'tracked', bindings: [{ origin: modelHole, state: 'missing', reason: 'deleted' }] },
    { version: 1, state: 'tracked', bindings: [{ origin: modelHole, state: 'split', candidates: [
      { kind: 'face', index: 7 }, { kind: 'face', index: 8 },
    ] }] },
    { version: 1, state: 'tracked', bindings: [{ origin: modelHole, state: 'merged',
      current: { kind: 'face', index: 7 }, coOrigins: [modelHole, foreign] }] },
  ];
  expect(states.map(origins => resolveSubShapeReference({ ...current, origins }, high).status))
    .toEqual(['missing', 'missing', 'ambiguous', 'ambiguous']);
  expect(JSON.stringify(saved)).toBe(savedJson);
  expect(saved.fingerprint).toMatchObject({ radius: 3 });
});


const sphereCanonical = { version: 1, shapeKind: 'face', identity: {
  kind: 'sphere-face', featureId: 'persisted-sphere', role: 'surface',
} } as const satisfies KernelOrigin;
const modelSphere: ModelOrigin = sphereCanonical;
const drawingSphere: DrawingOrigin = modelSphere;
const kernelSphere: KernelOrigin = drawingSphere;
it('keeps the sphere surface identity closed across all three DTO owners', () => {
  expect(kernelSphere).toEqual(sphereCanonical);
  expect(JSON.parse(JSON.stringify(drawingSphere))).toEqual(modelSphere);
});


const analyticCanonicals = [
  { version: 1, shapeKind: 'face', identity: { kind: 'cone-face', featureId: 'cone', role: 'side' } },
  { version: 1, shapeKind: 'face', identity: { kind: 'cone-face', featureId: 'cone', role: 'start' } },
  { version: 1, shapeKind: 'face', identity: { kind: 'cone-face', featureId: 'cone', role: 'end' } },
  { version: 1, shapeKind: 'face', identity: { kind: 'torus-face', featureId: 'torus', role: 'surface' } },
] as const satisfies readonly KernelOrigin[];
const modelAnalytics: readonly ModelOrigin[] = analyticCanonicals;
const drawingAnalytics: readonly DrawingOrigin[] = modelAnalytics;
const kernelAnalytics: readonly KernelOrigin[] = drawingAnalytics;
it('retains all cone and torus semantic face variants across all three owners', () => {
  expect(kernelAnalytics).toEqual(analyticCanonicals);
  expect(JSON.parse(JSON.stringify(drawingAnalytics))).toEqual(modelAnalytics);
  expect(new Set(kernelAnalytics.map(origin => JSON.stringify(origin))).size).toBe(4);
});
it('keeps saved whole-curve side and cap identities assignable across all three layers', () => {
  const values = [
    { version: 1, shapeKind: 'face', identity: { kind: 'extrude-curve-side', featureId: 'extrude',
      profile: { sketchId: 'sketch', faceFeatureId: 'face', curveFeatureId: 'spline', role: 'whole-curve' } } },
    { version: 1, shapeKind: 'face', identity: { kind: 'extrude-curve-cap', featureId: 'extrude', end: 'end',
      profile: { sketchId: 'sketch', faceFeatureId: 'face', curveFeatureIds: ['spline', 'line-a', 'line-b'] } } },
  ] as const satisfies readonly KernelOrigin[];
  const modelValues: readonly ModelOrigin[] = values;
  const drawingValues: readonly DrawingOrigin[] = modelValues;
  const kernelValues: readonly KernelOrigin[] = drawingValues;
  expect(kernelValues).toEqual(values);
  expect(kernelValues[0].identity.kind).toBe('extrude-curve-side');
  expect(kernelValues[1].identity.kind).toBe('extrude-curve-cap');
});

it('preserves real open-profile identity across kernel/model/drawing without a closed face ID', () => {
  const kernelSurface = { version: 1, shapeKind: 'face', identity: {
    kind: 'surface-side', featureId: 'saved-surface', profile: {
      sketchId: 'saved-sketch', lineFeatureId: 'saved-line', role: 'whole-line' } } } satisfies KernelOrigin;
  const modelSurface: ModelOrigin = kernelSurface;
  const drawingSurface: DrawingOrigin = modelSurface;
  const returned: KernelOrigin = drawingSurface;
  expect(returned).toEqual(kernelSurface);
  expect(JSON.parse(JSON.stringify(returned))).toEqual(kernelSurface);
  expect('faceFeatureId' in kernelSurface.identity.profile).toBe(false);
});

const grooveCanonical = { version: 1, shapeKind: 'face', identity: { kind: 'hole-face', featureId: 'thread-producer',
  center: { sketchId: 'sketch-1', producer: { kind: 'point', featureId: 'center' } },
  placement: { kind: 'linear', step: 2 }, stage: 'thread', role: 'groove',
} } as const satisfies KernelOrigin;
const modelGroove: ModelOrigin = grooveCanonical;
const drawingGroove: DrawingOrigin = modelGroove;
const kernelGroove: KernelOrigin = drawingGroove;
it('keeps the modeled thread groove producer (center and placement) closed across all three DTO owners', () => {
  expect(kernelGroove).toEqual(grooveCanonical);
  expect(JSON.parse(JSON.stringify(drawingGroove))).toEqual(modelGroove);
});
