/** Reuse the interval solver in the math Worker; never promote a midpoint to an exact root. */
import { MathInputProblem, type MathEvaluation, type MathNode } from './mathInputContract.js';
import { numericalRootFunction, type NumericalRootIntervals } from './numericalRootResult.js';
import { isolateScalarRoots } from './isolateScalarRoots.js';
import { compileScalarMath } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { createScalarFirstDerivatives } from './scalarCurveCurvature.js';
import { exactDouble } from './exactDoubleInterval.js';
import { rationalOfExpression } from './exactRational.js';
import { mathScalarValue } from './mathScalarExpression.js';
import { prepareMathCalculation } from './prepareMathCalculation.js';
import { evaluatePreparedScalarMath, type PreparedScalarMathContext } from './evaluatePreparedScalarMath.js';
import type { MathInterval } from './mathInterval.js';

type Resolution = { readonly expression: MathNode; readonly evaluation?: never }
  | { readonly expression?: never; readonly evaluation: MathEvaluation };
class Stopped extends Error {
  constructor(readonly reason: 'cancelled' | 'deadline' | 'budget') { super(reason); }
}
function doubleNode(value: number): MathNode {
  const exact = exactDouble(value);
  if (exact === null) throw new MathInputProblem('domain', '有限でない解の区間は使えません。');
  const number = (decimal: string): MathNode => ({ kind: 'number', decimal });
  return exact.denominator === 1n ? number(String(exact.numerator))
    : { kind: 'operation', operation: 'divide', operands: [number(String(exact.numerator)), number(String(exact.denominator))] };
}
export function resolveNumericalRoots(source: MathNode, original: MathNode, context: PreparedScalarMathContext): Resolution {
  const pending = [source]; let scan = 4096, found = false;
  while (pending.length > 0) {
    if (--scan < 0) throw new MathInputProblem('budget', '解探索の構造が複雑すぎます。');
    const node = pending.pop();
    if (node?.kind === 'operation') {
      if (node.operation === 'numerical-roots' || node.operation === 'root-interval') { found = true; break; }
      pending.push(...node.operands);
    } else if (node?.kind === 'binder') {
      pending.push(node.body);
      for (const { domain } of node.bindings) {
        if (domain.kind === 'set') pending.push(domain.value);
        else if (domain.kind === 'range') {
          pending.push(domain.lower, domain.upper); if (domain.step !== null) pending.push(domain.step);
        }
      }
    }
  }
  if (!found) return { expression: source };
  let remaining = 4096;
  const check = (): void => { const stop = context.shouldStop(); if (stop !== undefined) throw new Stopped(stop); };
  const constant = (node: MathNode): number => {
    check();
    const prepared = prepareMathCalculation(node, { angleUnit: context.angleUnit, resolve: () => null });
    if (prepared.status !== 'ready') throw new MathInputProblem('domain', '解を探す式の定数を確定してください。');
    const result = mathScalarValue(evaluatePreparedScalarMath(prepared.expression, node, context));
    if (!result.ok) throw new MathInputProblem('domain', result.message);
    return result.value;
  };
  function closedRange(node: MathNode): MathInterval {
    const tape = compileScalarMath(node, { inputs: [], angleUnit: context.angleUnit, evaluateConstant: constant });
    const range = createScalarIntervalSampler(tape)([]);
    if (!range.continuous || range.ranges.length !== 1 || !Number.isFinite(range.ranges[0].lower)
      || !Number.isFinite(range.ranges[0].upper)) throw new MathInputProblem('domain', '探索範囲と精度を有限の実数として確定してください。');
    return range.ranges[0];
  }
  function calculate(node: MathNode): NumericalRootIntervals {
    check();
    const fn = numericalRootFunction(node);
    if (node.kind !== 'operation') throw new MathInputProblem('syntax', '解探索の条件がありません。');
    const lower = closedRange(node.operands[1]), upper = closedRange(node.operands[2]), tolerance = closedRange(node.operands[3]).lower;
    if (lower.upper >= upper.lower) throw new MathInputProblem('domain', '探索範囲の下端を上端より小さく指定してください。');
    const variable = fn.bindings[0].variable;
    function local(body: MathNode): MathNode {
      if (--remaining < 0) throw new MathInputProblem('budget', '解を探す式が複雑すぎます。');
      if (body.kind === 'symbol') {
        if (body.reference.role === 'bound' && body.reference.id === variable.id) {
          return { kind: 'symbol', reference: { role: 'parameter', name: 'T' } };
        }
        throw new MathInputProblem('unsupported', '解を探す前に、未知数以外の値を確定してください。');
      }
      if (body.kind === 'binder') throw new MathInputProblem('unsupported', '解を探す式の内側の計算を先に確定してください。');
      return body.kind === 'operation' ? { ...body, operands: body.operands.map(local) } : body;
    }
    const body = local(fn.body);
    const tape = compileScalarMath(body, { inputs: ['T'], angleUnit: context.angleUnit, evaluateConstant: constant });
    const enclosure = createScalarIntervalSampler(tape), slope = createScalarFirstDerivatives(tape, [[1]]);
    const found = isolateScalarRoots({ enclosure: (a, b) => enclosure([{ lower: a, upper: b }]),
      derivative: (a, b) => slope([{ lower: a, upper: b }])[0] ?? null }, {
      lower: lower.lower, upper: upper.upper, tolerance, maximumEvaluations: 200_000, maximumRegions: 256,
      maximumDepth: 64, shouldStop: context.shouldStop,
    });
    if (found.status !== 'complete' && found.status !== 'unresolved') throw new Stopped(found.status);
    const unresolved: NumericalRootIntervals['unresolved'][number][] = found.unresolved.map(region =>
      region.reason === 'resolution' && ((lower.lower !== lower.upper && region.lower < lower.upper)
        || (upper.lower !== upper.upper && region.upper > upper.lower)) ? { ...region, reason: 'boundary' } : region);
    const roots = found.roots.filter(root => {
      if (root.lower >= lower.upper && root.upper <= upper.lower) return true;
      unresolved.push({ lower: root.lower, upper: root.upper, reason: 'boundary' });
      return false;
    });
    check();
    return { status: unresolved.length === 0 ? 'complete' : 'unresolved', lower, upper, tolerance,
      roots, unresolved, evaluations: found.evaluations };
  }
  function visit(node: MathNode): MathNode {
    if (--remaining < 0) throw new MathInputProblem('budget', '解探索の構造が複雑すぎます。');
    if (node.kind === 'operation') {
      if (node.operation === 'root-interval') {
        if (node.operands.length !== 2) throw new MathInputProblem('syntax', '解の区間と番号を指定してください。');
        const intervals = calculate(node.operands[0]), index = rationalOfExpression(node.operands[1]);
        if (intervals.status !== 'complete') throw new MathInputProblem('domain', '未解決の範囲があるため、解の区間を選択できません。');
        if (index === null || index.denominator !== 1n || index.numerator < 1n || index.numerator > BigInt(intervals.roots.length)) {
          throw new MathInputProblem('domain', '解の区間の番号を、表示された1からの番号で指定してください。');
        }
        const selected = intervals.roots[Number(index.numerator) - 1];
        return { kind: 'operation', operation: 'list', operands: [doubleNode(selected.lower), doubleNode(selected.upper)] };
      }
      if (node.operation === 'numerical-roots') throw new MathInputProblem('domain', '解の区間はrootintervalで番号を選んでください。');
      // Visit every operand before simplification, including those multiplied by zero.
      return { ...node, operands: node.operands.map(visit) };
    }
    if (node.kind === 'binder') return { ...node, body: visit(node.body), bindings: node.bindings.map(binding => {
      const domain = binding.domain;
      return { ...binding, domain: domain.kind === 'unrestricted' ? domain : domain.kind === 'set'
        ? { ...domain, value: visit(domain.value) } : { ...domain, lower: visit(domain.lower), upper: visit(domain.upper),
          step: domain.step === null ? null : visit(domain.step) } };
    }) };
    return node;
  }
  try {
    if (source.kind === 'operation' && source.operation === 'numerical-roots') {
      return { evaluation: { status: 'value', kind: 'root-intervals', expression: original, intervals: calculate(source) } };
    }
    return { expression: visit(source) };
  } catch (error) {
    if (error instanceof Stopped) return { evaluation: { status: 'stopped', reason: error.reason } };
    throw error;
  }
}
