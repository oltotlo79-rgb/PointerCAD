/** Only exact identities between this surface's parameter boundaries authorize shared topology. */
import { MathInputProblem, type MathNode, type StoredMathExpression } from './mathInputContract.js';
import { readFunctionMathSource } from './functionMathSource.js';
import { functionBoundaryKey } from './functionBoundaryCanonical.js';
import { prepareMathCalculation } from './prepareMathCalculation.js';
import { evaluatePreparedScalarMath, type PreparedScalarMathContext } from './evaluatePreparedScalarMath.js';
import { mathScalarValue } from './mathScalarExpression.js';
import type { FunctionSurfaceWorkRequest } from './functionSurfaceWorkRequest.js';
import { coefficientExpression, substituteCoefficientExpressions, coefficientExpressionMap } from './mathCoefficientExpression.js';
import { createScalarConditionSampler, type ScalarComparison, type ScalarCondition, type ScalarTape } from './scalarMathTape.js';
import { compareRanges, createScalarConditionIntervalSampler, createScalarDefinedIntervalSampler, createScalarIntervalSampler,
  scalarIntervalTape, withScalarIntervalTapes, type ScalarConditionInterval } from './scalarMathIntervals.js';
import { intervalAdd, intervalMultiply, nextFloat, type MathInterval } from './mathInterval.js';
import { rational, type ExactRational } from './exactRational.js';
import { exactDouble, exactDoubleInterval } from './exactDoubleInterval.js';
import { unionOutsideBounds, type IntervalUnion } from './mathIntervalUnion.js';
import type { FunctionPoint, FunctionPointRanges } from './functionGeometryBounds.js';

export interface FunctionSurfaceBoundary {
  readonly periodic: readonly [boolean,boolean];
  /** [U lower/upper, V lower/upper]. True only if the entire boundary is a single point. */
  readonly poles: readonly [readonly [boolean,boolean],readonly [boolean,boolean]];
}
export function proveFunctionSurfaceBoundary(request: FunctionSurfaceWorkRequest,
  context: Omit<PreparedScalarMathContext,'angleUnit'>): FunctionSurfaceBoundary | undefined {
  if (request.independent[0] !== 'U' || request.parameterBounds === undefined) return undefined;
  const { backend } = context, coefficients = new Map(request.coefficients.map(item => [item.id,item]));
  const scope = { axes: [],parameters: [],coefficients: request.coefficients };
  const stop = () => { if (context.shouldStop() !== undefined) throw new MathInputProblem('budget','周期境界の確認を中止しました。'); };
  const coefficient = (id: string): MathNode => {
    const value = coefficients.get(id); if (value === undefined) throw new MathInputProblem('syntax','境界式の係数が見つかりません。');
    return coefficientExpression(value);
  };
  const checked = (raw: StoredMathExpression, expected: number): StoredMathExpression => backend.withinDeadline(() => {
    stop(); const definition = readFunctionMathSource(raw,scope,backend);
    const substituted = substituteCoefficientExpressions(definition.expression, coefficientExpressionMap(request.coefficients, definition.angleUnit));
    const prepared = prepareMathCalculation(substituted,{angleUnit:definition.angleUnit,resolve:()=>null});
    if (prepared.status !== 'ready') throw new MathInputProblem('domain','媒介変数の境界値を確定できません。');
    const result = mathScalarValue(evaluatePreparedScalarMath(prepared.expression,definition.expression,{...context,angleUnit:definition.angleUnit}));
    if (!result.ok || result.value !== expected) throw new MathInputProblem('domain','媒介変数の境界式と現在の値が一致しません。');
    return definition;
  });
  const low = request.parameterBounds.lower.map((value,axis) => checked(value,request.lower[axis]));
  const high = request.parameterBounds.upper.map((value,axis) => checked(value,request.upper[axis]));
  const outputs = request.outputs.map(value => backend.withinDeadline(() => readFunctionMathSource(value,
    {...scope,parameters:['U','V']},backend)));
  const keys = (fixed: ReadonlyMap<string,StoredMathExpression>) => outputs.map(output => {
    stop(); return functionBoundaryKey(output.expression,output.angleUnit,reference => reference.role === 'coefficient'
      ? {expression:coefficient(reference.id),angleUnit:'radian'} : reference.role === 'parameter' ? fixed.get(reference.name) ?? null : null);
  });
  const same = (a: readonly (string|null)[], b: readonly (string|null)[]) => a.every((value,index) => value !== null && value === b[index]);
  const periodic: [boolean,boolean] = [false,false], poles: [[boolean,boolean],[boolean,boolean]] = [[false,false],[false,false]];
  for (const axis of [0,1] as const) {
    const name = axis === 0 ? 'U' : 'V', other = axis === 0 ? 'V' : 'U';
    const a = keys(new Map([[name,low[axis]]])), b = keys(new Map([[name,high[axis]]]));
    periodic[axis] = same(a,b);
    poles[axis][0] = same(a,keys(new Map([[name,low[axis]],[other,low[1-axis]]])));
    poles[axis][1] = same(b,keys(new Map([[name,high[axis]],[other,low[1-axis]]])));
  }
  return {periodic,poles};
}

/*
 * Condition-defined drawing ranges (which conditions and an explicit range condition).
 * A parameter cell is drawn only when every selection is proven on the whole closed cell.
 * A cell on a general condition boundary may be left out only when each branch that can occur
 * there, continued over the cell, stays within the reported error of a drawn vertex. Otherwise
 * the cell is split, and a boundary that cannot be certified is rejected instead of approximated.
 * A square root that the branch's own conditions keep non-negative (a hemisphere under X^2+Y^2<1)
 * continues only over its defined part; every other operation keeps its whole-cell domain.
 */
