import type { SolidModalInput, SolidModalResult } from '@pointercad/fem';
import { describe, expect, it } from 'vitest';
import { solidModeResultFor } from './solidModalDisplay.js';
import { cancelSolidModal, editSolidModalInput, initialSolidModalState, invalidateSolidModal, receiveSolidModal,
  setSolidModalView, solidModalPreview, solidModalRequestValues, startSolidModal } from './solidModalState.js';

const source = { documentId: 'doc-1', revision: 4, meshKey: 'mesh-a' };

function input(constraints: SolidModalInput['constraints'] = [{ node: 0, fixed: [true, true, true] }]): SolidModalInput {
  return {
    schema: 'pointercad-solid-tet4-modal/1', source, units: 'N-mm-MPa', numericBudgetBytes: 1_000_000,
    nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]],
    elements: [{ nodes: [0, 1, 2, 3], materialId: 'steel' }],
    materials: [{ id: 'steel', youngMPa: 205000, poisson: 0.3, densityKgM3: 7850 }],
    constraints, modeCount: 2,
  };
}

function result(overrides: Partial<SolidModalResult> = {}): SolidModalResult {
  return {
    kind: 'oofem-solid-tet4-modal', method: 'oofem-ltrspace-isole-consistent-mass-numpy-eigh/1', source,
    inputSha256: '0'.repeat(64), units: 'N-mm-MPa-t-s', structuralCertification: false, applicability: 'supported',
    nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]],
    fixed: [[true, true, true], [false, false, false], [false, false, false], [false, false, false]],
    rigidBodyModes: 0, freeDofs: 9, totalMassT: 1.3e-6,
    modes: [
      { number: 1, eigenvaluePerSecondSquared: 4e8, frequencyHz: 3183.1, normalizedResidual: 1e-12,
        massNormalizedShapePerSqrtT: [[0, 0, 0], [3, 4, 0], [0, 0, 1], [1, 0, 0]] },
      { number: 2, eigenvaluePerSecondSquared: 9e8, frequencyHz: 4774.6, normalizedResidual: 1e-12,
        massNormalizedShapePerSqrtT: [[0, 0, 0], [0, 0, 2], [0, 2, 0], [2, 0, 0]] },
    ],
    maximumMassOrthogonalityError: 1e-12, maximumRigidMotionResidual: 0, maximumElementMassError: 1e-14,
    reservedNumericBytes: 100_000, independentMaximumResidual: 1e-12, independentMaximumOrthogonalityError: 1e-12,
    ...overrides,
  };
}
const reply = (request = input(), value = result()) => ({ kind: 'result' as const, input: request, result: value });

describe('solidModeResultFor', () => {
  it('takes the elements from the matching request and keeps the result rows', () => {
    const request = input(), value = result();
    const display = solidModeResultFor(request, value);
    expect(display?.elements).toBe(request.elements);
    expect(display?.nodes).toBe(value.nodes);
    expect(display?.fixed).toBe(value.fixed);
    expect(display?.modes.map(mode => [mode.number, mode.frequencyHz])).toEqual([[1, 3183.1], [2, 4774.6]]);
  });

  it('refuses a result that does not provably belong to the request', () => {
    const request = input();
    for (const value of [
      result({ source: { ...source, documentId: 'doc-2' } }),
      result({ source: { ...source, revision: 5 } }),
      result({ source: { ...source, meshKey: 'mesh-b' } }),
      result({ nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0]] }),
      result({ nodes: [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10.000001]] }),
      result({ fixed: [[true, true, false], [false, false, false], [false, false, false], [false, false, false]] }),
      result({ applicability: 'free-free' }),
      result({ modes: [{ ...result().modes[0], massNormalizedShapePerSqrtT: [[0, 0, 0]] }] }),
    ]) expect(solidModeResultFor(request, value)).toBeNull();
    expect(solidModeResultFor(input([{ node: 0, fixed: [true, true, true] }, { node: 0, fixed: [true, true, true] }]), result())).toBeNull();
    expect(solidModeResultFor(input([{ node: 7, fixed: [true, true, true] }]), result())).toBeNull();
  });

  it('pairs a free-free request only with a free-free result', () => {
    const free = result({ applicability: 'free-free', rigidBodyModes: 6, fixed: [[false, false, false], [false, false, false], [false, false, false], [false, false, false]] });
    expect(solidModeResultFor(input([]), free)).not.toBeNull();
    expect(solidModeResultFor(input([]), result())).toBeNull();
  });
});

