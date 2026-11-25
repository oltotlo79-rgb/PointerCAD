import { FailureTextError, type FailureText } from '../failureText.js';

type PlotKind = 'curve' | 'surface' | 'implicitCurve' | 'implicitSurface';
type WorkerFailure = 'deadline' | 'worker-error' | 'queue-full' | 'disposed';
type StopReason = 'deadline' | 'samples' | 'cells' | 'triangles' | 'vertices' | 'segments' | 'subdivision' | 'roundoff'
  | 'singular' | 'unresolved' | 'domain';

const PRECISION_KEYS = {
  curve: 'functionPlot.failure.curvePrecision',
  surface: 'functionPlot.failure.surfacePrecision',
  implicitCurve: 'functionPlot.failure.implicitCurvePrecision',
  implicitSurface: 'functionPlot.failure.implicitSurfacePrecision',
} as const satisfies Record<PlotKind, string>;

const STOP_KEYS = {
  deadline: 'functionPlot.failure.deadline',
  samples: 'functionPlot.failure.subdivision',
  cells: 'functionPlot.failure.subdivision',
  triangles: 'functionPlot.failure.subdivision',
  vertices: 'functionPlot.failure.subdivision',
  segments: 'functionPlot.failure.subdivision',
  subdivision: 'functionPlot.failure.subdivision',
  roundoff: 'functionPlot.failure.roundoff',
} as const satisfies Record<Exclude<StopReason, 'singular' | 'unresolved' | 'domain'>, string>;

export function functionPlotStopped(kind: PlotKind, reason: StopReason): FailureTextError {
  if (reason === 'domain') return new FailureTextError({ key: kind === 'implicitCurve' ? PRECISION_KEYS[kind]
    : 'functionPlot.failure.implicitSurfaceDomain', parameters: {} });
  if (reason === 'singular' || reason === 'unresolved') {
    return new FailureTextError({ key: kind === 'implicitCurve' ? 'functionPlot.failure.implicitCurveUnresolved'
      : 'functionPlot.failure.implicitSurfaceUnresolved', parameters: {} });
  }
  return new FailureTextError({ key: 'functionPlot.failure.withReason', parameters: {
    guidance: { key: PRECISION_KEYS[kind], parameters: {} }, reason: { key: STOP_KEYS[reason], parameters: {} },
  } });
}

export function functionPlotWorkerFailure(kind: PlotKind, status: WorkerFailure): FailureTextError {
  switch (status) {
    case 'deadline': return functionPlotStopped(kind, status);
    case 'queue-full': return new FailureTextError({ key: 'functionPlot.failure.queueFull', parameters: {} });
    case 'disposed': return new FailureTextError({ key: 'math.error.function.engineUnavailable', parameters: {} });
    case 'worker-error': return new FailureTextError(internalFunctionPlotFailure(kind, status));
  }
}

export function internalFunctionPlotFailure(stage: string, cause: unknown): FailureText {
  console.error('PointerCAD function plot', stage, cause);
  return { key: 'assembly.error.internal', parameters: {} };
}
