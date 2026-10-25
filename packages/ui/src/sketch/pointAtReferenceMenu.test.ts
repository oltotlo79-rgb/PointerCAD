import { absoluteCoordinate, appendFeature, appendReference, createEmptyPartDocument, createPointFeature, replaceSketch,
  type PartDocument, type ReferencePointFeature } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { pointAtReferenceDecision } from './pointAtReferencePoint.js';
import { pointAtReferenceShownInMenu } from './pointAtReferenceMenu.js';
import { pointReferenceCoordinate } from './selectedPointEnds.js';

const state = () => useAppStore.getState();
const P_ID = 'refpoint-1';
function partWith(definition: ReferencePointFeature['definition']): PartDocument {
  const reference: ReferencePointFeature = { id: P_ID, name: 'P', visible: true, kind: 'referencePoint', definition };
  const part = appendReference(createEmptyPartDocument(), reference);
  return replaceSketch(part, appendFeature(part.sketches[0], createPointFeature(part.sketches[0], absoluteCoordinate(1, 2, 3))));
}
beforeEach(() => { resetTestStore(); });

describe('radial menu entry for point at a part reference point', () => {
  it('is shown only while exactly one part reference point is selected', () => {
    state().applyDocument(partWith({ kind: 'coordinate', at: absoluteCoordinate(10, 15, 10) }), { replacesDocument: true });
    const sketchPoint = state().sketch.features[0].id;
    state().setSelection([]);
    expect(pointAtReferenceShownInMenu()).toBe(false);
    state().setSelection([P_ID]);
    expect(pointAtReferenceShownInMenu()).toBe(true);
    state().setSelection([P_ID, sketchPoint]);
    expect(pointAtReferenceShownInMenu()).toBe(false);
    state().setSelection([sketchPoint]);
    expect(pointAtReferenceShownInMenu()).toBe(false);
    state().setSelection(['xy']);
    expect(pointAtReferenceShownInMenu()).toBe(false);
  });

  it('stays shown for an unsupported reference point so the menu can explain the refusal', () => {
    state().applyDocument(partWith({ kind: 'coordinate', at: pointReferenceCoordinate('point-1') }), { replacesDocument: true });
    state().setSelection([P_ID]);
    expect(pointAtReferenceShownInMenu()).toBe(true);
    expect(pointAtReferenceDecision()).toMatchObject({ ready: false });
  });
});
