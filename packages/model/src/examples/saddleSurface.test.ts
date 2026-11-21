import { beforeAll, describe, expect, it } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  createFunctionMathSource,
  createMathBackend,
  executeFunctionCurveWorkRequest,
  executeFunctionSurfaceWorkRequest,
  executeMathWorkRequest,
  type MathExecutionBackend,
} from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '@pointercad/kernel/testing/occt-node';
import { createDirectKernelBridge } from '../kernelBridge.js';
import { recomputePart, type PartRecomputeOptions } from '../part/recomputePart.js';
import type { PartDocument } from '../part/types.js';
import { saddleSurfaceExample } from './saddleSurface.js';

let backend: MathExecutionBackend;
beforeAll(async () => { backend = createMathBackend(); await loadOcctForNode(); }, 180_000);

function options(document: PartDocument): PartRecomputeOptions {
  return { partId: document.id, measureAreas: true, math: { identity: { documentId: document.id, documentVersion: 1 }, isCurrent: () => true,
    client: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
      result: decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
        { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(request.coefficients.map(value => value.id)), declaredIds: new Set() }).result }) } },
    functions: {
      curves: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
        result: executeFunctionCurveWorkRequest({ kind: 'sample-function-curve', serial: 1, request }, backend).result }) },
      surfaces: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
        result: executeFunctionSurfaceWorkRequest({ kind: 'sample-function-surface', serial: 1, request }, backend).result }) },
    } };
}

/**
 * Area of Z = a(X² − Y²) over the 80 × 80 square by composite Simpson in both directions. With n = 400 the value
 * moves by under 2e-12 relative when n is doubled, far inside the 1e-9 bound used below.
 */
function referenceArea(a: number, n = 400): number {
  const step = 80 / n;
  const weight = (index: number): number => (index === 0 || index === n ? 1 : index % 2 === 1 ? 4 : 2);
  let total = 0;
  for (let i = 0; i <= n; i += 1) {
    const x = -40 + i * step;
    for (let j = 0; j <= n; j += 1) {
      const y = -40 + j * step;
      total += weight(i) * weight(j) * Math.sqrt(1 + 4 * a * a * (x * x + y * y));
    }
  }
  return total * step * step / 9;
}

function definitionOf(document: PartDocument) {
  const feature = document.solids[0];
  if (feature.kind !== 'functionSurface') throw new Error('Expected the saddle surface');
  return feature.definition;
}

describe('作例「関数曲面の鞍形」(J-06b)', () => {
  it('保存する式は、関数の入力が同じ原文から作る式と 1 字も違わない(計算の境界はこの一致を確かめる)', () => {
    const { formula } = definitionOf(saddleSurfaceExample.create());
    if (formula.kind !== 'coordinate-surface') throw new Error('Expected Z = f(X, Y)');
    const parsed = createFunctionMathSource(formula.expression.source, 'text', 'radian',
      { axes: ['X', 'Y'], parameters: [], coefficients: [{ id: 'coefficient:1', label: 'a' }] }, backend);
    expect(JSON.stringify(formula.expression)).toBe(JSON.stringify(parsed));
  });

  it.each([0.01, 0.005])('係数 a=%s の開いた面を作り、面積は原式の数値積分と相対 1e-9 で合い、表示の点は原式から精度 0.05 mm 以内にある', async a => {
    const created = saddleSurfaceExample.create();
    const document: PartDocument = { ...created,
      parameters: created.parameters.map(parameter => ({ ...parameter, value: expressionValueFromNumber(a) })) };
    const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
    try {
      const result = await recomputePart(document, bridge, options(document));
      expect(result.errors).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      const [body] = result.bodies;
      expect(body.isValid).toBe(true);
      expect(body.bodyKind).toBe('shell');
      expect(body.volume).toBe(0);
      expect(body.faces.length).toBeGreaterThan(0);
      expect(body.faces.every(face => face.surfaceKind === 'other')).toBe(true);
      // The surface is quadratic, so the certified bicubic spline represents it exactly (measured 2026-11-20: 1e-13 relative).
      const area = body.area, reference = referenceArea(a);
      if (area === undefined) throw new Error('The area was requested but not measured');
      expect(Math.abs(area - reference)).toBeLessThanOrEqual(1e-9 * reference);
      const positions = body.mesh.positions;
      expect(positions.length).toBeGreaterThan(9);
      for (let index = 0; index < positions.length; index += 3) {
        const [x, y, z] = positions.slice(index, index + 3);
        expect(Math.abs(x)).toBeLessThanOrEqual(40 + 1e-6);
        expect(Math.abs(y)).toBeLessThanOrEqual(40 + 1e-6);
        expect(Math.abs(z - a * (x * x - y * y))).toBeLessThanOrEqual(0.05);
      }
    } finally {
      await bridge.releasePart(document.id);
      bridge.dispose();
    }
  }, 120_000);
});
