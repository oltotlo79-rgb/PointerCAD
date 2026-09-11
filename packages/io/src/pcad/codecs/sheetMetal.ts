/** P10: 板金の入力だけを保存する。導出座標・メッシュ・一時表示は書き出さない。 */
import type { SheetBaseFeature, SheetBendFeature, SheetBendRuleOverride, SheetFlangeFeature, SheetFlangeProfile, SheetMetalFeature,
  SheetMetalRule, SheetPanelBoundaryRef, SheetReliefFeature, SketchFaceRef, SketchLineRef } from '@pointercad/model';
import { checkRecord, fieldProblem, joinPath, readBoolean, readExpression, readLiteral, readRecord, readString, readValue,
  type Checked, type ExpressionValueJson } from '../guards.js';
import { readList, serializeExpression } from './fields.js';
import { readFaceRefItem, serializeFaceRef, serializeLineRef } from './shapeReferences.js';
import type { SolidFeatureBase } from './solidBase.js';

function readId(record: Record<string, unknown>, key: string, path: string): Checked<string> {
  const id = readString(record, key, path);
  return !id.ok || id.value.trim() !== '' ? id : fieldProblem(joinPath(path, key), 'type');
}
function readFiniteExpression(record: Record<string, unknown>, key: string, path: string,
  accepts: (value: number) => boolean): Checked<ExpressionValueJson> {
  const expression = readExpression(record, key, path);
  if (!expression.ok) return expression;
  return Number.isFinite(expression.value.value) && accepts(expression.value.value)
    ? expression : fieldProblem(joinPath(joinPath(path, key), 'value'), 'type');
}
const positiveLength = (value: number): boolean => value > 1e-7;
const nonNegative = (value: number): boolean => value >= 0;
const validAngle = (value: number): boolean => Math.abs(value) < 180;
const validK = (value: number): boolean => value >= 0 && value <= 0.5;

function readSheetRule(record: Record<string, unknown>, path: string): Checked<SheetMetalRule> {
  const found = readRecord(record, 'rule', path); if (!found.ok) return found;
  const at = joinPath(path, 'rule');
  const thickness = readFiniteExpression(found.value, 'thickness', at, positiveLength); if (!thickness.ok) return thickness;
  const innerRadius = readFiniteExpression(found.value, 'innerRadius', at, positiveLength); if (!innerRadius.ok) return innerRadius;
  const kFactor = readFiniteExpression(found.value, 'kFactor', at, validK); if (!kFactor.ok) return kFactor;
  return { ok: true, value: { thickness: thickness.value, innerRadius: innerRadius.value, kFactor: kFactor.value } };
}
function readOverrideExpression(record: Record<string, unknown>, key: string, path: string,
  accepts: (value: number) => boolean): Checked<ExpressionValueJson | null> {
  const found = readValue(record, key, path); if (!found.ok) return found;
  return found.value === null ? { ok: true, value: null } : readFiniteExpression(record, key, path, accepts);
}
function readRuleOverride(record: Record<string, unknown>, path: string): Checked<SheetBendRuleOverride> {
  const found = readRecord(record, 'rule', path); if (!found.ok) return found;
  const at = joinPath(path, 'rule');
  const innerRadius = readOverrideExpression(found.value, 'innerRadius', at, positiveLength); if (!innerRadius.ok) return innerRadius;
  const kFactor = readOverrideExpression(found.value, 'kFactor', at, validK); if (!kFactor.ok) return kFactor;
  return { ok: true, value: { innerRadius: innerRadius.value, kFactor: kFactor.value } };
}
function readBoundary(value: unknown, path: string): Checked<SheetPanelBoundaryRef> {
  const record = checkRecord(value, path); if (!record.ok) return record;
  const panelId = readId(record.value, 'panelId', path); if (!panelId.ok) return panelId;
  const boundaryId = readId(record.value, 'boundaryId', path); if (!boundaryId.ok) return boundaryId;
  return { ok: true, value: { panelId: panelId.value, boundaryId: boundaryId.value } };
}
function readProfile(value: unknown, path: string): Checked<SketchFaceRef> {
  const ref = readFaceRefItem(value, path); if (!ref.ok) return ref;
  if (ref.value.sketchId.trim() === '' || ref.value.faceFeatureId.trim() === '') return fieldProblem(path, 'type');
  return ref;
}
function readProfileField(record: Record<string, unknown>, path: string): Checked<SketchFaceRef> {
  const found = readValue(record, 'profile', path); if (!found.ok) return found;
  return readProfile(found.value, joinPath(path, 'profile'));
}
function readNullableProfile(record: Record<string, unknown>, path: string): Checked<SheetFlangeProfile | null> {
  const found = readValue(record, 'profile', path); if (!found.ok) return found;
  if (found.value === null) return { ok: true, value: null };
  const at = joinPath(path, 'profile'), data = checkRecord(found.value, at); if (!data.ok) return data;
  const faceValue = readValue(data.value, 'face', at); if (!faceValue.ok) return faceValue;
  const face = readProfile(faceValue.value, joinPath(at, 'face')); if (!face.ok) return face;
  const baselineId = readId(data.value, 'baselineId', at); if (!baselineId.ok) return baselineId;
  const holes = readList(data.value, 'holes', at, readProfile); if (!holes.ok) return holes;
  const references = [face.value, ...holes.value].map((ref) => JSON.stringify([ref.sketchId, ref.faceFeatureId]));
  if (new Set(references).size !== references.length) return fieldProblem(joinPath(at, 'holes'), 'type');
  return { ok: true, value: { face: face.value, baselineId: baselineId.value, holes: holes.value } };
}
function readLine(record: Record<string, unknown>, path: string): Checked<SketchLineRef> {
  const found = readRecord(record, 'line', path); if (!found.ok) return found;
  const at = joinPath(path, 'line');
  const sketchId = readId(found.value, 'sketchId', at); if (!sketchId.ok) return sketchId;
  const lineFeatureId = readId(found.value, 'lineFeatureId', at); if (!lineFeatureId.ok) return lineFeatureId;
  return { ok: true, value: { sketchId: sketchId.value, lineFeatureId: lineFeatureId.value } };
}
function readTarget(record: Record<string, unknown>, path: string, base: SolidFeatureBase): Checked<string> {
  const found = readId(record, 'targetFeatureId', path);
  return !found.ok || found.value !== base.id ? found : fieldProblem(joinPath(path, 'targetFeatureId'), 'type');
}

