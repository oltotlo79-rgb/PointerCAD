import { MAX_BEAM_CONTACTS, MAX_CONTACT_LOAD_FACTORS } from '@pointercad/fem';
import { createUndoStack } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { bucklingUiFixture } from './beamBuckling.testSupport.js';
import { contactUiFixture } from './beamContact.testSupport.js';
import { beamContactNodes, beamDefinition, editBeamSession, restoreBeamSession, type BeamEdit,
  type BeamSession } from './beamSession.js';

beforeEach(resetTestStore);

describe('explicit CAD contact form and saved inputs', () => {
  it('builds saved schema 5 with explicit supports, reference loads, mesh refinement, the contact in mm and the factors', () => {
    const fixture = contactUiFixture();
    const checked = beamDefinition(fixture.session, fixture.source, []);
    if (!checked.ok || checked.definition.schema !== 'pointercad-standard-beam/5') throw new Error('Expected valid schema5 form');
    expect(checked.definition.contact).toEqual({ segmentsPerMember: 4, loadFactors: [1, -1], contacts: [
      { kind: 'node-plane', id: 'contact-1', nodeId: fixture.member.endNodeId, normal: [0, 0, 1], gapMm: 0.5 }] });
    expect(checked.definition.supports).toEqual([{ nodeId: fixture.member.startNodeId, restrained: [true, true, true, true, true, true] }]);
    expect(checked.definition.referenceLoads).toEqual([{ id: 'load-0', kind: 'nodal', nodeId: fixture.member.endNodeId,
      force: [0, 0, -1], moment: [0, 0, 0] }]);
    for (const absent of ['constraints', 'modal', 'buckling', 'transient', 'loads']) expect(checked.definition).not.toHaveProperty(absent);
  });

  it('offers only the selected members\' end nodes, each once', () => {
    const fixture = contactUiFixture();
    expect(beamContactNodes(fixture.session)).toEqual([
      { nodeId: fixture.member.startNodeId, label: fixture.occurrence.label, end: 'start' },
      { nodeId: fixture.member.endNodeId, label: fixture.occurrence.label, end: 'end' }]);
    const shared = editBeamSession(fixture.session, { kind: 'connection', id: fixture.member.id, end: 'end',
      nodeId: fixture.member.startNodeId });
    expect(beamContactNodes(shared).map(node => node.nodeId)).toEqual([fixture.member.startNodeId]);
  });

  it('reports the exact contact field and refuses missing, stale or invalid inputs instead of dropping them', () => {
    const fixture = contactUiFixture();
    const at = (...edits: readonly BeamEdit[]) => beamDefinition(edits.reduce(editBeamSession, fixture.session), fixture.source, []);
    for (const [edits, key, field] of [
      [[{ kind: 'contact-value', index: 0, field: 'gap', source: '-0.5' }], 'beam.error.contactGap', 'contact:contact-1:gap'],
      [[{ kind: 'contact-value', index: 0, field: 'gap', source: '' }], 'beam.error.inputs', 'contact:contact-1:gap'],
      [[{ kind: 'contact-value', index: 0, field: 'normalX', source: 'x' }], 'beam.error.inputs', 'contact:contact-1:normalX'],
      [[{ kind: 'contact-factor', index: 1, source: '' }], 'beam.error.inputs', 'contact:factor:1'],
      [[{ kind: 'contact-node', index: 0, end: 'a', nodeId: '' }], 'beam.error.contactNode', 'contact:contact-1:nodeA'],
      // A node of a member that is no longer selected (for example restored from an older save) is refused, not dropped.
      [[{ kind: 'contact-node', index: 0, end: 'a', nodeId: 'beam-member-9-end' }], 'beam.error.contactNode', 'contact:contact-1:nodeA'],
      [[{ kind: 'contact-kind', index: 0, value: 'node-pair' }], 'beam.error.contactNode', 'contact:contact-1:nodeB'],
      [[{ kind: 'contact-remove', index: 0 }], 'beam.error.contacts', 'contact:add'],
    ] as const) {
      const checked = at(...edits);
      expect(checked.ok, JSON.stringify(edits)).toBe(false);
      if (!checked.ok) expect([checked.key, checked.field]).toEqual([key, field]);
    }
    for (const [edits, code] of [
      [[{ kind: 'contact-value', index: 0, field: 'normalZ', source: '0' }], 'contact-normal'],
      [[{ kind: 'contact-kind', index: 0, value: 'node-pair' },
        { kind: 'contact-node', index: 0, end: 'b', nodeId: fixture.member.endNodeId }], 'contact-self'],
    ] as const) {
      const checked = at(...edits);
      expect(checked.ok, JSON.stringify(edits)).toBe(false);
      if (!checked.ok) {
        expect(checked.key).toBe('beam.error.model');
        expect(checked.diagnostic).toContain(code);
      }
    }
  });

  it('restores schema 5 exactly, and older schemas restore with an empty contact form', () => {
    const fixture = contactUiFixture();
    const checked = beamDefinition(fixture.session, fixture.source, []);
    if (!checked.ok || checked.definition.schema !== 'pointercad-standard-beam/5') throw new Error('Expected valid schema5 form');
    const restored = restoreBeamSession(fixture.session.ownerId, checked.definition, [fixture.occurrence]);
    expect([restored.analysisType, restored.segmentsPerMember, restored.result, restored.reviewed])
      .toEqual(['contact', 4, null, null]);
    expect(restored.members[0].confirmed).toBe(false);
    expect(restored.members[0].startRestraints).toEqual([true, true, true, true, true, true]);
    expect(restored.contact).toEqual({ nextContact: 2, loadFactors: ['1', '-1'], rows: [{ id: 'contact-1', kind: 'node-plane',
      nodeIdA: fixture.member.endNodeId, nodeIdB: '', normal: ['0', '0', '1'], gap: '0.5' }] });
    const again = beamDefinition({ ...restored, members: restored.members.map(row => ({ ...row, confirmed: true })) },
      fixture.source, []);
    if (!again.ok || again.definition.schema !== 'pointercad-standard-beam/5') throw new Error('Expected restored schema5 form');
    expect(again.definition.contact).toEqual(checked.definition.contact);
    expect(again.definition.supports).toEqual(checked.definition.supports);
    expect(again.definition.referenceLoads).toEqual(checked.definition.referenceLoads);

    const buckling = bucklingUiFixture();
    const old = beamDefinition(buckling.session, buckling.source, []);
    if (!old.ok || old.definition.schema !== 'pointercad-standard-beam/3') throw new Error('Expected valid schema3 form');
    const oldRestored = restoreBeamSession(buckling.session.ownerId, old.definition, [buckling.occurrence]);
    expect(oldRestored.analysisType).toBe('buckling');
    // No contact, direction, gap or factor is invented for an older schema.
    expect(oldRestored.contact).toEqual({ nextContact: 1, rows: [], loadFactors: [''] });
  });

  it('never reuses a contact id, bounds the rows and factors, and keeps the keyboard position on the new row', () => {
    const fixture = contactUiFixture();
    let session = editBeamSession(fixture.session, { kind: 'contact-add' });
    expect(session.focusedField).toBe('contact:contact-2:normalX');
    session = editBeamSession(session, { kind: 'contact-remove', index: 0 });
    session = editBeamSession(session, { kind: 'contact-add' });
    expect(session.contact.rows.map(row => row.id)).toEqual(['contact-2', 'contact-3']);
    for (let count = session.contact.rows.length; count < MAX_BEAM_CONTACTS + 2; count += 1) {
      session = editBeamSession(session, { kind: 'contact-add' });
    }
    expect(session.contact.rows).toHaveLength(MAX_BEAM_CONTACTS);
    expect(new Set(session.contact.rows.map(row => row.id)).size).toBe(MAX_BEAM_CONTACTS);
    expect(editBeamSession(session, { kind: 'contact-factor-add' }).focusedField).toBe('contact:factor:2');
    for (let count = session.contact.loadFactors.length; count < MAX_CONTACT_LOAD_FACTORS + 2; count += 1) {
      session = editBeamSession(session, { kind: 'contact-factor-add' });
    }
    expect(session.contact.loadFactors).toHaveLength(MAX_CONTACT_LOAD_FACTORS);
    const single = { ...fixture.session, contact: { ...fixture.session.contact, loadFactors: ['1'] } };
    expect(editBeamSession(single, { kind: 'contact-factor-remove', index: 0 })).toBe(single);
    const plane = editBeamSession(editBeamSession(fixture.session, { kind: 'contact-kind', index: 0, value: 'node-pair' }),
      { kind: 'contact-node', index: 0, end: 'b', nodeId: fixture.member.startNodeId });
    expect(editBeamSession(plane, { kind: 'contact-kind', index: 0, value: 'node-plane' }).contact.rows[0].nodeIdB).toBe('');
  });

  it('invalidates the review and cancels a run on contact edits, but not on the view-only state choice', () => {
    const fixture = contactUiFixture();
    const reviewed: BeamSession = { ...fixture.session, reviewed: fixture.source, status: 'complete' };
    const viewed = editBeamSession(reviewed, { kind: 'contact-view', state: 1 });
    expect(viewed.contactView).toEqual({ state: 1 });
    expect([viewed.revision, viewed.reviewed, viewed.status]).toEqual([reviewed.revision, fixture.source, 'complete']);
    const edited = editBeamSession(viewed, { kind: 'contact-value', index: 0, field: 'gap', source: '0.25' });
    expect([edited.revision, edited.reviewed, edited.result, edited.contactView])
      .toEqual([reviewed.revision + 1, null, null, { state: 0 }]);
    let cancelled = 0;
    useAppStore.setState({ beamSession: reviewed, beamRunner: { run: () => undefined, cancel: () => { cancelled += 1; } } });
    useAppStore.getState().editBeam({ kind: 'contact-view', state: 1 });
    expect(cancelled).toBe(0);
    for (const edit of [{ kind: 'contact-value', index: 0, field: 'gap', source: '0.25' }, { kind: 'contact-add' },
      { kind: 'contact-factor', index: 0, source: '2' }, { kind: 'contact-kind', index: 0, value: 'node-pair' }] as const) {
      const before = cancelled;
      useAppStore.getState().editBeam(edit);
      expect(cancelled, edit.kind).toBe(before + 1);
    }
  });

  it('saves through the existing assembly undo history and reopens without trust or results', () => {
    const fixture = contactUiFixture();
    useAppStore.setState({ ...fixture.state,
      assemblyUndoStack: createUndoStack({ document: fixture.source.document, library: fixture.source.library }),
      beamSession: { ...fixture.session, reviewed: fixture.source } });
    const before = useAppStore.getState();
    if (before.assemblyUndoStack === null) throw new Error('Expected initialized assembly history');
    useAppStore.getState().applyBeamInputs();
    const saved = useAppStore.getState().assembly?.beamAnalysisInputs?.analyses[0];
    if (saved?.kind !== 'standard-members' || saved.definition.schema !== 'pointercad-standard-beam/5') {
      throw new Error('Missing saved contact inputs');
    }
    expect(saved.definition.contact.contacts[0].gapMm).toBe(0.5);
    expect(JSON.stringify(saved)).not.toMatch(/"(?:gapM|states|nodes|result|normalReactionN|contactView)"/u);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(before.assemblyUndoStack.past.length + 1);
    expect(useAppStore.getState().assemblyUndoStack?.past[0].document).toBe(before.assembly);
    useAppStore.getState().openBeam();
    const restored = useAppStore.getState().beamSession;
    expect(restored?.analysisType).toBe('contact');
    expect(restored?.reviewed).toBeNull();
    expect(restored?.result).toBeNull();
    expect(restored?.contact.rows.map(row => [row.id, row.nodeIdA, row.gap])).toEqual([['contact-1', fixture.member.endNodeId, '0.5']]);
    expect(restored?.contact.loadFactors).toEqual(['1', '-1']);
  });
});
