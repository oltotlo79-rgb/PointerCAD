import { containsMappingCalculation } from './mathMappings.js';
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
import { exactResultAxes, normalizeTensorOperation } from './tensorOperations.js';
import { DeferredExactLinearOperations } from './deferredExactLinearOperations.js';
import { VECTOR_CALCULUS_AT_IDS } from './vectorCalculusAt.js';
import { LINE_INTEGRAL_IDS, validateLineIntegral } from './lineIntegrals.js';
import { REGION_INTEGRAL_IDS, validateRegionIntegral } from './regionIntegrals.js';
import { GENERAL_PROBABILITY_IDS, probabilityFunction } from './generalProbability.js';
/** Substitute declared values without simplifying away invalid source operands. */
import {MATH_INPUT_LIMITS,MathInputProblem,type MathNode,type MathSymbolReference} from './mathInputContract.js';
import {substituteMathValues} from './substituteMathValues.js';
import {validateMathDomains} from './realRootDomains.js';
import {reduceExactMatrixRank} from './exactMatrixOperation.js';
import {pruneMathPiecewise,exactMathBoolean} from './pruneMathPiecewise.js';
import {validateElementaryDomains} from './elementaryMathDomains.js';
import { LINEAR_DEFINITIONS } from './mathOperationMetadata.js';
import { requiresExactCalculus } from './mathExactCalculus.js';
import { hasInfiniteDiscreteRange } from './discreteMathDomains.js';
import { rationalOfExpression } from './exactRational.js';

import {normalizeStatisticsOperation} from './statisticsOperations.js';
import {normalizeElementaryOperation} from './elementaryMathNormalization.js';

import { containsSetCalculation } from './setBounds.js';
import { containsLimitBound } from './limitBounds.js';
import { EXTENDED_OPERATION_DEFINITIONS, type ExtendedLowering } from './mathExtendedOperations.js';
import { LOWERINGS as TOTAL_DIFFERENTIAL_LOWERINGS } from './totalDifferential.js';
import { LOWERINGS as CLOSED_INTEGRAL_LOWERINGS } from './closedIntegrals.js';
import { nativeMathProvenUndefined } from './nativeMathBackend.js';

/**
 * Registered operations implemented by a TypeScript rewrite into existing operations. Each implementing
 * task fills only its own module's LOWERINGS; an entry takes effect once that operation is 'implemented'.
 */
const EXTENDED_LOWERINGS: ReadonlyMap<string, ExtendedLowering> = new Map([
  ...Object.entries(TOTAL_DIFFERENTIAL_LOWERINGS),
  // ∮ and ∯ (MC-19d): the closure is proved in the saved angle unit before the open integral is calculated.
  ...Object.entries(CLOSED_INTEGRAL_LOWERINGS),
].filter(([id]) => EXTENDED_OPERATION_DEFINITIONS.some(value => value.id === id && value.status === 'implemented')));
function lowerExtendedOperations(source: MathNode, angleUnit: 'degree' | 'radian'): MathNode {
  if (EXTENDED_LOWERINGS.size === 0) return source;
  let remaining = MATH_INPUT_LIMITS.nodes * 4;
  function visit(node: MathNode, depth: number): MathNode {
    if (--remaining < 0 || depth > MATH_INPUT_LIMITS.depth * 4) throw new MathInputProblem('budget', '数式の置き換えが大きすぎます。');
    if (node.kind === 'operation') {
      const value = { ...node, operands: node.operands.map(child => visit(child, depth + 1)) };
      const lowering = EXTENDED_LOWERINGS.get(value.operation);
      if (lowering === undefined) return value;
      const lowered = lowering(value, angleUnit);
      if (lowered.kind === 'operation' && lowered.operation === value.operation) {
        throw new MathInputProblem('syntax', '演算の置き換えが同じ演算に戻っています。');
      }
      return visit(lowered, depth + 1);
    }
    if (node.kind === 'binder') return { ...node, body: visit(node.body, depth + 1), bindings: node.bindings.map(binding => {
      const domain = binding.domain;
      return { ...binding, domain: domain.kind === 'set' ? { ...domain, value: visit(domain.value, depth + 1) } : domain.kind === 'range'
        ? { ...domain, lower: visit(domain.lower, depth + 1), upper: visit(domain.upper, depth + 1),
          step: domain.step === null ? null : visit(domain.step, depth + 1) } : domain };
    }) };
    return node;
  }
  return visit(source, 0);
}