export function readSheetBaseFeature(record: Record<string, unknown>, path: string, base: SolidFeatureBase): Checked<SheetBaseFeature> {
  const profile = readProfileField(record, path); if (!profile.ok) return profile;
  const holes = readList(record, 'holes', path, readProfile); if (!holes.ok) return holes;
  const references = [profile.value, ...holes.value].map((ref) => JSON.stringify([ref.sketchId, ref.faceFeatureId]));
  if (new Set(references).size !== references.length) return fieldProblem(joinPath(path, 'holes'), 'type');
  const reversed = readBoolean(record, 'reversed', path); if (!reversed.ok) return reversed;
  const rule = readSheetRule(record, path); if (!rule.ok) return rule;
  return { ok: true, value: { ...base, kind: 'sheetBase', profile: profile.value, holes: holes.value, reversed: reversed.value, rule: rule.value } };
}
export function readSheetFlangeFeature(record: Record<string, unknown>, path: string, base: SolidFeatureBase): Checked<SheetFlangeFeature> {
  const target = readTarget(record, path, base); if (!target.ok) return target;
  const edges = readList(record, 'edges', path, readBoundary); if (!edges.ok) return edges;
  if (edges.value.length === 0 || new Set(edges.value.map((edge) => JSON.stringify([edge.panelId, edge.boundaryId]))).size !== edges.value.length)
    return fieldProblem(joinPath(path, 'edges'), 'type');
  const length = readFiniteExpression(record, 'length', path, positiveLength); if (!length.ok) return length;
  const angle = readFiniteExpression(record, 'angle', path, validAngle); if (!angle.ok) return angle;
  const startOffset = readFiniteExpression(record, 'startOffset', path, nonNegative); if (!startOffset.ok) return startOffset;
  const endOffset = readFiniteExpression(record, 'endOffset', path, nonNegative); if (!endOffset.ok) return endOffset;
  const lengthBasis = readLiteral(record, 'lengthBasis', path, ['tangent', 'outer', 'inner']); if (!lengthBasis.ok) return lengthBasis;
  const rule = readRuleOverride(record, path); if (!rule.ok) return rule;
  const profile = readNullableProfile(record, path); if (!profile.ok) return profile;
  return { ok: true, value: { ...base, kind: 'sheetFlange', targetFeatureId: target.value, edges: edges.value,
    length: length.value, angle: angle.value, startOffset: startOffset.value, endOffset: endOffset.value,
    lengthBasis: lengthBasis.value, rule: rule.value, profile: profile.value } };
}
export function readSheetBendFeature(record: Record<string, unknown>, path: string, base: SolidFeatureBase): Checked<SheetBendFeature> {
  const target = readTarget(record, path, base); if (!target.ok) return target;
  const panelId = readId(record, 'panelId', path); if (!panelId.ok) return panelId;
  const line = readLine(record, path); if (!line.ok) return line;
  const fixedSide = readLiteral(record, 'fixedSide', path, ['left', 'right']); if (!fixedSide.ok) return fixedSide;
  const angle = readFiniteExpression(record, 'angle', path, validAngle); if (!angle.ok) return angle;
  const rule = readRuleOverride(record, path); if (!rule.ok) return rule;
  return { ok: true, value: { ...base, kind: 'sheetBend', targetFeatureId: target.value, panelId: panelId.value,
    line: line.value, fixedSide: fixedSide.value, angle: angle.value, rule: rule.value } };
}
function readReliefSeams(record: Record<string, unknown>, path: string): Checked<readonly string[] | undefined> {
  if (!Object.hasOwn(record, 'seamConnectionIds')) return { ok: true, value: undefined };
  const at = joinPath(path, 'seamConnectionIds');
  const seams = readList<string>(record, 'seamConnectionIds', path, (value, itemPath) =>
    typeof value === 'string' && value.trim() !== '' ? { ok: true, value } : fieldProblem(itemPath, 'type'));
  if (!seams.ok) return seams;
  return new Set(seams.value).size === seams.value.length ? seams : fieldProblem(at, 'type');
}
export function readSheetReliefFeature(record: Record<string, unknown>, path: string, base: SolidFeatureBase): Checked<SheetReliefFeature> {
  const target = readTarget(record, path, base); if (!target.ok) return target;
  const value = readValue(record, 'boundary', path); if (!value.ok) return value;
  const boundary = readBoundary(value.value, joinPath(path, 'boundary')); if (!boundary.ok) return boundary;
  const position = readFiniteExpression(record, 'position', path, nonNegative); if (!position.ok) return position;
  const width = readFiniteExpression(record, 'width', path, positiveLength); if (!width.ok) return width;
  const depth = readFiniteExpression(record, 'depth', path, positiveLength); if (!depth.ok) return depth;
  const shape = readLiteral(record, 'shape', path, ['rectangle', 'slot']); if (!shape.ok) return shape;
  const seams = readReliefSeams(record, path); if (!seams.ok) return seams;
  return { ok: true, value: { ...base, kind: 'sheetRelief', targetFeatureId: target.value, boundary: boundary.value,
    position: position.value, width: width.value, depth: depth.value, shape: shape.value,
    ...(seams.value === undefined ? {} : { seamConnectionIds: seams.value }) } };
}

