import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber } from '@pointercad/expression';
import { commitBoltedJointSet, previewBoltedJointSet } from './boltedJointSetCommand.js';
import { planBoltedJointSet } from './planBoltedJointSet.js';
import { entryFixture } from './entryFastening.testSupport.js';
import type { EntryHoleSelection } from './holeEntryTypes.js';
import type { BoltedJointSetPicks, BoltedJointSetRequest } from './boltedJointSetTypes.js';

const PLAIN = entryFixture();

function selection(first: boolean, x = 0): EntryHoleSelection {
  return { ...(first ? PLAIN.request.first : PLAIN.request.second), axisOrigin: [x, 0, 0] };
}

function request(): BoltedJointSetRequest {
  return { first: PLAIN.firstSelections,
    second: PLAIN.secondSelections, choices: PLAIN.request };
}

function picks(): BoltedJointSetPicks {
  return { first: PLAIN.firstPicks, second: PLAIN.secondPicks,
    choices: PLAIN.request };
}

describe('all-or-nothing bolted joint sets', () => {
  it('plans four holes in one feature without mutating the document or choices', () => {
    const document = PLAIN.context.document, input = request();
    const before = JSON.stringify([document, input]);
    const result = planBoltedJointSet(document, input, PLAIN.context.partRevisions);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.joints.map(j => j.joint.boltLength)).toEqual([40, 40, 40, 40]);
    expect(JSON.stringify([document, input])).toBe(before);
  });
  it('reports count mismatch and returns no partial plan', () => {
    expect(planBoltedJointSet(PLAIN.context.document, { ...request(), second: [] }, PLAIN.context.partRevisions))
      .toMatchObject({ ok: false, rejections: [{ code: 'holeCountMismatch', detail: { first: 4, second: 0 } }] });
  });
  it('keeps the first alignment and reports every non-coaxial remaining hole', () => {
    const input = request();
    const bad = { ...input, second: [selection(false, 0), selection(false, 26),
      selection(false, 52), selection(false, 75)] };
    const result = planBoltedJointSet(PLAIN.context.document, bad, PLAIN.context.partRevisions);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.holes.map(h => h.index)).toEqual([1, 2]);
    for (const failure of result.holes) expect(failure.rejections.map(r => r.code)).toContain('axesNotCoaxial');
    expect(result).not.toHaveProperty('plan');
  });
  it('returns one document with four ordinary records, after moving the second plate only once', () => {
    const context = entryFixture(undefined, false, 100).context, input = picks(), before = JSON.stringify(context.document);
    const preview = previewBoltedJointSet(context, input);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const committed = commitBoltedJointSet(context, input, preview.plan);
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.document.components).toHaveLength(10);
    expect(committed.document.boltedJoints).toHaveLength(4);
    expect(new Set(committed.componentIds.flat()).size).toBe(8);
    expect(committed.document.components[1]?.placement.position.map(v => v.value)).toEqual([0, 0, 0]);
    expect(new Set(committed.document.components.map(c => c.rigidGroupId)).size).toBe(1);
    expect(JSON.stringify(context.document)).toBe(before);
    expect(committed.document.boltedJoints?.map(r => r.first.holeFace.index)).toEqual([0, 1, 2, 3]);
    expect(committed.document.boltedJoints?.map(r => r.componentIds)).toEqual(committed.componentIds);
    for (const record of committed.document.boltedJoints ?? []) {
      expect(Object.keys(record).sort()).toEqual(['choices', 'componentIds', 'first', 'id', 'second']);
    }
  });
  it('returns the original document if a late pair is changed after preview', () => {
    const context = entryFixture().context, input = picks(), preview = previewBoltedJointSet(context, input);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const changed = { ...input, second: input.second.map((pick, i) => i === 3 ? PLAIN.unpairedSecondPick : pick) };
    const result = commitBoltedJointSet(context, changed, preview.plan);
    expect(result.ok).toBe(false);
    expect(result.document).toBe(context.document);
    expect(result.document.boltedJoints).toBeUndefined();
  });
  it('collects both missing faces instead of stopping at the first failed pair', () => {
    const context = entryFixture().context;
    const missing = { ...context, resolveFace: (...args: Parameters<typeof context.resolveFace>) =>
      args[1].index === 1 || args[1].index === 3 ? { status: 'missing' as const } : context.resolveFace(...args) };
    const result = previewBoltedJointSet(missing, picks());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.holes.map(h => h.index)).toEqual([1, 3]);
  });
  it('rejects repeated holes and empty sets', () => {
    const input = request();
    const duplicated = { ...input, first: [selection(true), selection(true)],
      second: [selection(false), selection(false)] };
    expect(planBoltedJointSet(PLAIN.context.document, duplicated, PLAIN.context.partRevisions)).toMatchObject({ ok: false,
      holes: [{ index: 1, rejections: [{ code: 'unsupportedHole' }, { code: 'unsupportedHole' }] }] });
    expect(planBoltedJointSet(PLAIN.context.document, { ...input, first: [], second: [] }, PLAIN.context.partRevisions))
      .toMatchObject({ ok: false, rejections: [{ code: 'holeCountMismatch' }] });
  });
  it('collects entry failures at both invalid indices', () => {
    const input = request();
    const first = input.first.map((selection, index) => index === 1 || index === 3 ? { ...selection,
      entry: { kind: 'counterbore' as const, diameter: 12, depth: 8, side: 'outer' as const } } : selection);
    const result = planBoltedJointSet(PLAIN.context.document, { ...input, first }, PLAIN.context.partRevisions);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.holes.map(h => [h.index, h.entryRejections[0]?.code])).toEqual([[1, 'counterboreTooSmall'], [3, 'counterboreTooSmall']]);
  });
  it('rejects every pair affected by a conflicting constraint without inserting anything', () => {
    const context = entryFixture().context, input = picks();
    const mate = { id: 'mate', name: 'distance', kind: 'distance' as const, suppressed: false, flipped: false,
      value: expressionValueFromNumber(10), a: { kind: 'origin' as const, componentId: 'component-1', element: 'xy' as const },
      b: { kind: 'origin' as const, componentId: 'component-2', element: 'xy' as const } };
    const constrained = { ...context, document: { ...context.document, mates: [mate] } };
    const result = previewBoltedJointSet(constrained, input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.holes.map(h => h.index)).toEqual([0, 1, 2, 3]);
    for (const failure of result.holes) expect(failure.rejections.map(r => r.code)).toContain('existingConstraintConflict');
    expect(constrained.document.components).toHaveLength(2);
  });
});