type ScalarInstruction = ScalarTape['instructions'][number];
type ConditionSites = readonly ConditionSite[];
interface ConditionSite {
  readonly id: number;
  /** Instruction index of the which in its tape; -1 for the explicit range condition. */
  readonly index: number;
  readonly interior: boolean;
  readonly branches: readonly { readonly condition: number; readonly value: ConditionStructure }[];
}
interface ConditionStructure { readonly tape: ScalarTape | undefined; readonly sites: ConditionSites }
interface ConditionSelection { readonly key: string; readonly choices: ReadonlyMap<number, number>; thin: boolean }
type ConditionPending = { readonly sites: ConditionSites; readonly position: number; readonly next: ConditionPending } | null;
interface ConditionThinness { readonly whenTrue: boolean; readonly whenFalse: boolean }
/** What a condition can be at the points of a box, following the point evaluation order of and/or. */
interface ConditionPossibility {
  readonly canTrue: boolean; readonly canFalse: boolean; readonly canUndefined: boolean;
  /** Compared values may meet, which leaves a derivative branch undefined there. */
  readonly boundary: boolean;
}

export interface FunctionConditionBranch {
  /** The same text for the same branch choices in every cell of one sampling. */
  readonly key: string;
  /** Chosen only where an equality holds: a set without length or area that no drawn cell proves. */
  readonly thin: boolean;
  /**
   * Per-axis hull of this branch continued over the whole cell; null when it has no value there. A square root that
   * the branch's conditions keep non-negative contributes only its defined part.
   */
  readonly hull: readonly MathInterval[] | null;
  /** Whether points of this branch in the cell may lie inside the XYZ box. */
  readonly visible: boolean;
}
export interface FunctionConditionCell {
  /**
   * resolved: one selection holds at every point of the closed cell. empty: no point of the cell is drawn.
   * boundary: every visible branch fits within the limit. refine: split the cell; at the depth limit the
   * boundary cannot be certified.
   */
  readonly kind: 'resolved' | 'empty' | 'boundary' | 'refine';
  readonly branches: readonly FunctionConditionBranch[];
  /** resolved: the enclosure of that single branch, equal to the function everywhere on the cell. */
  readonly values?: FunctionPointRanges;
}
export interface FunctionConditionDomain {
  readonly classify: (box: readonly MathInterval[], minimum: FunctionPoint, maximum: FunctionPoint, limit: number) => FunctionConditionCell;
  /** The single selection proven on a closed drawn cell, or null. */
  readonly selection: (box: readonly MathInterval[]) => string | null;
  /** Per-axis hull of a selection seen in this sampling, continued over the box; null when it has no value. */
  readonly hull: (box: readonly MathInterval[], key: string) => readonly MathInterval[] | null;
}

/** An omitted boundary cell uses this share of the tolerance; the covering vertex error uses the rest. */
export const CONDITION_BOUNDARY_SHARE = 0.9375;
const CONDITION_SELECTION_LIMIT = 16, CONDITION_STEP_LIMIT = 1024, FORCED_CACHE_LIMIT = 256;
const TRUE_CONDITION: ScalarCondition = { kind: 'boolean', value: true };
const NO_SITES: ConditionSites = [];
const EMPTY_CELL: FunctionConditionCell = { kind: 'empty', branches: [] };
const REFINE_CELL: FunctionConditionCell = { kind: 'refine', branches: [] };
const STEP_FUNCTIONS: ReadonlySet<string> = new Set(['floor', 'ceiling', 'sign']);

function shapeKey(_name: string, value: unknown): unknown {
  if (typeof value === 'bigint') return `#${value.toString()}n`;
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) {
    return `#${Object.is(value, -0) ? '-0' : String(value)}`;
  }
  return value;
}
function conditionShape(condition: ScalarCondition): unknown {
  switch (condition.kind) {
    case 'boolean': return ['boolean', condition.value];
    case 'not': return ['not', conditionShape(condition.operand)];
    case 'and': case 'or': return [condition.kind, condition.operands.map(conditionShape)];
    case 'comparison': return ['comparison', condition.operation, condition.dynamic, condition.operands.map(tapeShape)];
  }
}
function tapeShape(tape: ScalarTape): unknown {
  return [tape.inputs, tape.angleUnit, tape.output, tape.domainGuards ?? null, tape.instructions.map(instruction =>
    instruction.kind === 'piecewise' ? ['piecewise', instruction.interior, instruction.branches.map(branch =>
      [conditionShape(branch.condition), tapeShape(branch.value)])] : instruction)];
}
/** Structurally equal conditions share one truth value, including the same test in several outputs. */
function conditionKey(condition: ScalarCondition): string { return JSON.stringify(conditionShape(condition), shapeKey); }

