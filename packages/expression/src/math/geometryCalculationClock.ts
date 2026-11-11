import { MathInputProblem, pacedCalculationMs, type MathNode, type MathOperationDefinition } from './mathInputContract.js';
import type { MathBackendBox } from './numericMathBoundary.js';
import type { DisplayMathJson } from './mathNotationConversion.js';
import type { EngineMathJson } from './encodeMathJson.js';
import type { PreparedScalarMathContext } from './evaluatePreparedScalarMath.js';
import type { PreparedOdeFunction } from './odeFunctionLowering.js';

export interface MathExecutionBackend {
  /** Present only after this geometry request's ODEs have been solved and verified. */
  readonly prepareOdeFunction?: (source: MathNode, context: PreparedScalarMathContext) => PreparedOdeFunction;
  /** Parse raw LaTeX only. No canonicalization, evaluation, bindings, or ambient name assignment. */
  readonly parseLatex:(source:string)=>unknown;
  readonly serializeLatex:(expression:DisplayMathJson)=>string;
  readonly operations:ReadonlyMap<string,MathOperationDefinition>;
  readonly operationsById:ReadonlyMap<string,MathOperationDefinition>;
  /** Backend is configured for JIT off, radians, finite precision/iteration/recursion before use. */
  readonly box:(expression:EngineMathJson)=>MathBackendBox;
  /** Classify validated input before preparation; allowances remain relative to the current request. */
  readonly prepareDeadline?: (expression: MathNode) => void;
  /** One synchronous block of 200ms at the machine's pace (`pacedCalculationMs`), or of `allowance` ms of this machine
   * when given (only the point calculations below pass it, already paced).
   * A nested block never outlasts the block around it. */
  readonly withinDeadline:<T>(operation:()=>T extends Promise<unknown> ? never : T,allowance?:number)=>T;
}
/** The backend's wall clock (200ms per synchronous block, 1s or 3s for the special functions) ended a block.
 * Every existing reader still sees a 'budget' problem; the Worker entry tells this stop apart from a step or
 * size limit, calculates only that stage once more and reports a second stop as the time limit ('deadline'). */
export class MathDeadlineExceeded extends MathInputProblem {
  constructor() {
    super('budget', '計算時間の上限に達しました。式や範囲を小さくしてください。');
    this.name = 'MathDeadlineExceeded';
  }
}
/** The user's limit for one calculation that makes a shape from a function (decided 2026-09-26): a point search
 * or continuation on a function, and the samples of a function curve or surface (also when a document is reopened).
 * Ordinary expressions in the input fields keep their 200ms. Both are stated for a machine at its usual speed and
 * stretch with the machine's current pace (v1.0.2, `pacedCalculationMs`). */
export const GEOMETRY_CALCULATION_MS=2000;
interface GeometryStop {readonly status:'stopped';readonly reason:'deadline'|'budget'}
/** The clock of one such calculation, started when its request was decoded. Every block of the calculation (given
 * this clock's backend) may use the time left until the same moment as `shouldStop`, never a fresh 200ms. A stop by
 * the wall clock is the time limit ('deadline'); a step or size limit stays 'budget'. */
export function geometryCalculationClock(backend:MathExecutionBackend,started:number) {
  let exceeded=false;
  const limit=pacedCalculationMs(GEOMETRY_CALCULATION_MS);
  const left=():number=>Math.max(0,limit-(performance.now()-started));
  const shouldStop=():'deadline'|undefined=>performance.now()-started>=limit?'deadline':undefined;
  const timeStopped=():boolean=>exceeded||shouldStop()!==undefined;
  const watched:MathExecutionBackend={...backend,
    withinDeadline:<T>(operation:()=>T extends Promise<unknown> ? never : T,allowance?:number):T=>{
      try{return backend.withinDeadline<T>(operation,allowance??left());}
      catch(error){if(error instanceof MathDeadlineExceeded)exceeded=true;throw error;}
    }};
  return {
    /** Pass this backend to the calculation: its blocks use the time left and report their wall-clock stops. */
    backend:watched,shouldStop,timeStopped,
    /** One block around the whole calculation, ending with `shouldStop`. */
    run<T>(operation:()=>T extends Promise<unknown> ? never : T):T {
      return watched.withinDeadline<T>(operation);
    },
    /** A calculation that caught a wall-clock stop reports 'budget'; report it as the time limit. */
    settle<R extends {readonly status:string}>(result:R):R {
      return result.status==='stopped'&&'reason' in result&&result.reason==='budget'&&timeStopped()
        ?{...result,reason:'deadline' as const}:result;
    },
    /** The stop for a thrown problem, or undefined when the problem is not a stop. */
    stopped(error:unknown):GeometryStop|undefined {
      if(!(error instanceof MathInputProblem)||error.code!=='budget')return undefined;
      return {status:'stopped',reason:error instanceof MathDeadlineExceeded||timeStopped()?'deadline':'budget'};
    },
  };
}
