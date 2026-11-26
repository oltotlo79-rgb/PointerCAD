import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { analyzeParameters } from '../parameters/parameterTable.js';
import type { PartDocument } from '../part/types.js';
import { parseDisplayInput, normalizeInchQuotes, type LengthUnit } from '../units/length.js';
import type { WorkPlaneId } from '../sketch/planeMath.js';
import { plainText, type FailureText } from '../failureText.js';
import type { ScriptCoordinate, ScriptFailureReason } from './scriptTypes.js';
import type { CoordinateInput } from '../sketch/types.js';

export interface ScriptModelReference {
  readonly kind: 'sketch' | 'point' | 'edge' | 'face' | 'solid';
  readonly sketchId: string | null;
  readonly featureId: string;
  readonly planeId: WorkPlaneId;
}
export interface ScriptCommandContext {
  readonly document: PartDocument;
  readonly references: ReadonlyMap<string, ScriptModelReference>;
  readonly lengthUnit: LengthUnit;
}
export interface ScriptCommandChange {
  readonly document: PartDocument;
  readonly reference: ScriptModelReference | null;
  readonly featureIds: readonly string[];
}

export class ScriptCommandError extends Error {
  constructor(readonly detail: ScriptFailureReason | FailureText) {
    super(typeof detail === 'string' ? detail : detail.key);
  }
}
export function scriptReference(context: ScriptCommandContext, alias: string, kind: ScriptModelReference['kind']): ScriptModelReference {
  const reference = context.references.get(alias);
  if (!reference || reference.kind !== kind) throw new ScriptCommandError('referenceKind');
  return reference;
}
export function readScriptLength(context: ScriptCommandContext, enteredSource: string): ExpressionValue {
  const analysis = analyzeParameters(context.document.parameters, []);
  const source = parseDisplayInput(normalizeInchQuotes(enteredSource), context.lengthUnit);
  const read = evaluateExpression(source, { exactVariables: analysis.exactVariables, nonLengthVariables: analysis.nonLengthVariables });
  if (!read.ok) throw new ScriptCommandError(plainText(read.error.message));
  if (!Number.isFinite(read.value.value)) throw new ScriptCommandError('finiteLength');
  return read.value;
}
export function readScriptCoordinate(context: ScriptCommandContext, source: ScriptCoordinate): CoordinateInput {
  return { mode: 'absolute', x: readScriptLength(context, source[0]), y: readScriptLength(context, source[1]), z: readScriptLength(context, source[2]) };
}
