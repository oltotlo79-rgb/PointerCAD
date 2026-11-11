import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { contactUiFixture } from './beamContact.testSupport.js';
import { impactSettingsFromDraft, type ImpactDraft } from './beamImpactDraft.js';
import type { ContactDraft } from './beamSession.js';

beforeEach(resetTestStore);

function impactCase() {
  const fixture = contactUiFixture();
  const draft: ImpactDraft = { velocities: [{ nodeId: fixture.member.endNodeId, velocity: ['0', '0', '-2'] }],
    contactStiffness: '10000000', timeStep: '0.01ms', stepCount: '200', outputEvery: '2' };
  return { fixture, draft, contact: fixture.session.contact };
}

describe('beam impact settings from the existing fixed-plane contact rows', () => {
  it('converts mm gaps, ms steps and the entered velocity into the impact contract units', () => {
    const { fixture, draft, contact } = impactCase();
    const checked = impactSettingsFromDraft(draft, contact, []);
    if (!checked.ok) throw new Error(`Expected valid impact settings: ${checked.key} ${checked.field}`);
    expect(checked.settings.initialVelocities).toEqual([{ nodeId: fixture.member.endNodeId, velocityMPerS: [0, 0, -2] }]);
    expect(checked.settings.contacts).toHaveLength(1);
    expect(checked.settings.contacts[0].nodeId).toBe(fixture.member.endNodeId);
    expect(checked.settings.contacts[0].directionUnit).toEqual([0, 0, 1]);
    expect(checked.settings.contacts[0].gapM).toBeCloseTo(0.0005, 15);
    expect(checked.settings.contactStiffnessNPerM).toBe(10000000);
    // The shared expression grammar accepts powers, not scientific-notation text.
    expect(impactSettingsFromDraft({ ...draft, contactStiffness: '10^7' }, contact, [])).toEqual(checked);
    expect(impactSettingsFromDraft({ ...draft, contactStiffness: '1e7' }, contact, []))
      .toEqual({ ok: false, key: 'beam.error.expression', field: 'impact:contactStiffness' });
    expect(checked.settings.history.timeStepS).toBeCloseTo(1e-5, 18);
    expect(checked.settings.history.stepCount).toBe(200);
    expect(checked.settings.history.outputEvery).toBe(2);
  });

  it('normalizes the entered plane direction to the unit vector required by the impact input', () => {
    const { draft, contact } = impactCase();
    const tilted: ContactDraft = { ...contact, rows: contact.rows.map(row => ({ ...row, normal: ['0', '3', '4'] as const })) };
    const checked = impactSettingsFromDraft(draft, tilted, []);
    if (!checked.ok) throw new Error('Expected valid impact settings');
    const [x, y, z] = checked.settings.contacts[0].directionUnit;
    expect(x).toBe(0);
    expect(y).toBeCloseTo(0.6, 15);
    expect(z).toBeCloseTo(0.8, 15);
    expect(Math.abs(Math.hypot(x, y, z) - 1)).toBeLessThanOrEqual(1e-12);
  });

  it('reports the exact field and refuses invalid or unsupported inputs instead of dropping them', () => {
    const { fixture, draft, contact } = impactCase();
    const row = contact.rows[0];
    const cases: readonly (readonly [ImpactDraft, ContactDraft, string, string])[] = [
      [{ ...draft, velocities: [{ nodeId: fixture.member.endNodeId, velocity: ['0', '0', '0'] }] }, contact,
        'beam.error.impactVelocity', 'impact:velocity'],
      [{ ...draft, velocities: [] }, contact, 'beam.error.impactVelocity', 'impact:velocity'],
      [{ ...draft, velocities: [{ nodeId: fixture.member.endNodeId, velocity: ['0', '0', '2 mm'] }] }, contact,
        'beam.error.expression', `impact:velocity:${fixture.member.endNodeId}:2`],
      [draft, { ...contact, rows: [{ ...row, kind: 'node-pair', nodeIdB: fixture.member.startNodeId }] },
        'beam.error.impactPairUnsupported', `contact:${row.id}`],
      [draft, { ...contact, rows: [] }, 'beam.error.impactContacts', 'impact:contacts'],
      [draft, { ...contact, rows: [{ ...row, normal: ['0', '0', '0'] }] }, 'beam.error.impactDirection', `contact:${row.id}:normalX`],
      [draft, { ...contact, rows: [{ ...row, gap: '-1' }] }, 'beam.error.contactGap', `contact:${row.id}:gap`],
      [{ ...draft, contactStiffness: '0' }, contact, 'beam.error.range', 'impact:contactStiffness'],
      [{ ...draft, contactStiffness: '' }, contact, 'beam.error.expression', 'impact:contactStiffness'],
      [{ ...draft, timeStep: '0' }, contact, 'beam.error.expression', 'impact:timeStep'],
      [{ ...draft, stepCount: '1.5' }, contact, 'beam.error.range', 'impact:stepCount'],
      [{ ...draft, outputEvery: '0' }, contact, 'beam.error.expression', 'impact:outputEvery'],
    ];
    for (const [input, contactInput, key, field] of cases) {
      expect(impactSettingsFromDraft(input, contactInput, [])).toEqual({ ok: false, key, field });
    }
  });
});