function inputDependent(tape: ScalarTape): boolean { return tape.instructions.some(instruction => instruction.kind === 'input'); }
/** The variable-versus-constant cuts that the exact boundary splitting already certifies. */
function exactCut(a: ScalarTape, b: ScalarTape): boolean {
  const left = a.instructions[a.output], right = b.instructions[b.output];
  const constant = left.kind === 'constant' ? left : right.kind === 'constant' ? right : null;
  return (left.kind === 'input' || right.kind === 'input') && constant !== null && constant.enclosure !== null
    && Number.isFinite(constant.enclosure.lower) && Number.isFinite(constant.enclosure.upper)
    && constant.value >= constant.enclosure.lower && constant.value <= constant.enclosure.upper;
}
function generalCondition(condition: ScalarCondition): boolean {
  if (condition.kind === 'boolean') return false;
  if (condition.kind === 'not') return generalCondition(condition.operand);
  if (condition.kind === 'and' || condition.kind === 'or') return condition.operands.some(generalCondition);
  const operands = condition.operands;
  for (let i = 1; i < operands.length; i++) {
    for (let j = condition.operation === 'not-equal' ? 0 : i - 1; j < i; j++) {
      if ((inputDependent(operands[j]) || inputDependent(operands[i])) && !exactCut(operands[j], operands[i])) return true;
    }
  }
  return false;
}
function continuousTape(tape: ScalarTape): boolean {
  return tape.instructions.every(instruction => instruction.kind !== 'piecewise'
    && !(instruction.kind === 'unary' && STEP_FUNCTIONS.has(instruction.operation)));
}
/** An equality of continuous varying values holds only on a curve or point set, never on a cell. */
function thinness(condition: ScalarCondition): ConditionThinness {
  switch (condition.kind) {
    case 'boolean': return { whenTrue: false, whenFalse: false };
    case 'not': {
      const inner = thinness(condition.operand);
      return { whenTrue: inner.whenFalse, whenFalse: inner.whenTrue };
    }
    case 'and': case 'or': {
      const parts = condition.operands.map(thinness), all = condition.kind === 'and';
      return { whenTrue: all ? parts.some(part => part.whenTrue) : parts.every(part => part.whenTrue),
        whenFalse: all ? parts.every(part => part.whenFalse) : parts.some(part => part.whenFalse) };
    }
    case 'comparison': {
      const thin = condition.dynamic && condition.operands.every(continuousTape);
      return { whenTrue: thin && condition.operation === 'equal', whenFalse: thin && condition.operation === 'not-equal' };
    }
  }
}
const IMPOSSIBLE: ConditionPossibility = { canTrue: false, canFalse: false, canUndefined: true, boundary: true };
/**
 * Unlike the drawing enclosure, a later operand that is certainly false still decides and(), because
 * an undefined earlier operand gives no value at all at its points. Each operand is bounded separately.
 */
function createConditionPossibility(condition: ScalarCondition): (box: readonly MathInterval[]) => ConditionPossibility {
  if (condition.kind === 'boolean') {
    const value: ConditionPossibility = { canTrue: condition.value, canFalse: !condition.value, canUndefined: false, boundary: false };
    return () => value;
  }
  if (condition.kind === 'not') {
    const operand = createConditionPossibility(condition.operand);
    return box => { const value = operand(box); return { ...value, canTrue: value.canFalse, canFalse: value.canTrue }; };
  }
  if (condition.kind === 'and' || condition.kind === 'or') {
    const operands = condition.operands.map(createConditionPossibility), all = condition.kind === 'and';
    return box => {
      // A point reaches the next operand only while every earlier operand takes the non-deciding value.
      let reach = true, canTrue = false, canFalse = false, canUndefined = false, boundary = false;
      for (const operand of operands) {
        if (!reach) break;
        const value = operand(box);
        boundary ||= value.boundary; canUndefined ||= value.canUndefined;
        if (all) { canFalse ||= value.canFalse; reach = value.canTrue; } else { canTrue ||= value.canTrue; reach = value.canFalse; }
      }
      if (reach) { if (all) canTrue = true; else canFalse = true; }
      return { canTrue, canFalse, canUndefined, boundary };
    };
  }
  const operation = condition.operation, dynamic = condition.dynamic, operands = condition.operands.map(createScalarIntervalSampler);
  return box => {
    const values = operands.map(evaluate => evaluate(box));
    if (values.some(value => value.ranges.length === 0)) return IMPOSSIBLE;
    let canTrue = true, canFalse = false, boundary = false;
    for (let i = 1; i < values.length; i++) {
      for (let j = operation === 'not-equal' ? 0 : i - 1; j < i; j++) {
        let yes = false, no = false;
        for (const a of values[j].ranges) for (const b of values[i].ranges) {
          const comparison = compareRanges(operation, a, b);
          yes ||= comparison !== false; no ||= comparison !== true;
          boundary ||= dynamic && a.lower <= b.upper && b.lower <= a.upper;
        }
        canTrue &&= yes; canFalse ||= no;
      }
    }
    return { canTrue, canFalse, canUndefined: values.some(value => !value.continuous), boundary };
  };
}
function rangeHull(values: readonly IntervalUnion[]): readonly MathInterval[] | null {
  const hull: MathInterval[] = [];
  for (const value of values) {
    if (value.ranges.length === 0) return null;
    let lower = Infinity, upper = -Infinity;
    for (const range of value.ranges) { lower = Math.min(lower, range.lower); upper = Math.max(upper, range.upper); }
    hull.push({ lower, upper });
  }
  return hull;
}
/** Directed L1 width of a box, which bounds the Euclidean distance between any two of its points. */
function hullDiameter(hull: readonly MathInterval[]): number {
  let total = 0;
  for (const range of hull) {
    if (!Number.isFinite(range.lower) || !Number.isFinite(range.upper)) return Infinity;
    if (range.upper > range.lower) total = nextFloat(total + nextFloat(range.upper - range.lower, 1), 1);
  }
  return total;
}
/**
 * Upper bound for the distance from a point of one branch to a vertex of another branch, when both lie in the
 * box over which the two hulls were continued.
 */
