import type { FunctionPoint } from './functionGeometryBounds.js';
import type { MathRequestIdentity } from './mathWorkRequest.js';
import { IMPLICIT_STOP_REASONS } from './functionImplicitProtocol.js';

export const IMPLICIT_CURVE_STOP_REASONS=[...IMPLICIT_STOP_REASONS,'segments'] as const;
export interface FunctionImplicitCurveStats {readonly gridSamples:number;readonly cells:number;readonly vertices:number;readonly segments:number}
export type FunctionImplicitCurveWorkResult = {
  readonly status:'ready';readonly components:readonly (readonly FunctionPoint[])[];
  readonly maximumDistanceBound:number;readonly stats:FunctionImplicitCurveStats;
} | {readonly status:'empty';readonly stats:FunctionImplicitCurveStats}
  | {readonly status:'degenerate';readonly stats:FunctionImplicitCurveStats}
  | {readonly status:'stopped';readonly reason:typeof IMPLICIT_CURVE_STOP_REASONS[number];readonly stats:FunctionImplicitCurveStats}
  | {readonly status:'invalid';readonly message:string};
export interface FunctionImplicitCurveWorkReply {
  readonly kind:'function-implicit-curve-result';readonly serial:number;readonly identity:MathRequestIdentity;readonly result:FunctionImplicitCurveWorkResult;
}
