import type { FunctionDefinition } from '../functionGeometry/functionDefinitionTypes.js';
import { createFunctionCurve } from '../functionGeometry/createFunctionCurve.js';
import { createFunctionSurface } from '../functionGeometry/functionSurfaceFeature.js';
import { findSketch, replaceSketch, appendSolid } from '../part/createPartDocument.js';
import type { PartDocument } from '../part/types.js';
import { FREE_WORK_PLANE_ID } from '../sketch/planeMath.js';
import { scriptReference, ScriptCommandError, type ScriptCommandContext, type ScriptCommandChange } from './scriptCommandContext.js';
import type { ScriptFunctionDefinition } from './scriptFunctionInput.js';
import type { ScriptCommand } from './scriptTypes.js';

export interface CompiledScriptFunction {
  readonly document: PartDocument;
  readonly definition: FunctionDefinition;
}

export type ScriptFunctionCompiler = (
  document: PartDocument, definition: ScriptFunctionDefinition, shouldCancel: () => boolean,
) => Promise<CompiledScriptFunction>;

export function applyScriptFunctionCommand(
  context: ScriptCommandContext,
  command: Extract<ScriptCommand, { kind: 'function.curve' | 'function.surface' }>,
  compiled: CompiledScriptFunction | undefined,
): ScriptCommandChange {
  if (!compiled || compiled.document.id !== context.document.id) {
    throw new ScriptCommandError('関数の数学計算部を準備できません。');
  }
  const { document, definition } = compiled;
  if (command.kind === 'function.surface') {
    const feature = { ...createFunctionSurface(document, definition), id: command.resultId };
    return {
      document: appendSolid(document, feature), featureIds: [feature.id],
      reference: { kind: 'solid', sketchId: null, featureId: feature.id, planeId: FREE_WORK_PLANE_ID },
    };
  }
  const owner = scriptReference(context, command.fields.sketch, 'sketch');
  const sketch = findSketch(document, owner.featureId);
  if (!sketch) {
    throw new ScriptCommandError('関数を作図するスケッチが見つかりません。');
  }
  const feature = { ...createFunctionCurve(sketch, definition), id: command.resultId };
  return {
    document: replaceSketch(document, { ...sketch, features: [...sketch.features, feature] }), featureIds: [feature.id],
    reference: { kind: 'edge', sketchId: sketch.id, featureId: feature.id, planeId: FREE_WORK_PLANE_ID },
  };
}
