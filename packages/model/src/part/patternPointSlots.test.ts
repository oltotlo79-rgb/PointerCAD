import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument } from './createPartDocument.js';
import { allocatePatternPointSlots, patternSlotHighWater, readPatternSlotHighWater, retainPatternSlotHighWater } from './patternPointSlots.js';

describe('persisted point-pattern slots', () => {
  it('preserves identity through reorder and reference editing', () => {
    const initial = allocatePatternPointSlots([{ kind: 'origin' }, { kind: 'origin' }]);
    const first = initial.points[0];
    const second = initial.points[1];
    const reordered = allocatePatternPointSlots([
      second, { ...first, reference: { kind: 'point', pointId: 'different-source' } },
    ], initial);
    expect(reordered.points.map((point) => point.slotId)).toEqual(['slot-2', 'slot-1']);
    expect(reordered.nextSlotSerial).toBe(3);
  });

  it('does not reuse deleted slots and refuses explicit resurrection', () => {
    const initial = allocatePatternPointSlots([{ kind: 'origin' }, { kind: 'origin' }]);
    const deleted = allocatePatternPointSlots([initial.points[1]], initial);
    const appended = allocatePatternPointSlots([...deleted.points, { kind: 'origin' }], deleted);
    expect(appended.points.map((point) => point.slotId)).toEqual(['slot-2', 'slot-3']);
    expect(() => allocatePatternPointSlots([...deleted.points, initial.points[0]], deleted)).toThrow();
  });

  it('retains high-water mark across save/read and rejects duplicated identities', () => {
    const initial = allocatePatternPointSlots([{ kind: 'origin' }, { kind: 'origin' }]);
    const deleted = allocatePatternPointSlots([], initial);
    const reopened = allocatePatternPointSlots(deleted.points, undefined, deleted.nextSlotSerial);
    expect(allocatePatternPointSlots([{ kind: 'origin' }], reopened).points[0]?.slotId).toBe('slot-3');
    expect(() => allocatePatternPointSlots([initial.points[0], initial.points[0]])).toThrow();
  });
});

describe('document-owned point-slot issuance', () => {
  it('retains deleted-feature issuance through undo restoration and a new branch', () => {
    const empty = createEmptyPartDocument();
    const issued = { ...empty, patternSlotHighWater: { pattern: 4 } };
    const undone = retainPatternSlotHighWater(empty, issued);
    expect(undone.solids).toEqual([]);
    expect(patternSlotHighWater(undone, 'pattern')).toBe(4);
    const replacement = allocatePatternPointSlots([{ kind: 'point', pointId: 'new-source' }],
      undefined, undefined, patternSlotHighWater(undone, 'pattern'));
    expect(replacement.points.map((slot) => slot.slotId)).toEqual(['slot-4']);
    expect(() => allocatePatternPointSlots([{ slotId: 'slot-1', reference: { kind: 'origin' } }],
      undefined, undefined, patternSlotHighWater(undone, 'pattern'))).toThrow();
  });

  it('preserves a currently restored slot while allocating above future issued identities', () => {
    const previous = allocatePatternPointSlots([{ kind: 'origin' }]);
    const next = allocatePatternPointSlots([...previous.points, { kind: 'origin' }], previous,
      undefined, 7);
    expect(next.points.map((slot) => slot.slotId)).toEqual(['slot-1', 'slot-7']);
    expect(next.nextSlotSerial).toBe(8);
  });

  it('strictly reads a deleted-feature ledger independently of current placements', () => {
    expect(readPatternSlotHighWater(JSON.parse('{"removed":9}'))).toEqual({ removed: 9 });
    for (const value of [null, [], { removed: 0 }, { removed: 1.5 }, { removed: '9' }]) {
      expect(() => readPatternSlotHighWater(value)).toThrow();
    }
  });
});
