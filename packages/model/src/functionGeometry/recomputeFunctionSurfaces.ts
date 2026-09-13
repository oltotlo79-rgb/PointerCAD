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

export async function recomputeFunctionSurfaces(document: PartDocument, analysis: ParameterAnalysis | undefined,
  math: DocumentMathContext | undefined, context: FunctionRecomputeContext | undefined,
  previousInvalid: ReadonlyMap<string, string>, shouldCancel: () => boolean) {
  const plans = new Map<string, FunctionSurfacePlan>(), invalidInputs = new Map(previousInvalid);
  const current = () => !shouldCancel() && !math?.signal?.aborted && (math?.isCurrent() ?? true);
  const result = (cancelled: boolean) => ({ plans: cancelled ? new Map<string, FunctionSurfacePlan>() : plans, invalidInputs, cancelled });
  let inputRevision = 0;
  for (const feature of document.solids) {
    if (!current()) return result(true);
    if (feature.kind !== 'functionSurface' || feature.suppressed || invalidInputs.has(feature.id)) continue;
    try {
      if (math === undefined || context === undefined || analysis === undefined) {
        throw new Error('関数曲面の計算部を準備できません。再計算してから作図してください。');
      }
      const inputs = await resolveFunctionInputs(document, feature.definition, analysis, current);
      if (inputs.status === 'cancelled') return result(true);
      const formula = feature.definition.formula;
      if (formula.kind === 'implicit-surface') {
        if (context.implicitSurfaces === undefined) throw new Error('等式の面の計算部を準備できません。再計算してから作図してください。');
        const plan = await recomputeImplicitFunctionSurface(formula, inputs.ranges, { coefficients: inputs.coefficients,
          identity: { ...math.identity, editorId: 'document-function-implicit', inputRevision: ++inputRevision } }, context.implicitSurfaces, math.signal, current);
        if (plan === null) return result(true);
        plans.set(feature.id, plan); continue;
      }
      if (formula.kind !== 'coordinate-surface' && formula.kind !== 'parametric-surface') {
        throw new Error('この曲面の関数形式を計算できません。');
      }
      if (context.surfaces === undefined) throw new Error('関数曲面の計算部を準備できません。再計算してから作図してください。');
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
      if (completion.status !== 'result') throw new Error('関数曲面の計算を完了できませんでした。範囲や精度を見直してください。');
      const sampled = completion.result;
      if (sampled.status === 'invalid') throw new Error(sampled.message);
      if (sampled.status !== 'ready') throw new Error(sampled.status === 'empty'
        ? '指定したXYZ範囲内に面がありません。'
        : '指定した精度で面を計算しきれませんでした。範囲や精度を見直してください。');
      const plan: FunctionSurfacePlan = { kind: 'functionSurface', inputSignature,
        geometry: { vertices: sampled.vertices.map(vertex => vertex.point), triangles: sampled.triangles,
          bounds: { minimum: request.minimum, maximum: request.maximum } } };
      context.surfacePlans?.set(plan);
      plans.set(feature.id, plan);
    } catch (error) {
      if (!current()) return result(true);
      invalidInputs.set(feature.id, error instanceof Error ? error.message : '関数曲面の再計算を完了できませんでした。');
    }
  }
  return result(false);
}
