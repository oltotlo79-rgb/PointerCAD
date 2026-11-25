/** Recompute function features before pure sketch resolution. Never retain geometry from another generation. */
import type {
  FunctionCurveWorkerClient,
  FunctionImplicitCurveWorkerClient,
  FunctionImplicitWorkerClient,
  PointContinuationWorkerClient,
  FunctionSurfaceWorkerClient,
} from '@pointercad/expression/math/client';
import { FailureTextError, plainText, type FailureText } from '../failureText.js';




import type { KernelBridge } from '../kernelBridge.js';
import type { ParameterAnalysis } from '../parameters/types.js';
import type { DocumentMathContext } from '../part/evaluateDocumentMath.js';
import type { PartDocument } from '../part/types.js';
import type { ResolvedCurve } from '../sketch/types.js';
import type { FunctionKernelBridge } from './functionCurveGeometry.js';
import { sampleFunctionCurveGeometry } from './sampleFunctionCurveGeometry.js';
import { internalFunctionPlotFailure } from './functionPlotFailure.js';
import { resolveFunctionInputs } from './resolveFunctionInputs.js';
import type { FunctionSurfacePlanCache } from './functionSurfacePlanCache.js';

export interface FunctionRecomputeContext {
  readonly surfacePlans?: FunctionSurfacePlanCache;
  readonly points?: Pick<PointContinuationWorkerClient, 'evaluate'>;
  readonly curves: Pick<FunctionCurveWorkerClient, 'evaluate'>;
  readonly surfaces?: Pick<FunctionSurfaceWorkerClient, 'evaluate'>;
  readonly implicitSurfaces?: Pick<FunctionImplicitWorkerClient, 'evaluate'>;
  readonly implicitCurves?: Pick<FunctionImplicitCurveWorkerClient, 'evaluate'>;
}
export interface FunctionCurvesResult {
  readonly curves: ReadonlyMap<string, readonly ResolvedCurve[]>;
  readonly invalidInputs: ReadonlyMap<string, FailureText>;
  /** invalidInputs のうち、計算部(Worker)が止まって曲線を作れなかった関数の曲線の id(0b-1b。その誤りの code を workerBroken にする)。 */
  readonly workerBrokenInputs: ReadonlySet<string>;
  readonly cancelled: boolean;
}
function supportsFunctions(bridge: KernelBridge): bridge is KernelBridge & FunctionKernelBridge {
  return 'functionSketchCurves' in bridge && typeof bridge.functionSketchCurves === 'function';
}

export async function recomputeFunctionCurves(document: PartDocument, bridge: KernelBridge,
  analysis: ParameterAnalysis | undefined, math: DocumentMathContext | undefined,
  context: FunctionRecomputeContext | undefined, previousInvalid: ReadonlyMap<string, FailureText> | undefined,
  shouldCancel: () => boolean): Promise<FunctionCurvesResult> {
  const curves = new Map<string, readonly ResolvedCurve[]>(), invalidInputs = new Map(previousInvalid), workerBrokenInputs = new Set<string>();
  const current = () => !shouldCancel() && !math?.signal?.aborted && (math?.isCurrent() ?? true);
  const result = (cancelled: boolean): FunctionCurvesResult => ({ curves: cancelled ? new Map() : curves, invalidInputs, workerBrokenInputs, cancelled });
  let inputRevision = 0;
  for (const sketch of document.sketches) for (const feature of sketch.features) {
    if (!current()) return result(true);
    if (feature.kind !== 'functionCurve' || invalidInputs.has(feature.id)) continue;
    try {
      if (math === undefined || context === undefined || analysis === undefined || !supportsFunctions(bridge)) {
        invalidInputs.set(feature.id, { key: 'math.error.function.engineUnavailable', parameters: {} });
        continue;
      }
      const inputs = await resolveFunctionInputs(document, feature.definition, analysis, current);
      if (inputs.status === 'cancelled') return result(true);
      const sampled=await sampleFunctionCurveGeometry(feature.id,feature.definition.formula,inputs.ranges,{coefficients:inputs.coefficients,
        identity:{...math.identity,editorId:'document-function',inputRevision:++inputRevision}},context,math.signal,current);
      if(sampled===null || !current()) return result(true);
      if(sampled.components.length===0 && sampled.bezier===undefined){
        // Empty geometry cannot supply an endpoint. Mark the owner invalid before
        // resolving relative points and their connected constraint components.
        invalidInputs.set(feature.id,{ key: 'math.error.function.emptyCurve', parameters: {} });
        continue;
      }
      const geometry = await bridge.functionSketchCurves(sampled);
      if (!current() || geometry.status === 'cancelled') return result(true);
      if (geometry.status === 'failed' && geometry.code === 'workerBroken') workerBrokenInputs.add(feature.id);
      if (geometry.status === 'failed') throw new FailureTextError(plainText(geometry.message));
      curves.set(feature.id, geometry.curves);
    } catch (error) {
      if (!current()) return result(true);
      invalidInputs.set(feature.id, error instanceof FailureTextError ? error.text
        : internalFunctionPlotFailure('curve recompute', error));
    }
  }
  return result(false);
}
