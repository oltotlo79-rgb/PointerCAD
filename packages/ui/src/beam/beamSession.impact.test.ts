import { readBeamAnalysisInputs } from '@pointercad/model/beam-analysis';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { contactUiFixture } from './beamContact.testSupport.js';
import { beamDefinition, editBeamSession, restoreBeamSession, type BeamDefinition, type BeamEdit,
  type BeamSession } from './beamSession.js';

beforeEach(resetTestStore);

/** The contact form's member (start fully restrained) and its plane row at the free end, switched to impact: the
 * reference load is cleared, the end moves at -2 m/s along Z, and the plane direction is entered unnormalized as 0,0,2. */
function impactCase() {
  const fixture = contactUiFixture();
  const edits: readonly BeamEdit[] = [
    { kind: 'analysis-type', value: 'impact' },
    { kind: 'value', id: fixture.member.id, field: 'endFz', source: '0' },
    { kind: 'impact-velocity', nodeId: fixture.member.endNodeId, axis: 2, source: '-2' },
    { kind: 'impact-value', field: 'contactStiffness', source: '10000000' },
    { kind: 'impact-value', field: 'timeStep', source: '0.01ms' },
    { kind: 'impact-value', field: 'stepCount', source: '200' },
    { kind: 'impact-value', field: 'outputEvery', source: '2' },
    { kind: 'contact-value', index: 0, field: 'normalZ', source: '2' },
  ];
  return { fixture, session: edits.reduce(editBeamSession, fixture.session) };
}
const attachment = (definition: unknown) => ({ schema: 'pointercad-beam-inputs/1', analyses: [{ kind: 'standard-members', definition }] });

function savedImpact(session: BeamSession, fixture: ReturnType<typeof contactUiFixture>): BeamDefinition {
  const checked = beamDefinition(session, fixture.source, []);
  if (!checked.ok) throw new Error(`Expected a valid impact form: ${checked.key} ${checked.field ?? ''} ${checked.diagnostic ?? ''}`);
  return checked.definition;
}

