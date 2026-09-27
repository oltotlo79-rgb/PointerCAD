/** Validate the original geometry envelope before any asynchronous symbolic preparation. */
import { MathInputProblem, type StoredMathExpression } from './mathInputContract.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import type { ExactMathWorkOptions } from './exactMathWorkExecution.js';
import type { MathRequestIdentity, MathWorkRequest } from './mathWorkRequest.js';
import type { ScalarInput } from './scalarMathTape.js';
import { prepareOdeFunctions, type OdeFunctionInput } from './odeFunctionPreparation.js';
import { ExactMathEngineStopped } from './exactMathEngineClient.js';
import { functionWorkCounter, functionWorkRecord } from './functionWorkData.js';
import { decodeFunctionCurveWorkEnvelope } from './functionCurveWorkRequest.js';
import { decodeFunctionSurfaceWorkEnvelope } from './functionSurfaceWorkRequest.js';
import { decodeFunctionImplicitWorkEnvelope } from './functionImplicitWorkRequest.js';
import { decodeFunctionImplicitCurveWorkEnvelope } from './functionImplicitCurveWorkRequest.js';
import { decodeFunctionPointWorkEnvelope } from './functionPointWorkRequest.js';
import { decodeCurvePointWorkEnvelope } from './curvePointWorkEnvelope.js';
import { decodeSurfacePointWorkEnvelope } from './surfacePointWorkEnvelope.js';
import { decodeCurvePointContinuationWorkRequest } from './curvePointContinuationWork.js';
import { decodeSurfacePointContinuationWorkRequest } from './surfacePointContinuationWork.js';
import { decodeFunctionPointContinuationWorkRequest } from './functionPointContinuationWork.js';
import { executeFunctionCurveWorkRequest } from './functionCurveWorkExecution.js';
import { executeFunctionSurfaceWorkRequest } from './functionSurfaceWorkExecution.js';
import { executeFunctionImplicitWorkRequest } from './functionImplicitWorkExecution.js';
import { executeFunctionImplicitCurveWorkRequest } from './functionImplicitCurveWorkExecution.js';
import { executeFunctionPointWorkRequest } from './functionPointWorkExecution.js';
import { executeCurvePointWorkRequest } from './curvePointWorkExecution.js';
import { executeSurfacePointWorkRequest } from './surfacePointWorkExecution.js';
import { executeCurvePointContinuationWork } from './curvePointContinuationWorkExecution.js';
import { executeSurfacePointContinuationWork } from './surfacePointContinuationWorkExecution.js';
import { executeFunctionPointContinuationWork } from './functionPointContinuationWorkExecution.js';

