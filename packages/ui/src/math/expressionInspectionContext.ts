import {
  inspectExpression,
  type ExactEvaluateOptions,
  type ExpressionError,
  type ExpressionInspection,
} from '@pointercad/expression';
import type { StoredMathExpression } from '@pointercad/expression/math/contracts';
import { collectExpressionOwners, collectParameterUsages, expressionParameterNames, type Parameter, type PartDocument } from '@pointercad/model';

export interface VisibleExpressionReference {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  /** The already evaluated parameter table is authoritative for displayed source values. */
  readonly value: number | null;
  readonly circular: boolean;
}

export interface InputExpressionInspection {
  readonly inspection: ExpressionInspection;
  readonly references: readonly VisibleExpressionReference[];
  /** UTF-16 position in the raw typed source; null when the error cannot be identified safely. */
  readonly errorPosition: number | null;
}

/** Read-only projection. The caller keeps its existing evaluation and commit path authoritative. */
export function inspectInputExpression(
  source: string,
  options: ExactEvaluateOptions,
  authoritativeError: ExpressionError | null,
  circularNames: readonly string[] = [],
): InputExpressionInspection | null {
  if (source.trim() === '') return null;
  const inspection = inspectExpression(source, options);
  const references = Object.freeze(inspection.references.map(reference => Object.freeze({
    ...reference,
    value: options.variables?.get(reference.name) ?? null,
    circular: circularNames.includes(reference.name),
  })));
  // Reparse the actual input. An inch display wrapper can shift the field evaluator's
  // position, so never copy that offset into the original source.
  const sameError = authoritativeError !== null && inspection.error?.code === authoritativeError.code;
  // The parser reports unexpectedEnd without a numeric position. In that one case the
  // insertion point after the last UTF-16 code unit is unambiguous and stays visible.
  const errorPosition = sameError && inspection.error?.code === 'unexpectedEnd' ? source.length
    : sameError && inspection.error !== null && inspection.error.position >= 0
      && inspection.error.position <= source.length ? inspection.error.position : null;
  return Object.freeze({ inspection, references, errorPosition });
}

/** Counts expression sites in this part, preserving separate fields even under one owner ID. */
export function countParameterUsageSites(document: PartDocument): ReadonlyMap<string, number> {
  const counts = new Map<string, number>(document.parameters.map(parameter => [parameter.name, 0]));
  for (const source of collectParameterUsages(document)) {
    // The model resolver reads plain sources with the parser and math definitions by
    // coefficient identity. It never guesses from an owner's ID or displayed label.
    for (const name of expressionParameterNames(source, document.parameters)) {
      const prior = counts.get(name);
      if (prior !== undefined) counts.set(name, prior + 1);
    }
  }
  return counts;
}

/** A Math Worker definition, not similarly spelled local variables, must bind every shown name. */
export function matchesMathParameterBindings(
  context: InputExpressionInspection,
  definition: StoredMathExpression,
  parameters: readonly Parameter[],
): boolean {
  if (definition.source !== context.inspection.source) return false;
  const parsedNames = new Set(context.references.map(reference => reference.name));
  const boundNames = new Set(expressionParameterNames({ source: definition.source, mathDefinition: definition }, parameters));
  return parsedNames.size === boundNames.size && [...parsedNames].every(name => boundNames.has(name));
}

/**
 * Number of distinct features whose expressions depend on any of the named parameters, directly
 * or through other parameters. `undefined` means the count cannot be asserted: no name is a
 * parameter, a circular name is involved, or the model walk failed. Never a guessed number.
 */
export function countAffectedFeatures(
  document: PartDocument,
  names: readonly string[],
  circularNames: readonly string[] = [],
): number | undefined {
  try {
    const parameters = document.parameters;
    const affected = new Set(names.filter(name => parameters.some(parameter => parameter.name === name)));
    if (affected.size === 0) return undefined;
    for (let changed = true; changed;) {
      changed = false;
      for (const parameter of parameters) {
        if (affected.has(parameter.name)) continue;
        if (expressionParameterNames(parameter.value, parameters).some(name => affected.has(name))) {
          affected.add(parameter.name);
          changed = true;
        }
      }
    }
    if (circularNames.some(name => affected.has(name))) return undefined;
    const owners = new Set<string>();
    for (const owner of collectExpressionOwners(document)) {
      if (expressionParameterNames(owner, parameters).some(name => affected.has(name))) owners.add(owner.ownerId);
    }
    return owners.size;
  } catch {
    return undefined;
  }
}