function serializeOverride(rule: SheetBendRuleOverride): SheetBendRuleOverride {
  return { innerRadius: rule.innerRadius === null ? null : serializeExpression(rule.innerRadius),
    kFactor: rule.kFactor === null ? null : serializeExpression(rule.kFactor) };
}
function serializeBoundary(ref: SheetPanelBoundaryRef): SheetPanelBoundaryRef { return { panelId: ref.panelId, boundaryId: ref.boundaryId }; }
export function serializeSheetMetalFeature(feature: SheetBaseFeature | SheetFlangeFeature | SheetBendFeature | SheetReliefFeature): SheetBaseFeature | SheetFlangeFeature | SheetBendFeature | SheetReliefFeature;
export function serializeSheetMetalFeature(feature: SheetMetalFeature): SheetMetalFeature;
export function serializeSheetMetalFeature(feature: SheetMetalFeature): SheetMetalFeature {
  const base = { id: feature.id, name: feature.name, suppressed: feature.suppressed };
  switch (feature.kind) {
    case 'sheetBase':
      return { ...base, kind: feature.kind, profile: serializeFaceRef(feature.profile), holes: feature.holes.map(serializeFaceRef), reversed: feature.reversed,
        rule: { thickness: serializeExpression(feature.rule.thickness), innerRadius: serializeExpression(feature.rule.innerRadius), kFactor: serializeExpression(feature.rule.kFactor) } };
    case 'sheetFlange':
      return { ...base, kind: feature.kind, targetFeatureId: feature.targetFeatureId, edges: feature.edges.map(serializeBoundary),
        length: serializeExpression(feature.length), angle: serializeExpression(feature.angle), startOffset: serializeExpression(feature.startOffset),
        endOffset: serializeExpression(feature.endOffset), lengthBasis: feature.lengthBasis, rule: serializeOverride(feature.rule),
        profile: feature.profile === null ? null : { face: serializeFaceRef(feature.profile.face), baselineId: feature.profile.baselineId,
          holes: feature.profile.holes.map(serializeFaceRef) } };
    case 'sheetBend':
      return { ...base, kind: feature.kind, targetFeatureId: feature.targetFeatureId, panelId: feature.panelId, line: serializeLineRef(feature.line),
        fixedSide: feature.fixedSide, angle: serializeExpression(feature.angle), rule: serializeOverride(feature.rule) };
    case 'sheetRelief':
      return { ...base, kind: feature.kind, targetFeatureId: feature.targetFeatureId, boundary: serializeBoundary(feature.boundary),
        position: serializeExpression(feature.position), width: serializeExpression(feature.width), depth: serializeExpression(feature.depth), shape: feature.shape,
        ...(feature.seamConnectionIds === undefined ? {} : { seamConnectionIds: [...feature.seamConnectionIds] }) };
  }
}
