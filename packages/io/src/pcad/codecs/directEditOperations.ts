import type { FaceRotateFeature, HoleTranslateFeature } from '@pointercad/model';
import { type Checked, fieldProblem, joinPath, readExpression, readString } from '../guards.js';
import { readExpressionItem, readList, serializeExpression } from './fields.js';
import { readSubShapeRefField, serializeSubShapeRef } from './shapeReferences.js';
import type { SolidFeatureBase } from './solidBase.js';

export function readDirectEditFeature(
  record: Record<string, unknown>, path: string, base: SolidFeatureBase, kind: 'holeTranslate' | 'faceRotate',
): Checked<HoleTranslateFeature | FaceRotateFeature> {
  const target = readString(record, 'targetFeatureId', path);
  if (!target.ok) return target;
  const face = readSubShapeRefField(record, 'face', path);
  if (!face.ok) return face;
  if (face.value.fingerprint.kind !== 'face' || face.value.bodyFeatureId !== target.value) {
    return fieldProblem(joinPath(path, 'face'), 'type');
  }
  const common = { ...base, targetFeatureId: target.value, face: face.value };
  if (kind === 'holeTranslate') {
    const translation = readList(record, 'translation', path, readExpressionItem);
    if (!translation.ok) return translation;
    if (translation.value.length !== 3) return fieldProblem(joinPath(path, 'translation'), 'type');
    if (!translation.value.every(value => Number.isFinite(value.value))) return fieldProblem(joinPath(path, 'translation'), 'type');
    return { ok: true, value: { ...common, kind,
      translation: [translation.value[0], translation.value[1], translation.value[2]] } };
  }
  const hinge = readSubShapeRefField(record, 'hinge', path);
  if (!hinge.ok) return hinge;
  if (hinge.value.fingerprint.kind !== 'edge' || hinge.value.bodyFeatureId !== target.value) {
    return fieldProblem(joinPath(path, 'hinge'), 'type');
  }
  const angle = readExpression(record, 'angle', path);
  if (!angle.ok) return angle;
  if (!Number.isFinite(angle.value.value)) return fieldProblem(joinPath(path, 'angle'), 'type');
  return { ok: true, value: { ...common, kind, hinge: hinge.value, angle: angle.value } };
}

export function serializeDirectEditFeature(feature: HoleTranslateFeature | FaceRotateFeature): HoleTranslateFeature | FaceRotateFeature {
  const common = { id: feature.id, name: feature.name, suppressed: feature.suppressed,
    targetFeatureId: feature.targetFeatureId, face: serializeSubShapeRef(feature.face) };
  return feature.kind === 'holeTranslate'
    ? { ...common, kind: feature.kind, translation: [serializeExpression(feature.translation[0]),
      serializeExpression(feature.translation[1]), serializeExpression(feature.translation[2])] }
    : { ...common, kind: feature.kind, hinge: serializeSubShapeRef(feature.hinge), angle: serializeExpression(feature.angle) };
}
