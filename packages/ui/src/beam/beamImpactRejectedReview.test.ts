import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { requireBeamSession } from './beam.testSupport.js';
import { contactUiFixture } from './beamContact.testSupport.js';
import type { BeamEdit } from './beamSession.js';

beforeEach(resetTestStore);
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); });

/**
 * Public lifecycle of a refused impact review (task169): the contact form's free end as an impact (start fully
 * restrained, -2 m/s along Z towards the plane 0.5 mm away, direction entered as 0,0,-2, no load), 200 steps of
 * 0.01 ms with one output every 201 steps. The impact solver admits an output interval of 1 to the step count only
 * (fem beamImpactTranslation.ts readHistory count(outputEvery, 1, stepCount)), so no run of this history exists; the
 * saved-input reader refuses it as well once task167's contract is composed. Only public store actions are used, in
 * the same order as attachBeamAnalysis.impact.test.ts builds its valid impact.
 */
function store(outputEvery: string) {
  const fixture = contactUiFixture();
  const runner = { run: vi.fn(), cancel: vi.fn() };
  useAppStore.setState({ ...fixture.state, beamRunner: runner, beamSession: fixture.session });
  const edits: readonly BeamEdit[] = [
    { kind: 'analysis-type', value: 'impact' },
    { kind: 'value', id: fixture.member.id, field: 'endFz', source: '0' },
    { kind: 'contact-value', index: 0, field: 'normalZ', source: '-2' },
    { kind: 'impact-velocity', nodeId: fixture.member.endNodeId, axis: 2, source: '-2' },
    { kind: 'impact-value', field: 'contactStiffness', source: '10000000' },
    { kind: 'impact-value', field: 'timeStep', source: '0.01ms' },
    { kind: 'impact-value', field: 'stepCount', source: '200' },
    { kind: 'impact-value', field: 'outputEvery', source: outputEvery },
  ];
  for (const edit of edits) useAppStore.getState().editBeam(edit);
  return { fixture, runner };
}

describe('a refused impact review keeps everything the user entered and starts nothing', () => {
  it('refuses an output interval longer than the run, then accepts the corrected interval without re-entry', () => {
    const { fixture, runner } = store('201');
    const entered = requireBeamSession();
    // The document side of the store (everything the fixture installs except the session and its runner).
    const documentKeys = Object.keys(fixture.state).filter(key => key !== 'beamSession' && key !== 'beamRunner');
    const documentBefore = documentKeys.map(key => [key, Reflect.get(useAppStore.getState(), key)] as const);

    useAppStore.getState().reviewBeam();
    const refused = requireBeamSession();
    expect([refused.status, refused.reviewed, refused.result, refused.errorKey]).toEqual(['editing', null, null, 'beam.error.model']);
    // Source names the solver's refusal (impact-step); with task167 the saved-input reader names it (impact-history).
    expect(refused.diagnostic).toMatch(/impact-(?:step|history)/u);
    // Every value the user typed stays exactly as typed: the impact draft, the plane row and the member.
    expect(refused.impact).toEqual(entered.impact);
    expect(refused.impact).toMatchObject({ contactStiffness: '10000000', timeStep: '0.01ms', stepCount: '200', outputEvery: '201' });
    expect(refused.contact).toEqual(entered.contact);
    expect(refused.members).toEqual(entered.members);
    expect(refused.analysisType).toBe('impact');

    // Neither a run nor a save can follow the refusal; the document and its saved inputs are untouched.
    useAppStore.getState().runBeam();
    expect(runner.run).not.toHaveBeenCalled();
    expect(requireBeamSession().errorKey).toBe('beam.error.review');
    useAppStore.getState().applyBeamInputs();
    for (const [key, value] of documentBefore) expect(Reflect.get(useAppStore.getState(), key), key).toBe(value);
    expect(requireBeamSession().impact).toEqual(entered.impact);

    // Correcting the one field is enough: review accepts the kept inputs and the run starts with them.
    useAppStore.getState().editBeam({ kind: 'impact-value', field: 'outputEvery', source: '200' });
    useAppStore.getState().reviewBeam();
    const accepted = requireBeamSession();
    expect([accepted.errorKey, accepted.reviewed === null]).toEqual([null, false]);
    expect(accepted.impact).toEqual({ ...entered.impact, outputEvery: '200' });
    useAppStore.getState().runBeam();
    expect(runner.run).toHaveBeenCalledOnce();
  });
});