export function functionBranchDistance(first: readonly MathInterval[] | null, second: readonly MathInterval[] | null): number {
  if (first === null || second === null) return Infinity;
  return hullDiameter(first.map((range, axis) => ({ lower: Math.min(range.lower, second[axis].lower),
    upper: Math.max(range.upper, second[axis].upper) })));
}
/** Lower bound for the same distance. It can only grow when the cell is split. */
export function functionBranchSeparation(first: readonly MathInterval[] | null, second: readonly MathInterval[] | null): number {
  if (first === null || second === null) return Infinity;
  let total = 0;
  first.forEach((range, axis) => {
    const gap = Math.max(0, second[axis].lower - range.upper, range.lower - second[axis].upper);
    if (gap > 0) total = Math.max(0, nextFloat(total + Math.max(0, nextFloat(gap, -1)), -1));
  });
  return total;
}
export function functionConditionBoundaryProblem(): MathInputProblem {
  return new MathInputProblem('domain', '条件を満たす範囲の境界を指定した精度で確かめられないため、形を作れません。'
    + '等式だけで成り立つ条件になっていないか、条件・範囲・精度を見直してください。');
}
/** Must run inside the provenance scope. Undefined where an evaluator exposes no scalar tape. */
function scopedOutputTapes(values: readonly IntervalUnion[], inputs: number, known: readonly (ScalarTape | undefined)[]): (ScalarTape | undefined)[] {
  return [0, 1, 2].map(output => {
    const value = values[output];
    if (known[output] !== undefined || value === undefined) return known[output];
    // A value object shared by two outputs carries only the provenance written last. (An output whose
    // enclosure is the shared unknown value is never continuous, so it cannot be drawn by a wrong tape.)
    if (values.some((other, index) => index !== output && other === value)) return undefined;
    const tape = scalarIntervalTape(value);
    return tape !== undefined && tape.inputs.length === inputs ? tape : undefined;
  });
}
/** Evaluate once inside the provenance scope; the values are those of an ordinary evaluation. */
export function functionTapeScope<T extends readonly IntervalUnion[]>(evaluate: () => T, inputs: number):
  { readonly values: T; readonly tapes: readonly (ScalarTape | undefined)[] } {
  return withScalarIntervalTapes(() => {
    const values = evaluate();
    return { values, tapes: scopedOutputTapes(values, inputs, [undefined, undefined, undefined]) };
  });
}
/** Complete missing output tapes from point evaluations, where piecewise guards keep their provenance. */
export function functionOutputTapes(evaluate: (point: readonly number[]) => readonly IntervalUnion[],
  points: readonly (readonly number[])[], inputs: number,
  known: readonly (ScalarTape | undefined)[] = [undefined, undefined, undefined]): readonly (ScalarTape | undefined)[] {
  let tapes = [...known];
  withScalarIntervalTapes(() => {
    for (const point of points) {
      if (tapes.every(tape => tape !== undefined)) break;
      tapes = scopedOutputTapes(evaluate(point), inputs, tapes);
    }
  });
  return tapes;
}
/** Point and box truth of an explicit range condition compiled with the same inputs as the outputs. */
export function createFunctionDomainTest(domain: ScalarCondition): {
  readonly point: (inputs: readonly number[]) => boolean;
  readonly box: (box: readonly MathInterval[]) => ScalarConditionInterval;
} {
  const point = createScalarConditionSampler(domain);
  return { point: inputs => point(inputs).truth === true, box: createScalarConditionIntervalSampler(domain) };
}
/** Outside the range condition there is no value; on its boundary the cell is never continuous. */
export function restrictFunctionRanges(truth: ScalarConditionInterval, evaluate: () => FunctionPointRanges): FunctionPointRanges {
  const none = (): IntervalUnion => ({ ranges: [], continuous: false });
  if (!truth.defined || truth.truth === false) return [none(), none(), none()];
  const values = evaluate();
  if (truth.truth === true) return values;
  const open = (value: IntervalUnion): IntervalUnion => value.continuous ? { ranges: value.ranges, continuous: false } : value;
  return [open(values[0]), open(values[1]), open(values[2])];
}

/*
 * Square roots that the conditions of one branch selection keep defined. Where a selection holds, its chosen conditions
 * are true and every earlier condition of the same which is false, so each compared pair gives a difference P >= 0.
 * A root is guaranteed when its argument equals k*P + c exactly, for a rational k > 0 and a constant c whose directed
 * enclosure is non-negative. Polynomials are compared exactly over the inputs, the constants that no double represents,
 * and every other subexpression as one opaque factor named by its structure; anything else stays unguaranteed.
 * Such a constant is named by its double value and enclosure, so two literals that differ only beyond double precision
 * count as one; that can only miss an undefined strip narrower than that precision.
 */
interface GuaranteeTerm { readonly factors: ReadonlyMap<string, number>; readonly coefficient: ExactRational }
type GuaranteePolynomial = ReadonlyMap<string, GuaranteeTerm>;
interface KnownCondition { readonly condition: ScalarCondition; readonly truth: boolean }
interface DomainGuarantee {
  readonly facts: (known: readonly KnownCondition[]) => readonly GuaranteePolynomial[];
  /** Square roots (instruction indexes per tape, including branch tapes) whose argument the facts keep non-negative. */
  readonly roots: (tape: ScalarTape, facts: readonly GuaranteePolynomial[]) => ReadonlyMap<ScalarTape, ReadonlySet<number>>;
}
const GUARANTEE_TERMS = 32, GUARANTEE_DEGREE = 8;
const RATIONAL_ONE: ExactRational = { numerator: 1n, denominator: 1n }, RATIONAL_MINUS_ONE: ExactRational = { numerator: -1n, denominator: 1n };
const NEGATED: Readonly<Record<ScalarComparison, ScalarComparison>> = { equal: 'not-equal', 'not-equal': 'equal', less: 'greater-equal',
  'less-equal': 'greater', greater: 'less-equal', 'greater-equal': 'less' };