/**
 * Registered operations that are not 'implemented', read from the same definitions that enable a lowering above,
 * so no status can both skip the lowering and pass this check. Every calculation that keeps one is rejected as
 * unsupported with the operation's name before an operand is used; an unselected piecewise branch is not calculated.
 */
const PENDING_EXTENDED = EXTENDED_OPERATION_DEFINITIONS.filter(value => value.status !== 'implemented');
const PENDING_EXTENDED_IDS: ReadonlySet<string> = new Set(PENDING_EXTENDED.map(value => value.id));
function pendingExtendedMessage(expression: MathNode): string | null {
  const found = new Set<string>(), stack: MathNode[] = [expression];
  let remaining = MATH_INPUT_LIMITS.nodes;
  while (stack.length > 0) {
    const node = stack.pop(); if (node === undefined) break;
    if (--remaining < 0) throw new MathInputProblem('budget', '数式の構造が複雑すぎます。');
    if (node.kind === 'operation') {
      if (PENDING_EXTENDED_IDS.has(node.operation)) found.add(node.operation);
      stack.push(...node.operands);
    } else if (node.kind === 'binder') {
      stack.push(node.body);
      for (const { domain } of node.bindings) {
        if (domain.kind === 'set') stack.push(domain.value);
        else if (domain.kind === 'range') stack.push(domain.lower, domain.upper, ...(domain.step === null ? [] : [domain.step]));
      }
    }
  }
  const labels = PENDING_EXTENDED.filter(value => found.has(value.id)).map(value => value.label);
  return labels.length === 0 ? null : `「${labels.join('」「')}」の計算にはまだ対応していません。`;
}

/**
 * Operations whose value only the exact runtime calculates and whose original domain only it checks. A component
 * or tensor-element selection must not discard one of them here (like an outer 0, that would hide an invalid value),
 * and it selects from such a vector or matrix only once the result exists. A linear-algebra or rank node that is
 * still present after reduction is one deferred to the exact runtime.
 */
const EXACT_ONLY_IDS: ReadonlySet<string> = new Set<string>([
  'dot', 'cross', 'norm', 'determinant', 'transpose', 'conjugate-transpose', 'trace', 'inverse-matrix', 'rank',
  'limit', 'limit-supremum', 'limit-infimum', 'differentiate-at', ...LINEAR_DEFINITIONS.map(([id]) => id),
  ...VECTOR_CALCULUS_AT_IDS, ...LINE_INTEGRAL_IDS, ...REGION_INTEGRAL_IDS, ...GENERAL_PROBABILITY_IDS, ...SEQUENCE_IDS,
  // ± and ∓ become separate candidates before preparation; every other registered operation is calculated there.
  ...EXTENDED_OPERATION_DEFINITIONS.filter(value => value.result !== 'candidates').map(value => value.id),
]);
function containsExactOnlyValue(source: MathNode): boolean {
  const pending = [source];
  let remaining = MATH_INPUT_LIMITS.nodes * 4;
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (--remaining < 0) throw new MathInputProblem('budget', '成分を選ぶ式が大きすぎます。');
    if (node.kind === 'operation') {
      if (EXACT_ONLY_IDS.has(node.operation)) return true;
      pending.push(...node.operands);
    } else if (node.kind === 'binder') {
      // An improper or discontinuous integral and an infinite series also need the exact proof;
      // a finite quantifier (∀/∃) is decided only by the exact runtime's own enumeration.
      if (requiresExactCalculus(node) || hasInfiniteDiscreteRange(node) || node.operation === 'for-all' || node.operation === 'exists') return true;
      pending.push(node.body);
      for (const { domain } of node.bindings) {
        if (domain.kind === 'set') pending.push(domain.value);
        else if (domain.kind === 'range') pending.push(domain.lower, domain.upper, ...(domain.step === null ? [] : [domain.step]));
      }
    }
  }
  return false;
}
/**
 * A "which" branch condition containing an exact-only value (≈, ∀, ∃, or any other operation only the
 * exact runtime decides) can never resolve to true/false in reduce()'s own exactMathBoolean pass, so
 * pruneMathPiecewise would otherwise report it as a permanently missing condition. The whole request
 * defers to the exact runtime instead, which decodes "which" itself and never evaluates the branch it
 * does not select (cas_input.py).
 */
