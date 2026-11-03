import { describe, expect, it } from 'vitest';
import { cantilever } from './analysisCases.testSupport.js';
import { bucklingFixture } from './buckling.testSupport.js';
import { compareVerification } from './verificationComparison.testSupport.js';
import { bucklingInput, linearInput } from './verificationCases.testSupport.js';

describe('verification case input binding', () => {
  it('accepts the actual fixed linear and buckling fixture inputs with independent literal observables', () => {
    const linear = { caseId: 'linear-cantilever-tip-y-v1', input: linearInput(cantilever({ mode: 'y' })), value: .010296410256410255 };
    expect(compareVerification(linear.caseId, linear).passed).toBe(true);
    const buckling = { caseId: 'buckling-fixed-free-first-v1', input: bucklingInput(bucklingFixture({ pinned: false, segments: 16 })), value: .5181542310571913 };
    expect(compareVerification(buckling.caseId, buckling).passed).toBe(true);
  });
  it('rejects a different case, units, load, revision and non-finite value', () => {
    const input = cantilever({ mode: 'y' });
    const observation = { caseId: 'linear-cantilever-tip-y-v1', input: linearInput(input), value: .010296410256410255 };
    expect(() => compareVerification('buckling-fixed-free-first-v1', observation)).toThrow();
    expect(() => compareVerification(observation.caseId, { ...observation, input: { ...observation.input, units: 'N-mm' } })).toThrow();
    expect(() => compareVerification(observation.caseId, { ...observation, input: linearInput(cantilever({ forceMultiplier: -1 })) })).toThrow();
    expect(() => compareVerification(observation.caseId, { ...observation, input: linearInput({ ...input, revision: input.revision + 1 }) })).toThrow();
    for (const value of [NaN, Infinity, -Infinity]) expect(() => compareVerification(observation.caseId, { ...observation, value })).toThrow();
    expect(compareVerification(observation.caseId, { ...observation, value: .02 }).passed).toBe(false);
  });
});
