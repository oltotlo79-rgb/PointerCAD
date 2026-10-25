/** Native geometry and public store actions for the EX-05 history regressions. */
import { createHash } from 'node:crypto';
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  absoluteCoordinate, appendFeature, appendSolid, createEmptyPartDocument, createPointFeature,
  recomputePart, replaceSketch, type PartDocument, type PartRecomputeOptions,
  type PartRecomputeResult, type SolidBody,
} from '@pointercad/model';
import { createNativeKernelBridgeForNodeTests } from '../../../model/src/testing/createNativeKernelBridge.node.js';
import { expect, vi } from 'vitest';
import { applyNumericTransition } from '../sketch/commitToStore.js';
import { createNumericInput, type SolidInputCommit } from '../sketch/numericInput.js';
import { attachPartRecompute } from '../store/attachKernel.js';
import { useAppStore } from '../store/useAppStore.js';
import { beginDocumentRequest } from '../store/documentRequest.js';
import { subShapeElementId } from './subShapeSelection.js';

export type HistorySurface = 'plane' | 'cylinder';
export type HistoryOperation = 'through' | 'blind' | 'thread' | 'counterbore';
export const historyFormula = (source: string, value: number): ExpressionValue => ({ source, value, display: String(value) });

export function documentSha(document: PartDocument): string {
  return createHash('sha256').update(JSON.stringify(document,
    (_key: string, value: unknown): unknown => typeof value === 'bigint' ? String(value) : value)).digest('hex');
}

/** Geometry plus every displayed mesh byte; no cache identity is used as proof of shape. */
export function shapeSha(bodies = useAppStore.getState().bodies): string {
  const hash = createHash('sha256');
  for (const body of bodies) {
    hash.update(JSON.stringify({ featureId: body.featureId, volume: body.volume, area: body.area,
      valid: body.isValid, faces: body.faces, edges: body.edges, vertices: body.vertices, threadMarks: body.threadMarks }));
    for (const array of [body.mesh.positions, body.mesh.normals, body.mesh.indices, body.mesh.edgePositions]) {
      hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    }
  }
  return hash.digest('hex');
}

export function holeWallCount(body: SolidBody, radius: number): number {
  return body.faces.filter(face => face.surfaceKind === 'cylinder'
    && face.radius !== null && Math.abs(face.radius - radius) < 1e-7).length;
}

function fixture(surface: HistorySurface, outside: boolean): PartDocument {
  const value = expressionValueFromNumber;
  let document = createEmptyPartDocument();
  const sketch = document.sketches[0];
  const point = { ...createPointFeature(sketch, absoluteCoordinate(outside ? 100 : 0, 0, 10)), id: 'hole-center' };
  document = replaceSketch(document, appendFeature(sketch, point));
  return appendSolid(document, { id: 'stock', name: 'Stock', kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }, axis: { kind: 'world', axis: 'z' },
    shape: surface === 'plane' ? { kind: 'box', sizeX: value(40), sizeY: value(40), sizeZ: value(20) }
      : { kind: 'cylinder', radius: value(20), height: value(40) } });
}

export function historyCommit(operation: HistoryOperation, surface: HistorySurface): SolidInputCommit {
  return { kind: 'solid', tool: operation === 'thread' ? 'threadHole' : 'hole',
    step: operation === 'thread' ? 'threadSize' : 'holeSize',
    values: { diameter: historyFormula('2*3', 6), depth: historyFormula('2*4', 8),
      threadLength: historyFormula('2+2', 4), counterboreDiameter: historyFormula('2*5', 10),
      counterboreDepth: historyFormula('1+2', 3), holeCylinderHeight: historyFormula('10+10', 20),
      holeCylinderAngle: historyFormula('15+15', 30) },
    flags: { through: operation === 'through' || operation === 'counterbore', cylinderFace: surface === 'cylinder' },
    shapeChoices: { holeEntry: operation === 'counterbore' ? 'counterbore' : 'plain' },
    threadDesignation: 'M6', threadSeries: 'coarse' };
}

export interface HeldNativeRequest {
  readonly document: PartDocument;
  readonly options: PartRecomputeOptions;
  readonly result: Promise<PartRecomputeResult>;
  readonly release: () => Promise<void>;
}

export async function nativeHistoryHarness(surface: HistorySurface = 'plane', outside = false) {
  const bridge = createNativeKernelBridgeForNodeTests();
  const document = fixture(surface, outside);
  useAppStore.getState().applyDocument(document, { opensDocument: true });
  const results: PartRecomputeResult[] = [];
  const held: HeldNativeRequest[] = [];
  let hold = false;
  const detach = attachPartRecompute((candidate, options) => {
    const delayed = hold;
    hold = false;
    // The delayed worker deliberately ignores cancellation, so ownership must reject its success.
    const result = recomputePart(candidate, bridge, delayed ? { ...options, shouldCancel: () => false } : options)
      .then(computed => { results.push(computed); return computed; });
    if (!delayed) return result;
    return new Promise<PartRecomputeResult>(resolve => {
      held.push({ document: candidate, options, result, release: async () => { resolve(await result); } });
    });
  });
  async function settled(): Promise<void> {
    await vi.waitFor(() => {
      expect(useAppStore.getState().isComputing).toBe(false);
      expect(useAppStore.getState().lastOutcome).toBe('success');
      expect(useAppStore.getState().requestedGeneration).toBe(useAppStore.getState().completedGeneration);
    }, { timeout: 90_000, interval: 20 });
  }
  const initialRequest = beginDocumentRequest('test.holeThreadHistory.initial');
  await settled();
  expect(initialRequest.isCurrent()).toBe(true);
  const body = useAppStore.getState().bodies[0];
  expect(body.isValid).toBe(true);
  const face = body.faces.find(entry => surface === 'cylinder' ? entry.surfaceKind === 'cylinder'
    : entry.surfaceKind === 'plane' && entry.axis !== null && entry.axis[2] > 0.99);
  if (face === undefined) throw new Error('Native stock has no machining face');
  const selection = [subShapeElementId('stock', 'face', face.index), ...(surface === 'plane' ? ['hole-center'] : [])];
  function begin(operation: HistoryOperation): SolidInputCommit {
    const commit = historyCommit(operation, surface);
    useAppStore.getState().setActiveTool(commit.tool);
    useAppStore.getState().setSelection(selection);
    useAppStore.getState().updateNumericInput(createNumericInput(commit.tool, commit.step));
    return commit;
  }
  function confirm(commit: SolidInputCommit): void {
    const input = useAppStore.getState().numericInput;
    if (input === null) throw new Error('Missing numeric input');
    applyNumericTransition({ kind: 'solidCommitted', state: input, commit });
  }
  async function committed(): Promise<void> {
    await vi.waitFor(() => { expect(useAppStore.getState().numericInput).toBeNull(); }, { timeout: 90_000, interval: 20 });
    await settled();
  }
  return { document, results, held, begin, confirm, committed, settled,
    holdNext: () => { hold = true; },
    dispose: () => { detach(); bridge.dispose(); } };
}
