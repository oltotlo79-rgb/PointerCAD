import { expressionValueFromNumber } from '@pointercad/expression';
import { appendSolid, createEmptyPartDocument, type PartDocument } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { extrudeOperationSelection, extrudeTargetCandidates } from './extrudeOperation.js';
function fixture(): PartDocument {
  const base = createEmptyPartDocument();
  const feature = { id: 'body-a', name: 'A', kind: 'extrude' as const, suppressed: false,
    profile: { sketchId: base.activeSketchId, faceFeatureId: 'face' },
    distance: expressionValueFromNumber(10), reversed: false, symmetric: false };
  return appendSolid(appendSolid(base, feature), { ...feature, id: 'body-b', name: 'B' });
}

describe('extrude operation target validation', () => {
  it('lists only live bodies in history order with explicit IDs and names', () => {
    const document = fixture();
    expect(extrudeTargetCandidates(document)).toEqual([{ value: 'body-a', label: 'A' }, { value: 'body-b', label: 'B' }]);
    expect(extrudeTargetCandidates({ ...document, solids: document.solids.map((feature) => ({ ...feature, suppressed: true })) })).toEqual([]);
  });
  it('rejects ambiguous duplicate IDs rather than choosing by order', () => {
    const document = fixture();
    const ambiguous = { ...document, solids: [document.solids[0], document.solids[0]] };
    expect(extrudeOperationSelection(ambiguous, 'join', 'body-a')).toEqual({ ok: false, reasonKey: 'solidError.extrudeTargetUnavailable' });
  });
  it('new requires no target and unknown operation is not silently new', () => {
    expect(extrudeOperationSelection(fixture(), undefined, undefined)).toEqual({ ok: true, operation: 'new' });
    expect(extrudeOperationSelection(fixture(), 'intersect', 'body-a')).toEqual({ ok: false, reasonKey: 'shapeError.unknownChoice' });
  });
});
