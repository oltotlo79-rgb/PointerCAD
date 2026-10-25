import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expressionValueFromNumber as number } from '@pointercad/expression';
import {
  createFunctionMathSource,
  createMathBackend,
  executeFunctionSurfaceWorkRequest,
  executeMathWorkRequest,
  type MathExecutionBackend,
} from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import { FunctionSurfaceWorkerClient, type MathWorkerPort } from '@pointercad/expression/math/client';
import { createKernelApi } from '@pointercad/kernel';
import {
  createDirectKernelBridge,
  createEmptyPartDocument,
  createFunctionSurface,
  FUNCTION_DEFINITION_FORMAT,
  recomputePart,
  type FunctionDefinition,
  type PartDocument,
  type PartRecomputeOptions,
} from '@pointercad/model';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { readPcadFile, writePcadFile } from './pcadFile.js';
import { isRecord } from './guards.js';
import { PCAD_SCHEMA_VERSION } from './schema.js';
import { absoluteCoordinate, DEFAULT_PRIMITIVE_AXIS, type PrimitiveFeature, type SketchArcFeature,
  type SketchEllipseFeature, type SurfaceCutBlade, type SurfaceCutFeature } from '@pointercad/model';

/** The Worker side in this process: the client posts its envelope, the execution answers on the next microtask. */
class InProcessSurfacePort implements MathWorkerPort {
  onmessage: MathWorkerPort['onmessage'] = null;
  onerror: MathWorkerPort['onerror'] = null;
  onmessageerror: MathWorkerPort['onmessageerror'] = null;
  postMessage(value: unknown): void {
    queueMicrotask(() => this.onmessage?.({ data: executeFunctionSurfaceWorkRequest(value, backend) }));
  }
  terminate(): void { this.onmessage = null; }
}

const createBridge = () => createDirectKernelBridge(createKernelApi(loadOcctForNode));
let backend: MathExecutionBackend, bridge: ReturnType<typeof createBridge> | undefined;
let surfaces: FunctionSurfaceWorkerClient | undefined;
beforeAll(async () => {
  backend = createMathBackend(); await loadOcctForNode(); bridge = createBridge();
  surfaces = new FunctionSurfaceWorkerClient({ createWorker: () => new InProcessSurfacePort() });
}, 180_000);
// The bridge owns kernel state and the client owns its port; release both once, even when a test failed.
afterAll(() => { bridge?.dispose(); bridge = undefined; surfaces?.dispose(); surfaces = undefined; });
function ownedBridge(): ReturnType<typeof createBridge> {
  if (bridge === undefined) throw new Error('Kernel bridge is not ready');
  return bridge;
}
function surfaceClient(): FunctionSurfaceWorkerClient {
  if (surfaces === undefined) throw new Error('Surface client is not ready');
  return surfaces;
}
type SurfaceCompletion = Awaited<ReturnType<FunctionSurfaceWorkerClient['evaluate']>>;

const box: PrimitiveFeature = { id: 'box', name: 'Box', kind: 'primitive', suppressed: false,
  origin: { kind: 'coordinate', value: absoluteCoordinate(5, 5, 5) }, axis: DEFAULT_PRIMITIVE_AXIS,
  shape: { kind: 'box', sizeX: number(10), sizeY: number(10), sizeZ: number(10) } };
type BladeKind = 'plane' | 'arc' | 'ellipse' | 'function';
function definition(formula = '2+0.01*X*Y'): FunctionDefinition {
  return { format: FUNCTION_DEFINITION_FORMAT, bounds: {
    X: { min: number(-1), max: number(11) }, Y: { min: number(-1), max: number(11) }, Z: { min: number(-1), max: number(11) },
  }, tolerance: number(0.01), formula: { kind: 'coordinate-surface', output: 'Z',
    expression: createFunctionMathSource(formula, 'text', 'radian', { axes: ['X', 'Y'], parameters: [], coefficients: [] }, backend) } };
}
function fixture(kind: BladeKind, both: boolean): PartDocument {
  let document: PartDocument = { ...createEmptyPartDocument(), solids: [box] };
  let blade: SurfaceCutBlade;
  if (kind === 'plane') blade = { kind: 'plane', plane: { kind: 'workPlane', planeId: 'yz', offset: number(5) } };
  else if (kind === 'function') {
    const surface = createFunctionSurface(document, definition());
    document = { ...document, solids: [...document.solids, surface] };
    blade = { kind: 'surface', surfaceFeatureId: surface.id };
  } else {
    const sketch = document.sketches[0];
    const common = { id: 'curve', name: 'Blade', planeId: 'xy', center: absoluteCoordinate(5, 0, 0),
      startAngle: number(0), endAngle: number(180), construction: false };
    const curve: SketchArcFeature | SketchEllipseFeature = kind === 'arc'
      ? { ...common, kind, radius: number(3) }
      : { ...common, kind, majorRadius: number(4), minorRadius: number(2), rotation: number(0) };
    document = { ...document, sketches: [{ ...sketch, features: [curve] }] };
    blade = { kind: 'extrusion', profile: { sketchId: sketch.id, curveIds: [curve.id] } };
  }
  const positive: SurfaceCutFeature = { id: 'cut-positive', name: 'Positive', kind: 'surfaceCut', suppressed: false,
    targetFeatureId: box.id, blade, keep: 'positive', pairedWith: null };
  const negative: SurfaceCutFeature = { ...positive, id: 'cut-negative', name: 'Negative', keep: 'negative', pairedWith: positive.id };
  return { ...document, solids: [...document.solids, positive, ...(both ? [negative] : [])] };
}
const negativeVolume: Readonly<Record<BladeKind, number>> = { plane: 500, arc: 45 * Math.PI, ellipse: 40 * Math.PI, function: 225 };
const cases = (['plane', 'arc', 'ellipse', 'function'] as const).flatMap(kind => [false, true].map(both => ({ kind, both })));
const relative = (actual: number, expected: number): void => {
  expect(Math.abs(actual - expected) / expected).toBeLessThanOrEqual(1e-9);
};

