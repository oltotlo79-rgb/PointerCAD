import { beforeEach, describe, expect, it } from 'vitest';
import { createUndoStack } from '@pointercad/model';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { bucklingUiFixture } from './beamBuckling.testSupport.js';
import { beamDefinition, editBeamSession, restoreBeamSession, TRANSIENT_DRAFT_MAXIMUM_SAMPLES, type BeamEdit,
  type BeamSession } from './beamSession.js';

beforeEach(resetTestStore);

/** 0.1 ms x 200 steps = 20 ms; factor 0 at 0, ramp to 1 at 2 ms, held to 20 ms; every 4th step returned. */
function transientUiFixture() {
  const fixture = bucklingUiFixture();
  let session: BeamSession = { ...fixture.session, analysisType: 'transient' };
  const edits: readonly BeamEdit[] = [
    { kind: 'transient-value', field: 'timeStep', source: '0.1 ms' },
    { kind: 'transient-value', field: 'stepCount', source: '200' },
    { kind: 'transient-value', field: 'outputEvery', source: '4' },
    { kind: 'transient-sample', index: 0, field: 'factor', source: '0' },
    { kind: 'transient-sample', index: 1, field: 'time', source: '2 ms' },
    { kind: 'transient-sample', index: 1, field: 'factor', source: '1' },
    { kind: 'transient-sample-add' },
    { kind: 'transient-sample', index: 2, field: 'time', source: '20 ms' },
    { kind: 'transient-sample', index: 2, field: 'factor', source: '1' },
  ];
  for (const edit of edits) session = editBeamSession(session, edit);
  return { ...fixture, session };
}

