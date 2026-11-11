import { beforeEach, describe, expect, it } from 'vitest';
import { createUndoStack } from '@pointercad/model';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { bucklingUiFixture } from './beamBuckling.testSupport.js';
import { beamDefinition, editBeamSession, restoreBeamSession, type BeamSession } from './beamSession.js';

beforeEach(resetTestStore);

describe('explicit CAD buckling form and saved inputs', () => {
  it('keeps six explicit global supports separate from CAD fixed flags and old static clamps', () => {
    const fixture = bucklingUiFixture(), member = fixture.session.members[0];
    const untouched = { ...fixture.session, members: [{ ...member, startRestraints: member.endRestraints }] };
    expect(member.fixedStart).toBe(true);
    expect(fixture.component.fixed).toBe(true);
    expect(beamDefinition(untouched, fixture.source, []).ok).toBe(false);
    const checked = beamDefinition(fixture.session, fixture.source, []);
    if (!checked.ok || checked.definition.schema !== 'pointercad-standard-beam/3') throw new Error('Expected valid schema3 form');
    expect(checked.definition.supports).toEqual([{ nodeId: member.startNodeId, restrained: [true, true, true, true, true, true] }]);
    expect(checked.definition.referenceLoads).toEqual([{ id: 'load-0', kind: 'nodal', nodeId: member.endNodeId,
      force: [0, 0, -1], moment: [0, 0, 0] }]);
    expect(checked.definition.buckling).toEqual({ modeCount: 2, segmentsPerMember: 4 });
    expect(checked.definition).not.toHaveProperty('constraints');
    expect(checked.definition).not.toHaveProperty('modal');
    const staticCheck = beamDefinition({ ...fixture.session, analysisType: 'static' }, fixture.source, []);
    if (!staticCheck.ok || staticCheck.definition.schema !== 'pointercad-standard-beam/1') throw new Error('Expected static form');
    expect(staticCheck.definition.constraints).toEqual([{ id: 'support-0', kind: 'fixed', nodeId: member.startNodeId }]);
  });

  it('allows pinned/roller component edits, invalidates review and retains expressions and other support directions', () => {
    const fixture = bucklingUiFixture(), id = fixture.session.members[0].id;
    let session: BeamSession = { ...fixture.session, reviewed: fixture.source };
    for (const axis of [3, 4, 5] as const) session = editBeamSession(session,
      { kind: 'buckling-support', id, end: 'start', axis, restrained: false });
    session = editBeamSession(session, { kind: 'buckling-support', id, end: 'end', axis: 1, restrained: true });
    expect(session.members[0].startRestraints).toEqual([true, true, true, false, false, false]);
    expect(session.members[0].endRestraints).toEqual([false, true, false, false, false, false]);
    expect(session.members[0].values).toEqual(fixture.session.members[0].values);
    expect(session.members[0].fixedStart).toBe(true);
    expect(session.reviewed).toBeNull();
    expect(session.revision).toBe(fixture.session.revision + 4);
    expect(fixture.session.members[0].startRestraints).toEqual([true, true, true, true, true, true]);
  });

  it('combines shared-node supports by component and shared loads once across save/restore', () => {
    const fixture = bucklingUiFixture(), member = fixture.session.members[0];
    const shared = { ...member, id: 'other-member', startNodeId: member.endNodeId, endNodeId: 'other-end',
      occurrence: { ...member.occurrence, path: ['other-occurrence'], label: 'Other member' },
      startRestraints: [false, true, false, false, false, false] as const,
      values: { ...member.values, startFz: '-2', endFz: '0' } };
    const session = { ...fixture.session, members: [{ ...member,
      endRestraints: [false, false, true, false, false, false] as const }, shared] };
    const checked = beamDefinition(session, fixture.source, []);
    if (!checked.ok || checked.definition.schema !== 'pointercad-standard-beam/3') throw new Error('Expected valid shared-node form');
    expect(checked.definition.supports.find(row => row.nodeId === member.endNodeId)?.restrained)
      .toEqual([false, true, true, false, false, false]);
    expect(checked.definition.referenceLoads).toEqual([{ id: 'load-0', kind: 'nodal', nodeId: member.endNodeId,
      force: [0, 0, -3], moment: [0, 0, 0] }]);
    const restored = restoreBeamSession(session.ownerId, checked.definition, [fixture.occurrence]);
    const reconfirmed = { ...restored, members: restored.members.map(row => ({ ...row, confirmed: true })) };
    const again = beamDefinition(reconfirmed, fixture.source, []);
    if (!again.ok || again.definition.schema !== 'pointercad-standard-beam/3') throw new Error('Expected restored form');
    expect(again.definition.referenceLoads).toEqual(checked.definition.referenceLoads);
    expect(again.definition.supports).toEqual(checked.definition.supports);
  });

  it('uses existing undo/document persistence and reopens buckling inputs without trust or results', () => {
    const fixture = bucklingUiFixture();
    useAppStore.setState({ ...fixture.state,
      assemblyUndoStack: createUndoStack({ document: fixture.source.document, library: fixture.source.library }),
      beamSession: { ...fixture.session, reviewed: fixture.source } });
    const before = useAppStore.getState();
    if (before.assemblyUndoStack === null) throw new Error('Expected initialized assembly history');
    useAppStore.getState().applyBeamInputs();
    const saved = useAppStore.getState().assembly?.beamAnalysisInputs?.analyses[0];
    if (saved?.kind !== 'standard-members' || saved.definition.schema !== 'pointercad-standard-beam/3') throw new Error('Missing saved buckling inputs');
    expect(saved.definition.buckling).toEqual({ modeCount: 2, segmentsPerMember: 4 });
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(before.assemblyUndoStack.past.length + 1);
    expect(useAppStore.getState().assemblyUndoStack?.past[0].document).toBe(before.assembly);
    useAppStore.getState().openBeam();
    const restored = useAppStore.getState().beamSession;
    expect(restored?.analysisType).toBe('buckling');
    expect(restored?.modeCount).toBe(2);
    expect(restored?.segmentsPerMember).toBe(4);
    expect(restored?.reviewed).toBeNull();
    expect(restored?.result).toBeNull();
    expect(restored?.bucklingEdges).toEqual([]);
    expect(restored?.members[0].confirmed).toBe(false);
    expect(restored?.members[0].startRestraints).toEqual([true, true, true, true, true, true]);
  });

  it('refuses invalid mesh/mode settings and all-zero reference loads before a run', () => {
    const fixture = bucklingUiFixture();
    for (const change of [{ modeCount: 0 }, { modeCount: 25 }, { segmentsPerMember: 0 }, { segmentsPerMember: 33 }]) {
      expect(beamDefinition({ ...fixture.session, ...change }, fixture.source, []).ok).toBe(false);
    }
    const zero = { ...fixture.session, members: fixture.session.members.map(member => ({ ...member,
      values: { ...member.values, endFz: '0' } })) };
    expect(beamDefinition(zero, fixture.source, []).ok).toBe(false);
  });
});