function options(document: PartDocument, completions: SurfaceCompletion[]): PartRecomputeOptions {
  return { partId: document.id, measureAreas: true, math: { identity: { documentId: document.id, documentVersion: 1 }, isCurrent: () => true,
    client: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
      result: decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
        { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(request.coefficients.map(value => value.id)), declaredIds: new Set() }).result }) } },
    functions: { curves: { evaluate: () => Promise.reject(new Error('No curve in this document')) },
      surfaces: { evaluate: async (request, timeoutMs, signal) => {
        const completion = await surfaceClient().evaluate(request, timeoutMs, signal);
        completions.push(completion);
        return completion;
      } } } };
}
async function compute(document: PartDocument) {
  const completions: SurfaceCompletion[] = [];
  try { return { recomputed: await recomputePart(document, ownedBridge(), options(document, completions)), completions }; }
  finally { await ownedBridge().releasePart(document.id); }
}
describe('surfaceCut PCAD definitions and real regeneration', () => {
  it.each(cases)('$kind both=$both preserves every definition and regenerates analytic volumes before/after PCAD', async ({ kind, both }) => {
    const document = fixture(kind, both), json = serializeDocument(document);
    expect(PCAD_SCHEMA_VERSION).toBe(22);
    for (const derived of ['targetKey', 'sourceKey', 'planeOrigin', 'planeNormal', 'poles', 'uKnots', 'vKnots']) expect(json).not.toContain(derived);
    const read = readPcadFile(writePcadFile(document, { savedAt: '2026-10-24T12:00:00.000Z' }));
    if (!read.ok) throw new Error(JSON.stringify(read.error));
    expect(read.document).toEqual(document);
    const cutDefinitions = document.solids.filter(feature => feature.kind === 'surfaceCut');
    expect(read.document.solids.filter(feature => feature.kind === 'surfaceCut')).toEqual(cutDefinitions);
    for (const current of [document, read.document]) {
      const { recomputed, completions } = await compute(current);
      expect(recomputed.errors).toEqual([]); expect(recomputed.cancelled).toBe(false);
      const pieces = recomputed.bodies.filter(body => body.featureId.startsWith('cut-'));
      expect(pieces).toHaveLength(both ? 2 : 1);
      for (const body of pieces) {
        expect(body.isValid).toBe(true); expect(body.bodyKind).toBe('solid');
        relative(body.volume, body.featureId === 'cut-negative' ? negativeVolume[kind] : 1000 - negativeVolume[kind]);
      }
      if (kind === 'function') {
        expect(completions).toHaveLength(1);
        expect(recomputed.bodies.filter(body => body.bodyKind === 'shell')).toHaveLength(1);
      }
    }
  }, 60_000);

  it.each(['plane', 'arc', 'function'] as const)('editing upstream %s changes the cut key and recomputes its volume', async kind => {
    const original = fixture(kind, false);
    const changed: PartDocument = kind === 'plane'
      ? { ...original, solids: original.solids.map(feature => feature.kind === 'surfaceCut'
        ? { ...feature, blade: { kind: 'plane', plane: { kind: 'workPlane', planeId: 'yz', offset: number(4) } } } : feature) }
      : kind === 'arc' ? { ...original, sketches: original.sketches.map(sketch => ({ ...sketch,
        features: sketch.features.map(feature => feature.kind === 'arc' ? { ...feature, radius: number(4) } : feature) })) }
      : { ...original, solids: original.solids.map(feature => feature.kind === 'functionSurface'
        ? { ...feature, definition: definition('3+0.01*X*Y') } : feature) };
    const keys: string[] = [], volumes: number[] = [];
    try {
      for (const document of [original, changed]) {
        const result = await recomputePart(document, ownedBridge(), { ...options(document, []),
          onResolved: resolved => {
            const key = resolved.steps.find(step => step.featureId === 'cut-positive')?.key;
            if (key === undefined) throw new Error('Missing cut key');
            keys.push(key);
          } });
        expect(result.errors).toEqual([]);
        const body = result.bodies.find(entry => entry.featureId === 'cut-positive');
        if (body === undefined) throw new Error('Missing cut body');
        volumes.push(body.volume);
      }
      expect(keys).toHaveLength(2); expect(keys[1]).not.toBe(keys[0]);
      relative(volumes[0], 1000 - negativeVolume[kind]);
      relative(volumes[1], kind === 'plane' ? 600 : kind === 'arc' ? 1000 - 80 * Math.PI : 675);
    } finally { await ownedBridge().releasePart(original.id); }
  }, 60_000);

  it('changing an upstream reference plane changes the cut key and volume without editing the cut definition', async () => {
    const seed = fixture('plane', false);
    const original: PartDocument = { ...seed,
      references: [{ id: 'blade-plane', kind: 'referencePlane', name: 'Blade plane', visible: true,
        plane: { kind: 'workPlane', planeId: 'yz', offset: number(5) } }],
      solids: seed.solids.map(feature => feature.kind === 'surfaceCut' ? { ...feature,
        blade: { kind: 'plane', plane: { kind: 'workPlane', planeId: 'blade-plane', offset: number(0) } } } : feature) };
    const changed: PartDocument = { ...original, references: original.references.map(reference => reference.kind === 'referencePlane'
      ? { ...reference, plane: { kind: 'workPlane', planeId: 'yz', offset: number(4) } } : reference) };
    expect(changed.solids).toBe(original.solids);
    const keys: string[] = [];
    try {
      for (const [document, volume] of [[original, 500], [changed, 600]] as const) {
        const result = await recomputePart(document, ownedBridge(), { ...options(document, []), onResolved: resolved => {
          const key = resolved.steps.find(step => step.featureId === 'cut-positive')?.key;
          if (key === undefined) throw new Error('Missing cut key');
          keys.push(key);
        } });
        expect(result.errors).toEqual([]);
        const piece = result.bodies.find(body => body.featureId === 'cut-positive');
        if (piece === undefined) throw new Error('Missing cut body');
        relative(piece.volume, volume);
      }
      expect(keys).toHaveLength(2); expect(keys[1]).not.toBe(keys[0]);
    } finally { await ownedBridge().releasePart(original.id); }
  }, 60_000);

  it.each([
    { blade: { kind: 'future-blade' }, field: 'blade.kind', code: 'invalidField' },
    { blade: { kind: 'plane' }, field: 'blade.plane', code: 'missingField' },
    { blade: { kind: 'extrusion', profile: { sketchId: 'sketch-1', curveIds: [12] } }, field: 'blade.profile.curveIds[0]', code: 'invalidField' },
    { blade: { kind: 'surface', surfaceFeatureId: 12 }, field: 'blade.surfaceFeatureId', code: 'invalidField' },
  ])('rejects malformed blades at $field', ({ blade, field, code }) => {
    const document = fixture('plane', false);
    const raw: unknown = JSON.parse(serializeDocument(document));
    if (!isRecord(raw)) throw new Error('Invalid fixture envelope');
    const broken = { ...raw, document: { ...document, solids: document.solids.map(feature => feature.kind === 'surfaceCut'
      ? { ...feature, blade } : feature) } };
    const result = parseDocument(JSON.stringify(broken));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Accepted invalid blade');
    expect(result.error.code).toBe(code);
    expect(result.error.message).toContain(`document.solids[1].${field}`);
  });

  it.each([17, 18, 19, 20, 21, 22])('keeps legacy version %i readable without adding a surface cut', version => {
    const document = { ...createEmptyPartDocument(), solids: [box] };
    const raw: unknown = JSON.parse(serializeDocument(document));
    if (!isRecord(raw)) throw new Error('Invalid fixture envelope');
    const read = parseDocument(JSON.stringify({ ...raw, schema: version, document: { ...document, schemaVersion: version } }));
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(JSON.stringify(read.error));
    expect(read.document.schemaVersion).toBe(22); expect(read.document.solids).toEqual([box]);
  });
});