describe('impact session saved as schema 6', () => {
  it('saves the original plane direction and gap in mm with velocities, stiffness and history, and no load or result', () => {
    const { fixture, session } = impactCase();
    const definition = savedImpact(session, fixture);
    if (definition.schema !== 'pointercad-standard-beam/6') throw new Error('Expected schema 6');
    expect(definition.impact.planes).toEqual([{ id: 'contact-1', nodeId: fixture.member.endNodeId, normal: [0, 0, 2], gapMm: 0.5 }]);
    expect(definition.impact.initialVelocities).toEqual([{ nodeId: fixture.member.endNodeId, velocityMPerS: [0, 0, -2] }]);
    expect(definition.impact.contactStiffnessNPerM).toBe(10000000);
    expect(definition.impact.history.timeStepS).toBeCloseTo(1e-5, 18);
    expect(definition.impact.history.stepCount).toBe(200);
    expect(definition.impact.history.outputEvery).toBe(2);
    expect(definition.impact.segmentsPerMember).toBe(session.segmentsPerMember);
    expect(definition.supports).toEqual([{ nodeId: fixture.member.startNodeId, restrained: [true, true, true, true, true, true] }]);
    for (const absent of ['referenceLoads', 'contact', 'transient', 'constraints', 'loads']) expect(definition).not.toHaveProperty(absent);
    expect(JSON.stringify(definition)).not.toMatch(/"(?:gapM|directionUnit|samples|contactPeaks|energyJ)"/u);
    // Material, section, member and source identity are the same as the unchanged contact form produces.
    const contact = beamDefinition(fixture.session, fixture.source, []);
    if (!contact.ok) throw new Error('Expected the contact form to stay valid');
    expect(definition.members).toEqual(contact.definition.members);
    expect(definition.materials).toEqual(contact.definition.materials);
    expect(definition.sections).toEqual(contact.definition.sections);
    expect(definition.source).toEqual(contact.definition.source);
  });

  it('round-trips through the real saved-input decoder and restores the editable impact text exactly', () => {
    const { fixture, session } = impactCase();
    const definition = savedImpact(session, fixture);
    const checked = readBeamAnalysisInputs(JSON.parse(JSON.stringify(attachment(definition))), fixture.source.document.id);
    if (!checked.ok) throw new Error(`${checked.issue.code}: ${checked.issue.path}`);
    const input = checked.value.analyses[0];
    if (input.kind !== 'standard-members') throw new Error('Expected a standard member definition');
    expect(input.definition).toEqual(definition);
    const restored = restoreBeamSession(fixture.session.ownerId, input.definition, [fixture.occurrence]);
    expect(restored.analysisType).toBe('impact');
    expect(restored.result).toBeNull();
    if (definition.schema !== 'pointercad-standard-beam/6') throw new Error('Expected schema 6');
    expect(restored.impact.velocities).toEqual([{ nodeId: fixture.member.endNodeId, velocity: ['0', '0', '-2'] }]);
    expect(restored.impact.contactStiffness).toBe('10000000');
    expect(restored.impact.stepCount).toBe('200');
    expect(restored.impact.outputEvery).toBe('2');
    // The saved time step comes back as plain exact decimal text of the same double (no exponent).
    expect(restored.impact.timeStep).not.toMatch(/e/iu);
    expect(Number(restored.impact.timeStep)).toBe(definition.impact.history.timeStepS);
    expect(restored.contact.rows).toEqual([{ id: 'contact-1', kind: 'node-plane', nodeIdA: fixture.member.endNodeId, nodeIdB: '',
      normal: ['0', '0', '2'], gap: '0.5' }]);
    // Restored members need the usual confirmation; afterwards the same definition is produced again.
    const confirmed = restored.members.reduce((current, member) =>
      editBeamSession(current, { kind: 'confirmed', id: member.id, confirmed: true }), restored);
    expect(savedImpact(confirmed, fixture)).toEqual({ ...definition, revision: confirmed.revision });
  });

  it('invalidates an accepted state on every impact edit and keeps the impact text across mode changes', () => {
    const { fixture, session } = impactCase();
    const reviewed: BeamSession = { ...session, status: 'complete', reviewed: fixture.source };
    for (const edit of [{ kind: 'impact-value', field: 'timeStep', source: '0.02ms' },
      { kind: 'impact-velocity', nodeId: fixture.member.endNodeId, axis: 0, source: '1' },
      { kind: 'impact-velocity-remove', nodeId: fixture.member.endNodeId }] satisfies readonly BeamEdit[]) {
      const next = editBeamSession(reviewed, edit);
      expect(next.status).toBe('editing');
      expect(next.reviewed).toBeNull();
      expect(next.result).toBeNull();
      expect(next.revision).toBe(reviewed.revision + 1);
    }
    const contactMode = editBeamSession(session, { kind: 'analysis-type', value: 'contact' });
    expect(contactMode.impact).toEqual(session.impact);
    const back = savedImpact(editBeamSession(contactMode, { kind: 'analysis-type', value: 'impact' }), fixture);
    expect(back.schema).toBe('pointercad-standard-beam/6');
  });

  it('refuses node pairs, entered loads, unselected nodes and malformed saved impact input', () => {
    const { fixture, session } = impactCase();
    const pair = editBeamSession(editBeamSession(session, { kind: 'contact-kind', index: 0, value: 'node-pair' }),
      { kind: 'contact-node', index: 0, end: 'b', nodeId: fixture.member.startNodeId });
    expect(beamDefinition(pair, fixture.source, [])).toMatchObject({ ok: false, key: 'beam.error.impactPairUnsupported' });
    const loaded = editBeamSession(session, { kind: 'value', id: fixture.member.id, field: 'endFz', source: '-1' });
    expect(beamDefinition(loaded, fixture.source, [])).toMatchObject({ ok: false, key: 'beam.error.model' });
    const elsewhere = editBeamSession(session, { kind: 'impact-velocity', nodeId: 'removed-node', axis: 2, source: '-1' });
    expect(beamDefinition(elsewhere, fixture.source, [])).toEqual({ ok: false, key: 'beam.error.contactNode',
      field: 'impact:velocity:removed-node:0', diagnostic: null });
    const definition = savedImpact(session, fixture);
    if (definition.schema !== 'pointercad-standard-beam/6') throw new Error('Expected schema 6');
    for (const malformed of [{ ...definition, impact: { ...definition.impact, planes: [] } },
      { ...definition, impact: { ...definition.impact, contactStiffnessNPerM: -1 } },
      { ...definition, schema: 'pointercad-standard-beam/5' }]) {
      expect(readBeamAnalysisInputs(attachment(malformed), fixture.source.document.id)).toMatchObject({ ok: false });
    }
  });

  it('restores an older contact definition exactly as before, with an empty impact draft', () => {
    const { fixture } = impactCase();
    const contact = beamDefinition(fixture.session, fixture.source, []);
    if (!contact.ok) throw new Error('Expected the contact form to stay valid');
    const restored = restoreBeamSession(fixture.session.ownerId, contact.definition, [fixture.occurrence]);
    expect(restored.analysisType).toBe('contact');
    expect(restored.impact).toEqual({ velocities: [], contactStiffness: '', timeStep: '', stepCount: '', outputEvery: '1' });
    expect(restored.members[0].startRestraints).toEqual([true, true, true, true, true, true]);
    expect(restored.members[0].values.endFz).toBe('-1');
  });
});
