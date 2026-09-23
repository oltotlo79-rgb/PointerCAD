import { containsEquationCalculation } from './equationSolutions.js';
import { containsFourierSeries } from './fourierSeries.js';
import { containsIntegralTransform } from './integralTransforms.js';
import { containsDiscreteFourier } from './discreteFourierTransforms.js';
import { normalizeBesselFunction } from './besselFunctions.js';
import { normalizeAiryFunction } from './airyFunctions.js';
import { normalizeZetaFunction } from './zetaFunctions.js';
import { normalizeEllipticFunction } from './ellipticFunctions.js';
import { normalizeLambertW } from './lambertWFunctions.js';
import { TAYLOR_IDS, taylorFunction, containsSeriesCoefficient } from './taylorExpansion.js';
import { lowerLegendrePolynomial } from './legendrePolynomial.js';
import { normalizeErrorFunction } from './errorFunctions.js';
import { normalizeGammaFunction } from './gammaFunctions.js';
import { normalizeBetaFunction } from './betaFunctions.js';
import { SEQUENCE_IDS, sequenceFunction, containsSequenceCalculation } from './sequenceCalculations.js';
import { normalizeIntegerMathOperation } from './integerMathOperations.js';
import { normalizeTensorOperation } from './tensorOperations.js';
import { DeferredExactLinearOperations } from './deferredExactLinearOperations.js';
import { VECTOR_CALCULUS_AT_IDS } from './vectorCalculusAt.js';
import { LINE_INTEGRAL_IDS, validateLineIntegral } from './lineIntegrals.js';
import { REGION_INTEGRAL_IDS, validateRegionIntegral } from './regionIntegrals.js';
import { GENERAL_PROBABILITY_IDS, probabilityFunction } from './generalProbability.js';
/** Substitute declared values without simplifying away invalid source operands. */
import {MathInputProblem,type MathNode,type MathSymbolReference} from './mathInputContract.js';
import {substituteMathValues} from './substituteMathValues.js';
import {validateMathDomains} from './realRootDomains.js';
import {reduceExactMatrixRank} from './exactMatrixOperation.js';
import {pruneMathPiecewise,exactMathBoolean} from './pruneMathPiecewise.js';
import {validateElementaryDomains} from './elementaryMathDomains.js';

import {normalizeStatisticsOperation} from './statisticsOperations.js';
import {normalizeElementaryOperation} from './elementaryMathNormalization.js';

import { containsSetCalculation } from './setBounds.js';

export interface MathCalculationContext {
  readonly deferSets?: boolean;
  readonly angleUnit?:'degree'|'radian';
  readonly resolve:(reference:MathSymbolReference)=>MathNode|null;
  /** Only the optional exact engine can evaluate a validated non-rational rank. */
  readonly deferNonRationalRank?:boolean;
  readonly deferNonRationalLinear?:boolean;
  readonly deferProbability?:boolean;
  readonly deferSequences?:boolean;
  readonly deferTaylor?:boolean;
  readonly deferDiscreteFourier?:boolean;
  readonly deferIntegralTransforms?:boolean;
  readonly deferFourierSeries?:boolean;
  readonly deferEquations?:boolean;
}
export type PreparedMathCalculation=
  | {readonly status:'ready';readonly expression:MathNode}
  | {readonly status:'unresolved';readonly reason:'missing-condition';readonly operations:readonly string[]};
