/** Exact structural identities only. Original domain regularity must still be checked by the sampler. */
import { MathInputProblem, MATH_INPUT_LIMITS, type MathNode, type MathSymbolReference } from './mathInputContract.js';
import { decimalRational, rational, rationalOfExpression, type ExactRational } from './exactRational.js';
import { engineSymbolOf } from './mathSymbolScope.js';

type Term = { readonly kind: 'rational' | 'pi'; readonly value: ExactRational; readonly key: string }
  | { readonly kind: 'symbol'; readonly key: string }
  | { readonly kind: 'operation'; readonly operation: string; readonly operands: readonly Term[]; readonly key: string };
const ZERO: ExactRational = { numerator: 0n, denominator: 1n }, ONE: ExactRational = { numerator: 1n, denominator: 1n };
function checked(value: ExactRational | null): ExactRational {
  if (value === null) throw new MathInputProblem('budget', '周期境界の厳密な比較が複雑すぎます。'); return value;
}
function number(value: ExactRational, pi = false): Term {
  return { kind: pi && value.numerator !== 0n ? 'pi' : 'rational', value,
    key: `${pi && value.numerator !== 0n ? 'p' : 'q'}:${value.numerator}/${value.denominator}` };
}
function combine(a: ExactRational, b: ExactRational, add: boolean): ExactRational {
  return checked(add ? rational(a.numerator*b.denominator+b.numerator*a.denominator,a.denominator*b.denominator)
    : rational(a.numerator*b.numerator,a.denominator*b.denominator));
}
function operation(name: string, operands: readonly Term[]): Term {
  const key = `${name}(${operands.map(value => value.key).join(',')})`;
  if (key.length > MATH_INPUT_LIMITS.sourceCodeUnits) throw new MathInputProblem('budget', '周期境界の比較式が大きすぎます。');
  return { kind: 'operation', operation: name, operands, key };
}
function sum(terms: readonly Term[]): Term {
  const expanded = terms.flatMap(term => term.kind === 'operation' && term.operation === 'add' ? term.operands : [term]);
  let scalar = ZERO, angle = ZERO; const rest: Term[] = [];
  for (const term of expanded) {
    if (term.kind === 'rational') scalar = combine(scalar, term.value, true);
    else if (term.kind === 'pi') angle = combine(angle, term.value, true);
    else rest.push(term);
  }
  if (scalar.numerator !== 0n) rest.push(number(scalar)); if (angle.numerator !== 0n) rest.push(number(angle,true));
  rest.sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return rest.length === 0 ? number(ZERO) : rest.length === 1 ? rest[0] : operation('add',rest);
}
function product(terms: readonly Term[]): Term {
  const expanded = terms.flatMap(term => term.kind === 'operation' && term.operation === 'multiply' ? term.operands : [term]);
  let scalar = ONE, piCount = 0; const rest: Term[] = [];
  for (const term of expanded) {
    if (term.kind === 'rational' || term.kind === 'pi') {
      scalar = combine(scalar,term.value,false); if (term.kind === 'pi') piCount++;
    } else rest.push(term);
  }
  if (scalar.numerator === 0n) return number(ZERO);
  if (piCount === 1) { rest.push(number(scalar,true)); scalar = ONE; }
  else for (let i=0; i<piCount; i++) rest.push(number(ONE,true));
  if (scalar.numerator !== scalar.denominator) rest.push(number(scalar));
  rest.sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return rest.length === 0 ? number(ONE) : rest.length === 1 ? rest[0] : operation('multiply',rest);
}
function trig(name: 'sin' | 'cos', argument: Term, unit: 'degree' | 'radian'): Term {
  const scalar = argument.kind === 'rational' ? argument.value : null;
  const pi = argument.kind === 'pi' ? argument.value : scalar?.numerator === 0n ? ZERO : null;
  const quarter = unit === 'degree' ? scalar === null ? null : checked(rational(scalar.numerator,scalar.denominator*90n))
    : pi === null ? null : checked(rational(pi.numerator*2n,pi.denominator));
  if (quarter?.denominator === 1n) {
    const index = Number((quarter.numerator%4n+4n)%4n);
    return number({ numerator: BigInt(name === 'sin' ? [0,1,0,-1][index] : [1,0,-1,0][index]), denominator: 1n });
  }
  // Remove whole turns exactly, without approximating Pi or rounding a close-to-period angle.
  if (argument.kind === 'operation' && argument.operation === 'add') {
    const reduced = argument.operands.map(term => {
      const isPhase = unit === 'degree' ? term.kind === 'rational' : term.kind === 'pi';
      if (!isPhase || (term.kind !== 'rational' && term.kind !== 'pi')) return term;
      const period = term.value.denominator * (unit === 'degree' ? 360n : 2n);
      return number(checked(rational((term.value.numerator%period+period)%period,term.value.denominator)),term.kind === 'pi');
    });
    return operation(`${name}:${unit}`,[sum(reduced)]);
  }
  return operation(`${name}:${unit}`,[argument]);
}
function rationalNode(value: ExactRational): MathNode {
  return { kind: 'operation', operation: 'divide', operands: [{ kind: 'number', decimal: String(value.numerator) },
    { kind: 'number', decimal: String(value.denominator) }] };
}

