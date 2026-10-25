/**
 * Assembly parameter table commands (FR-207 for `AssemblyDocument.parameters`, §0.a-0.9). The CORE half of
 * scratchpad/claude/instructions/v103-root-assembly-parameter-contract-r1.md; the panel lives elsewhere.
 *
 * Pure functions with the argument conventions of the part commands (parameterCommands.ts): documents are immutable,
 * a refusal returns a reason and a translated message, every success returns the re-evaluated document, which the
 * caller commits through `applyAssembly` (the existing assembly Undo stack). No part document is read or written and
 * no PartDocument-shaped value is built: the hidden parts of the assembly are never touched.
 *
 * Expression owners of an assembly (packages/model/src/assembly/types.ts): component placement positions, mate
 * values, joint limits, explode distances, joint-step from/to, and the parameters themselves. Rename rewrites all of
 * them by identifier token (`renameVariable`): `a` never changes `aa`, function names or unit spellings; text that
 * does not parse but still tokenizes (`a +`) is renamed too, and only text that cannot be tokenized stays unchanged.
 * Expressions bound by a math definition use IDs, so a document holding any is refused as the part commands do.
 * Re-evaluation uses `assemblyExpressionContext`, the same context `resolveAssembly` evaluates placements with.
 * A command that changes no stored data (same name, identical row contents, an ignored move) returns the same
 * document object, so `applyAssembly` records no Undo step and stored values are not re-evaluated.
 */
import { checkVariableName, evaluateExpression, expressionValueFromNumber, renameVariable,
  type ExpressionValue, type VariableNameIssue } from '@pointercad/expression';
import { addParameter, analyzeParameters, assemblyExpressionContext, expressionParameterNames, nextParameterName,
  removeParameter, renameParameter, reorderParameters, replaceParameter, type AssemblyDocument, type Mate,
  type Parameter, type PresentationStep } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { referencedByMessage, type ParameterCommandRejectionReason, type ParameterRow } from './parameterCommands.js';

export type AssemblyParameterCommandOutcome =
  | { readonly ok: true; readonly document: AssemblyDocument }
  | { readonly ok: false; readonly reason: ParameterCommandRejectionReason; readonly message: string };

/** One expression of the assembly with the display name of the object that owns it (for refusal messages). */
interface AssemblyExpressionOwner {
  readonly ownerName: string;
  readonly value: ExpressionValue;
}

/** Every expression outside the parameter table, in document order. */
export function assemblyExpressionOwners(document: AssemblyDocument): readonly AssemblyExpressionOwner[] {
  const owners: AssemblyExpressionOwner[] = [];
  for (const component of document.components) {
    for (const value of component.placement.position) owners.push({ ownerName: component.name, value });
  }
  for (const mate of document.mates) if (mate.value !== undefined) owners.push({ ownerName: mate.name, value: mate.value });
  for (const joint of document.joints) {
    if (joint.minValue !== null) owners.push({ ownerName: joint.name, value: joint.minValue });
    if (joint.maxValue !== null) owners.push({ ownerName: joint.name, value: joint.maxValue });
  }
  for (const step of document.presentation) {
    if (step.body.kind === 'explode') owners.push({ ownerName: step.name, value: step.body.distance });
    else {
      owners.push({ ownerName: step.name, value: step.body.from });
      owners.push({ ownerName: step.name, value: step.body.to });
    }
  }
  return owners;
}