describe('solid modal run state', () => {
  it('shows the current reply, keeps the exact request and starts at the first mode', () => {
    const running = startSolidModal(initialSolidModalState());
    const request = input();
    const done = receiveSolidModal(running, running.requestId, reply(request));
    expect(done.status).toBe('result');
    expect(done.input).toBe(request);
    expect(done.view.modeNumber).toBe(1);
    expect(solidModalPreview(done, source)?.kind).toBe('preview');
  });

  it('ignores a late reply of a replaced, cancelled or invalidated request', () => {
    const first = startSolidModal(initialSolidModalState());
    const second = startSolidModal(first);
    expect(receiveSolidModal(second, first.requestId, reply())).toBe(second);
    const cancelled = cancelSolidModal(second);
    expect(cancelled.status).toBe('cancelled');
    expect(receiveSolidModal(cancelled, second.requestId, reply())).toBe(cancelled);
    const closed = invalidateSolidModal(second);
    expect(receiveSolidModal(closed, second.requestId, reply())).toBe(closed);
    expect(solidModalPreview(closed, source)).toBeNull();
  });

  it('turns a failed or mismatched reply into a failure without any preview, keeping the message', () => {
    const running = startSolidModal(initialSolidModalState());
    const failed = receiveSolidModal(running, running.requestId, { kind: 'failed', message: 'solid-modal-mechanism' });
    expect([failed.status, failed.error, failed.display]).toEqual(['failed', 'solid-modal-mechanism', null]);
    const mismatched = receiveSolidModal(running, running.requestId, reply(input(), result({ source: { ...source, revision: 9 } })));
    expect([mismatched.status, mismatched.display, mismatched.input]).toEqual(['failed', null, null]);
    expect(solidModalPreview(mismatched, source)).toBeNull();
  });

  it('clears the preview when the current source changes and keeps the request on display changes', () => {
    const running = startSolidModal(initialSolidModalState());
    const done = receiveSolidModal(running, running.requestId, reply());
    expect(solidModalPreview(done, { ...source, revision: 5 })).toEqual({ kind: 'none', reason: 'stale' });
    expect(solidModalPreview(done, null)).toBeNull();
    const before = JSON.stringify(done.input);
    const viewed = setSolidModalView(done, { modeNumber: 2, amplitudeMm: 3, phase: -1 }, '3');
    expect(viewed.input).toBe(done.input);
    expect(JSON.stringify(viewed.input)).toBe(before);
    expect([viewed.display, viewed.requestId, viewed.densityText, viewed.modeCountText])
      .toEqual([done.display, done.requestId, done.densityText, done.modeCountText]);
  });

  it('treats density and mode count as physical input: an edit drops the result and validates strictly', () => {
    const running = startSolidModal(initialSolidModalState());
    const done = receiveSolidModal(running, running.requestId, reply());
    const edited = editSolidModalInput(done, 'density', '7850');
    expect([edited.status, edited.display, edited.densityText]).toEqual(['idle', null, '7850']);
    expect(receiveSolidModal(edited, running.requestId, reply())).toBe(edited);
    expect(solidModalRequestValues(editSolidModalInput(edited, 'modeCount', '20'))).toEqual({ densityKgM3: 7850, modeCount: 20 });
    for (const [density, count] of [['', '6'], ['0', '6'], ['-1', '6'], ['NaN', '6'], ['7850', '0'], ['7850', '21'], ['7850', '2.5'], ['7850', '']]) {
      expect(solidModalRequestValues({ densityText: density, modeCountText: count })).toBeNull();
    }
  });
});
