import { expressionValueFromNumber } from '@pointercad/expression';
import { addSketch, createSketchFor, findSketch, replaceSketch } from '../part/createPartDocument.js';
import { appendFeature, createPointFeature, nextFeatureId, nextFeatureName } from '../sketch/createSketchDocument.js';
import { DEFAULT_FACE_COLOR } from '../sketch/createSketchDocument.js';
import type { CoordinateInput, SketchFeature } from '../sketch/types.js';
import type { ScriptCommand } from './scriptTypes.js';
import { readScriptCoordinate, scriptReference, ScriptCommandError, type ScriptCommandContext, type ScriptCommandChange } from './scriptCommandContext.js';

type SketchCommand = Extract<ScriptCommand, { readonly kind: 'sketch.create' | 'sketch.point' | 'sketch.line' | 'sketch.face' }>;

function referenceCoordinate(pointId: string): CoordinateInput {
  return { mode: 'relative', base: { kind: 'point', pointId }, dx: expressionValueFromNumber(0),
    dy: expressionValueFromNumber(0), dz: expressionValueFromNumber(0) };
}

export function applyScriptSketchCommand(context: ScriptCommandContext, command: SketchCommand): ScriptCommandChange {
  if (command.kind === 'sketch.create') {
    const sketch = { ...createSketchFor(context.document), id: command.resultId, name: command.fields.name };
    return { document: addSketch(context.document, sketch), featureIds: [],
      reference: { kind: 'sketch', sketchId: sketch.id, featureId: sketch.id, planeId: command.fields.plane } };
  }
  const owner = scriptReference(context, command.fields.sketch, 'sketch');
  const sketch = findSketch(context.document, owner.featureId);
  if (!sketch) throw new ScriptCommandError('作図するスケッチが見つかりません。');
  let feature: SketchFeature;
  let kind: 'point' | 'edge' | 'face';
  if (command.kind === 'sketch.point') {
    feature = createPointFeature(sketch, readScriptCoordinate(context, command.fields.coordinates), owner.planeId);
    kind = 'point';
  } else if (command.kind === 'sketch.line') {
    const start = scriptReference(context, command.fields.start, 'point');
    const end = scriptReference(context, command.fields.end, 'point');
    if (start.sketchId !== sketch.id || end.sketchId !== sketch.id) throw new ScriptCommandError('同じスケッチの点を指定してください。');
    feature = { id: nextFeatureId(sketch, 'line'), name: nextFeatureName(sketch, 'line'), kind: 'line',
      planeId: owner.planeId, construction: false, from: referenceCoordinate(start.featureId), to: referenceCoordinate(end.featureId) };
    kind = 'edge';
  } else {
    const boundary = command.fields.edges.map(alias => {
      const edge = scriptReference(context, alias, 'edge');
      if (edge.sketchId !== sketch.id) throw new ScriptCommandError('同じスケッチの線を指定してください。');
      return { featureId: edge.featureId };
    });
    feature = { id: nextFeatureId(sketch, 'face'), name: nextFeatureName(sketch, 'face'), kind: 'face',
      planeId: owner.planeId, boundary, color: DEFAULT_FACE_COLOR };
    kind = 'face';
  }
  feature = { ...feature, id: command.resultId };
  return { document: replaceSketch(context.document, appendFeature(sketch, feature)), featureIds: [feature.id],
    reference: { kind, sketchId: sketch.id, featureId: feature.id, planeId: owner.planeId } };
}
