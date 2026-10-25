import { absoluteCoordinate, appendFeature, appendReference, createEmptyPartDocument, createPointFeature, replaceSketch,
  resolveConstrainedSketch, type PartDocument, type ReferencePointFeature } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestStore, resultFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { placePointAtReferencePoint, pointAtReferenceDecision } from './pointAtReferencePoint.js';
import { pointReferenceCoordinate } from './selectedPointEnds.js';

const state = () => useAppStore.getState();
const P_ID = 'refpoint-1';
function partWith(definition: ReferencePointFeature['definition']): PartDocument {
  const reference: ReferencePointFeature = { id: P_ID, name: 'P', visible: true, kind: 'referencePoint', definition };
  return appendReference(createEmptyPartDocument(), reference);
}
function ready(document: PartDocument, selection: readonly string[] = [P_ID]): void {
  state().applyDocument(document, { replacesDocument: true });
  state().recordRecomputeRequest(1);
  state().applyRecompute(state().document, { ...resultFor(state().document), generation: 1 });
  state().recordRecomputeCompletion(1, 'success');
  state().setSelection(selection);
}
beforeEach(() => {
  resetTestStore();
  useAppStore.setState({ requestedGeneration: 0, completedGeneration: 0, lastOutcome: 'idle' });
});

describe('point at a part reference point (EX-18 route 5 UI entry)', () => {
  it('adds one undoable sketch point that follows the selected reference point', () => {
    ready(partWith({ kind: 'coordinate', at: absoluteCoordinate(10, 15, 10) }));
    const before = state().document, historyLength = state().undoStack.past.length;
    const result = placePointAtReferencePoint();
    if (!result.ready) throw new Error(result.reasonKey);
    expect(result.point.at).toMatchObject({ mode: 'relative', base: { kind: 'point', pointId: P_ID } });
    expect(state().undoStack.past).toHaveLength(historyLength + 1);
    expect(state().selection).toEqual([result.point.id]);
    expect(state().editNoticeKey).toBe('sketch.referencePoint.created');
    // The link resolves only through the bridge; without it the base is missing, so nothing copies coordinates.
    const bridged = resolveConstrainedSketch(state().sketch, { partPoint: (id) => id === P_ID
      ? { kind: 'point', position: [10, 15, 10] } : { kind: 'none' } });
    expect(bridged.resolved.points.find((point) => point.id === result.point.id)?.position).toEqual([10, 15, 10]);
    expect(resolveConstrainedSketch(state().sketch).resolved.errors).toMatchObject([{ code: 'missingBase' }]);
    const after = state().document;
    state().undo();
    expect(state().document).toBe(before);
    state().redo();
    expect(state().document).toBe(after);
  });

  it('refuses unsupported, ambiguous, multiple and non-reference selections without changing the document', () => {
    ready(partWith({ kind: 'coordinate', at: absoluteCoordinate(10, 15, 10) }), []);
    expect(pointAtReferenceDecision()).toMatchObject({ ready: false, reasonKey: 'sketch.referencePoint.selectOne' });
    ready(partWith({ kind: 'coordinate', at: absoluteCoordinate(10, 15, 10) }), [P_ID, 'xy']);
    expect(pointAtReferenceDecision()).toMatchObject({ ready: false, reasonKey: 'sketch.referencePoint.selectOne' });
    // A reference point placed relative to another point could cycle back through this sketch: refused.
    ready(partWith({ kind: 'coordinate', at: pointReferenceCoordinate('point-1') }));
    expect(pointAtReferenceDecision()).toMatchObject({ ready: false, reasonKey: 'sketch.referencePoint.unsupported' });
    const base = partWith({ kind: 'coordinate', at: absoluteCoordinate(10, 15, 10) });
    const local = { ...createPointFeature(base.sketches[0], absoluteCoordinate(0, 0, 0)), id: P_ID };
    ready(replaceSketch(base, appendFeature(base.sketches[0], local)));
    const before = state().document;
    expect(placePointAtReferencePoint()).toMatchObject({ ready: false, reasonKey: 'sketch.referencePoint.ambiguous' });
    expect(state().document).toBe(before);
  });
});
