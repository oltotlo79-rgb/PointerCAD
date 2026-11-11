import { expressionValueFromNumber as ev } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature, consumedTargetsOf,
  nextSolidId, nextSolidName, replaceSolid } from './createPartDocument.js';
import { createHoleTranslateFeature, createFaceRotateFeature } from './directEditOperations.js';
import { resolvePart } from './resolvePart.js';
import { canMoveHistoryItem, historyDependencies, moveHistoryItem, timelineIndexOf } from './timelineOrder.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { createUndoStack, pushUndo, redo, undo } from '../history/undoStack.js';

describe('direct edit history contracts', () => {
  it.each(['holeTranslate', 'faceRotate'] as const)('%s preserves suppression, serials and upstream dependencies', kind => {
    const empty = createEmptyPartDocument();
    const base = createPrimitiveFeature(empty, 'box');
    const source = appendSolid(empty, base);
    const face: SubShapeRef = { bodyFeatureId: base.id, index: 0,
      fingerprint: { kind: 'face', surfaceKind: 'plane', area: 100, position: [0, 0, 0], axis: [0, 0, 1], radius: null } };
    const hinge: SubShapeRef = { bodyFeatureId: base.id, index: 0,
      fingerprint: { kind: 'edge', curveKind: 'line', length: 10, position: [0, 0, 0], axis: [1, 0, 0], radius: null } };
    const input = { id: nextSolidId(source, kind), name: nextSolidName(source, kind), targetFeatureId: base.id, face };
    const feature = kind === 'holeTranslate'
      ? createHoleTranslateFeature({ ...input, translation: [ev(2), ev(0), ev(0)] })
      : createFaceRotateFeature({ ...input, hinge, angle: ev(5) });
    const document = appendSolid(source, feature);
    expect(feature.id).toBe(`${kind}-1`);
    expect(nextSolidId(document, kind)).toBe(`${kind}-2`);
    expect(nextSolidName(document, kind)).toBe(kind === 'holeTranslate' ? '穴の移動2' : '面の回転2');
    expect(consumedTargetsOf(feature)).toEqual([base.id]);
    const resolved = resolvePart(document);
    expect(resolved.errors).toEqual([]);
    expect(resolved.steps.filter(step => step.visible).map(step => step.featureId)).toEqual([feature.id]);
    const suppressed = replaceSolid(document, feature.id, { ...feature, suppressed: true });
    expect(resolvePart(suppressed).steps.filter(step => step.visible).map(step => step.featureId)).toEqual([base.id]);
    expect(historyDependencies(document).get(feature.id)).toEqual([base.id]);
    const baseIndex = timelineIndexOf(document, base.id);
    if (baseIndex === null) throw new Error('missing base timeline entry');
    expect(canMoveHistoryItem(document, feature.id, baseIndex).ok).toBe(false);
    expect(moveHistoryItem(document, feature.id, baseIndex).ok).toBe(false);
    const foreign = feature.kind === 'faceRotate' ? { ...feature, hinge: { ...hinge, bodyFeatureId: 'foreign' } }
      : { ...feature, face: { ...face, bodyFeatureId: 'foreign' } };
    const withForeignBody = appendSolid(document, { ...base, id: 'foreign' });
    const foreignIndex = timelineIndexOf(withForeignBody, 'foreign');
    if (foreignIndex === null) throw new Error('missing independent body');
    const moved = moveHistoryItem(withForeignBody, feature.id, foreignIndex);
    expect(moved.ok).toBe(true);
    if (!moved.ok) throw new Error(moved.reason);
    expect(resolvePart(moved.document).errors).toEqual([]);
    expect(resolvePart(moved.document).steps.find(step => step.featureId === feature.id)?.key)
      .toBe(resolved.steps.find(step => step.featureId === feature.id)?.key);
    expect(moved.document.solids.find(item => item.id === feature.id)).toBe(feature);
    expect(historyDependencies(replaceSolid(withForeignBody, feature.id, foreign)).get(feature.id)).toContain('foreign');
    expect(source.solids).toEqual([base]);
    expect(document.solids.at(-1)).toBe(feature);
    const back = undo(pushUndo(createUndoStack(source), document));
    expect(back.present).toBe(source);
    const forward = redo(back);
    expect(forward.present).toBe(document);
    expect(forward.present.solids.at(-1)).toBe(feature);
  });
});