/** Rewrites every owner expression (not the parameter table) with `map`, keeping object identity when unchanged. */
function mapOwnerExpressions(document: AssemblyDocument, map: (value: ExpressionValue) => ExpressionValue): AssemblyDocument {
  let changed = false;
  const each = (value: ExpressionValue): ExpressionValue => {
    const next = map(value);
    if (next !== value) changed = true;
    return next;
  };
  const components = document.components.map(component => {
    const [x, y, z] = component.placement.position;
    const position = [each(x), each(y), each(z)] as const;
    return position.every((value, index) => value === component.placement.position[index]) ? component
      : { ...component, placement: { ...component.placement, position } };
  });
  const mates = document.mates.map((mate): Mate => {
    if (mate.value === undefined) return mate;
    const value = each(mate.value);
    return value === mate.value ? mate : { ...mate, value };
  });
  const joints = document.joints.map(joint => {
    const minValue = joint.minValue === null ? null : each(joint.minValue);
    const maxValue = joint.maxValue === null ? null : each(joint.maxValue);
    return minValue === joint.minValue && maxValue === joint.maxValue ? joint : { ...joint, minValue, maxValue };
  });
  const presentation = document.presentation.map((step): PresentationStep => {
    if (step.body.kind === 'explode') {
      const distance = each(step.body.distance);
      return distance === step.body.distance ? step : { ...step, body: { ...step.body, distance } };
    }
    const from = each(step.body.from), to = each(step.body.to);
    return from === step.body.from && to === step.body.to ? step : { ...step, body: { ...step.body, from, to } };
  });
  return changed ? { ...document, components, mates, joints, presentation } : document;
}

/**
 * Re-evaluates stored values with the resolver's own context (resolveAssembly.ts `assemblyExpressionContext` /
 * `numberOf`): the source text never changes; a failed evaluation keeps the stored value, as the resolver does.
 */
function reevaluated(document: AssemblyDocument): AssemblyDocument {
  const context = assemblyExpressionContext(document);
  const evaluate = (value: ExpressionValue): ExpressionValue => {
    if (value.mathDefinition !== undefined) return value;
    const result = evaluateExpression(value.source, context);
    if (!result.ok) return value;
    return result.value.value === value.value && result.value.display === value.display ? value
      : { ...result.value, source: value.source };
  };
  const parameters = document.parameters.map(parameter => {
    const value = evaluate(parameter.value);
    return value === parameter.value ? parameter : { ...parameter, value };
  });
  const owners = mapOwnerExpressions(document, evaluate);
  return parameters.every((parameter, index) => parameter === document.parameters[index]) ? owners
    : { ...owners, parameters };
}

function nameIssueMessage(issue: VariableNameIssue): string {
  switch (issue) {
    case 'empty': return t('parameter.error.empty');
    case 'startsWithDigit': return t('parameter.error.startsWithDigit');
    case 'reserved': return t('parameter.error.reserved');
    case 'invalidCharacter': return t('parameter.error.invalidCharacter');
  }
}
function refused(reason: ParameterCommandRejectionReason, message: string): AssemblyParameterCommandOutcome {
  return { ok: false, reason, message };
}
const hasName = (parameters: readonly Parameter[], name: string): boolean => parameters.some(parameter => parameter.name === name);
const applied = (document: AssemblyDocument): AssemblyParameterCommandOutcome => ({ ok: true, document: reevaluated(document) });

/** The new-row default: the next free name, expression `0`, unit mm (same as the part table). */
export function assemblyParameterDraftFor(document: AssemblyDocument): Parameter {
  return { name: nextParameterName(document.parameters), value: expressionValueFromNumber(0), unit: 'mm', description: '' };
}

export function commitAddAssemblyParameter(document: AssemblyDocument, draft: Parameter): AssemblyParameterCommandOutcome {
  const issue = checkVariableName(draft.name);
  if (issue !== null) return refused(issue, nameIssueMessage(issue));
  if (hasName(document.parameters, draft.name)) return refused('duplicateName', t('parameter.error.duplicateName'));
  return applied({ ...document, parameters: addParameter(document.parameters, draft) });
}

/** Names of the objects (and other parameters) that reference `name`; self references do not count. */
function usage(document: AssemblyDocument, name: string): { readonly owners: readonly string[]; readonly count: number } {
  const owners: string[] = [];
  let count = 0;
  for (const parameter of document.parameters) {
    if (parameter.name !== name && expressionParameterNames(parameter.value, document.parameters).includes(name)) count += 1;
  }
  for (const owner of assemblyExpressionOwners(document)) {
    if (!expressionParameterNames(owner.value, document.parameters).includes(name)) continue;
    count += 1;
    if (!owners.includes(owner.ownerName)) owners.push(owner.ownerName);
  }
  return { owners, count };
}