/** The outgoing request and returned-result validation must use identical deferrals. */
export function prepareExactMathCalculation(source: MathNode, context: MathCalculationContext): PreparedMathCalculation {
  return prepareMathCalculation(source, { ...context, deferNonRationalRank: true, deferNonRationalLinear: true,
    deferSets: true, deferSequences: true, deferProbability: true, deferTaylor: true, deferDiscreteFourier: true, deferIntegralTransforms: true, deferFourierSeries: true, deferEquations: true });
}
export function prepareMathCalculation(source:MathNode,context:MathCalculationContext):PreparedMathCalculation {
  if (containsSetCalculation(source, true)) {
    if (!context.deferSets) throw new MathInputProblem('unsupported', '集合の上下限には追加の計算部を使います。');
    return { status: 'ready', expression: substituteMathValues(source, context.resolve) };
  }
  if (containsEquationCalculation(source)) {
    if (!context.deferEquations) throw new MathInputProblem('unsupported', '方程式には追加の計算部を使います。');
    return { status: 'ready', expression: substituteMathValues(source, context.resolve) };
  }
  if (containsFourierSeries(source)) {
    if (!context.deferFourierSeries) throw new MathInputProblem('unsupported', 'フーリエ級数には追加の計算部を使います。');
    return { status: 'ready', expression: substituteMathValues(source, context.resolve) };
  }
  if (containsIntegralTransform(source)) {
    if (!context.deferIntegralTransforms) throw new MathInputProblem('unsupported', '連続変換には追加の計算部を使います。');
    return { status: 'ready', expression: substituteMathValues(source, context.resolve) };
  }
  if (containsDiscreteFourier(source)) {
    if (!context.deferDiscreteFourier) throw new MathInputProblem('unsupported', '離散フーリエ変換には追加の計算部を使います。');
    // The exact decoder checks every original entry before selecting a component.
    return { status: 'ready', expression: substituteMathValues(source, context.resolve) };
  }
  if (containsSeriesCoefficient(source)) {
    if (!context.deferTaylor) throw new MathInputProblem('unsupported', '級数の係数には追加の計算部を使います。');
    // The exact decoder validates every operand and the whole original expansion
    // before selection. A zero or component rewrite here could erase a failure.
    return { status: 'ready', expression: substituteMathValues(source, context.resolve) };
  }
  // A series is a typed expansion, never a scalar for component/zero rewrites.
  if (source.kind === 'operation' && TAYLOR_IDS.has(source.operation)) {
    taylorFunction(source);
    if (!context.deferTaylor) throw new MathInputProblem('unsupported', '級数の展開には追加の計算部を使います。');
    return { status: 'ready', expression: substituteMathValues(source, context.resolve) };
  }
  const linear = new DeferredExactLinearOperations(context.deferNonRationalLinear === true);
  const piecewise=pruneMathPiecewise(substituteMathValues(source,context.resolve),condition=>{
    validateElementaryDomains(condition,context.angleUnit);return validateMathDomains(condition).length===0;
  },condition=>exactMathBoolean(reduce(condition)));
  if(piecewise.undecided)return {status:'unresolved',reason:'missing-condition',operations:['which']};
  const substituted=piecewise.expression,obligations=validateMathDomains(substituted,{deferSequenceBodies:context.deferSequences});
  validateElementaryDomains(substituted,context.angleUnit);
  if(obligations.length>0)return {status:'unresolved',reason:'missing-condition',operations:[...new Set(obligations.map(value=>'operation' in value?value.operation:'root'))]};
  function reduce(node:MathNode):MathNode {
    if(node.kind==='operation') {
      if (TAYLOR_IDS.has(node.operation)) {
        throw new MathInputProblem('domain', '打ち切った級数をそのまま数値として演算できません。展開結果を確認してください。');
      }
      if (SEQUENCE_IDS.has(node.operation)) {
        sequenceFunction(node);
        if (!context.deferSequences) throw new MathInputProblem('unsupported', '数列と漸化式には追加の計算部を使います。');
        // A zero or a selected component must not erase a failed intermediate term.
        return node;
      }
      if (GENERAL_PROBABILITY_IDS.has(node.operation)) {
        probabilityFunction(node);
        if (!context.deferProbability) throw new MathInputProblem('unsupported', '宣言した分布の確率計算には追加の計算部を使います。');
        // Retain every original operand until the declared support is checked.
        return node;
      }
      if (LINE_INTEGRAL_IDS.has(node.operation) || REGION_INTEGRAL_IDS.has(node.operation)) {
        if (REGION_INTEGRAL_IDS.has(node.operation)) validateRegionIntegral(node);
      else validateLineIntegral(node);
        // Both original fields must retain every component and domain obligation.
        return { ...node, operands: [...node.operands.slice(0, 2), ...node.operands.slice(2).map(reduce)] };
      }
      if (VECTOR_CALCULUS_AT_IDS.has(node.operation)) {
        // Keep the original field intact until every component's neighbourhood
        // is proved. A component rewrite here could erase an unselected hole.
        return linear.reduce({ ...node, operands: [node.operands[0], ...node.operands.slice(1).map(reduce)] });
      }
      const value={...node,operands:node.operands.map(reduce)};
      // Keep all original children until the exact evaluator has checked the
      // indexed terms; component/rank rewrites must not erase a failed term.
      if (context.deferSequences && containsSequenceCalculation(value)) return value;
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
      const special = normalizeGammaFunction(normalizeErrorFunction(lowerLegendrePolynomial(integer) ?? integer, context.angleUnit ?? 'radian'), context.angleUnit ?? 'radian');
      const polynomial = normalizeBetaFunction(special, context.angleUnit ?? 'radian');
      const bessel=normalizeBesselFunction(polynomial,context.angleUnit??'radian');
      const lambert=normalizeLambertW(bessel,context.angleUnit??'radian');
      const airy=normalizeAiryFunction(lambert,context.angleUnit??'radian');
      const elliptic=normalizeEllipticFunction(airy,context.angleUnit??'radian');
      const zeta=normalizeZetaFunction(elliptic,context.angleUnit??'radian');
      const normalized=zeta.kind==='operation'?normalizeElementaryOperation(zeta,context.angleUnit??'radian'):zeta;
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
