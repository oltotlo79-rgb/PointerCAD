import type { MathRequestIdentity } from './mathWorkRequest.js';
import type { ImplicitMesh } from './implicitTetrahedra.js';
import type { ImplicitPrimitiveResult } from './implicitPrimitiveReply.js';

export const IMPLICIT_STOP_REASONS=['cancelled','deadline','samples','cells','subdivision','domain','singular','unresolved','vertices','triangles','roundoff'] as const;
export interface FunctionImplicitStats {readonly gridSamples:number;readonly cells:number;readonly vertices:number;readonly triangles:number}
export type FunctionImplicitWorkResult = {readonly status:'ready';readonly mesh:ImplicitMesh;readonly maximumDistanceBound:number;readonly stats:FunctionImplicitStats}
  | ImplicitPrimitiveResult
  | {readonly status:'empty'|'degenerate';readonly stats:FunctionImplicitStats}
  | {readonly status:'stopped';readonly reason:typeof IMPLICIT_STOP_REASONS[number];readonly stats:FunctionImplicitStats}
  | {readonly status:'invalid';readonly message:string};
export interface FunctionImplicitWorkReply {readonly kind:'function-implicit-surface-result';readonly serial:number;readonly identity:MathRequestIdentity;readonly result:FunctionImplicitWorkResult}