/** Refuses while any placement, mate, joint, step or other parameter still uses the name. */
export function commitRemoveAssemblyParameter(document: AssemblyDocument, name: string): AssemblyParameterCommandOutcome {
  if (!hasName(document.parameters, name)) return refused('notFound', t('parameter.error.notFound'));
  const used = usage(document, name);
  if (used.count > 0) return refused('referenced', referencedByMessage(used.owners, used.count));
  return applied({ ...document, parameters: removeParameter(document.parameters, name) });
}

const hasMathDefinition = (document: AssemblyDocument): boolean =>
  document.parameters.some(parameter => parameter.value.mathDefinition !== undefined)
  || assemblyExpressionOwners(document).some(owner => owner.value.mathDefinition !== undefined);

/** Renames the row and every reference to it in all assembly expressions by identifier token. */
export function commitRenameAssemblyParameter(document: AssemblyDocument, from: string, to: string): AssemblyParameterCommandOutcome {
  if (!hasName(document.parameters, from)) return refused('notFound', t('parameter.error.notFound'));
  if (from === to) return { ok: true, document };
  const issue = checkVariableName(to);
  if (issue !== null) return refused(issue, nameIssueMessage(issue));
  if (hasName(document.parameters, to)) return refused('duplicateRename', t('parameter.error.duplicateName'));
  if (hasMathDefinition(document)) return refused('requiresMathWorker', t('math.rename.requiresWorker'));
  const renamed = mapOwnerExpressions(document, value => {
    const source = renameVariable(value.source, from, to);
    return source === value.source ? value : { ...value, source };
  });
  return applied({ ...renamed, parameters: renameParameter(document.parameters, from, to) });
}

/**
 * Every stored field of the typed row (Parameter / ExpressionValue). A math definition counts as the same only
 * when it is the same object: there is no shared structural equality for it, and an extra Undo step is safer
 * than dropping a real change.
 */
function sameStoredParameter(left: Parameter, right: Parameter): boolean {
  return left.mathId === right.mathId && left.name === right.name && left.unit === right.unit
    && left.description === right.description && left.value.source === right.value.source
    && Object.is(left.value.value, right.value.value) && left.value.display === right.value.display
    && left.value.mathDefinition === right.value.mathDefinition;
}

/** Replaces value, unit or description; a `name` in the patch never renames the row. */
export function commitReplaceAssemblyParameter(document: AssemblyDocument, name: string,
  patch: Partial<Parameter>): AssemblyParameterCommandOutcome {
  const current = document.parameters.find(parameter => parameter.name === name);
  if (current === undefined) return refused('notFound', t('parameter.error.notFound'));
  const next: Parameter = { ...current, ...patch, name: current.name };
  if (sameStoredParameter(current, next)) return { ok: true, document };
  return applied({ ...document, parameters: replaceParameter(document.parameters, name, next) });
}

export function commitReorderAssemblyParameters(document: AssemblyDocument, from: number, to: number): AssemblyParameterCommandOutcome {
  const parameters = reorderParameters(document.parameters, from, to);
  // The model returns the same array for out-of-range, non-integer and same-position moves.
  if (parameters === document.parameters) return { ok: true, document };
  return applied({ ...document, parameters });
}

/**
 * Panel rows in table order. Invalid and circular expressions stay editable with their messages; `unused` counts
 * every assembly expression owner (the resolver's own context counts placements only). No geometry metadata.
 */
export function assemblyParameterRows(document: AssemblyDocument): readonly ParameterRow[] {
  const analysis = analyzeParameters(document.parameters, assemblyExpressionOwners(document).map(owner => owner.value));
  const failures = new Map(analysis.failures.map(failure => [failure.name, failure.message] as const));
  const circular = new Set(analysis.circular), unused = new Set(analysis.unused);
  return document.parameters.map(parameter => ({
    name: parameter.name, source: parameter.value.source,
    value: analysis.variables.get(parameter.name) ?? parameter.value.value, unit: parameter.unit,
    description: parameter.description, circular: circular.has(parameter.name), unused: unused.has(parameter.name),
    failureMessage: failures.get(parameter.name) ?? null,
  }));
}
