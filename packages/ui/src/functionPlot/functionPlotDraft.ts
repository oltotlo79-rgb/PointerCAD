/** Function form fields stay textual until the shared Worker has evaluated every required scalar. */
import { mathScalarExpression, type AngleUnit, type ExpressionValue, type StoredMathExpression } from '@pointercad/expression';
import { FUNCTION_DEFINITION_FORMAT, FunctionPlotBounds, checkGeometryDerivedFunctionOperations,
  mathGeometryDerivedCoefficientIds, mathGeometryDerivedParameters, type FunctionDefinition, type FunctionPlotAxis,
  type MathGeometryOutcome, type PartDocument, type SketchFunctionCurveFeature, type FunctionSurfaceFeature } from '@pointercad/model';
import type { MathWorkerClient } from '@pointercad/expression/math/client';
import { prepareDocumentMathEnvironment } from '../math/prepareDocumentMathEditor.js';
import { t } from '../i18n/t.js';

/**
 * rules/06 §10.317 (GR-18b): the calculation tape has no `equal`; F in "F=0" is what a curve/surface samples, not
 * "A=B". Checked on the parsed root before confirming, so a written "X^2+Y^2=1" is refused with a reason instead
 * of being silently rewritten to "X^2+Y^2-(1)" (which side becomes F is the user's choice). `resolveFunctionInputs`
 * (model) shows the same guidance text for an older saved file that still holds this form.
 */
function implicitEqualsRootRejected(expression: StoredMathExpression['expression']): boolean {
  return expression.kind === 'operation' && expression.operation === 'equal' && expression.operands.length === 2;
}

