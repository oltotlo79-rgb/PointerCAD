/**
 * Save/reopen of a function curve: only the definition is written; reopening regenerates the smooth curve.
 *
 * Needs devDependencies "@pointercad/expression": "workspace:*" and "@pointercad/kernel": "workspace:*" in
 * packages/io/package.json (private candidate diff; Root installs and qualifies the workspace closure) for the real
 * math Worker functions and the OCCT kernel, like packages/model's own function-history tests. The node OCCT loader
 * is imported by path from packages/io/src/pcad: ../../../kernel/src/occt/loadOcct.node.js resolves to
 * packages/kernel/src/occt/loadOcct.node.ts (checked with os.path.normpath on the real tree).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMathBackend,
  executeFunctionCurveWorkRequest,
  executeMathWorkRequest,
  type MathExecutionBackend,
} from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import { createKernelApi } from '@pointercad/kernel';
import {
  createDirectKernelBridge,
  createEmptyPartDocument,
  createFunctionCurve,
  FUNCTION_DEFINITION_FORMAT,
  recomputePart,
  sampleSpline,
  type FunctionDefinition,
  type PartDocument,
  type PartRecomputeOptions,
} from '@pointercad/model';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { parseDocument, serializeDocument } from './documentJson.js';

let backend: MathExecutionBackend, bridge: ReturnType<typeof createDirectKernelBridge> | undefined;
beforeAll(async () => {
  backend = createMathBackend(); await loadOcctForNode(); bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
}, 180_000);
// The bridge owns kernel state; release it once, even when a test failed.
afterAll(() => { bridge?.dispose(); bridge = undefined; });
function ownedBridge(): ReturnType<typeof createDirectKernelBridge> {
  if (bridge === undefined) throw new Error('Kernel bridge is not ready');
  return bridge;
}

const number = (value: number) => ({ source: String(value), display: String(value), value });
/** Y = X^2 leaves the Y range, so it is not the exact enclosed cubic: the smooth route is used. */
const definition: FunctionDefinition = {
  format: FUNCTION_DEFINITION_FORMAT,
  bounds: { X: { min: number(-2), max: number(2) }, Y: { min: number(-1), max: number(2) }, Z: { min: number(-1), max: number(1) } },
  tolerance: number(0.001),
  formula: { kind: 'coordinate-curve', independent: 'X', outputs: {
    Y: { format: 'pointercad-math/1', source: 'X^2', inputNotation: 'text', angleUnit: 'radian',
      expression: { kind: 'operation', operation: 'power', operands: [{ kind: 'symbol', reference: { role: 'axis', name: 'X' } }, { kind: 'number', decimal: '2' }] } },
    Z: { format: 'pointercad-math/1', source: '0', inputNotation: 'text', angleUnit: 'radian', expression: { kind: 'number', decimal: '0' } },
  } },
};
function fixture(): PartDocument {
  const document = createEmptyPartDocument(), sketch = document.sketches[0];
  return { ...document, sketches: [{ ...sketch, features: [createFunctionCurve(sketch, definition)] }] };
}
function options(document: PartDocument): PartRecomputeOptions {
  return { math: { identity: { documentId: document.id, documentVersion: 1 }, isCurrent: () => true,
    client: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
      result: decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
        { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(request.coefficients.map(coefficient => coefficient.id)), declaredIds: new Set() }).result }) } },
    functions: { curves: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
      result: executeFunctionCurveWorkRequest({ kind: 'sample-function-curve', serial: 1, request }, backend).result }) } } };
}

describe('関数曲線は定義だけを保存し、開き直すと同じ滑らかな曲線を再生成する', () => {
  it('保存した文書を読み直して再計算すると、節点付きの3次曲線が原式・範囲・精度を満たす', async () => {
    const original = fixture(), text = serializeDocument(original);
    // Derived geometry is never stored: no samples, poles, knots or bounds of the generated curve.
    for (const derived of ['knots', 'poles', 'components', 'maximumChordErrorBound', 'errorBound']) expect(text).not.toContain(derived);
    const reopened = parseDocument(text);
    if (!reopened.ok) throw new Error(JSON.stringify(reopened.error));
    expect(reopened.document).toEqual(original);
    const regenerated = await recomputePart(reopened.document, ownedBridge(), options(reopened.document));
    expect(regenerated.errors).toEqual([]); expect(regenerated.cancelled).toBe(false);
    const curves = regenerated.sketches[0].resolved.splines;
    expect(curves).toHaveLength(1);
    const [curve] = curves;
    expect(curve.degree).toBe(3); expect(curve.knots?.length).toBeGreaterThan(2);
    expect(curve.points).toHaveLength(2 * (curve.knots?.length ?? 0));
    // Sampled check against the analytic parabola (the proof is the Worker's bound, at most the tolerance).
    for (const [x, y, z] of sampleSpline(curve)) {
      expect(x).toBeGreaterThanOrEqual(-2 - 1e-6); expect(x).toBeLessThanOrEqual(2 + 1e-6);
      expect(y).toBeLessThanOrEqual(2 + 1e-6); expect(z).toBeCloseTo(0, 10);
      // Vertical gap <= sqrt(1 + max slope^2) * distance; the slope of X^2 within Y <= 2 is at most 2*sqrt(2).
      expect(Math.abs(y - x * x)).toBeLessThanOrEqual(0.001 * Math.sqrt(9));
    }
    // The in-memory document regenerates the same curve: the saved definition is complete.
    const direct = await recomputePart(original, ownedBridge(), options(original));
    expect(direct.sketches[0].resolved.splines).toEqual(curves);
  }, 60_000);
});