describe('explicit CAD transient form and saved inputs', () => {
  it('parses Rayleigh coefficients with units and restores their exact saved values', () => {
    const fixture = transientUiFixture();
    let session = editBeamSession(fixture.session, { kind: 'transient-damping', value: 'rayleigh' });
    session = editBeamSession(session, { kind: 'transient-value', field: 'massCoefficientPerS', source: '(1 + 1) 1/s' });
    session = editBeamSession(session, { kind: 'transient-value', field: 'stiffnessCoefficientS', source: '2 ms' });
    const checked = beamDefinition(session, fixture.source, []);
    if (!checked.ok || checked.definition.schema !== 'pointercad-standard-beam/4') throw new Error('Expected Rayleigh inputs');
    expect(checked.definition.transient.history.damping)
      .toEqual({ kind: 'rayleigh', massCoefficientPerS: 2, stiffnessCoefficientS: 0.002 });
    const restored = restoreBeamSession(session.ownerId, checked.definition, [fixture.occurrence]);
    expect(restored.transient.damping).toBe('rayleigh');
    const again = beamDefinition({ ...restored, members: restored.members.map(row => ({ ...row, confirmed: true })) },
      fixture.source, []);
    if (!again.ok || again.definition.schema !== 'pointercad-standard-beam/4') throw new Error('Expected restored Rayleigh inputs');
    expect(again.definition.transient).toEqual(checked.definition.transient);
    for (const field of ['massCoefficientPerS', 'stiffnessCoefficientS'] as const) {
      for (const source of ['', '-1', '1 mm', '1/0']) {
        const bad = beamDefinition(editBeamSession(session, { kind: 'transient-value', field, source }), fixture.source, []);
        expect(bad.ok, field + ':' + source).toBe(false);
        if (!bad.ok) expect(bad.field).toBe('transient:' + field);
      }
    }
    let zero = editBeamSession(session, { kind: 'transient-value', field: 'massCoefficientPerS', source: '0' });
    zero = editBeamSession(zero, { kind: 'transient-value', field: 'stiffnessCoefficientS', source: '0' });
    const explicitZero = beamDefinition(zero, fixture.source, []);
    if (!explicitZero.ok || explicitZero.definition.schema !== 'pointercad-standard-beam/4') throw new Error('Expected explicit zero damping');
    expect(explicitZero.definition.transient.history.damping)
      .toEqual({ kind: 'rayleigh', massCoefficientPerS: 0, stiffnessCoefficientS: 0 });
    // A numeric digit must not be consumed as the leading 1 of a unit suffix.
    for (const [source, value] of [['1/s', 1], ['21/s', 21], ['0.11/s', 0.11],
      ['2 1/s', 2], ['(1 + 1)1/s', 2], ['21', 21]] as const) {
      const edited = editBeamSession(session, { kind: 'transient-value', field: 'massCoefficientPerS', source });
      const parsed = beamDefinition(edited, fixture.source, []);
      if (!parsed.ok || parsed.definition.schema !== 'pointercad-standard-beam/4') throw new Error('Expected inverse-time units');
      expect(parsed.definition.transient.history.damping)
        .toEqual({ kind: 'rayleigh', massCoefficientPerS: value, stiffnessCoefficientS: 0.002 });
    }
    for (const source of ['-1/s', '1/0/s', '21/s/s', '1//s', '1e309/s']) {
      const edited = editBeamSession(session, { kind: 'transient-value', field: 'massCoefficientPerS', source });
      const parsed = beamDefinition(edited, fixture.source, []);
      expect(parsed.ok, source).toBe(false);
      if (!parsed.ok) expect(parsed.field).toBe('transient:massCoefficientPerS');
    }
  });

  it('invalidates review and cancels active work for the mode and either coefficient edit', () => {
    const fixture = transientUiFixture();
    const reviewed: BeamSession = { ...fixture.session, reviewed: fixture.source, status: 'running',
      transientView: { sample: 3, node: 1 } };
    const edits: readonly BeamEdit[] = [
      { kind: 'transient-damping', value: 'rayleigh' },
      { kind: 'transient-value', field: 'massCoefficientPerS', source: '2' },
      { kind: 'transient-value', field: 'stiffnessCoefficientS', source: '0.001' },
    ];
    for (const edit of edits) {
      let cancelled = 0;
      useAppStore.setState({ beamSession: reviewed, beamRunner: { run: () => undefined, cancel: () => { cancelled += 1; } } });
      useAppStore.getState().editBeam(edit);
      const changed = useAppStore.getState().beamSession;
      expect(cancelled).toBe(1);
      expect(changed?.revision).toBe(reviewed.revision + 1);
      expect(changed?.reviewed).toBeNull();
      expect(changed?.result).toBeNull();
      expect(changed?.transientAxial).toBeNull();
      expect(changed?.transientView).toEqual({ sample: 0, node: 0 });
    }
  });

  it('builds saved schema 4 with explicit supports, reference loads, mesh refinement and the parsed history', () => {
    const fixture = transientUiFixture(), member = fixture.session.members[0];
    const checked = beamDefinition(fixture.session, fixture.source, []);
    if (!checked.ok || checked.definition.schema !== 'pointercad-standard-beam/4') throw new Error('Expected valid schema4 form');
    const { history } = checked.definition.transient;
    expect(history.timeStepS).toBeCloseTo(1e-4, 18);
    expect([history.stepCount, history.outputEvery, history.damping, history.initialConditions])
      .toEqual([200, 4, 'none', 'zero-at-rest']);
    expect(history.loadFactor.map(row => row.factor)).toEqual([0, 1, 1]);
    // The shared expression evaluator owns decimal rounding; compare to the stated times within 1e-15 s.
    history.loadFactor.forEach((row, index) => expect(Math.abs(row.timeS - [0, 0.002, 0.02][index])).toBeLessThan(1e-15));
    expect(checked.definition.transient.segmentsPerMember).toBe(4);
    expect(checked.definition.supports).toEqual([{ nodeId: member.startNodeId, restrained: [true, true, true, true, true, true] }]);
    expect(checked.definition.referenceLoads).toEqual([{ id: 'load-0', kind: 'nodal', nodeId: member.endNodeId,
      force: [0, 0, -1], moment: [0, 0, 0] }]);
    for (const absent of ['constraints', 'modal', 'buckling', 'loads']) expect(checked.definition).not.toHaveProperty(absent);
  });

  it('reports the exact history field, and lets the model reject an inconsistent duration', () => {
    const fixture = transientUiFixture();
    const at = (edit: BeamEdit) => beamDefinition(editBeamSession(fixture.session, edit), fixture.source, []);
    for (const [edit, field] of [
      [{ kind: 'transient-value', field: 'timeStep', source: '' }, 'transient:timeStep'],
      [{ kind: 'transient-value', field: 'timeStep', source: '-1 ms' }, 'transient:timeStep'],
      [{ kind: 'transient-value', field: 'timeStep', source: '5 mm' }, 'transient:timeStep'],
      [{ kind: 'transient-value', field: 'stepCount', source: '1.5' }, 'transient:stepCount'],
      [{ kind: 'transient-value', field: 'outputEvery', source: '0' }, 'transient:outputEvery'],
      [{ kind: 'transient-sample', index: 2, field: 'factor', source: 'x' }, 'transient:sample:2:factor'],
    ] as const) {
      const checked = at(edit);
      expect(checked.ok, JSON.stringify(edit)).toBe(false);
      if (!checked.ok) expect([checked.key, checked.field]).toEqual(['beam.error.inputs', field]);
    }
    const mismatch = at({ kind: 'transient-sample', index: 2, field: 'time', source: '19 ms' });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.key).toBe('beam.error.model');
      expect(mismatch.diagnostic).toContain('transient-history');
    }
    const interval = at({ kind: 'transient-value', field: 'outputEvery', source: '201' });
    expect(interval.ok).toBe(false);
    if (!interval.ok) expect(interval.diagnostic).toContain('transient-output');
  });

  it('restores schema 4 exactly and keeps schema 3 restore unchanged', () => {
    const fixture = transientUiFixture();
    const checked = beamDefinition(fixture.session, fixture.source, []);
    if (!checked.ok || checked.definition.schema !== 'pointercad-standard-beam/4') throw new Error('Expected valid schema4 form');
    const restored = restoreBeamSession(fixture.session.ownerId, checked.definition, [fixture.occurrence]);
    expect(restored.analysisType).toBe('transient');
    expect(restored.segmentsPerMember).toBe(4);
    expect(restored.result).toBeNull();
    expect(restored.reviewed).toBeNull();
    expect(restored.members[0].confirmed).toBe(false);
    expect(restored.transient.samples).toHaveLength(3);
    expect(restored.transient.timeStep).not.toMatch(/e/iu);
    const again = beamDefinition({ ...restored, members: restored.members.map(row => ({ ...row, confirmed: true })) },
      fixture.source, []);
    if (!again.ok || again.definition.schema !== 'pointercad-standard-beam/4') throw new Error('Expected restored schema4 form');
    expect(again.definition.transient).toEqual(checked.definition.transient);
    expect(again.definition.supports).toEqual(checked.definition.supports);
    expect(again.definition.referenceLoads).toEqual(checked.definition.referenceLoads);

    const buckling = bucklingUiFixture();
    const old = beamDefinition(buckling.session, buckling.source, []);
    if (!old.ok || old.definition.schema !== 'pointercad-standard-beam/3') throw new Error('Expected valid schema3 form');
    expect(old.definition).not.toHaveProperty('transient');
    const oldRestored = restoreBeamSession(buckling.session.ownerId, old.definition, [buckling.occurrence]);
    expect(oldRestored.analysisType).toBe('buckling');
    // No time history is invented for an older schema; the editable default is empty apart from time 0.
    expect(oldRestored.transient).toEqual({ damping: 'none', massCoefficientPerS: '0', stiffnessCoefficientS: '0',
      timeStep: '', stepCount: '', outputEvery: '1',
      samples: [{ time: '0', factor: '' }, { time: '', factor: '' }] });
  });

  it('bounds the sample rows and keeps view-only choices from invalidating a run or result', () => {
    const fixture = transientUiFixture();
    let session = fixture.session;
    expect(editBeamSession({ ...session, transient: { ...session.transient, samples: session.transient.samples.slice(0, 2) } },
      { kind: 'transient-sample-remove', index: 0 }).transient.samples).toHaveLength(2);
    // Regression (UI proof finding): adding a row moves the keyboard position to the new row's time field.
    expect(editBeamSession(session, { kind: 'transient-sample-add' }).focusedField).toBe('transient:sample:3:time');
    for (let index = session.transient.samples.length; index < TRANSIENT_DRAFT_MAXIMUM_SAMPLES + 2; index += 1) {
      session = editBeamSession(session, { kind: 'transient-sample-add' });
    }
    expect(session.transient.samples).toHaveLength(TRANSIENT_DRAFT_MAXIMUM_SAMPLES);
    const reviewed: BeamSession = { ...fixture.session, reviewed: fixture.source, status: 'complete' };
    const viewed = editBeamSession(reviewed, { kind: 'transient-view', sample: 3, node: 1 });
    expect(viewed.transientView).toEqual({ sample: 3, node: 1 });
    expect([viewed.revision, viewed.reviewed, viewed.status]).toEqual([reviewed.revision, fixture.source, 'complete']);
    const edited = editBeamSession(viewed, { kind: 'transient-value', field: 'stepCount', source: '100' });
    expect([edited.revision, edited.reviewed, edited.transientView]).toEqual([reviewed.revision + 1, null, { sample: 0, node: 0 }]);
    let cancelled = 0;
    useAppStore.setState({ beamSession: reviewed, beamRunner: { run: () => undefined, cancel: () => { cancelled += 1; } } });
    useAppStore.getState().editBeam({ kind: 'transient-view', sample: 1, node: 0 });
    expect(cancelled).toBe(0);
    useAppStore.getState().editBeam({ kind: 'transient-value', field: 'stepCount', source: '100' });
    expect(cancelled).toBe(1);
  });

  it('saves through the existing assembly undo history and reopens without trust or results', () => {
    const fixture = transientUiFixture();
    useAppStore.setState({ ...fixture.state,
      assemblyUndoStack: createUndoStack({ document: fixture.source.document, library: fixture.source.library }),
      beamSession: { ...fixture.session, reviewed: fixture.source } });
    const before = useAppStore.getState();
    if (before.assemblyUndoStack === null) throw new Error('Expected initialized assembly history');
    useAppStore.getState().applyBeamInputs();
    const saved = useAppStore.getState().assembly?.beamAnalysisInputs?.analyses[0];
    if (saved?.kind !== 'standard-members' || saved.definition.schema !== 'pointercad-standard-beam/4') {
      throw new Error('Missing saved transient inputs');
    }
    expect(JSON.stringify(saved)).not.toMatch(/"(?:samples|nodes|result|peakDisplacementM|transientView)"/u);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(before.assemblyUndoStack.past.length + 1);
    expect(useAppStore.getState().assemblyUndoStack?.past[0].document).toBe(before.assembly);
    useAppStore.getState().openBeam();
    const restored = useAppStore.getState().beamSession;
    expect(restored?.analysisType).toBe('transient');
    expect(restored?.reviewed).toBeNull();
    expect(restored?.result).toBeNull();
    expect(restored?.transient.stepCount).toBe('200');
    expect(restored?.members[0].startRestraints).toEqual([true, true, true, true, true, true]);
  });
});
