import type { prepareCadSolidAnalysis } from '@pointercad/fem';
import { describe, expect, it } from 'vitest';
import { cadSolidBucklingFailureCode, cadSolidBucklingInput } from './cadSolidBuckling.js';

type Prepared = ReturnType<typeof prepareCadSolidAnalysis>;
/** Unit corner tet, z = 0 face (nodes 0, 2, 1; area L^2 / 2 = 50 mm^2) loaded by +z traction 1 MPa: 50 N into the
 * material. The expected area and force are derived here from the geometry, not from the adapter. */
function prepared(traction: readonly [number, number, number] = [0, 0, 1], totalForceN: readonly [number, number, number] = [0, 0, 50],
  loadedAreaMm2 = 50): Prepared {
  return {
    input: {
      schema: 'pointercad-solid-tet4/1', source: { documentId: 'doc-1', revision: 3, meshKey: 'mesh-a' }, units: 'N-mm-MPa',
      numericBudgetBytes: 16 * 1024 * 1024, nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]],
      elements: [{ nodes: [0, 1, 2, 3], materialId: 'material' }],
      materials: [{ id: 'material', youngMPa: 205000, poisson: 0.3 }],
      constraints: [{ node: 3, fixed: [true, true, true] }],
      nodalLoads: [], surfaceLoads: [{ nodes: [0, 2, 1], tractionMPa: [traction[0], traction[1], traction[2]] }],
    },
    loadedAreaMm2, totalForceN: [totalForceN[0], totalForceN[1], totalForceN[2]],
  };
}

describe('cadSolidBucklingInput', () => {
  it('uses the prepared static input unchanged as the reference state', () => {
    const value = prepared();
    const input = cadSolidBucklingInput(value, 3);
    expect(input.reference).toBe(value.input);
    expect([input.schema, input.modeCount]).toEqual(['pointercad-solid-tet4-buckling/1', 3]);
    expect(Object.keys(input).sort()).toEqual(['modeCount', 'reference', 'schema']);
  });
  it('refuses a zero reference load', () => {
    expect(() => cadSolidBucklingInput(prepared([0, 0, 0], [0, 0, 0]), 1)).toThrow('solid-buckling-load: zero reference load');
  });
  it('refuses a preparation whose total force or loaded area does not match its own boundary', () => {
    expect(() => cadSolidBucklingInput(prepared([0, 0, 1], [0, 0, 40]), 1)).toThrow('differs from the loaded boundary');
    expect(() => cadSolidBucklingInput(prepared([0, 0, 1], [0, 0, 50], 60), 1)).toThrow('differs from the loaded boundary');
  });
  it('refuses nodal loads or a missing boundary traction, which the CAD static path never produces', () => {
    const value = prepared();
    expect(() => cadSolidBucklingInput({ ...value, input: { ...value.input, nodalLoads: [{ node: 1, forceN: [0, 0, 1] }] } }, 1))
      .toThrow('solid-buckling-load');
    expect(() => cadSolidBucklingInput({ ...value, input: { ...value.input, surfaceLoads: [] } }, 1)).toThrow('solid-buckling-load');
  });
  it('does not mutate the prepared static input', () => {
    const value = prepared();
    const before = JSON.stringify(value);
    cadSolidBucklingInput(value, 2);
    expect(JSON.stringify(value)).toBe(before);
  });
});

describe('cadSolidBucklingFailureCode', () => {
  it.each([
    ['solid-buckling-no-positive-mode: 0 positive load factor(s) for 2 requested', 'buckling-no-compression'],
    ['solid-buckling-mechanism: reduced stiffness is not positive definite', 'buckling-mechanism'],
    ['solid-input: unrestrained component rigid-body motion', 'buckling-mechanism'],
    ['CAD source changed during analysis', 'buckling-stale'],
    ['Mesh belongs to another CAD revision', 'buckling-stale'],
    ['solid-buckling-budget: dense buckling reservation exceeds the numeric budget', 'buckling-unsupported'],
    ['solid-buckling-native: native element initial-stress matrix differs', 'cad-solid-buckling'],
  ])('classifies %s', (message, code) => {
    expect(cadSolidBucklingFailureCode(message)).toBe(code);
  });
});