export type FunctionScalarField = `${FunctionPlotAxis | 'T' | 'U' | 'V'}.${'min' | 'max'}` | 'tolerance' | 'fixedCoordinate';
export interface FunctionTextDraft { readonly source: string; readonly angleUnit: AngleUnit }
export interface FunctionScalarDraft extends FunctionTextDraft { readonly accepted?: ExpressionValue }
export interface FunctionFormulaDraft extends FunctionTextDraft { readonly accepted?: StoredMathExpression }
export interface FunctionPlotDraft {
  readonly geometry: 'curve' | 'surface';
  readonly form: 'coordinate' | 'parametric' | 'implicit';
  readonly independent: FunctionPlotAxis;
  readonly dependent: FunctionPlotAxis;
  readonly fixedAxis: FunctionPlotAxis;
  readonly outputs: Readonly<Record<FunctionPlotAxis, FunctionFormulaDraft>>;
  readonly equation: FunctionFormulaDraft;
  readonly scalars: Readonly<Record<FunctionScalarField, FunctionScalarDraft>>;
}
export const FUNCTION_AXES = ['X', 'Y', 'Z'] as const;
export function functionPlotDraft(feature?: SketchFunctionCurveFeature | FunctionSurfaceFeature,
  geometry: 'curve' | 'surface' = 'curve'): FunctionPlotDraft {
  const formula = feature?.definition.formula;
  const value = (input?: ExpressionValue): FunctionScalarDraft => input
    ? { source: input.source, angleUnit: input.mathDefinition?.angleUnit ?? 'degree', accepted: input } : { source: '', angleUnit: 'degree' };
  const output = (axis: FunctionPlotAxis): FunctionFormulaDraft => {
    const input = formula?.kind === 'coordinate-surface' ? axis === formula.output ? formula.expression : undefined
      : formula?.kind === 'parametric-curve' || formula?.kind === 'parametric-surface' ? formula.outputs[axis]
      : formula?.kind === 'coordinate-curve' ? axis === 'X' && 'X' in formula.outputs ? formula.outputs.X
        : axis === 'Y' && 'Y' in formula.outputs ? formula.outputs.Y : axis === 'Z' && 'Z' in formula.outputs ? formula.outputs.Z : undefined : undefined;
    return input ? { source: input.source, angleUnit: input.angleUnit, accepted: input } : { source: axis === 'Z' ? '0' : '', angleUnit: 'degree' };
  };
  const bounds = feature?.definition.bounds;
  return { geometry: feature === undefined ? geometry : feature.kind === 'functionSurface' ? 'surface' : 'curve',
    form: formula?.kind === 'implicit-surface' || formula?.kind === 'implicit-curve' ? 'implicit' : formula?.kind === 'parametric-curve' || formula?.kind === 'parametric-surface' ? 'parametric' : 'coordinate',
    independent: formula?.kind === 'coordinate-curve' ? formula.independent : 'X',
    dependent: formula?.kind === 'coordinate-surface' ? formula.output : 'Z',
    fixedAxis: formula?.kind === 'implicit-curve' ? formula.fixedAxis : 'Z',
    outputs: { X: output('X'), Y: output('Y'), Z: output('Z') },
    equation: formula?.kind === 'implicit-surface' || formula?.kind === 'implicit-curve' ? {source:formula.expression.source,angleUnit:formula.expression.angleUnit,accepted:formula.expression}
      : {source:'',angleUnit:'degree'},
    scalars: { 'X.min': value(bounds?.X.min), 'X.max': value(bounds?.X.max),
      'Y.min': value(bounds?.Y.min), 'Y.max': value(bounds?.Y.max), 'Z.min': value(bounds?.Z.min), 'Z.max': value(bounds?.Z.max),
      'T.min': value(formula?.kind === 'parametric-curve' ? formula.T.min : undefined),
      'T.max': value(formula?.kind === 'parametric-curve' ? formula.T.max : undefined),
      'U.min': value(formula?.kind === 'parametric-surface' ? formula.U.min : undefined),
      'U.max': value(formula?.kind === 'parametric-surface' ? formula.U.max : undefined),
      'V.min': value(formula?.kind === 'parametric-surface' ? formula.V.min : undefined),
      'V.max': value(formula?.kind === 'parametric-surface' ? formula.V.max : undefined),
      fixedCoordinate:value(formula?.kind==='implicit-curve' ? formula.fixedCoordinate : undefined),
      tolerance: feature ? value(feature.definition.tolerance) : { source: '0.01', angleUnit: 'degree' } } };
}
/** Text edits invalidate the accepted AST, but never reset the user's angle convention. */
export function editFunctionField<T extends FunctionScalarDraft | FunctionFormulaDraft>(input: T, source: string): T {
  return { ...input, source, accepted: undefined };
}
export function functionParameters(draft: FunctionPlotDraft): readonly ('T' | 'U' | 'V')[] {
  return draft.form !== 'parametric' ? [] : draft.geometry === 'surface' ? ['U', 'V'] : ['T'];
}
export function activeFunctionOutputs(draft: FunctionPlotDraft): readonly FunctionPlotAxis[] {
  return draft.form === 'implicit' ? [] : draft.form === 'parametric' ? FUNCTION_AXES : draft.geometry === 'surface' ? [draft.dependent]
    : FUNCTION_AXES.filter(axis => axis !== draft.independent);
}
export function functionDraftScope(draft: FunctionPlotDraft) {
  return { axes: draft.form === 'implicit' ? draft.geometry==='curve' ? FUNCTION_AXES.filter(axis=>axis!==draft.fixedAxis) : FUNCTION_AXES : draft.form === 'parametric' ? [] : draft.geometry === 'surface'
    ? FUNCTION_AXES.filter(axis => axis !== draft.dependent) : [draft.independent], parameters: functionParameters(draft) };
}
export type FunctionDraftResult = { readonly ok: true; readonly definition: FunctionDefinition; readonly prepared: PartDocument }
  | { readonly ok: false; readonly cancelled: boolean; readonly fields: ReadonlyMap<string, string> };

/**
 * rules/06 (GR-18c): the caller supplies the document's CURRENT math-geometry outcomes exactly as
 * `MathExpressionDialog.tsx` does (`mathGeometryInputsFor`, waiting via `waitForMathEditorGeometry` while
 * pending) so `prepareDocumentMathEnvironment`'s `evaluateDocumentMath` can resolve a geometry-derived
 * coefficient instead of leaving the WHOLE document's coefficient list empty (GR-18b's report: an ordinary
 * coefficient sharing the document with an unresolved geometry-derived one failed identically). Omitting
 * `geometry` (scripting, and every pre-existing caller before this fix) keeps exactly today's behaviour.
 */
