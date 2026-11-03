import { describe, expect, it } from 'vitest';
import { createSolidFiniteSession, type SolidFiniteSession } from './solidFiniteSession.js';
import { DEFAULT_SOLID_FINITE_FIELD_VIEW } from './solidFiniteFieldView.js';
import { solidFiniteFieldOf } from './solidFiniteFieldState.js';
import { finiteFieldOutcome } from './solidFiniteField.testSupport.js';

async function complete(): Promise<SolidFiniteSession> {
  return { ...createSolidFiniteSession('open-document-session'), bodyFeatureId: 'box',
    revision: 42, status: 'complete', result: await finiteFieldOutcome(), fieldView: DEFAULT_SOLID_FINITE_FIELD_VIEW };
}

describe('finite field state cache', () => {
  it('draws only complete sessions and does not confuse open-document IDs or edit revisions with persistent CAD identity', async () => {
    const done = await complete();
    expect(solidFiniteFieldOf(done)?.triangleElements).toHaveLength(6);
    expect(solidFiniteFieldOf(null)).toBeNull();
    for (const status of ['editing', 'running', 'failed', 'cancelled'] as const)
      expect(solidFiniteFieldOf({ ...done, status })).toBeNull();
    expect(solidFiniteFieldOf({ ...done, result: null })).toBeNull();
    expect(solidFiniteFieldOf({ ...done, bodyFeatureId: 'another-body' })).toBeNull();
  });

  it('caches the full result and choice, rebuilding on step, quantity, scale, or outcome replacement', async () => {
    const done = await complete(), first = solidFiniteFieldOf(done);
    expect(first).not.toBeNull();
    expect(solidFiniteFieldOf({ ...done, focused: 'yield' })).toBe(first);
    expect(solidFiniteFieldOf({ ...done, fieldView: { ...done.fieldView } })).toBe(first);
    for (const fieldView of [{ ...done.fieldView, step: 2 }, { ...done.fieldView, quantity: 'xy' as const },
      { ...done.fieldView, deformationScale: 0 }]) {
      const changed = solidFiniteFieldOf({ ...done, fieldView });
      expect(changed).not.toBeNull(); expect(changed).not.toBe(first);
    }
    expect(solidFiniteFieldOf({ ...done, result: await finiteFieldOutcome() })).not.toBe(first);
  });

  it('hides cached geometry during an invalidated or late-result state and rejects an absent chosen step', async () => {
    const done = await complete();
    expect(solidFiniteFieldOf(done)).not.toBeNull();
    expect(solidFiniteFieldOf({ ...done, status: 'cancelled' })).toBeNull();
    expect(solidFiniteFieldOf({ ...done, revision: done.revision + 1, status: 'editing', result: null })).toBeNull();
    expect(solidFiniteFieldOf({ ...done, revision: done.revision + 1, status: 'editing' })).toBeNull();
    expect(solidFiniteFieldOf({ ...done, fieldView: { ...done.fieldView, step: 3 } })).toBeNull();
  });
});
