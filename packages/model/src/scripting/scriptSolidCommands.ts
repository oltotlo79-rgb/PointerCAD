import { appendSolid, createPrimitiveFeature, nextSolidId, nextSolidName } from '../part/createPartDocument.js';
import type { PrimitiveShape, SolidFeature, SolidOrigin } from '../part/types.js';
import { readScriptCoordinate, readScriptLength, scriptReference, ScriptCommandError, type ScriptCommandChange, type ScriptCommandContext } from './scriptCommandContext.js';
import type { ScriptCommand } from './scriptTypes.js';

type SolidCommand = Extract<ScriptCommand, { readonly kind: `solid.${string}` }>;
type PrimitiveCommand = Exclude<SolidCommand, { readonly kind: 'solid.extrude' | 'solid.hole' }>;
function primitiveShape(context: ScriptCommandContext, command: PrimitiveCommand): PrimitiveShape {
  const length = (source: string) => readScriptLength(context, source);
  switch (command.kind) {
    case 'solid.box': return { kind: 'box', sizeX: length(command.fields.x), sizeY: length(command.fields.y), sizeZ: length(command.fields.z) };
    case 'solid.sphere': return { kind: 'sphere', radius: length(command.fields.radius) };
    case 'solid.cylinder': return { kind: 'cylinder', radius: length(command.fields.radius), height: length(command.fields.height) };
    case 'solid.cone': return { kind: 'cone', bottomRadius: length(command.fields.bottomRadius), topRadius: length(command.fields.topRadius), height: length(command.fields.height) };
    case 'solid.torus': return { kind: 'torus', majorRadius: length(command.fields.majorRadius), minorRadius: length(command.fields.minorRadius) };
  }
}
function change(context: ScriptCommandContext, feature: SolidFeature): ScriptCommandChange {
  return { document: appendSolid(context.document, feature), featureIds: [feature.id],
    reference: { kind: 'solid', sketchId: null, featureId: feature.id, planeId: 'xy' } };
}
export function applyScriptSolidCommand(context: ScriptCommandContext, command: SolidCommand): ScriptCommandChange {
  const { document } = context;
  if (command.kind === 'solid.extrude') {
    const face = scriptReference(context, command.fields.face, 'face');
    if (face.sketchId === null) throw new ScriptCommandError('押し出すスケッチの面がありません。');
    return change(context, { id: nextSolidId(document, 'extrude'), name: nextSolidName(document, 'extrude'), kind: 'extrude',
      suppressed: false, profile: { sketchId: face.sketchId, faceFeatureId: face.featureId },
      distance: readScriptLength(context, command.fields.distance), reversed: false, symmetric: false });
  }
  if (command.kind === 'solid.hole') {
    const target = scriptReference(context, command.fields.target, 'solid');
    const origin: SolidOrigin = { kind: 'coordinate', value: readScriptCoordinate(context, command.fields.origin) };
    const tool = { ...createPrimitiveFeature(document, 'cylinder', origin, { kind: 'world', axis: command.fields.axis }),
      shape: { kind: 'cylinder', radius: readScriptLength(context, `(${command.fields.diameter})/2`),
        height: readScriptLength(context, command.fields.depth) } satisfies PrimitiveShape };
    const next = { ...context, document: appendSolid(document, tool) };
    const cut = change(next, { kind: 'boolean', operation: 'subtract', suppressed: false,
      id: nextSolidId(next.document, 'subtract'), name: nextSolidName(next.document, 'hole'),
      targetFeatureId: target.featureId, toolFeatureId: tool.id });
    return { ...cut, featureIds: [tool.id, ...cut.featureIds] };
  }
  const shape = primitiveShape(context, command);
  const origin: SolidOrigin = { kind: 'coordinate', value: readScriptCoordinate(context, command.fields.origin) };
  return change(context, { ...createPrimitiveFeature(document, shape.kind, origin, { kind: 'world', axis: command.fields.axis }), shape });
}
