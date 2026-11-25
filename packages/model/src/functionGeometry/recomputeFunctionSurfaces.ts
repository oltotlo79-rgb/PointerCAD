/** Sample current formulas in the math Worker; the normal geometry Worker owns the resulting CAD. */
import type { ParameterAnalysis } from '../parameters/types.js';
import type { DocumentMathContext } from '../part/evaluateDocumentMath.js';
import type { PartDocument } from '../part/types.js';
import type { FunctionRecomputeContext } from './recomputeFunctionCurves.js';
import type { FunctionSurfacePlan } from './functionSurfaceFeature.js';
import { functionSurfaceRequest } from './functionSurfaceRequest.js';
import { resolveFunctionInputs } from './resolveFunctionInputs.js';
import { recomputeImplicitFunctionSurface } from './recomputeImplicitFunctionSurface.js';
import { functionSurfaceInputSignature } from './functionSurfacePlanCache.js';
import { FailureTextError, plainText, type FailureText } from '../failureText.js';
import { functionPlotStopped, functionPlotWorkerFailure, internalFunctionPlotFailure } from './functionPlotFailure.js';

export async function recomputeFunctionSurfaces(document: PartDocument, analysis: ParameterAnalysis | undefined,
  math: DocumentMathContext | undefined, context: FunctionRecomputeContext | undefined,
  previousInvalid: ReadonlyMap<string, FailureText>, shouldCancel: () => boolean) {
  const plans = new Map<string, FunctionSurfacePlan>(), invalidInputs = new Map(previousInvalid);
  const current = () => !shouldCancel() && !math?.signal?.aborted && (math?.isCurrent() ?? true);
  const result = (cancelled: boolean) => ({ plans: cancelled ? new Map<string, FunctionSurfacePlan>() : plans, invalidInputs, cancelled });
  let inputRevision = 0;
  for (const feature of document.solids) {
    if (!current()) return result(true);
    if (feature.kind !== 'functionSurface' || feature.suppressed || invalidInputs.has(feature.id)) continue;
    try {
      if (math === undefined || context === undefined || analysis === undefined) {
        throw new FailureTextError({ key: 'math.error.function.engineUnavailable', parameters: {} });
      }
      const inputs = await resolveFunctionInputs(document, feature.definition, analysis, current);
      if (inputs.status === 'cancelled') return result(true);
      const formula = feature.definition.formula;
      if (formula.kind === 'implicit-surface') {
        if (context.implicitSurfaces === undefined) throw new FailureTextError({ key: 'functionPlot.failure.implicitSurfaceUnavailable', parameters: {} });
        const plan = await recomputeImplicitFunctionSurface(formula, inputs.ranges, { coefficients: inputs.coefficients,
          identity: { ...math.identity, editorId: 'document-function-implicit', inputRevision: ++inputRevision } }, context.implicitSurfaces, math.signal, current);
        if (plan === null) return result(true);
        plans.set(feature.id, plan); continue;
      }
      if (formula.kind !== 'coordinate-surface' && formula.kind !== 'parametric-surface') {
        throw new Error(`Unexpected formula for a function surface: ${formula.kind}`);
      }
      if (context.surfaces === undefined) {
        throw new FailureTextError({ key: 'math.error.function.engineUnavailable', parameters: {} });
      }
      const request = functionSurfaceRequest(formula, inputs.ranges, { coefficients: inputs.coefficients,
        identity: { ...math.identity, editorId: 'document-function-surface', inputRevision: ++inputRevision } });
      // Every source, evaluated coefficient, range, precision and budget is part of the identity.
      // Editing a point on an unchanged surface need not sample that parent again.
      const inputSignature = functionSurfaceInputSignature(request);
      const cached = context.surfacePlans?.get(inputSignature);
      if (!current()) return result(true);
      if (cached !== undefined) { plans.set(feature.id, cached); continue; }
      const completion = await context.surfaces.evaluate(request, 5_000, math.signal);
      if (!current() || completion.status === 'cancelled') return result(true);
      if (completion.status !== 'result') throw functionPlotWorkerFailure('surface', completion.status);
      const sampled = completion.result;
      if (sampled.status === 'invalid') throw new FailureTextError(plainText(sampled.message));
      if (sampled.status === 'empty') throw new FailureTextError({ key: 'functionPlot.emptySurface', parameters: {} });
      if (sampled.status === 'stopped') {
        if (sampled.reason === 'cancelled') return result(true);
        throw functionPlotStopped('surface', sampled.reason);
      }
      if (sampled.status !== 'ready') throw new FailureTextError({ key: 'functionPlot.failure.surfaceDegenerate', parameters: {} });
      // A certified C1 spline, when the Worker could prove one, is what CAD builds; the certified mesh it was tied to
      // stays in the plan. A declined spline is not an error: the certified triangles are the surface, as before.
      const plan: FunctionSurfacePlan = { kind: 'functionSurface', inputSignature,
        geometry: { vertices: sampled.vertices.map(vertex => vertex.point), triangles: sampled.triangles,
          bounds: { minimum: request.minimum, maximum: request.maximum },
          ...(sampled.spline === undefined ? {} : { spline: sampled.spline }) } };
      context.surfacePlans?.set(plan);
      plans.set(feature.id, plan);
    } catch (error) {
      if (!current()) return result(true);
      invalidInputs.set(feature.id, error instanceof FailureTextError ? error.text
        : internalFunctionPlotFailure('surface recompute', error));
    }
  }
  return result(false);
}
