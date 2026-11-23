import type { prepareCadSolidAnalysis } from '@pointercad/fem';
import { describe, expect, it } from 'vitest';
import { cadSolidBucklingFailureCode, cadSolidBucklingFailureSource, cadSolidBucklingInput } from './cadSolidBuckling.js';
import { t } from '../i18n/t.js';

type Prepared = ReturnType<typeof prepareCadSolidAnalysis>;
/** 投げた誤り(投げなければ null)。 */
function thrown(run: () => unknown): unknown {
  try { run(); } catch (error) { return error; }
  return null;
}
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
  it('refuses gravity and prescribed deformation with specific unsupported reasons while preserving the reference', () => {
    const base = prepared();
    const cases = [
      { input: { ...base.input, gravity: { accelerationMps2: [0, 0, -9.81] as const,
        densities: [{ materialId: 'material', densityKgM3: 7800 }] } }, message: t('solidAnalysis.bucklingGravityUnsupported') },
      { input: { ...base.input, constraints: [{ node: 3, fixed: [true, true, true] as const, prescribedMm: [0.125, 0, 0] as const }] },
        message: t('solidAnalysis.bucklingDisplacementUnsupported') },
    ];
    for (const { input, message } of cases) {
      const bytes = JSON.stringify(input);
      expect(() => cadSolidBucklingInput({ ...base, input }, 1)).toThrow(message);
      expect(cadSolidBucklingFailureCode(cadSolidBucklingFailureSource(thrown(() => cadSolidBucklingInput({ ...base, input }, 1)))))
        .toBe('buckling-unsupported');
      expect(JSON.stringify(input)).toBe(bytes);
    }
    const zero = { ...base.input, constraints: [{ node: 3, fixed: [true, true, true] as const, prescribedMm: [0, 0, 0] as const }] };
    expect(cadSolidBucklingInput({ ...base, input: zero }, 1).reference).toBe(zero);
  });
});

// 0b-4: 分けは Worker の失敗の符号(code)と fem の断りの符号(refusal)で決め、文は読まない。前の表の文が運ぶ符号は fem が留める
// (計算部の文 → 符号は packages/fem/src/femCodedError.test.ts、欄の無い返事は solidBucklingRuntime.test.ts、
// CAD の元の変化・別の版の網は cadSolidAnalysis.test.ts)。ここは、その符号から前と同じ分けになる事を留める。
describe('cadSolidBucklingFailureCode', () => {
  it.each([
    [{ code: 'solver-failed', refusal: 'no-positive-mode' }, 'buckling-no-compression'],
    [{ code: 'solver-failed', refusal: 'mechanism' }, 'buckling-mechanism'],
    [{ code: 'cad-solid', refusal: 'rigid-body' }, 'buckling-mechanism'],
    [{ code: 'cad-mesh', refusal: 'stale-source' }, 'buckling-stale'],
    [{ refusal: 'stale-source' }, 'buckling-stale'],
    [{ code: 'solver-failed', refusal: 'budget' }, 'buckling-unsupported'],
    [{ code: 'solver-failed', refusal: 'supports' }, 'buckling-unsupported'],
    [{ code: 'solver-failed', refusal: 'unknown' }, 'cad-solid-buckling'],
    [{ code: 'cad-solid', refusal: 'support-conflict' }, 'cad-solid-buckling'],
    [{ code: 'solver-failed' }, 'cad-solid-buckling'],
    [{ code: 'asset-missing' }, 'buckling-asset'],
    [{ code: 'asset-corrupt' }, 'buckling-asset'],
    [{ code: 'asset-missing', unsupportedLoad: true }, 'buckling-unsupported'],
  ] as const)('classifies %j', (failure, code) => {
    expect(cadSolidBucklingFailureCode(failure)).toBe(code);
  });
  it('classifies thrown errors by their type, never by their text', () => {
    const value = prepared();
    const classify = (error: unknown): string => cadSolidBucklingFailureCode(cadSolidBucklingFailureSource(error));
    expect(classify(thrown(() => cadSolidBucklingInput({ ...value, input: { ...value.input, surfaceLoads: [] } }, 1)))).toBe('cad-solid-buckling');
    expect(classify(new Error('solid-buckling-mechanism: a text alone is not a refusal'))).toBe('cad-solid-buckling');
    expect(classify(new Error(t('solidAnalysis.bucklingGravityUnsupported')))).toBe('cad-solid-buckling');
    expect(classify('not an error')).toBe('cad-solid-buckling');
    expect(cadSolidBucklingFailureSource(new Error('x'))).toEqual({});
  });
});
