import { expressionValueFromNumber as ev } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { cacheKeyFor, keyMaterialText } from './cacheKey.js';
import { createHoleTranslateFeature, createFaceRotateFeature, directEditPlan } from './directEditOperations.js';
import { keyMaterialFor } from './solidPlanKeyMaterial.js';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from './createPartDocument.js';
import { reevaluatePartDocument } from './reevaluatePart.js';
import { resolvePart } from './resolvePart.js';

const face: SubShapeRef = { bodyFeatureId: 'primitive-1', index: 0,
  fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1200, position: [20, 15, 8], axis: [0, 0, 1], radius: null } };
const hinge: SubShapeRef = { bodyFeatureId: 'primitive-1', index: 0,
  fingerprint: { kind: 'edge', curveKind: 'line', length: 40, position: [20, 0, 8], axis: [1, 0, 0], radius: null } };
const common = { id: 'edit', name: 'edit', targetFeatureId: 'primitive-1', face };
const hole = createHoleTranslateFeature({ ...common, translation: [ev(2), ev(0), ev(0)] });
const rotation = createFaceRotateFeature({ ...common, hinge, angle: ev(5) });
function plan(feature: typeof hole | typeof rotation, target = 'target-key') {
  const result = directEditPlan(feature, target);
  if (!result.ok) throw new Error(result.message);
  return result.plan;
}
function key(feature: typeof hole | typeof rotation, target = 'target-key') {
  return cacheKeyFor(keyMaterialFor(plan(feature, target)));
}

describe('direct edit expression, plan and key contracts', () => {
  it('converts five degrees independently to pi/36 and keeps world mm components', () => {
    expect(plan(rotation)).toEqual({ kind: 'faceRotate', targetKey: 'target-key', face, hinge, angle: Math.PI / 36 });
    expect(plan(hole)).toEqual({ kind: 'holeTranslate', targetKey: 'target-key', face, translation: [2, 0, 0] });
  });
  it.each([0, 1, 2])('keys translation component %i independently', axis => {
    const translation: [ReturnType<typeof ev>, ReturnType<typeof ev>, ReturnType<typeof ev>] = [...hole.translation];
    translation[axis] = ev(3);
    expect(key({ ...hole, translation })).not.toBe(key(hole));
  });
  it.each([hole, rotation])('keys target and face independently for $kind', feature => {
    expect(key(feature, 'another-target')).not.toBe(key(feature));
    expect(key({ ...feature, face: { ...face, index: 1 } })).not.toBe(key(feature));
  });
  it('keys hinge and angle independently', () => {
    expect(key({ ...rotation, hinge: { ...hinge, index: 1 } })).not.toBe(key(rotation));
    expect(key({ ...rotation, angle: ev(-5) })).not.toBe(key(rotation));
  });
  it.each([hole, rotation])('rejects foreign body and non-face input for $kind', feature => {
    expect(directEditPlan({ ...feature, face: { ...face, bodyFeatureId: 'other' } }, 'key').ok).toBe(false);
    expect(directEditPlan({ ...feature, face: hinge }, 'key').ok).toBe(false);
  });
  it.each([0, NaN, Infinity, -Infinity])('rejects zero/nonfinite input %s', value => {
    expect(directEditPlan({ ...hole, translation: [ev(value), ev(0), ev(0)] }, 'key').ok).toBe(false);
    expect(directEditPlan({ ...rotation, angle: ev(value) }, 'key').ok).toBe(false);
  });
  it('rejects a foreign hinge and a face in the hinge slot', () => {
    expect(directEditPlan({ ...rotation, hinge: { ...hinge, bodyFeatureId: 'other' } }, 'key').ok).toBe(false);
    expect(directEditPlan({ ...rotation, hinge: face }, 'key').ok).toBe(false);
  });
  it.each([hole, rotation])('reevaluates the actual document without changing identity or equal-value keys: $kind', feature => {
    const empty = createEmptyPartDocument();
    const base = { ...createPrimitiveFeature(empty, 'box'), id: 'primitive-1' };
    const symbolic = feature.kind === 'holeTranslate'
      ? { ...feature, translation: [{ ...ev(2), source: 'distance' }, ev(0), ev(0)] as const }
      : { ...feature, angle: { ...ev(5), source: 'angle' } };
    const document = appendSolid(appendSolid(empty, base), symbolic);
    const snapshot = JSON.stringify(document);
    const same = reevaluatePartDocument(document, new Map([['distance', 2], ['angle', 5]]));
    const changed = reevaluatePartDocument(document, new Map([['distance', -2], ['angle', -5]]));
    expect(same.failures).toEqual([]);
    expect(changed.failures).toEqual([]);
    expect(resolvePart(same.document).steps.at(-1)?.key).toBe(resolvePart(document).steps.at(-1)?.key);
    expect(resolvePart(changed.document).steps.at(-1)?.key).not.toBe(resolvePart(document).steps.at(-1)?.key);
    expect(changed.document.solids.at(-1)?.id).toBe(feature.id);
    expect(JSON.stringify(document)).toBe(snapshot);
  });
  it('keeps the pre-existing faceOffset key text exactly', () => {
    expect(keyMaterialText({ kind: 'faceOffset', targetKey: 'key:bracket', face: 'face#4', offset: 5 }))
      .toBe('faceOffset{targetKey=key:bracket;face=face#4;offset=5.000000000}');
  });
});
