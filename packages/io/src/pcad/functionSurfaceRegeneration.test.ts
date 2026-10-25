/**
 * Save/reopen of a function surface: only the definition is written; reopening regenerates the smooth native surface.
 *
 * Needs the devDependencies "@pointercad/expression": "workspace:*" and "@pointercad/kernel": "workspace:*" in
 * packages/io/package.json (the same proposal as smooth-function-r4's functionCurveRegeneration.test.ts; Root installs
 * and qualifies the workspace closure). The node OCCT loader path ../../../kernel/src/occt/loadOcct.node.js resolves from
 * packages/io/src/pcad to packages/kernel/src/occt/loadOcct.node.ts.
 *
 * The surface reply travels the product path: the Worker execution runs behind an in-process port and the real
 * FunctionSurfaceWorkerClient decodes it with the real reply decoder (which recomputes the spline certificate) before
 * model recompute sees it.
 */
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

function fixture(): PartDocument {
  const expression = createFunctionMathSource('0.25*X*Y', 'text', 'radian', { axes: ['X', 'Y'], parameters: [], coefficients: [] }, backend);
  const definition: FunctionDefinition = { format: FUNCTION_DEFINITION_FORMAT, bounds: {
    X: { min: number(-1), max: number(1) }, Y: { min: number(-1), max: number(1) }, Z: { min: number(-0.5), max: number(0.5) },
  }, tolerance: number(0.05), formula: { kind: 'coordinate-surface', output: 'Z', expression } };
  const document = createEmptyPartDocument();
  return { ...document, solids: [createFunctionSurface(document, definition)] };
}
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
/** The decoded Worker result of the one surface request: a certified spline that passed the real decoder. */
function decodedSpline(completions: readonly SurfaceCompletion[]) {
  expect(completions).toHaveLength(1);
  const completion = completions[0];
  if (completion.status !== 'result' || completion.result.status !== 'ready') throw new Error(JSON.stringify(completion));
  const result = completion.result;
  // Decoded replies are frozen snapshots; the raw execution result is not, so this is the decoder's output.
  expect(Object.isFrozen(result)).toBe(true);
  if (result.spline === undefined) throw new Error(`No smooth surface: ${String(result.splineDeclined)}`);
  expect(Object.isFrozen(result.spline.poles)).toBe(true);
  expect(result.spline.errorBound).toBeGreaterThan(result.maximumInterpolationErrorBound);
  expect(result.spline.errorBound).toBeLessThanOrEqual(0.05);
  return result;
}

describe('関数曲面は定義だけを保存し、開き直すと同じ滑らかな面を再生成する', () => {
  it('保存した文書を読み直して再計算すると、検査済みの返答から実CADの滑らかな面を作り、原式・範囲・精度を満たす', async () => {
    const original = fixture(), text = serializeDocument(original);
    // Derived geometry is never stored: no spline, knots, poles, samples or certificates.
    for (const derived of ['uKnots', 'vKnots', 'poles', 'spline', 'triangles', 'maximumInterpolationErrorBound']) expect(text).not.toContain(derived);
    const reopened = parseDocument(text);
    if (!reopened.ok) throw new Error(JSON.stringify(reopened.error));
    expect(reopened.document).toEqual(original);
    const { recomputed: regenerated, completions } = await compute(reopened.document);
    const sampled = decodedSpline(completions);
    expect(regenerated.errors).toEqual([]); expect(regenerated.bodies).toHaveLength(1);
    const body = regenerated.bodies[0];
    expect(body.isValid).toBe(true); expect(body.bodyKind).toBe('shell');
    // The smooth native route: the certified triangle route would give one planar face per drawn triangle. Here CAD
    // holds the B-spline face(s) only, none planar, far fewer than the certified mesh's triangles.
    expect(body.faces.length).toBeGreaterThan(0);
    expect(body.faces.every(face => face.surfaceKind === 'other')).toBe(true);
    expect(body.faces.length).toBeLessThan(sampled.triangles.length);
    const positions = body.mesh.positions;
    expect(positions.length).toBeGreaterThan(9);
    for (let index = 0; index < positions.length; index += 3) {
      const [x, y, z] = positions.slice(index, index + 3);
      expect(Math.abs(x)).toBeLessThanOrEqual(1 + 1e-6); expect(Math.abs(y)).toBeLessThanOrEqual(1 + 1e-6);
      expect(Math.abs(z)).toBeLessThanOrEqual(0.5 + 1e-6); expect(Math.abs(z - 0.25 * x * y)).toBeLessThanOrEqual(0.05);
    }
    // The in-memory document regenerates the same displayed surface through the same decoded route.
    const direct = await compute(original);
    expect(decodedSpline(direct.completions).spline).toEqual(sampled.spline);
    expect(direct.recomputed.bodies[0].mesh.positions).toEqual(positions);
  }, 60_000);
});