function containsExactOnlyPiecewiseCondition(source: MathNode): boolean {
  const pending: MathNode[] = [source];
  let remaining = MATH_INPUT_LIMITS.nodes * 4;
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (--remaining < 0) throw new MathInputProblem('budget', '場合分けの式が大きすぎます。');
    if (node.kind === 'operation') {
      if (node.operation === 'which') {
        for (let index = 0; index < node.operands.length; index += 2) {
          if (containsExactOnlyValue(node.operands[index])) return true;
        }
      }
      pending.push(...node.operands);
    } else if (node.kind === 'binder') {
      pending.push(node.body);
      for (const { domain } of node.bindings) {
        if (domain.kind === 'set') pending.push(domain.value);
        else if (domain.kind === 'range') pending.push(domain.lower, domain.upper, ...(domain.step === null ? [] : [domain.step]));
      }
    }
  }
  return false;
}
/** Reject an index outside a result whose axes the explicit operands fix; the exact runtime checks the others. */
function checkExactSelection(value: MathNode, indices: readonly MathNode[], operation: string): void {
  const axes = exactResultAxes(value);
  if (axes === null) return;
  if (axes.length === 0) throw new MathInputProblem('domain', '成分を取り出すベクトルまたは行列を指定してください。');
  const reason = operation === 'tensor-element' ? '各軸に1つずつ、1から成分数までの添字を指定してください。'
    : '成分の番号は各軸の範囲内の整数で指定してください。';
  if (operation === 'tensor-element' ? indices.length !== axes.length : indices.length > axes.length) {
    throw new MathInputProblem('domain', reason);
  }
  indices.forEach((index, axis) => {
    const position = rationalOfExpression(index);
    if (position === null || position.denominator !== 1n || position.numerator < 1n || position.numerator > BigInt(axes[axis])) {
      throw new MathInputProblem('domain', reason);
    }
  });
}
/**
 * Whether a component or tensor-element selection stays for the exact runtime: it would discard an exact-only
 * sibling of the selected cell, or it selects from an exact-only vector or matrix that exists only after calculation.
 */
function keepsExactSelection(node: Extract<MathNode, { kind: 'operation' }>): boolean {
  if (node.operands.length < 2) return false;
  const [array, ...rest] = node.operands, [list] = rest;
  const indices = node.operation === 'component' ? rest : node.operation === 'tensor-element' && rest.length === 1
    && list.kind === 'operation' && list.operation === 'list' ? list.operands : null;
  if (indices === null) return false;
  let value = array;
  for (const [level, index] of indices.entries()) {
    if (value.kind === 'operation' && value.operation === 'matrix' && value.operands.length === 1) value = value.operands[0];
    if (value.kind !== 'operation' || value.operation !== 'list') {
      if (!containsExactOnlyValue(value)) return false;
      checkExactSelection(value, indices.slice(level), node.operation);
      return true;
    }
    const position = rationalOfExpression(index);
    const selected = position !== null && position.denominator === 1n && position.numerator >= 1n
      && position.numerator <= BigInt(value.operands.length) ? Number(position.numerator) - 1 : -1;
    // An invalid index keeps the explicit array's existing reason.
    if (selected < 0) return false;
    if (value.operands.some((sibling, at) => at !== selected && containsExactOnlyValue(sibling))) return true;
    value = value.operands[selected];
  }
  return false;
}
/**
 * Evaluate every cell of a tensor-element selection's plain list, once keepsExactSelection above has
 * ruled out deferring to the exact runtime; tensorOperations.ts selects the rest itself and never gets
 * a chance to check a sibling it does not reduce. component's own plain-list selection does the same
 * check in elementaryMathNormalization.ts, next to where it actually discards a sibling.
 */