interface GeometryInput {
  readonly independent?: ScalarInput | readonly ScalarInput[];
  readonly outputs?: readonly StoredMathExpression[];
  readonly expression?: StoredMathExpression;
  readonly coefficients: MathWorkRequest['coefficients'];
  readonly fixedAxis?: 'X' | 'Y' | 'Z';
}
interface GeometryWork {
  readonly serial: number;
  readonly identity: MathRequestIdentity;
  readonly replyKind: string;
  readonly inputs: readonly OdeFunctionInput[];
  readonly execute: (backend: MathExecutionBackend) => unknown;
}
function definitions(input: GeometryInput): readonly OdeFunctionInput[] {
  const inputs = typeof input.independent === 'string' ? [input.independent]
    : input.independent ?? (['X', 'Y', 'Z'] as const).filter(axis => axis !== input.fixedAxis);
  return (input.outputs ?? (input.expression === undefined ? [] : [input.expression]))
    .map(definition => ({ definition, inputs, coefficients: input.coefficients }));
}
function decode(value: unknown): GeometryWork {
  const raw = functionWorkRecord(value, ['kind', 'serial', 'request']);
  const serial = functionWorkCounter(raw.serial, Number.MAX_SAFE_INTEGER, 1);
  function work(request: { readonly identity: MathRequestIdentity }, inputs: readonly OdeFunctionInput[],
    replyKind: string, execute: (value: unknown, backend: MathExecutionBackend) => unknown): GeometryWork {
    const envelope = { kind: raw.kind, serial, request };
    return { serial, identity: request.identity, inputs, replyKind, execute: backend => execute(envelope, backend) };
  }
  switch (raw.kind) {
    case 'sample-function-curve': {
      const { request } = decodeFunctionCurveWorkEnvelope(value);
      return work(request, definitions(request), 'function-curve-result', executeFunctionCurveWorkRequest);
    }
    case 'sample-function-surface': {
      const { request } = decodeFunctionSurfaceWorkEnvelope(value);
      return work(request, definitions(request), 'function-surface-result', executeFunctionSurfaceWorkRequest);
    }
    case 'sample-function-implicit-surface': {
      const { request } = decodeFunctionImplicitWorkEnvelope(value);
      return work(request, definitions(request), 'function-implicit-surface-result', executeFunctionImplicitWorkRequest);
    }
    case 'sample-function-implicit-curve': {
      const { request } = decodeFunctionImplicitCurveWorkEnvelope(value);
      return work(request, definitions(request), 'function-implicit-curve-result', executeFunctionImplicitCurveWorkRequest);
    }
    case 'solve-function-points': {
      const { request } = decodeFunctionPointWorkEnvelope(value);
      return work(request, definitions(request), 'function-points-result', executeFunctionPointWorkRequest);
    }
    case 'solve-curve-points': {
      const { request } = decodeCurvePointWorkEnvelope(value);
      return work(request, definitions(request), 'curve-points-result', executeCurvePointWorkRequest);
    }
    case 'solve-surface-points': {
      const { request } = decodeSurfacePointWorkEnvelope(value);
      return work(request, definitions(request), 'surface-points-result', executeSurfacePointWorkRequest);
    }
    case 'continue-curve-point': {
      const request = decodeCurvePointContinuationWorkRequest(raw.request);
      return work(request, [...definitions(request.previous), ...definitions(request.current)], 'curve-point-continuation-result', executeCurvePointContinuationWork);
    }
    case 'continue-surface-point': {
      const request = decodeSurfacePointContinuationWorkRequest(raw.request);
      return work(request, [...definitions(request.previous), ...definitions(request.current)], 'surface-point-continuation-result', executeSurfacePointContinuationWork);
    }
    case 'continue-function-point': {
      const request = decodeFunctionPointContinuationWorkRequest(raw.request);
      return work(request, [...definitions(request.previous), ...definitions(request.current)], 'function-point-continuation-result', executeFunctionPointContinuationWork);
    }
    default: throw new MathInputProblem('syntax', '関数の計算依頼の種類を確認できません。');
  }
}
export async function executePreparedFunctionWork(value: unknown, options: ExactMathWorkOptions & {
  readonly onIdentity?: (serial: number, identity: MathRequestIdentity) => void;
}): Promise<unknown> {
  const work = decode(value);
  options.onIdentity?.(work.serial, work.identity);
  try {
    const backend = await prepareOdeFunctions(work.inputs, options);
    const stop = options.shouldStop();
    if (stop !== undefined) throw new ExactMathEngineStopped(stop);
    return work.execute(backend);
  } catch (error) {
    const stats = work.replyKind === 'function-curve-result' ? { samples: 0, cells: 0 }
      : work.replyKind === 'function-surface-result' ? { samples: 0, cells: 0, triangles: 0 }
        : work.replyKind === 'function-implicit-surface-result' ? { gridSamples: 0, cells: 0, vertices: 0, triangles: 0 }
          : work.replyKind === 'function-implicit-curve-result' ? { gridSamples: 0, cells: 0, vertices: 0, segments: 0 } : undefined;
    const result = error instanceof ExactMathEngineStopped ? { status: 'stopped', reason: error.reason, ...(stats === undefined ? {} : { stats }) }
      : error instanceof MathInputProblem ? { status: 'invalid', message: error.message } : null;
    if (result === null) throw error;
    return { kind: work.replyKind, serial: work.serial, identity: work.identity, result };
  }
}
