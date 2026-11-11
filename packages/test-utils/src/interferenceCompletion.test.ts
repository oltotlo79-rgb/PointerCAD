import { describe, expect, it } from 'vitest';
import { requireCompletedInterferenceRuns } from './interferenceCompletion.js';

type InterferenceCompletion = Parameters<typeof requireCompletedInterferenceRuns>[0][number];

const complete = (): InterferenceCompletion[] => Array.from({ length: 5 }, () => ({ completed: true, error: null }));

describe('all requested interference runs must finish', () => {
  it('rejects the observed five progress-only runs with no completed geometry result', () => {
    expect(() => requireCompletedInterferenceRuns(Array.from({ length: 5 }, () => ({ completed: false, error: null })), 5))
      .toThrow('run 1 did not complete');
  });
  it('rejects a missing run and an unfinished or failed later run', () => {
    expect(() => requireCompletedInterferenceRuns(complete().slice(0, 4), 5)).toThrow('exactly 5');
    const unfinished = complete();
    unfinished[4] = { completed: false, error: null };
    expect(() => requireCompletedInterferenceRuns(unfinished, 5)).toThrow('run 5 did not complete');
    const failed = complete();
    failed[3] = { completed: true, error: 'native failure' };
    expect(() => requireCompletedInterferenceRuns(failed, 5)).toThrow('run 4 did not complete successfully: native failure');
  });
  it('accepts all five successful results without modifying their evidence', () => {
    const runs = complete(), before = structuredClone(runs);
    expect(() => requireCompletedInterferenceRuns(runs, 5)).not.toThrow();
    expect(runs).toEqual(before);
  });
});
