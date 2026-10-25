import { SOLID_BUCKLING_MAX_MODES, type SolidBucklingInput, type SolidBucklingMode, type SolidBucklingResult } from '@pointercad/fem';
import { SOLID_BUCKLING_CAD_MAX_MODES } from '@pointercad/model/beam-analysis';
import { describe, expect, it } from 'vitest';
import { cancelSolidBuckling, editSolidBucklingCount, initialSolidBucklingState, invalidateSolidBuckling, receiveSolidBuckling,
  solidBucklingDisplayFor, solidBucklingModeCount, startSolidBuckling } from './solidBucklingState.js';

function input(modeCount = 2): SolidBucklingInput {
  return { schema: 'pointercad-solid-tet4-buckling/1', modeCount, reference: {
    schema: 'pointercad-solid-tet4/1', source: { documentId: 'doc-1', revision: 4, meshKey: 'mesh-a' }, units: 'N-mm-MPa',
    numericBudgetBytes: 1_000_000, nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'material' }], materials: [{ id: 'material', youngMPa: 205000, poisson: 0.3 }],
    constraints: [{ node: 3, fixed: [true, true, true] }], nodalLoads: [], surfaceLoads: [{ nodes: [0, 2, 1], tractionMPa: [0, 0, 1] }] } };
}
function mode(number: number, loadFactor: number): SolidBucklingMode {
  return { number, loadFactor, normalizedResidual: 1e-12, shape: [[0, 0, 0], [1, 0, 0], [0, 0, 0], [0, 0, 0]] };
}
function result(request: SolidBucklingInput, modes: readonly SolidBucklingMode[] = [mode(1, 120), mode(2, 340)],
  source = request.reference.source): SolidBucklingResult {
  return { kind: 'oofem-solid-tet4-buckling', method: 'oofem-ltrspace-initial-stress-eigh/1', scope: 'linear-elastic-prestress-bifurcation',
    units: 'N-mm-MPa', source, inputSha256: '0'.repeat(64), freeDofs: 9, referenceEquilibriumResidual: 1e-13,
    maximumElementInitialStressError: 1e-12, modes, structuralCertification: false };
}
const AREA = 50, FORCE = [0, 0, 50] as const;

describe('solidBucklingModeCount', () => {
  it('uses the same bound as the FEM contract', () => {
    expect(SOLID_BUCKLING_CAD_MAX_MODES).toBe(SOLID_BUCKLING_MAX_MODES);
  });
  it.each([['', null], ['0', null], ['13', null], ['2.5', null], ['-1', null], ['abc', null], ['1', 1], ['12', 12], [' 3 ', 3]] as const)(
    'reads %j as %j', (text, expected) => {
      expect(solidBucklingModeCount({ modeCountText: text })).toBe(expected);
    });
});

describe('solidBucklingDisplayFor', () => {
  it('pairs a result with its request and keeps the factors, area and force', () => {
    const request = input();
    const display = solidBucklingDisplayFor(request, result(request), AREA, FORCE);
    expect(display?.factors.map(factor => [factor.number, factor.loadFactor])).toEqual([[1, 120], [2, 340]]);
    expect([display?.loadedAreaMm2, display?.totalForceN, display?.freeDofs]).toEqual([AREA, [0, 0, 50], 9]);
  });
  it.each([
    ['another revision', (request: SolidBucklingInput) => result(request, undefined, { ...request.reference.source, revision: 5 })],
    ['another mesh', (request: SolidBucklingInput) => result(request, undefined, { ...request.reference.source, meshKey: 'mesh-b' })],
    ['no factor', (request: SolidBucklingInput) => result(request, [])],
    ['more factors than requested', (request: SolidBucklingInput) => result(request, [mode(1, 1), mode(2, 2), mode(3, 3)])],
    ['a zero factor', (request: SolidBucklingInput) => result(request, [mode(1, 0), mode(2, 2)])],
    ['a negative (tension) factor', (request: SolidBucklingInput) => result(request, [mode(1, -5), mode(2, 2)])],
    ['descending factors', (request: SolidBucklingInput) => result(request, [mode(1, 5), mode(2, 2)])],
    ['non-sequential numbers', (request: SolidBucklingInput) => result(request, [mode(2, 1), mode(3, 2)])],
    ['a non-finite factor', (request: SolidBucklingInput) => result(request, [mode(1, Number.POSITIVE_INFINITY)])],
  ])('refuses %s', (_name, make) => {
    const request = input();
    expect(solidBucklingDisplayFor(request, make(request), AREA, FORCE)).toBeNull();
  });
});

describe('solid buckling run state', () => {
  it('accepts only the reply of the current running request', () => {
    const request = input();
    const first = startSolidBuckling(initialSolidBucklingState());
    const second = startSolidBuckling(first);
    const reply = { kind: 'result' as const, input: request, result: result(request), loadedAreaMm2: AREA, totalForceN: FORCE };
    expect(receiveSolidBuckling(second, first.requestId, reply)).toBe(second);
    const done = receiveSolidBuckling(second, second.requestId, reply);
    expect([done.status, done.input, done.display?.factors.length]).toEqual(['result', request, 2]);
    expect(receiveSolidBuckling(done, second.requestId, reply)).toBe(done);
  });
  it('shows no result for an unpaired reply and keeps the category and text of a refusal', () => {
    const request = input(1);
    const running = startSolidBuckling(initialSolidBucklingState());
    const unpaired = receiveSolidBuckling(running, running.requestId,
      { kind: 'result', input: request, result: result(request), loadedAreaMm2: AREA, totalForceN: FORCE });
    expect([unpaired.status, unpaired.display, unpaired.code]).toEqual(['failed', null, null]);
    const message = 'solid-buckling-no-positive-mode: 0 positive load factor(s) for 1 requested';
    const refused = receiveSolidBuckling(startSolidBuckling(unpaired), unpaired.requestId + 1,
      { kind: 'failed', code: 'buckling-no-compression', message });
    expect([refused.status, refused.display, refused.code, refused.error]).toEqual(['failed', null, 'buckling-no-compression', message]);
  });
  it('drops a running request or a result on cancel, invalidation and a count edit', () => {
    const request = input();
    const running = startSolidBuckling(initialSolidBucklingState());
    const cancelled = cancelSolidBuckling(running);
    expect([cancelled.status, cancelled.requestId]).toEqual(['cancelled', running.requestId + 1]);
    expect(receiveSolidBuckling(cancelled, running.requestId,
      { kind: 'result', input: request, result: result(request), loadedAreaMm2: AREA, totalForceN: FORCE })).toBe(cancelled);
    const shown = receiveSolidBuckling(running, running.requestId,
      { kind: 'result', input: request, result: result(request), loadedAreaMm2: AREA, totalForceN: FORCE });
    for (const next of [invalidateSolidBuckling(shown), editSolidBucklingCount(shown, '4')]) {
      expect([next.status, next.input, next.display, next.requestId > shown.requestId]).toEqual(['idle', null, null, true]);
    }
    expect(editSolidBucklingCount(shown, '4').modeCountText).toBe('4');
    expect(cancelSolidBuckling(shown)).toBe(shown);
  });
});
