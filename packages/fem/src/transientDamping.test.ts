import { describe, expect, it } from 'vitest';
import { axialOscillator, transientHistory } from './transient.testSupport.js';
import { transientInputSha256, translateBeamTransient } from './transientTranslation.js';
import { decodeBeamTransient, isBeamTransientResult, transientResultMatches } from './transientResults.js';
import { isRequest, isReply, FEM_PROTOCOL } from './protocol.js';

const damping = { kind: 'rayleigh' as const, massCoefficientPerS: 2, stiffnessCoefficientS: 0.001 };
const history = { ...transientHistory(0.001, 2, [[0, 0], [2, 0]]), damping };
const input = axialOscillator(history);

/** Protocol fixture only. Real physics is tested through runTransientDampingNativeChecks. */
function raw() {
  const { plan } = translateBeamTransient(input);
  return { schema: 'pointercad-oofem-transient-result/2', damping: { ...damping }, dissipatedEnergyJ: 0,
    normalizationLengthM: plan.normalizationLengthM, meshNodes: 2, meshElements: 1, freeDofs: 1,
    maximumEquilibriumResidual: 0, maximumEnergyBalanceError: 0,
    peakDisplacementM: 0, peakDisplacementTimeS: 0, peakDisplacementSolverNode: 1,
    peakRotationRad: 0, peakRotationTimeS: 0, peakRotationSolverNode: 1,
    samples: [0, 1, 2].map(step => ({ timeS: step * history.timeStepS, loadFactor: 0,
      nodes: [1, 2].map(number => ({ number, displacementM: [0, 0, 0], rotationRad: [0, 0, 0],
        velocityMPerS: [0, 0, 0], angularVelocityRadPerS: [0, 0, 0],
        accelerationMPerS2: [0, 0, 0], angularAccelerationRadPerS2: [0, 0, 0] })) })) };
}

describe('Rayleigh FEM boundary and result identity', () => {
  it('hashes both coefficients, owns the object and admits the actual protocol shape', async () => {
    const translated = translateBeamTransient(input);
    expect(translated.plan.history.damping).toEqual(damping);
    expect(translated.plan.history.damping).not.toBe(input.history.damping);
    const hash = await transientInputSha256(input);
    for (const change of [{ massCoefficientPerS: 3 }, { stiffnessCoefficientS: 0.002 }]) {
      expect(await transientInputSha256({ ...input, history: { ...history,
        damping: { ...damping, ...change } } })).not.toBe(hash);
    }
    const identity = { documentId: 'independent-modal-fixture', revision: 1, generation: 1, requestId: 'damping-1' };
    expect(isRequest({ protocol: FEM_PROTOCOL, kind: 'analyze-beam-transient-3d', identity, input })).toBe(true);
    const result = decodeBeamTransient(raw(), input, hash);
    expect(result.method).toBe('oofem-beam3d-matrices-newmark-average-acceleration/2');
    expect(isReply({ protocol: FEM_PROTOCOL, kind: 'result', identity, result })).toBe(true);
    expect(transientResultMatches(result, input, hash)).toBe(true);
    const other = { ...input, history: { ...history, damping: { ...damping, massCoefficientPerS: 3 } } };
    expect(transientResultMatches(result, other, await transientInputSha256(other))).toBe(false);
  });

  it('refuses stale undamped runtime replies and forged loss/coefficient metadata', async () => {
    const hash = await transientInputSha256(input);
    const original = raw();
    const { damping: omitted, dissipatedEnergyJ: omittedLoss, ...old } = original;
    expect(omitted).toEqual(damping);
    expect(omittedLoss).toBe(0);
    for (const invalid of [
      { ...old, schema: 'pointercad-oofem-transient-result/1' }, old,
      { ...original, damping: { ...damping, massCoefficientPerS: 3 } },
      { ...original, damping: { ...damping, stiffnessCoefficientS: 0.002 } },
      { ...original, damping: { ...damping, extra: 0 } },
      { ...original, dissipatedEnergyJ: -1 }, { ...original, dissipatedEnergyJ: Number.NaN },
      { ...original, dissipatedEnergyJ: Number.POSITIVE_INFINITY },
      { ...original, maximumEnergyBalanceError: 1.0001e-8 },
      { ...original, maximumEquilibriumResidual: 1.0001e-8 },
    ]) expect(() => decodeBeamTransient(invalid, input, hash)).toThrow();
    const result = decodeBeamTransient(original, input, hash);
    expect(isBeamTransientResult({ ...result, method: 'oofem-beam3d-matrices-newmark-average-acceleration/1' })).toBe(false);
    const undamped = { ...input, history: { ...history, damping: 'none' as const } };
    expect(() => decodeBeamTransient(original, undamped, hash)).toThrow();
    const zero = { kind: 'rayleigh' as const, massCoefficientPerS: 0, stiffnessCoefficientS: 0 };
    expect(() => decodeBeamTransient({ ...original, damping: zero, dissipatedEnergyJ: 1e-30 },
      { ...input, history: { ...history, damping: zero } }, hash)).toThrow();
  });
});