function monomialKey(factors: ReadonlyMap<string, number>): string {
  return JSON.stringify([...factors].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
/** Adds coefficient*monomial in place; false when an exact coefficient leaves the arithmetic budget. */
function addTerm(target: Map<string, GuaranteeTerm>, factors: ReadonlyMap<string, number>, coefficient: ExactRational): boolean {
  const key = monomialKey(factors), previous = target.get(key);
  const total = previous === undefined ? coefficient : rational(previous.coefficient.numerator * coefficient.denominator
    + coefficient.numerator * previous.coefficient.denominator, previous.coefficient.denominator * coefficient.denominator);
  if (total === null) return false;
  if (total.numerator === 0n) target.delete(key); else target.set(key, { factors, coefficient: total });
  return true;
}
/** a + scale*b, or null beyond the size limit. */
function polynomialSum(a: GuaranteePolynomial, b: GuaranteePolynomial, scale: ExactRational): GuaranteePolynomial | null {
  const result = new Map(a);
  for (const term of b.values()) {
    const coefficient = rational(term.coefficient.numerator * scale.numerator, term.coefficient.denominator * scale.denominator);
    if (coefficient === null || !addTerm(result, term.factors, coefficient)) return null;
  }
  return result.size > GUARANTEE_TERMS ? null : result;
}
function polynomialProduct(a: GuaranteePolynomial, b: GuaranteePolynomial): GuaranteePolynomial | null {
  const result = new Map<string, GuaranteeTerm>();
  for (const x of a.values()) for (const y of b.values()) {
    const factors = new Map(x.factors);
    for (const [atom, power] of y.factors) factors.set(atom, (factors.get(atom) ?? 0) + power);
    let degree = 0;
    for (const power of factors.values()) degree += power;
    const coefficient = rational(x.coefficient.numerator * y.coefficient.numerator, x.coefficient.denominator * y.coefficient.denominator);
    if (degree > GUARANTEE_DEGREE || coefficient === null || !addTerm(result, factors, coefficient)) return null;
  }
  return result.size > GUARANTEE_TERMS ? null : result;
}
function createDomainGuarantee(): DomainGuarantee {
  /** Constants that no double represents, by structural name; their directed enclosure bounds c. */
  const constants = new Map<string, MathInterval | null>();
  const names = new WeakMap<ScalarTape, Map<number, string>>(), polynomials = new WeakMap<ScalarTape, Map<number, GuaranteePolynomial>>();
  let opaque = 0;
  const factor = (atom: string): GuaranteePolynomial => {
    const factors = new Map([[atom, 1]]);
    return new Map([[monomialKey(factors), { factors, coefficient: RATIONAL_ONE }]]);
  };
  const constant = (value: ExactRational): GuaranteePolynomial => value.numerator === 0n ? new Map()
    : new Map([[monomialKey(new Map()), { factors: new Map<string, number>(), coefficient: value }]]);
  /** Equal names mean the same function of the inputs in every tape compiled for this function. */
  const nameOf = (tape: ScalarTape, index: number): string => {
    let cache = names.get(tape);
    if (cache === undefined) { cache = new Map(); names.set(tape, cache); }
    const cached = cache.get(index);
    if (cached !== undefined) return cached;
    const instruction: ScalarInstruction | undefined = tape.instructions[index];
    const of = (value: number): string => nameOf(tape, value);
    let name: string;
    if (instruction === undefined || instruction.kind === 'piecewise') name = `#${opaque++}`;
    else if (instruction.kind === 'constant') name = `k(${instruction.value},${instruction.enclosure?.lower},${instruction.enclosure?.upper})`;
    else if (instruction.kind === 'input') name = `x${instruction.slot}`;
    else if (instruction.kind === 'unary') name = `${instruction.operation}(${of(instruction.value)})`;
    else if (instruction.kind === 'binary') name = `${instruction.operation}(${of(instruction.left)},${of(instruction.right)})`;
    else if (instruction.kind === 'rational-power') {
      name = `power(${of(instruction.base)},${instruction.exact.numerator}/${instruction.exact.denominator})`;
    } else if (instruction.kind === 'variadic') name = `${instruction.operation}(${instruction.values.map(of).join(',')})`;
    else if (instruction.kind === 'elliptic') name = `elliptic(${instruction.family},${instruction.orders.join(',')};${instruction.values.map(of).join(',')})`;
    else {
      const { value, ...parameters } = instruction;
      name = `${JSON.stringify(parameters)}(${of(value)})`;
    }
    cache.set(index, name);
    return name;
  };
  const polynomialOf = (tape: ScalarTape, index: number): GuaranteePolynomial => {
    let cache = polynomials.get(tape);
    if (cache === undefined) { cache = new Map(); polynomials.set(tape, cache); }
    const cached = cache.get(index);
    if (cached !== undefined) return cached;
    const instruction: ScalarInstruction | undefined = tape.instructions[index];
    const of = (value: number): GuaranteePolynomial => polynomialOf(tape, value);
    let result: GuaranteePolynomial | null = null;
    if (instruction?.kind === 'constant') {
      const enclosure = instruction.enclosure;
      const exact = enclosure?.lower === instruction.value && enclosure.upper === instruction.value ? exactDouble(instruction.value) : null;
      if (exact !== null) result = constant(exact);
      else if (Number.isFinite(instruction.value)) { constants.set(nameOf(tape, index), enclosure); result = factor(nameOf(tape, index)); }
    } else if (instruction?.kind === 'input') result = factor(nameOf(tape, index));
    else if (instruction?.kind === 'unary' && instruction.operation === 'negate') result = polynomialSum(new Map(), of(instruction.value), RATIONAL_MINUS_ONE);
    else if (instruction?.kind === 'unary' && instruction.operation === 'square') result = polynomialProduct(of(instruction.value), of(instruction.value));
    else if (instruction?.kind === 'binary' && instruction.operation === 'subtract') {
      result = polynomialSum(of(instruction.left), of(instruction.right), RATIONAL_MINUS_ONE);
    } else if (instruction?.kind === 'binary' && instruction.operation === 'divide') {
      const divisor = of(instruction.right).get(monomialKey(new Map()));
      const inverse = divisor === undefined || of(instruction.right).size !== 1 ? null
        : rational(divisor.coefficient.denominator, divisor.coefficient.numerator);
      result = inverse === null ? null : polynomialSum(new Map(), of(instruction.left), inverse);
    } else if (instruction?.kind === 'rational-power' && instruction.exact.denominator === 1n && instruction.exact.numerator > 0n
        && instruction.exact.numerator <= BigInt(GUARANTEE_DEGREE)) {
      result = constant(RATIONAL_ONE);
      for (let power = 0n; power < instruction.exact.numerator && result !== null; power++) result = polynomialProduct(result, of(instruction.base));
    } else if (instruction?.kind === 'variadic' && (instruction.operation === 'add' || instruction.operation === 'multiply')) {
      result = instruction.operation === 'add' ? new Map() : constant(RATIONAL_ONE);
      for (const value of instruction.values) {
        if (result === null) break;
        result = instruction.operation === 'add' ? polynomialSum(result, of(value), RATIONAL_ONE) : polynomialProduct(result, of(value));
      }
    }
    const value = result ?? factor(nameOf(tape, index));
    cache.set(index, value);
    return value;
  };
  const constantOnly = (term: GuaranteeTerm): boolean => [...term.factors.keys()].every(atom => constants.has(atom));
  /** Directed enclosure of a polynomial in constants only; null when a constant has no enclosure. */
  const enclose = (polynomial: GuaranteePolynomial): MathInterval | null => {
    let total: MathInterval = { lower: 0, upper: 0 };
    for (const term of polynomial.values()) {
      let value = exactDoubleInterval(term.coefficient);
      for (const [atom, power] of term.factors) {
        const enclosure = constants.get(atom);
        for (let index = 0; index < power && value !== null; index++) {
          const next = enclosure === undefined || enclosure === null ? null : intervalMultiply(value, enclosure);
          value = next?.status === 'range' ? next.interval : null;
        }
      }
      const next = value === null ? null : intervalAdd(total, value);
      if (next?.status !== 'range') return null;
      total = next.interval;
    }
    return total;
  };
  const nonNegative = (argument: GuaranteePolynomial, facts: readonly GuaranteePolynomial[]): boolean => {
    if ([...argument.values()].every(constantOnly)) return (enclose(argument)?.lower ?? -1) >= 0;
    for (const fact of facts) {
      const pivot = [...fact].find(([, term]) => !constantOnly(term));
      const own = pivot === undefined ? undefined : argument.get(pivot[0]);
      if (pivot === undefined || own === undefined) continue;
      const scale = rational(own.coefficient.numerator * pivot[1].coefficient.denominator, own.coefficient.denominator * pivot[1].coefficient.numerator);
      if (scale === null || scale.numerator <= 0n) continue;
      const rest = polynomialSum(argument, fact, { numerator: -scale.numerator, denominator: scale.denominator });
      if (rest !== null && [...rest.values()].every(constantOnly) && (enclose(rest)?.lower ?? -1) >= 0) return true;
    }
    return false;
  };
  const differences = (condition: ScalarCondition, truth: boolean, out: GuaranteePolynomial[]): void => {
    if (condition.kind === 'boolean') return;
    if (condition.kind === 'not') { differences(condition.operand, !truth, out); return; }
    if (condition.kind === 'and' || condition.kind === 'or') {
      // A true and() or a false or() fixes every operand; the other outcomes fix none of them alone.
      if ((condition.kind === 'and') === truth) for (const operand of condition.operands) differences(operand, truth, out);
      return;
    }
    const values = condition.operands.map(operand => polynomialOf(operand, operand.output));
    const operation = truth ? condition.operation : NEGATED[condition.operation];
    const pairs = truth ? values.slice(1).map((value, index) => [values[index], value] as const)
      : values.length === 2 ? [[values[0], values[1]] as const] : [];
    for (const [left, right] of pairs) {
      const upward = operation === 'less' || operation === 'less-equal' || operation === 'equal' ? polynomialSum(right, left, RATIONAL_MINUS_ONE) : null;
      const downward = operation === 'greater' || operation === 'greater-equal' || operation === 'equal' ? polynomialSum(left, right, RATIONAL_MINUS_ONE) : null;
      if (upward !== null) out.push(upward);
      if (downward !== null) out.push(downward);
    }
  };
  return {
    facts: known => {
      const out: GuaranteePolynomial[] = [];
      for (const { condition, truth } of known) differences(condition, truth, out);
      return out;
    },
    roots: (tape, facts) => {
      const result = new Map<ScalarTape, Set<number>>();
      const visit = (value: ScalarTape): void => value.instructions.forEach((instruction, index) => {
        if (instruction.kind === 'piecewise') { for (const branch of instruction.branches) visit(branch.value); return; }
        const argument = instruction.kind === 'unary' && instruction.operation === 'sqrt' ? instruction.value
          : instruction.kind === 'rational-power' && instruction.exact.denominator === 2n
            && (instruction.exact.numerator === 1n || instruction.exact.numerator === -1n) ? instruction.base : null;
        if (argument === null || facts.length === 0 || !nonNegative(polynomialOf(value, argument), facts)) return;
        const marks = result.get(value) ?? new Set<number>();
        marks.add(index); result.set(value, marks);
      });
      visit(tape);
      return result;
    },
  };
}

/** Null when no general which condition and no range condition exist, so the ordinary sampling is unchanged. */
export function createFunctionConditionDomain(outputs: readonly (ScalarTape | undefined)[],
  unrestricted: (box: readonly MathInterval[]) => readonly IntervalUnion[], domain?: ScalarCondition): FunctionConditionDomain | null {
  const keys = new Map<string, number>(), conditions: ScalarCondition[] = [], sitesById = new Map<number, ConditionSite>();
  let siteCount = 0;
  const register = (condition: ScalarCondition): number => {
    const key = conditionKey(condition);
    let id = keys.get(key);
    if (id === undefined) { id = conditions.length; keys.set(key, id); conditions.push(condition); }
    return id;
  };
  const structure = (tape: ScalarTape): ConditionStructure => {
    const sites: ConditionSite[] = [];
    tape.instructions.forEach((instruction, index) => {
      if (instruction.kind !== 'piecewise') return;
      const id = siteCount++;
      const site: ConditionSite = { id, index, interior: instruction.interior, branches: instruction.branches.map(branch =>
        ({ condition: register(branch.condition), value: structure(branch.value) })) };
      sites.push(site); sitesById.set(id, site);
    });
    return { tape, sites };
  };
  const structures = outputs.map((tape): ConditionStructure => tape === undefined ? { tape, sites: NO_SITES } : structure(tape));
  const general = (value: ConditionStructure): boolean => value.sites.some(site => site.branches.some(branch =>
    generalCondition(conditions[branch.condition]) || general(branch.value)));
  if (domain === undefined && !structures.some(general)) return null;
  const range: ConditionSites = domain === undefined ? NO_SITES : [{ id: -1, index: -1, interior: false,
    branches: [{ condition: register(domain), value: { tape: undefined, sites: NO_SITES } }] }];
  for (const site of range) sitesById.set(site.id, site);
  const possibilities = conditions.map(createConditionPossibility), thin = conditions.map(thinness);
  const seen = new Map<string, ConditionSelection>();
  let start: ConditionPending = null;
  const roots = [range, ...structures.map(value => value.sites)];
  for (let index = roots.length - 1; index >= 0; index--) start = { sites: roots[index], position: 0, next: start };

  /**
   * All branch choices possible somewhere in the box. Equal conditions are assigned once per choice.
   * forked: more than one outcome can occur; holes: some point may have no value at all.
   */
  const enumerate = (box: readonly MathInterval[]) => {
    const truths = new Map<number, ConditionPossibility>(), found = new Map<string, ConditionSelection>();
    let forked = false, holes = false, overflow = false, steps = 0;
    const truth = (id: number): ConditionPossibility => {
      let value = truths.get(id);
      if (value === undefined) { value = possibilities[id](box); truths.set(id, value); }
      return value;
    };
    const walk = (pending: ConditionPending, assigned: ReadonlyMap<number, boolean>, choices: ReadonlyMap<number, number>,
      key: string, thinPath: boolean): void => {
      if (overflow) return;
      if (++steps > CONDITION_STEP_LIMIT) { overflow = true; return; }
      let current = pending;
      while (current !== null && current.position >= current.sites.length) current = current.next;
      if (current === null) {
        const previous = found.get(key);
        if (previous !== undefined) previous.thin &&= thinPath;
        else if (found.size >= CONDITION_SELECTION_LIMIT) overflow = true;
        else found.set(key, { key, choices, thin: thinPath });
        return;
      }
      const site = current.sites[current.position];
      const rest: ConditionPending = { sites: current.sites, position: current.position + 1, next: current.next };
      let assignment = assigned, thinRest = thinPath;
      for (let index = 0; index < site.branches.length; index++) {
        const branch = site.branches[index], known = assignment.get(branch.condition);
        const enter = (values: ReadonlyMap<number, boolean>, thinEntry: boolean): void => walk(
          { sites: branch.value.sites, position: 0, next: rest }, values, new Map(choices).set(site.id, index),
          `${key}${site.id}:${index};`, thinEntry);
        if (known === false) continue;
        if (known === true) { enter(assignment, thinRest); return; }
        const value = truth(branch.condition);
        // A point where the condition has no value is not drawn, and later branches are not reached there.
        if (value.canUndefined) holes = true;
        if (site.interior && value.boundary) forked = true;
        if (!value.canTrue && !value.canFalse) return;
        if (!value.canTrue) continue;
        if (!value.canFalse) { enter(assignment, thinRest); return; }
        forked = true;
        enter(new Map(assignment).set(branch.condition, true), thinRest || thin[branch.condition].whenTrue);
        assignment = new Map(assignment).set(branch.condition, false);
        thinRest ||= thin[branch.condition].whenFalse;
      }
    };
    walk(start, new Map(), new Map(), '', false);
    for (const selection of found.values()) if (!seen.has(selection.key)) seen.set(selection.key, selection);
    return { forked, holes, overflow, selections: [...found.values()] };
  };
  /** The chosen branch continued over a whole cell, keeping every arithmetic domain of that branch. */
  const forceTape = (value: ConditionStructure, choices: ReadonlyMap<number, number>): ScalarTape | null => {
    const tape = value.tape;
    if (tape === undefined) return null;
    if (value.sites.length === 0) return tape;
    const instructions: ScalarInstruction[] = [...tape.instructions];
    for (const site of value.sites) {
      const chosen = choices.get(site.id), original = tape.instructions[site.index];
      if (chosen === undefined || original.kind !== 'piecewise') return null;
      const branch = forceTape(site.branches[chosen].value, choices);
      if (branch === null) return null;
      instructions[site.index] = { ...original, interior: false, branches: [{ condition: TRUE_CONDITION, value: branch }] };
    }
    return { ...tape, instructions };
  };
  const guarantee = createDomainGuarantee(), selectionFacts = new Map<string, readonly GuaranteePolynomial[]>();
  /** Where a selection holds, its chosen conditions are true and every earlier condition of the same which is false. */
  const factsOf = (selection: ConditionSelection): readonly GuaranteePolynomial[] => {
    let facts = selectionFacts.get(selection.key);
    if (facts === undefined) {
      const known: KnownCondition[] = [];
      for (const [id, chosen] of selection.choices) sitesById.get(id)?.branches.forEach((branch, index) => {
        if (index <= chosen) known.push({ condition: conditions[branch.condition], truth: index === chosen });
      });
      facts = guarantee.facts(known);
      selectionFacts.set(selection.key, facts);
    }
    return facts;
  };
  const forced = new Map<string, ((box: readonly MathInterval[]) => IntervalUnion) | null>();
  /** defined: square roots that the selection's conditions keep non-negative enclose only their defined part. */
  const forcedSampler = (output: number, selection: ConditionSelection, defined: boolean): ((box: readonly MathInterval[]) => IntervalUnion) | null => {
    const value = structures[output];
    if (value.tape === undefined || value.sites.length === 0) return null;
    const cacheKey = `${output}|${defined ? 'defined' : 'whole'}|${selection.key}`, cached = forced.get(cacheKey);
    if (cached !== undefined || forced.has(cacheKey)) return cached ?? null;
    if (forced.size >= FORCED_CACHE_LIMIT) forced.clear();
    const tape = forceTape(value, selection.choices), roots = tape === null || !defined ? null : guarantee.roots(tape, factsOf(selection));
    const sampler = tape === null ? null : roots !== null && roots.size > 0
      ? createScalarDefinedIntervalSampler(tape, (source, index) => roots.get(source)?.has(index) === true)
      : defined ? forcedSampler(output, selection, false) : createScalarIntervalSampler(tape);
    forced.set(cacheKey, sampler);
    return sampler;
  };
  /** An output without which, whose square roots the selection's conditions (e.g. an explicit range condition) keep defined. */
  const rootSampler = (output: number, selection: ConditionSelection): ((box: readonly MathInterval[]) => IntervalUnion) | null => {
    const value = structures[output];
    if (value.tape === undefined || value.sites.length > 0) return null;
    const cacheKey = `${output}|roots|${selection.key}`, cached = forced.get(cacheKey);
    if (cached !== undefined || forced.has(cacheKey)) return cached ?? null;
    if (forced.size >= FORCED_CACHE_LIMIT) forced.clear();
    const roots = guarantee.roots(value.tape, factsOf(selection));
    const sampler = roots.size === 0 ? null : createScalarDefinedIntervalSampler(value.tape, (source, index) => roots.get(source)?.has(index) === true);
    forced.set(cacheKey, sampler);
    return sampler;
  };
  /** The selected branch of every output continued over the box; outputs without which use their own enclosure. */
  const continued = (selection: ConditionSelection, box: readonly MathInterval[], defined = false): FunctionPointRanges => {
    let whole: readonly IntervalUnion[] | undefined;
    const value = (output: number): IntervalUnion => {
      const sampler = forcedSampler(output, selection, defined) ?? (defined ? rootSampler(output, selection) : null);
      if (sampler !== null) return sampler(box);
      whole ??= unrestricted(box);
      return whole[output];
    };
    return [value(0), value(1), value(2)];
  };
  return {
    classify: (box, minimum, maximum, limit) => {
      const result = enumerate(box);
      if (result.overflow) return REFINE_CELL;
      if (result.selections.length === 0) return EMPTY_CELL;
      if (!result.forked && !result.holes && result.selections.length === 1) {
        return { kind: 'resolved', branches: [], values: continued(result.selections[0], box) };
      }
      const branches: FunctionConditionBranch[] = [];
      for (const selection of result.selections) {
        const values = continued(selection, box, true), hull = rangeHull(values);
        const visible = hull !== null && !unionOutsideBounds(values, minimum, maximum);
        if (hull !== null && visible && !(hullDiameter(hull) <= limit)) return REFINE_CELL;
        branches.push({ key: selection.key, thin: selection.thin, hull, visible });
      }
      return { kind: 'boundary', branches };
    },
    selection: box => {
      const result = enumerate(box);
      return !result.overflow && !result.forked && !result.holes && result.selections.length === 1 ? result.selections[0].key : null;
    },
    hull: (box, key) => {
      const selection = seen.get(key);
      return selection === undefined ? null : rangeHull(continued(selection, box, true));
    },
  };
}