export async function evaluateFunctionPlotDraft(document: PartDocument, documentVersion: number,
  draft: FunctionPlotDraft, client: Pick<MathWorkerClient, 'evaluate'>, signal: AbortSignal,
  isCurrent: () => boolean, geometry?: ReadonlyMap<string, MathGeometryOutcome>): Promise<FunctionDraftResult> {
  const current = () => !signal.aborted && isCurrent(), fields = new Map<string, string>();
  const failed = (): FunctionDraftResult => ({ ok: false, cancelled: !current(), fields });
  if (!current()) return failed();
  const context = { client, identity: { documentId: document.id, documentVersion }, signal, isCurrent: current,
    ...(geometry === undefined ? {} : { geometry }) };
  const environment = await prepareDocumentMathEnvironment(document, context);
  if (!current()) return failed();
  // A caller that already resolved geometry (so this is a genuine, not merely 計算待ち, problem) gets one
  // clear reason instead of every field that happens to reference any coefficient failing to parse.
  if (geometry !== undefined && environment.coefficientProblem !== null) {
    fields.set('form', environment.coefficientProblem);
    return failed();
  }
  const scope = functionDraftScope(draft), values = new Map<FunctionScalarField, ExpressionValue>(), outputs = new Map<FunctionPlotAxis, StoredMathExpression>();
  const scalarFields: FunctionScalarField[] = ['X.min', 'X.max', 'Y.min', 'Y.max', 'Z.min', 'Z.max', 'tolerance',
    ...(draft.form==='implicit' && draft.geometry==='curve' ? ['fixedCoordinate'] as const : []),
    ...functionParameters(draft).flatMap(parameter => [`${parameter}.min`, `${parameter}.max`] as const)];
  let inputRevision = 0;
  const calculate = async (field: string, source: string, angleUnit: AngleUnit, definition: StoredMathExpression | undefined, formula: boolean) => {
    if (source.trim() === '') { fields.set(field, t('functionPlot.required')); return null; }
    try {
      const result = await client.evaluate({ identity: { ...context.identity, editorId: 'function-form', inputRevision: ++inputRevision },
        source, notation: definition?.inputNotation ?? 'text', angleUnit,
        coefficients: environment.coefficients, ...(definition ? { definition } : {}), ...(formula ? { functionScope: scope } : {}) }, 5_000, signal);
      if (!current()) return null;
      if (result.status !== 'result') { fields.set(field, t('math.workerFailed')); return null; }
      return result.result;
    } catch (error) { if (current()) fields.set(field, error instanceof Error ? error.message : t('math.workerFailed')); return null; }
  };
  for (const key of scalarFields) {
    const input = draft.scalars[key], completion = await calculate(key, input.source, input.angleUnit, input.accepted?.mathDefinition, false);
    if (!current()) return failed();
    if (completion === null) continue;
    const scalar = mathScalarExpression(completion);
    if (!scalar.ok) fields.set(key, scalar.message); else values.set(key, scalar.value);
  }
  for (const axis of activeFunctionOutputs(draft)) {
    const input = draft.outputs[axis], completion = await calculate(axis, input.source, input.angleUnit, input.accepted, true);
    if (!current()) return failed();
    if (completion === null) continue;
    // A refused formula keeps its own reason (e.g. an indefinite integral, MC-20); other states stay generic.
    if (completion.definition === null || completion.evaluation.status !== 'value' || completion.evaluation.kind !== 'function') {
      fields.set(axis, completion.evaluation.status === 'invalid' ? completion.evaluation.detail : t('math.invalidSource'));
    } else outputs.set(axis, completion.definition);
  }
  let equation:StoredMathExpression|undefined;
  if(draft.form==='implicit'){
    const input=draft.equation,completion=await calculate('equation',input.source,input.angleUnit,input.accepted,true);
    if(!current()) return failed();
    if(completion!==null){
      if(completion.definition===null || completion.evaluation.status!=='value' || completion.evaluation.kind!=='function') {
        fields.set('equation',completion.evaluation.status==='invalid' ? completion.evaluation.detail : t('math.invalidSource'));
      } else if(implicitEqualsRootRejected(completion.definition.expression)) fields.set('equation',t('functionPlot.implicitEqualsNotSupported'));
      else equation=completion.definition;
    }
  }
  if (fields.size > 0) return failed();
  const scalar = (key: FunctionScalarField) => { const value = values.get(key); if (!value) throw new Error(t('functionPlot.required')); return value; };
  const output = (axis: FunctionPlotAxis) => { const value = outputs.get(axis); if (!value) throw new Error(t('functionPlot.required')); return value; };
  const range = (axis: FunctionPlotAxis | 'T' | 'U' | 'V') => ({ min: scalar(`${axis}.min`), max: scalar(`${axis}.max`) });
  const bounds = { X: range('X'), Y: range('Y'), Z: range('Z') }, tolerance = scalar('tolerance');
  const box = FunctionPlotBounds.read(Object.fromEntries(FUNCTION_AXES.map(axis => [axis, { min: bounds[axis].min.value, max: bounds[axis].max.value }])));
  if (!box.ok) for (const issue of box.issues) fields.set(`${issue.axis}.${issue.field}`, t('functionPlot.invalidRange'));
  if (!(tolerance.value > 0)) fields.set('tolerance', t('functionPlot.invalidTolerance'));
  for (const parameter of functionParameters(draft)) {
    const width = scalar(`${parameter}.max`).value - scalar(`${parameter}.min`).value;
    if (!(width > 0) || !Number.isFinite(width)) fields.set(`${parameter}.max`, t('functionPlot.invalidRange'));
  }
  if (fields.size > 0) return failed();
  // GR-18b: a formula that feeds a geometry-derived coefficient into an operation that jumps at a value boundary
  // is refused here (before confirming), with GR-06b's own reason placed on the formula field it came from.
  const derivedCoefficientIds = mathGeometryDerivedCoefficientIds(environment.prepared.parameters,
    mathGeometryDerivedParameters(environment.prepared.parameters));
  const rejectGeometryDerived = (candidate: FunctionDefinition): boolean => {
    if (derivedCoefficientIds.size === 0) return false;
    const issue = checkGeometryDerivedFunctionOperations(candidate, derivedCoefficientIds);
    if (issue === null) return false;
    fields.set(issue.output ?? 'equation', issue.message);
    return true;
  };
  if(draft.form==='implicit'){
    if(equation===undefined) {fields.set('equation',t('functionPlot.required'));return failed();}
    const definition: FunctionDefinition = {format:FUNCTION_DEFINITION_FORMAT,bounds,tolerance,
      formula:draft.geometry==='surface' ? {kind:'implicit-surface',expression:equation}
        : {kind:'implicit-curve',expression:equation,fixedAxis:draft.fixedAxis,fixedCoordinate:scalar('fixedCoordinate')}};
    if (rejectGeometryDerived(definition)) return failed();
    return {ok:true,prepared:environment.prepared,definition};
  }
  const formula: FunctionDefinition['formula'] = draft.geometry === 'surface'
    ? draft.form === 'parametric'
      ? { kind: 'parametric-surface', U: range('U'), V: range('V'), outputs: { X: output('X'), Y: output('Y'), Z: output('Z') } }
      : { kind: 'coordinate-surface', output: draft.dependent, expression: output(draft.dependent) }
    : draft.form === 'parametric' ? { kind: 'parametric-curve', T: range('T'), outputs: { X: output('X'), Y: output('Y'), Z: output('Z') } }
    : draft.independent === 'X' ? { kind: 'coordinate-curve', independent: 'X', outputs: { Y: output('Y'), Z: output('Z') } }
      : draft.independent === 'Y' ? { kind: 'coordinate-curve', independent: 'Y', outputs: { X: output('X'), Z: output('Z') } }
        : { kind: 'coordinate-curve', independent: 'Z', outputs: { X: output('X'), Y: output('Y') } };
  const definition: FunctionDefinition = { format: FUNCTION_DEFINITION_FORMAT, bounds, tolerance, formula };
  if (rejectGeometryDerived(definition)) return failed();
  return { ok: true, prepared: environment.prepared, definition };
}
