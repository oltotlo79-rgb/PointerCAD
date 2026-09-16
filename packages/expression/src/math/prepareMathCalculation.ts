import { normalizeIntegerMathOperation } from './integerMathOperations.js';
import { normalizeTensorOperation } from './tensorOperations.js';
import { DeferredExactLinearOperations } from './deferredExactLinearOperations.js';
/** Substitute declared values without simplifying away invalid source operands. */
import {MathInputProblem,type MathNode,type MathSymbolReference} from './mathInputContract.js';
import {substituteMathValues} from './substituteMathValues.js';
import {validateMathDomains} from './realRootDomains.js';
import {reduceExactMatrixRank} from './exactMatrixOperation.js';
import {pruneMathPiecewise,exactMathBoolean} from './pruneMathPiecewise.js';
import {validateElementaryDomains} from './elementaryMathDomains.js';

import {normalizeStatisticsOperation} from './statisticsOperations.js';
import {normalizeElementaryOperation} from './elementaryMathNormalization.js';

export interface MathCalculationContext {
  readonly angleUnit?:'degree'|'radian';
  readonly resolve:(reference:MathSymbolReference)=>MathNode|null;
  /** Only the optional exact engine can evaluate a validated non-rational rank. */
  readonly deferNonRationalRank?:boolean;
  readonly deferNonRationalLinear?:boolean;
}
export type PreparedMathCalculation=
  | {readonly status:'ready';readonly expression:MathNode}
  | {readonly status:'unresolved';readonly reason:'missing-condition';readonly operations:readonly string[]};
export function prepareMathCalculation(source:MathNode,context:MathCalculationContext):PreparedMathCalculation {
  const linear = new DeferredExactLinearOperations(context.deferNonRationalLinear === true);
  const piecewise=pruneMathPiecewise(substituteMathValues(source,context.resolve),condition=>{
    validateElementaryDomains(condition,context.angleUnit);return validateMathDomains(condition).length===0;
  },condition=>exactMathBoolean(reduce(condition)));
  if(piecewise.undecided)return {status:'unresolved',reason:'missing-condition',operations:['which']};
  const substituted=piecewise.expression,obligations=validateMathDomains(substituted);
  validateElementaryDomains(substituted,context.angleUnit);
  if(obligations.length>0)return {status:'unresolved',reason:'missing-condition',operations:[...new Set(obligations.map(value=>'operation' in value?value.operation:'root'))]};
  function reduce(node:MathNode):MathNode {
    if(node.kind==='operation') {
      const value={...node,operands:node.operands.map(reduce)};
      if(node.operation==='rank') {
        const rank=reduceExactMatrixRank(value);
        if(rank===null&&context.deferNonRationalRank) {
          // Reuse the scalar/array validator before handing algebraic entries to
          // another engine; an extra axis or a proposition is not a matrix cell.
          const dimensions=normalizeTensorOperation({kind:'operation',operation:'tensor-shape',operands:value.operands});
          if(dimensions.kind!=='operation'||dimensions.operation!=='list'||dimensions.operands.length!==2) {
            throw new MathInputProblem('domain','行列の階数には数値の成分を二次元に並べてください。');
          }
          return value;
        }
        if(rank===null)throw new MathInputProblem('unsupported','この行列の厳密な階数の条件をまだ決定できません。');
        return rank;
      }
      const component = linear.component(value);
      if (component !== null) return component;
      const tensor=normalizeTensorOperation(value);
      const integer=tensor.kind==='operation'?normalizeIntegerMathOperation(tensor):tensor;
      const normalized=integer.kind==='operation'?normalizeElementaryOperation(integer,context.angleUnit??'radian'):integer;
      const statistics=normalized.kind==='operation'?normalizeStatisticsOperation(normalized):normalized;
      return statistics.kind==='operation'?linear.reduce(statistics):statistics;
    }
    if(node.kind==='binder')return {...node,body:reduce(node.body),bindings:node.bindings.map(binding=>{
      const domain=binding.domain;
      return {...binding,domain:domain.kind==='set'?{...domain,value:reduce(domain.value)}:domain.kind==='range'
        ?{...domain,lower:reduce(domain.lower),upper:reduce(domain.upper),step:domain.step===null?null:reduce(domain.step)}:domain};
    })};
    return node;
  }
  const reduced=reduce(substituted);
  validateElementaryDomains(reduced,context.angleUnit);
  return {status:'ready',expression:reduced};
}