function checkTensorElementSiblingsDefined(node: Extract<MathNode, { kind: 'operation' }>, angleUnit: 'degree' | 'radian'): void {
  if (node.operation !== 'tensor-element' || node.operands.length !== 2) return;
  const [array, list] = node.operands;
  if (list.kind !== 'operation' || list.operation !== 'list') return;
  const deadline = performance.now() + 50;
  const check = (): void => { if (performance.now() > deadline) throw new MathInputProblem('budget', '成分の確認が計算時間を超えました。'); };
  let value = array;
  for (const index of list.operands) {
    if (value.kind === 'operation' && value.operation === 'matrix' && value.operands.length === 1) value = value.operands[0];
    if (value.kind !== 'operation' || value.operation !== 'list') return;
    const position = rationalOfExpression(index);
    const selectedIndex = position !== null && position.denominator === 1n && position.numerator >= 1n
      && position.numerator <= BigInt(value.operands.length) ? Number(position.numerator) - 1 : -1;
    if (selectedIndex < 0) return;
    value.operands.forEach((sibling, at) => {
      if (at === selectedIndex) return;
      const reason = nativeMathProvenUndefined(sibling, angleUnit, check);
      if (reason !== null) throw new MathInputProblem('domain', reason);
    });
    value = value.operands[selectedIndex];
  }
}

export interface MathCalculationContext {
  readonly deferMappings?: boolean;
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
  /** A "which" condition decided only by the exact runtime (≈, ∀, ∃, ...). */
  readonly deferExactConditions?:boolean;
}
export type PreparedMathCalculation=
  | {readonly status:'ready';readonly expression:MathNode}
  | {readonly status:'unresolved';readonly reason:'missing-condition';readonly operations:readonly string[]};
/** The outgoing request and returned-result validation must use identical deferrals. */
export function prepareExactMathCalculation(source: MathNode, context: MathCalculationContext): PreparedMathCalculation {
  return prepareMathCalculation(source, { ...context, deferNonRationalRank: true, deferNonRationalLinear: true,
    deferMappings: true, deferSets: true, deferSequences: true, deferProbability: true, deferTaylor: true, deferDiscreteFourier: true,
    deferIntegralTransforms: true, deferFourierSeries: true, deferEquations: true, deferExactConditions: true });
}
export function prepareMathCalculation(source:MathNode,context:MathCalculationContext):PreparedMathCalculation {
  source=lowerExtendedOperations(source,context.angleUnit??'radian');
  if (containsMappingCalculation(source)) {
    if (!context.deferMappings) throw new MathInputProblem('unsupported', '写像には追加の計算部を使います。');
    return { status: 'ready', expression: substituteMathValues(source, context.resolve) };
  }
  if (containsLimitBound(source)) {
    // The exact runtime checks the original tail, including cancelled denominators,
    // before evaluating a bound or allowing any outer operation to consume it.
    return { status: 'ready', expression: substituteMathValues(source, context.resolve) };
  }
  if (containsSetCalculation(source, !context.deferSets)) {
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
  if (containsExactOnlyPiecewiseCondition(source)) {
    if (!context.deferExactConditions) throw new MathInputProblem('unsupported', '条件が追加計算部でしか判定できない場合分けには追加の計算部を使います。');
    // The exact runtime decodes "which" itself and never evaluates the branch it does not select.
    return { status: 'ready', expression: substituteMathValues(source, context.resolve) };
  }
  const linear = new DeferredExactLinearOperations(context.deferNonRationalLinear === true);
  const piecewise=pruneMathPiecewise(substituteMathValues(source,context.resolve),condition=>{
    if(pendingExtendedMessage(condition)!==null)return false;
    validateElementaryDomains(condition,context.angleUnit);return validateMathDomains(condition).length===0;
  },condition=>exactMathBoolean(reduce(condition)));
  // A registered operation without a calculation is rejected here, before a component selection,
  // a numeric-cell check or a condition could discard it. An unselected branch stays unevaluated.
  const pending=pendingExtendedMessage(piecewise.expression);
  if(pending!==null)throw new MathInputProblem('unsupported',pending);
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
      // Like an outer 0, a selection here must not discard an unevaluated exact-only cell; the exact
      // runtime decodes every original cell, then selects from the calculated vector or matrix.
      if (keepsExactSelection(value)) return value;
      checkTensorElementSiblingsDefined(value, context.angleUnit ?? 'radian');
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