/** Null means not proved. This comparison never invokes floating evaluation or an external simplifier. */
export function functionBoundaryKey(source: MathNode, angleUnit: 'degree' | 'radian',
  resolve: (reference: MathSymbolReference) => { readonly expression: MathNode; readonly angleUnit: 'degree' | 'radian' } | null): string | null {
  let remaining = MATH_INPUT_LIMITS.nodes;
  function visit(node: MathNode, depth: number, unit: 'degree' | 'radian'): Term | null {
    if (--remaining < 0 || depth > MATH_INPUT_LIMITS.depth) throw new MathInputProblem('budget','周期境界の式が複雑すぎます。');
    if (node.kind === 'number') return number(checked(decimalRational(node.decimal)));
    if (node.kind === 'constant') return node.name === 'pi' ? number(ONE,true) : { kind:'symbol',key:`constant:${node.name}` };
    if (node.kind === 'symbol') {
      const replacement = resolve(node.reference);
      return replacement === null ? {kind:'symbol',key:`symbol:${engineSymbolOf(node.reference)}` }
        : visit(replacement.expression,depth+1,replacement.angleUnit);
    }
    if (node.kind !== 'operation') return null;
    const terms: Term[] = [];
    for (const operand of node.operands) { const value = visit(operand,depth+1,unit); if (value === null) return null; terms.push(value); }
    const [a,b] = terms;
    if (node.operation === 'add') return sum(terms);
    if (node.operation === 'multiply') return product(terms);
    if (node.operation === 'negate' && terms.length === 1) return product([number({numerator:-1n,denominator:1n}),a]);
    if (node.operation === 'subtract' && terms.length === 2) return a.key === b.key ? number(ZERO)
      : sum([a,product([number({numerator:-1n,denominator:1n}),b])]);
    if (node.operation === 'divide' && terms.length === 2 && b.kind === 'rational' && b.value.numerator !== 0n) {
      return product([a,number(checked(rational(b.value.denominator,b.value.numerator)))]);
    }
    if ((node.operation === 'sin' || node.operation === 'cos') && terms.length === 1) return trig(node.operation,a,unit);
    const rationalOperands = terms.flatMap(term => term.kind === 'rational' ? [rationalNode(term.value)] : []);
    if (rationalOperands.length === terms.length) {
      const exact = rationalOfExpression({kind:'operation',operation:node.operation,operands:rationalOperands});
      if (exact !== null) return number(exact);
    }
    return operation(`${node.operation}:${unit}`,terms);
  }
  return visit(source,0,angleUnit)?.key ?? null;
}
