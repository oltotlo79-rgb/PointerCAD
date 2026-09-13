/** Candidate coordinates retain the interval that proves their location; list order is never branch identity. */
import type {FunctionPoint} from './functionGeometryBounds.js';
import type {MathAxis} from './mathInputContract.js';
import type {MathInterval} from './mathInterval.js';

export interface FunctionKnownCoordinate {readonly axis:MathAxis;readonly value:number}
export interface FunctionPointCandidate {
  readonly point:FunctionPoint;
  readonly minimum:FunctionPoint;readonly maximum:FunctionPoint;
  readonly location:{readonly kind:'implicit';readonly axis:MathAxis;readonly interval:MathInterval}
    |{readonly kind:'direct'};
}
export type FunctionPointCandidates={readonly status:'ready';readonly candidates:readonly FunctionPointCandidate[];
  readonly exhaustive:boolean;readonly unresolved:readonly {readonly axis:MathAxis;readonly interval:MathInterval;readonly reason:string}[]}
  |{readonly status:'underconstrained';readonly additionalCoordinates:1}
  |{readonly status:'out-of-range';readonly axes:readonly MathAxis[]}
  |{readonly status:'stopped';readonly reason:'cancelled'|'deadline'|'budget'};
