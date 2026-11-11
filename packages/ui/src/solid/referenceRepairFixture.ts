import { appendSolid, createEmptyPartDocument, type PartDocument, type SolidBody, type SubShapeRef } from '@pointercad/model';
import { expressionValueFromNumber } from '@pointercad/expression';
import { bodyFor, extrudeFeature } from '../store/testing/createTestStore.js';

/** Adversarial R17 fixture: both current edges tie against the saved edge, but each can be selected explicitly. */
export function repairFixture(): { readonly document: PartDocument; readonly body: SolidBody; readonly reference: SubShapeRef } {
  const reference: SubShapeRef = { bodyFeatureId: 'base', index: 99, fingerprint: {
    kind: 'edge', curveKind: 'line', length: 20, position: [0, 0, 0], axis: [1, 0, 0], radius: null,
  } };
  const base = bodyFor('base');
  const body: SolidBody = { ...base, mesh: { ...base.mesh, positions: new Float32Array([-50, -50, -50, 50, 50, 50]) },
    edges: [10, 40].map((length, index) => ({ index, curveKind: 'line', length, midpoint: [0, index === 0 ? -2 : 2, 0],
      start: [-length / 2, 0, 0], end: [length / 2, 0, 0], axis: [1, 0, 0], radius: null, segmentOffset: index, segmentCount: 1 })) };
  const document = appendSolid(appendSolid(createEmptyPartDocument(), extrudeFeature('base')), {
    id: 'blend', name: '修復対象R', kind: 'fillet', suppressed: false, targetFeatureId: 'base', targets: [reference],
    radius: expressionValueFromNumber(1),
  });
  return { document, body, reference };
}
