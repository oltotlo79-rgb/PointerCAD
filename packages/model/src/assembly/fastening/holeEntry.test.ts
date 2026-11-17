import { expressionValueFromNumber as value } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { bindHoleSelection } from './bindHoleSelection.js';
import { fastenerHeadForEntry } from './holeEntry.js';
import { planEntryBoltedJoint } from './planEntryBoltedJoint.js';
import { entryFixture } from './entryFastening.testSupport.js';
import type { FasteningHoleEntry } from './holeEntryTypes.js';

const BORE: FasteningHoleEntry = { kind: 'counterbore', diameter: 14, depth: 8, side: 'outer' };
const SINK: FasteningHoleEntry = { kind: 'countersink', diameter: 17.92, angle: 90, depth: 4.46, side: 'outer' };
const PLAIN = entryFixture();

function plan(entry: FasteningHoleEntry) {
  const request = PLAIN.request;
  return planEntryBoltedJoint(PLAIN.context.document, { ...request, first: { ...request.first, entry } }, PLAIN.context.partRevisions);
}

describe('hole entry and head selection', () => {
  it('derives all three head kinds without changing a saved record', () => {
    expect([fastenerHeadForEntry(), fastenerHeadForEntry(BORE), fastenerHeadForEntry(SINK)])
      .toEqual(['hex', 'socket', 'countersunk']);
  });
  it.each([false, true])('binds the full thickness and entry side (mating=%s)', far => {
    const context = entryFixture({ kind: 'counterbore', diameter: value(14), depth: value(8) }, far).context;
    const before = JSON.stringify(context.document);
    expect(bindHoleSelection(context, PLAIN.firstPick)).toMatchObject({ hole: { length: 20 },
      entry: { ...BORE, side: far ? 'mating' : 'outer' }, axisOrigin: [0, 0, 0], axisDirection: [0, 0, -1] });
    expect(JSON.stringify(context.document)).toBe(before);
  });
  it('binds the countersink angle and derived recess depth', () => {
    const context = entryFixture({ kind: 'countersink', diameter: value(17.92), angle: value(90) }).context;
    expect(bindHoleSelection(context, PLAIN.firstPick)).toMatchObject({ hole: { length: 20 },
      entry: { kind: 'countersink', diameter: 17.92, angle: 90, side: 'outer' } });
  });
  it('seats a socket head on the counterbore floor and selects length from that seat', () => {
    const result = plan(BORE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.headKind).toBe('socket');
    expect([result.plan.joint.gripLength, result.plan.joint.boltLength, result.plan.joint.protrusion]).toEqual([24, 35, 4.5]);
    expect(result.plan.bolt?.placement.position.map(v => v.value)).toEqual([0, 0, -20]);
    expect(result.plan.bolt?.source.options).toEqual({ family: 'socket-head-cap-screw', item: 'M8', length: '35' });
  });
  it('uses the countersunk total length, with its head top flush and its tip beyond the nut', () => {
    const result = plan(SINK);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.headKind).toBe('countersunk');
    // The cone meets the 9 mm bore at depth (17.92 - 9) / 2 = 4.46, before the shaft root at 4.96.
    expect(result.plan.joint.gripLength).toBeCloseTo(27.54, 9);
    expect(result.plan.joint.boltLength).toBe(40);
    expect(result.plan.joint.protrusion).toBeCloseTo(1.5, 9);
    expect(result.plan.bolt?.placement.position.map(v => v.value)).toEqual([0, 0, -20]);
  });
  it.each<readonly [FasteningHoleEntry, string]>([
    [{ ...BORE, diameter: 13 }, 'counterboreTooSmall'], [{ ...BORE, depth: 7.9 }, 'counterboreTooSmall'],
    [{ ...SINK, angle: 100 }, 'countersinkMismatch'], [{ ...SINK, diameter: 18 }, 'countersinkMismatch'],
    [{ ...BORE, side: 'mating' }, 'entryOnFarSide'],
  ])('rejects incompatible entry %j as %s', (entry, code) => {
    expect(plan(entry)).toMatchObject({ ok: false, entryRejections: [{ code }] });
  });
  it('rejects an entry on the nut side', () => {
    const request = PLAIN.request;
    expect(planEntryBoltedJoint(PLAIN.context.document, { ...request, second: { ...request.second, entry: BORE } }, PLAIN.context.partRevisions))
      .toMatchObject({ ok: false, entryRejections: [{ code: 'entryOnFarSide' }] });
  });
  it('rejects a countersink depth that disagrees with its diameter and angle', () => {
    expect(plan({ ...SINK, depth: 3 })).toMatchObject({ ok: false, rejections: [{ code: 'invalidDimension' }] });
  });
});
