import { beforeEach, describe, expect, it } from 'vitest';
import type { Parameter } from '@pointercad/model';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { beamDefinition, createBeamSession, editBeamSession, restoreBeamSession, type BeamSession } from './beamSession.js';
import { beamUiFixture } from './beam.testSupport.js';
import { readBeamField } from './beamFields.js';
import { beamSourceIsCurrent, captureBeamSource } from './beamSource.js';

beforeEach(resetTestStore);

describe('explicit beam inputs and source binding', () => {
  it('does not infer supports, material properties or confirmation from a fixed CAD occurrence', () => {
    const fixture = beamUiFixture();
    const session = editBeamSession(createBeamSession(fixture.state.activeDocumentId, 'new'),
      { kind: 'select', occurrence: fixture.occurrence, selected: true });
    expect(fixture.component.fixed).toBe(true);
    expect(session.members[0].fixedStart).toBe(false);
    expect(session.members[0].fixedEnd).toBe(false);
    expect(session.members[0].confirmed).toBe(false);
    expect(session.members[0].values.young).toBe('');
    expect(session.members[0].values.area).toBe('');
    expect(beamDefinition(session, fixture.source, []).ok).toBe(false);
  });

  it('converts explicit signed physical units and rejects wrong dimensions or invalid parameters', () => {
    for (const [name, source, expected] of [
      ['young', '208 GPa', 208000], ['endFx', '-2 kN', -2000], ['endMy', '3 N·m', 3000],
      ['area', '3 cm²', 300], ['iy', '2 cm⁴', 20000], ['cx', '20mm', 20], ['shearFactor', '5/6', 5 / 6],
    ] as const) expect(readBeamField(name, source, []).value?.value).toBeCloseTo(expected, 9);
    for (const source of ['', 'NaN', 'Infinity', '1mm', '1/0', '-1']) {
      expect(readBeamField('young', source, []).error).not.toBeNull();
    }
    expect(readBeamField('area', '2N', []).error).not.toBeNull();
    expect(readBeamField('endFx', '-2', []).error).toBeNull();
    expect(readBeamField('cx', '2cm', []).error).not.toBeNull();
    expect(readBeamField('cx', '1in', []).value?.value).toBeCloseTo(25.4, 9);
    const parameters: readonly Parameter[] = [{ name: '荷重', value: { source: '10', value: 10, display: '10' },
      unit: 'none', description: 'Explicit load parameter' }];
    const force = readBeamField('endFx', '荷重 N', parameters);
    expect(force.error).toBeNull();
    expect(force.value).toEqual({ source: '荷重 N', value: 10, display: '10' });
    expect(readBeamField('young', '荷重 MPa', [{ ...parameters[0], unit: 'mm' }]).error).not.toBeNull();
    expect(readBeamField('endFx', '荷重 N', [{ ...parameters[0],
      value: { source: '荷重', value: 10, display: '10' } }]).error).not.toBeNull();
  });

  it('restores input values without restoring results, confirmation or the old geometry trust', () => {
    const fixture = beamUiFixture();
    const checked = beamDefinition(fixture.session, fixture.source, []);
    expect(checked.ok).toBe(true);
    if (!checked.ok) throw new Error('Invalid explicit fixture');
    const restored = restoreBeamSession(fixture.state.activeDocumentId, checked.definition, [fixture.occurrence]);
    expect(restored.result).toBeNull();
    expect(restored.reviewed).toBeNull();
    expect(restored.status).toBe('editing');
    expect(restored.members[0].confirmed).toBe(false);
    expect(restored.members[0].values.young).toBe('208000');
    expect(restored.members[0].values.endFx).toBe('10');
    expect(restored.members[0].material).toEqual(fixture.session.members[0].material);
    expect(beamDefinition(restored, fixture.source, []).ok).toBe(false);
  });

  it('keeps restored sparse member identities unique on successive additions', () => {
    const fixture = beamUiFixture();
    let session: BeamSession = { ...fixture.session, nextMember: 2,
      members: [fixture.session.members[0], { ...fixture.session.members[0], id: 'beam-member-3',
        startNodeId: 'beam-member-3-start', endNodeId: 'beam-member-3-end',
        occurrence: { ...fixture.occurrence, path: ['third'] } }] };
    for (const path of ['second', 'fourth']) {
      session = editBeamSession(session, { kind: 'select', occurrence: { ...fixture.occurrence, path: [path] }, selected: true });
    }
    expect(session.members.map(member => member.id)).toEqual(['beam-member-1', 'beam-member-3', 'beam-member-2', 'beam-member-4']);
    expect(new Set(session.members.map(member => member.startNodeId)).size).toBe(4);
  });

  it('refuses stale publication, geometry revisions, active motion and failed recompute', () => {
    const fixture = beamUiFixture();
    expect(beamSourceIsCurrent(fixture.source, fixture.state)).toBe(true);
    for (const changed of [
      { documentVersion: 4 }, { completedGeneration: 8 }, { requestedGeneration: 8 }, { isComputing: true },
      { lastOutcome: 'failed' as const }, { timelineIndex: 0 }, { assemblyMotionPlaying: true },
      { activeDocumentId: 'other' }, { assemblyLibrary: { ...fixture.state.assemblyLibrary } },
    ]) expect(captureBeamSource({ ...fixture.state, ...changed })).toBeNull();
    fixture.current.publication = false;
    expect(beamSourceIsCurrent(fixture.source, fixture.state)).toBe(false);
  });
});
