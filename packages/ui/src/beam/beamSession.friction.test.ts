import { describe, expect, it } from 'vitest';
import { contactUiFixture } from './beamContact.testSupport.js';
import { beamDefinition, editBeamSession, restoreBeamSession, type BeamEdit } from './beamSession.js';

describe('friction session', () => {
  it('retains four independent load stages, including unloading, through schema 7 restore', () => {
    const fixture = contactUiFixture();
    let session = editBeamSession(fixture.session, { kind: 'analysis-type', value: 'friction' });
    session = editBeamSession(session, { kind: 'friction-coefficient', contactId: 'contact-1', source: '0.3' });
    const edits: BeamEdit[] = [
      { kind: 'friction-load-value', step: 0, load: 1, field: 'force', axis: 0, source: '2' },
      { kind: 'friction-load-value', step: 0, load: 1, field: 'force', axis: 1, source: '-10' },
      { kind: 'friction-load-value', step: 0, load: 1, field: 'force', axis: 2, source: '0' },
      { kind: 'friction-step-add' },
      { kind: 'friction-load-value', step: 1, load: 1, field: 'force', axis: 0, source: '5' },
      { kind: 'friction-step-add' },
      { kind: 'friction-load-value', step: 2, load: 1, field: 'force', axis: 0, source: '0' },
      { kind: 'friction-load-value', step: 2, load: 1, field: 'force', axis: 1, source: '0' },
      { kind: 'friction-step-add' },
      { kind: 'friction-load-value', step: 3, load: 1, field: 'force', axis: 0, source: '-5' },
      { kind: 'friction-load-value', step: 3, load: 1, field: 'force', axis: 1, source: '-10' },
    ];
    for (const edit of edits) session = editBeamSession(session, edit);
    const first = beamDefinition(session, fixture.source, []);
    if (!first.ok || first.definition.schema !== 'pointercad-standard-beam/7') throw new Error('schema 7 required');
    expect(first.definition.stepLoads.map(step => step[1].force)).toEqual([[2, -10, 0], [5, -10, 0], [0, 0, 0], [-5, -10, 0]]);
    expect(first.definition.friction).toEqual({ 'contact-1': 0.3 });
    const restored = restoreBeamSession(session.ownerId, first.definition, [fixture.occurrence]);
    const second = beamDefinition({ ...restored, members: restored.members.map(row => ({ ...row, confirmed: true })) }, fixture.source, []);
    if (!second.ok || second.definition.schema !== 'pointercad-standard-beam/7') throw new Error('restored schema 7 required');
    expect(second.definition.stepLoads).toEqual(first.definition.stepLoads);
    expect(second.definition.friction).toEqual(first.definition.friction);
    expect(second.definition.solverOptions).toEqual({ solver: 'newton', iterationLimit: 64 });
  });
  it('rejects a missing coefficient and invalid iteration limit with field diagnostics', () => {
    const fixture = contactUiFixture();
    let session = editBeamSession(fixture.session, { kind: 'analysis-type', value: 'friction' });
    expect(beamDefinition(session, fixture.source, [])).toMatchObject({ ok: false, field: 'friction:coefficient:contact-1' });
    session = editBeamSession(session, { kind: 'friction-coefficient', contactId: 'contact-1', source: '0.3' });
    session = editBeamSession(session, { kind: 'friction-iteration-limit', source: '0' });
    expect(beamDefinition(session, fixture.source, [])).toMatchObject({ ok: false, field: 'friction:iterationLimit' });
  });
  it('rejects negative mu, an invalid step expression and an invalid solver at their own fields', () => {
    const fixture = contactUiFixture();
    let session = editBeamSession(fixture.session, { kind: 'analysis-type', value: 'friction' });
    session = editBeamSession(session, { kind: 'friction-coefficient', contactId: 'contact-1', source: '-0.3' });
    expect(beamDefinition(session, fixture.source, [])).toMatchObject({ ok: false, field: 'friction:coefficient:contact-1' });
    session = editBeamSession(session, { kind: 'friction-coefficient', contactId: 'contact-1', source: '0.3' });
    const invalidStep = editBeamSession(session, { kind: 'friction-load-value', step: 0, load: 1,
      field: 'force', axis: 0, source: 'NaN' });
    expect(beamDefinition(invalidStep, fixture.source, [])).toMatchObject({ ok: false, field: 'friction:step:0:load:1:force:0' });
    const invalidSolver = { ...session, friction: { ...session.friction } };
    Reflect.set(invalidSolver.friction, 'solver', 'other');
    expect(beamDefinition(invalidSolver, fixture.source, [])).toMatchObject({ ok: false, field: 'friction:solver' });
  });
  it('removes only the deleted contact coefficient and can review the remaining contact', () => {
    const fixture = contactUiFixture();
    let session = editBeamSession(fixture.session, { kind: 'analysis-type', value: 'friction' });
    const edits: BeamEdit[] = [
      { kind: 'friction-coefficient', contactId: 'contact-1', source: '0.3' },
      { kind: 'contact-add' },
      { kind: 'contact-node', index: 1, end: 'a', nodeId: fixture.member.endNodeId },
      { kind: 'contact-value', index: 1, field: 'normalX', source: '0' },
      { kind: 'contact-value', index: 1, field: 'normalY', source: '0' },
      { kind: 'contact-value', index: 1, field: 'normalZ', source: '1' },
      { kind: 'contact-value', index: 1, field: 'gap', source: '0' },
      { kind: 'friction-coefficient', contactId: 'contact-2', source: '0.4' },
      { kind: 'contact-remove', index: 0 },
    ];
    for (const edit of edits) session = editBeamSession(session, edit);
    expect(session.friction.coefficients).toEqual({ 'contact-2': '0.4' });
    const checked = beamDefinition(session, fixture.source, []);
    if (!checked.ok || checked.definition.schema !== 'pointercad-standard-beam/7') throw new Error('remaining contact must be valid');
    expect(checked.definition.friction).toEqual({ 'contact-2': 0.4 });
  });
  it('preserves every saved field, external IDs, unused valid entries and exact non-axis frame without keeping caller objects', () => {
    const fixture = contactUiFixture();
    let session = editBeamSession(fixture.session, { kind: 'analysis-type', value: 'friction' });
    session = editBeamSession(session, { kind: 'friction-coefficient', contactId: 'contact-1', source: '0.3' });
    const checked = beamDefinition(session, fixture.source, []);
    if (!checked.ok || checked.definition.schema !== 'pointercad-standard-beam/7') throw new Error('schema 7 required');
    const saved = { ...checked.definition,
      members: checked.definition.members.map(member => ({ ...member, materialId: 'external-material', sectionId: 'external-section',
        sectionFrame: { ...member.sectionFrame, principalY: [0.6, 0.8, 0] as const } })),
      materials: [{ ...checked.definition.materials[0], id: 'external-material' }, { ...checked.definition.materials[0], id: 'unused-material' }],
      sections: [{ ...checked.definition.sections[0], id: 'external-section' }, { ...checked.definition.sections[0], id: 'unused-section' }] };
    const callerInput = structuredClone(saved), expected = structuredClone(callerInput);
    const restored = restoreBeamSession(session.ownerId, callerInput, [fixture.occurrence]);
    callerInput.materials[0].youngModulus = 1;
    Reflect.set(callerInput.materials[0].source, 'reference', 'mutated-after-restore');
    Reflect.set(callerInput.supports[0].restrained, 0, false);
    expect(Object.isFrozen(restored.frictionRestoreBaseline?.definition.members[0].sectionFrame.principalY)).toBe(true);
    const reviewed = { ...restored, members: restored.members.map(member => ({ ...member, confirmed: true })) };
    const again = beamDefinition(reviewed, fixture.source, []);
    if (!again.ok) throw new Error(`schema 7 restore: ${again.diagnostic}`);
    expect(again.definition).toEqual(expected);
    const changed = editBeamSession(reviewed, { kind: 'value', id: reviewed.members[0].id, field: 'young', source: '200000' });
    const changedDefinition = beamDefinition(changed, fixture.source, []);
    if (!changedDefinition.ok || changedDefinition.definition.schema !== 'pointercad-standard-beam/7') throw new Error('edited schema 7 required');
    expect(changedDefinition.definition.materials[0].youngModulus).toBe(200000);
    expect(changedDefinition.definition.members[0].materialId).not.toBe('external-material');
    const reopenedSource = { ...fixture.source, source: { ...fixture.source.source,
      documentRevision: fixture.source.source.documentRevision + 2, geometryRevision: 'new-document-opening:1' } };
    const opening = structuredClone(reopenedSource.source);
    const reopened = restoreBeamSession(session.ownerId, expected, [fixture.occurrence], opening);
    opening.geometryRevision = 'caller-mutated-after-open';
    const reopenedReviewed = { ...reopened, members: reopened.members.map(member => ({ ...member, confirmed: true })) };
    const reopenedDefinition = beamDefinition(reopenedReviewed, reopenedSource, []);
    if (!reopenedDefinition.ok) throw new Error('reopened definition must be reviewable');
    expect(reopenedDefinition.definition).toEqual({ ...expected, source: reopenedSource.source });
    expect(reopened.result).toBeNull();
    expect(reopened.reviewed).toBeNull();
    const afterOpeningChanged = { ...reopenedSource, source: { ...reopenedSource.source,
      documentRevision: reopenedSource.source.documentRevision + 1 } };
    const changedOpening = beamDefinition(reopenedReviewed, afterOpeningChanged, []);
    if (!changedOpening.ok) throw new Error('changed source must be rechecked');
    expect(changedOpening.definition.members[0].materialId).not.toBe('external-material');
    const foreignSource = { ...fixture.source, source: { ...fixture.source.source, documentRevision: fixture.source.source.documentRevision + 1 } };
    const foreign = beamDefinition(reviewed, foreignSource, []);
    if (!foreign.ok || foreign.definition.schema !== 'pointercad-standard-beam/7') throw new Error('current source required');
    expect(foreign.definition.members[0].materialId).not.toBe('external-material');
  });
});
