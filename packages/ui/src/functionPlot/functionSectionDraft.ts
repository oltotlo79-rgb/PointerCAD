/** Coordinate sections retain the parent body and an editable coordinate expression. */
import { expressionValueFromNumber as number, mathScalarExpression, multiplyExpression, type ExpressionValue } from '@pointercad/expression';
import type { MathWorkerClient } from '@pointercad/expression/math/client';
import { addSketch, createSketchFor, FunctionPlotBounds, setActiveSketch, type FunctionPlotAxis, type PartDocument } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { prepareDocumentMathEnvironment } from '../math/prepareDocumentMathEditor.js';
import { commitPlaneSection } from '../sketch/projectionCommands.js';
import { commitWorkPlane } from '../sketch/referenceCommands.js';
import { evaluateFunctionPlotDraft, functionPlotDraft, FUNCTION_AXES, type FunctionScalarDraft } from './functionPlotDraft.js';
import { readFunctionSection, type FunctionSectionAddress } from './functionSectionEdit.js';

export interface FunctionSectionResult {
  readonly document: PartDocument;
  readonly planeId: string;
  readonly sectionId: string;
}

/** XZ has a -Y normal. Compose the sign with the stored AST, preserving coefficients. */
export function commitFunctionSection(document: PartDocument, parentId: string, axis: FunctionPlotAxis,
  coordinate: ExpressionValue, edit?: FunctionSectionAddress): FunctionSectionResult {
  const parent = document.solids.find(feature => feature.id === parentId);
  if (parent?.kind !== 'functionSurface' || parent.suppressed) throw new Error(t('functionPlot.missingCurve'));
  const range = parent.definition.bounds[axis];
  if (!Number.isFinite(coordinate.value) || !Number.isFinite(range.min.value) || !Number.isFinite(range.max.value)
    || range.min.value >= range.max.value || coordinate.value < range.min.value || coordinate.value > range.max.value) {
    throw new Error(t('functionPoint.outside'));
  }
  const specification = { kind: 'workPlane' as const, planeId: axis === 'X' ? 'yz' : axis === 'Y' ? 'xz' : 'xy',
    offset: axis === 'Y' ? multiplyExpression(coordinate, number(-1)) : coordinate };
  if (edit) {
    const previous = readFunctionSection(document, edit);
    if (!previous || previous.parent.id !== parentId) throw new Error(t('functionSection.missing'));
    return { document: { ...document, references: document.references.map(feature => feature.id === previous.planeId
      && feature.kind === 'referencePlane' ? { ...feature, plane: specification } : feature) },
    planeId: previous.planeId, sectionId: edit.featureId };
  }
  const plane = commitWorkPlane(document, specification, false);
  const sketch = commitPlaneSection(createSketchFor(plane.document), plane.featureId, parentId);
  return { document: setActiveSketch(addSketch(plane.document, sketch), sketch.id), planeId: plane.featureId,
    sectionId: sketch.features[sketch.features.length - 1].id };
}

export type FunctionSectionPreparation = { readonly status: 'ready'; readonly result: FunctionSectionResult }
  | { readonly status: 'cancelled' } | { readonly status: 'failed'; readonly message: string };

export async function prepareFunctionSection(document: PartDocument, documentVersion: number, parentId: string,
  axis: FunctionPlotAxis, input: FunctionScalarDraft, client: Pick<MathWorkerClient, 'evaluate'>,
  signal: AbortSignal, isCurrent: () => boolean, edit?: FunctionSectionAddress): Promise<FunctionSectionPreparation> {
  const current = () => !signal.aborted && isCurrent();
  if (!current()) return { status: 'cancelled' };
  const parent = document.solids.find(feature => feature.id === parentId);
  if (parent?.kind !== 'functionSurface' || parent.suppressed) return { status: 'failed', message: t('functionPlot.missingCurve') };
  if (input.source.trim() === '') return { status: 'failed', message: t('functionPlot.required') };
  const evaluated = await evaluateFunctionPlotDraft(document, documentVersion, functionPlotDraft(parent), client, signal, current);
  if (!current() || (!evaluated.ok && evaluated.cancelled)) return { status: 'cancelled' };
  if (!evaluated.ok) return { status: 'failed', message: [...evaluated.fields.values()].join('\n') };
  const bounds = FunctionPlotBounds.read(Object.fromEntries(FUNCTION_AXES.map(key => [key,
    { min: evaluated.definition.bounds[key].min.value, max: evaluated.definition.bounds[key].max.value }])));
  if (!bounds.ok) return { status: 'failed', message: t('functionPlot.invalidRange') };
  const identity = { documentId: document.id, documentVersion, editorId: 'function-section', inputRevision: 1 };
  const environment = await prepareDocumentMathEnvironment(evaluated.prepared, { client, identity, signal, isCurrent: current });
  if (!current()) return { status: 'cancelled' };
  if (environment.coefficientProblem) return { status: 'failed', message: environment.coefficientProblem };
  const completion = await client.evaluate({ identity, source: input.source, angleUnit: input.angleUnit,
    notation: input.accepted?.mathDefinition?.inputNotation ?? 'text', coefficients: environment.coefficients,
    ...(input.accepted?.mathDefinition ? { definition: input.accepted.mathDefinition } : {}) }, 5_000, signal);
  if (!current() || completion.status === 'cancelled') return { status: 'cancelled' };
  if (completion.status !== 'result') return { status: 'failed', message: t('math.workerFailed') };
  const scalar = mathScalarExpression(completion.result);
  if (!scalar.ok) return { status: 'failed', message: scalar.message };
  const prepared = { ...environment.prepared, solids: environment.prepared.solids.map(feature => feature.id === parentId
    ? { ...parent, definition: evaluated.definition } : feature) };
  try { return { status: 'ready', result: commitFunctionSection(prepared, parentId, axis, scalar.value, edit) }; }
  catch (error) { return { status: 'failed', message: error instanceof Error ? error.message : t('math.workerFailed') }; }
}
