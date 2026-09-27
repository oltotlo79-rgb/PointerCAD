/** Expand explicit scalar derivatives once, retaining every original domain as a separate guard. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rationalOfExpression } from './exactRational.js';
import type { ScalarInput } from './scalarMathTape.js';
import { lowerReciprocalHyperbolic } from './hyperbolicOperations.js';
import { normalizeElementaryOperation } from './elementaryMathNormalization.js';
import { MAX_POLYGAMMA_ORDER } from './polygammaCoefficients.js';
import { realLambertBranch } from './lambertWFunctions.js';
import { ellipticOperation,ellipticPartialOperation } from './ellipticPartials.js';
import { zetaOrder,zetaDerivativeOrder } from './zetaFunctions.js';

const ZERO: MathNode = { kind: 'number', decimal: '0' };
const ONE: MathNode = { kind: 'number', decimal: '1' };
const TWO: MathNode = { kind: 'number', decimal: '2' };
function literal(node: MathNode, value: string): boolean { return node.kind === 'number' && node.decimal === value; }
function inputName(node: MathNode): ScalarInput | null {
  return node.kind === 'symbol' && (node.reference.role === 'axis' || node.reference.role === 'parameter')
    ? node.reference.name : null;
}

export function expandFunctionDerivatives(source: MathNode, inputs: readonly ScalarInput[], angleUnit: 'degree' | 'radian'):
  { readonly expression: MathNode; readonly guards: readonly MathNode[] } {
  const pending = [source];
  let hasDerivative = false;
  while (pending.length > 0) {
    const node = pending.pop();
    if (node?.kind === 'operation') {
      if (node.operation === 'differentiate') { hasDerivative = true; break; }
      pending.push(...node.operands);
    }
  }
  if (!hasDerivative) return { expression: source, guards: [] };
  const guards: MathNode[] = [];
  let work = 0;
  const spend = (): void => {
    if (++work > 4096) throw new MathInputProblem('budget', '微分後の式が複雑すぎます。式を分けてください。');
  };
  const op = (operation: string, ...operands: MathNode[]): MathNode => {
    spend(); return { kind: 'operation', operation, operands };
  };
  const add = (...values: MathNode[]): MathNode => {
    const terms = values.filter(value => !literal(value, '0'));
    return terms.length === 0 ? ZERO : terms.length === 1 ? terms[0] : op('add', ...terms);
  };
  const mul = (...values: MathNode[]): MathNode => {
    if (values.some(value => literal(value, '0'))) return ZERO;
    const terms = values.filter(value => !literal(value, '1'));
    return terms.length === 0 ? ONE : terms.length === 1 ? terms[0] : op('multiply', ...terms);
  };
  const neg = (value: MathNode): MathNode => literal(value, '0') ? ZERO : op('negate', value);
  const div = (a: MathNode, b: MathNode): MathNode => op('divide', a, b);
  const square = (value: MathNode): MathNode => op('square', value);
  const angle = angleUnit === 'degree' ? div({ kind: 'constant', name: 'pi' }, { kind: 'number', decimal: '180' }) : ONE;
  function piecewise(node: Extract<MathNode, { kind: 'operation' }>, transform: (branch: MathNode) => MathNode,
    interior: boolean): MathNode {
    if (node.operands.length < 2 || node.operands.length % 2 !== 0) {
      throw new MathInputProblem('syntax', '場合分けは条件と値を対で指定してください。');
    }
    const operands: MathNode[] = [], obligations: MathNode[] = [];
    let guarded = false;
    for (let index = 0; index < node.operands.length; index += 2) {
      const condition = node.operands[index], branch = node.operands[index + 1], start = guards.length;
      if (interior) guards.push(branch);
      const value = transform(branch), captured = guards.splice(start);
      guarded ||= captured.length > 0;
      operands.push(condition, value);
      // Use unsimplified zero products: invalid intermediates must survive, but
      // guards in unselected branches must never invalidate the chosen branch.
      obligations.push(condition, captured.length === 0 ? ZERO
        : op('add', ZERO, ...captured.map(guard => op('multiply', ZERO, guard))));
    }
    const operation = interior || node.operation === 'which-derivative' ? 'which-derivative' : 'which';
    if (guarded) guards.push(op(operation, ...obligations));
    return op(operation, ...operands);
  }
  function differentiate(expression: MathNode, variable: ScalarInput): MathNode {
    const memo = new Map<MathNode, MathNode>();
    const dependency = new Map<MathNode, boolean>();
    function depends(node: MathNode): boolean {
      const known = dependency.get(node); if (known !== undefined) return known;
      spend();
      const value = inputName(node) === variable || node.kind === 'operation' && node.operands.some(depends)
        || node.kind === 'binder' && (depends(node.body) || node.bindings.some(binding => {
          const domain = binding.domain;
          return domain.kind === 'set' ? depends(domain.value) : domain.kind === 'range'
            && (depends(domain.lower) || depends(domain.upper) || domain.step !== null && depends(domain.step));
        }));
      dependency.set(node, value); return value;
    }
    function derivative(node: MathNode): MathNode {
      const known = memo.get(node); if (known !== undefined) return known;
      spend();
      if (node.kind === 'operation' && (node.operation === 'which' || node.operation === 'which-derivative')) {
        const value = piecewise(node, branch => {
          // Derivative guards are scoped to a branch, so cached derivatives
          // cannot carry their proof into another branch.
          memo.clear();
          const result = derivative(branch);
          memo.clear();
          return result;
        }, true);
        guards.push(value);
        memo.set(node, value);
        return value;
      }
      if (!depends(node)) return ZERO;
      if (inputName(node) === variable) return ONE;
      const hyperbolic = lowerReciprocalHyperbolic(node);
      if (hyperbolic !== null) {
        const value = derivative(hyperbolic);
        memo.set(node, value);
        return value;
      }
      if (node.kind !== 'operation') throw new MathInputProblem('unsupported', 'この式の導関数を作図用に確定できません。');
      if(node.operation==='zetaderivative') {
        const order=node.operands.length===2?zetaDerivativeOrder(node.operands[0]):null;
        if(order===null)throw new MathInputProblem('budget','ゼータ関数の微分の次数を確定できません。');
        const value=derivative(op(order===0?'zeta':`zeta-derivative:${String(order)}`,node.operands[1]));
        memo.set(node,value);return value;
      }
      const [a, b] = node.operands;
      const da = a === undefined ? ZERO : derivative(a);
      let value: MathNode;
      const elliptic=ellipticOperation(node.operation);
      const zeta=zetaOrder(node.operation);
      if(zeta!==null) {
        if(zeta>=17)throw new MathInputProblem('budget','ゼータ関数の微分の次数が上限を越えました。');
        value=mul(op(`zeta-derivative:${String(zeta+1)}`,a),da);
      } else if(elliptic!==null) {
        value=add(...node.operands.map((operand,index)=>{
          const inner=derivative(operand);
          return literal(inner,'0')?ZERO:mul(op(ellipticPartialOperation(elliptic,index),...node.operands),inner);
        }));
      } else switch (node.operation) {
        case 'add': value = add(...node.operands.map(derivative)); break;
        case 'subtract': value = add(da, neg(derivative(b))); break;
        case 'negate': value = neg(da); break;
        case 'multiply': value = add(...node.operands.map((operand, index) =>
          mul(derivative(operand), ...node.operands.filter((_, other) => other !== index)))); break;
        case 'divide': value = div(add(mul(da, b), neg(mul(a, derivative(b)))), square(b)); break;
        case 'square': value = mul(TWO, a, da); break;
        case 'sqrt': value = div(da, mul(TWO, node)); break;
        case 'power': {
          const exponent = rationalOfExpression(b);
          if (exponent !== null) {
            const n = exponent.numerator, d = exponent.denominator;
            if (n === 0n) value = ZERO;
            else if (n === d) value = da;
            else {
              const remaining = div({ kind: 'number', decimal: String(n-d) }, { kind: 'number', decimal: String(d) });
              value = mul(b, op('power', a, remaining), da);
              // Noninteger powers with an even denominator lack a two-sided real
              // neighbourhood at zero, even when their right derivative is finite.
              if (d % 2n === 0n) guards.push(div(ONE, a));
            }
          } else value = mul(node, add(mul(derivative(b), op('natural-log', a)), div(mul(b, da), a)));
          break;
        }
        case 'root': value = derivative(op('power', a, div(ONE, b))); break;
        case 'exponential': value = mul(node, da); break;
        case 'airyai': value = mul(op('airyaiprime', a), da); break;
        case 'airybi': value = mul(op('airybiprime', a), da); break;
        case 'airyaiprime': value = mul(mul(a, op('airyai', a)), da); break;
        case 'airybiprime': value = mul(mul(a, op('airybi', a)), da); break;
        case 'lambertw': {
          realLambertBranch(a);
          value = mul(div(op('exponential', neg(node)), add(ONE, node)), derivative(b));
          break;
        }
        case 'besselj': case 'bessely': case 'besseli': case 'besselk': {
          const order = rationalOfExpression(a);
          if (order === null || order.denominator !== 1n || order.numerator <= -128n || order.numerator >= 128n) {
            throw new MathInputProblem('unsupported', 'Bessel関数の式の微分では、生成される次数も-128から128以内にしてください。');
          }
          const left = op(node.operation, { kind: 'number', decimal: String(order.numerator-1n) }, b);
          const right = op(node.operation, { kind: 'number', decimal: String(order.numerator+1n) }, b);
          const sum = add(left, node.operation === 'besselj' || node.operation === 'bessely' ? neg(right) : right);
          value = mul(div(node.operation === 'besselk' ? neg(sum) : sum, TWO), derivative(b));
          break;
        }
        case 'beta': {
          const psiSum = op('polygamma', ZERO, add(a, b));
          value = mul(node, add(mul(add(op('polygamma', ZERO, a), neg(psiSum)), da),
            mul(add(op('polygamma', ZERO, b), neg(psiSum)), derivative(b))));
          break;
        }
        case 'gamma': value = mul(node, op('polygamma', ZERO, a), da); break;
        case 'polygamma': {
          const order = rationalOfExpression(a);
          if (order === null || order.denominator !== 1n || order.numerator < 0n || order.numerator >= BigInt(MAX_POLYGAMMA_ORDER)) {
            throw new MathInputProblem('unsupported', 'Gamma関数の微分の次数を上限内で確定できません。');
          }
          value = mul(op('polygamma', { kind: 'number', decimal: String(order.numerator+1n) }, b), derivative(b));
          break;
        }
        case 'erf': case 'erfc': {
          const slope = div(mul(TWO, op('exponential', neg(square(a)))), op('sqrt', { kind: 'constant', name: 'pi' }));
          value = mul(node.operation === 'erf' ? slope : neg(slope), da); break;
        }
        case 'natural-log': value = div(da, a); break;
        case 'log-two': case 'log-ten': value = div(da, mul(a, op('natural-log',
          { kind: 'number', decimal: node.operation === 'log-two' ? '2' : '10' }))); break;
        case 'log-base': value = derivative(div(op('natural-log', a), op('natural-log', b))); break;
        case 'sin': value = mul(angle, op('cos', a), da); break;
        case 'cos': value = neg(mul(angle, op('sin', a), da)); break;
        case 'tan': value = div(mul(angle, da), square(op('cos', a))); break;
        case 'cot': value = neg(div(mul(angle, da), square(op('sin', a)))); break;
        case 'sec': value = mul(angle, node, op('tan', a), da); break;
        case 'csc': value = neg(mul(angle, node, op('cot', a), da)); break;
        case 'arcsin': case 'arccos': {
          const slope = div(da, mul(angle, op('sqrt', add(ONE, neg(square(a))))));
          value = node.operation === 'arcsin' ? slope : neg(slope); break;
        }
        case 'arctan': value = div(da, mul(angle, add(ONE, square(a)))); break;
        case 'sinh': value = mul(op('cosh', a), da); break;
        case 'cosh': value = mul(op('sinh', a), da); break;
        case 'tanh': value = div(da, square(op('cosh', a))); break;
        case 'arsinh': value = div(da, op('sqrt', add(square(a), ONE))); break;
        case 'arcosh': value = div(da, mul(op('sqrt', add(a, neg(ONE))), op('sqrt', add(a, ONE)))); break;
        case 'artanh': value = div(da, add(ONE, neg(square(a)))); break;
        case 'absolute':
          guards.push(div(ONE, a)); value = mul(op('sign', a), da); break;
        case 'sign':
          guards.push(div(ONE, a)); value = ZERO; break;
        default: throw new MathInputProblem('unsupported', `演算「${node.operation}」の作図用の導関数はまだ確定できません。`);
      }
      // A surrounding zero must not erase a failed derivative or its domain.
      guards.push(value);
      memo.set(node, value); return value;
    }
    return derivative(expression);
  }
  function visit(node: MathNode, depth: number): MathNode {
    spend();
    if (depth > 64) throw new MathInputProblem('budget', '微分する式の入れ子が深すぎます。');
    if (node.kind !== 'operation') return node;
    if (node.operation === 'which' || node.operation === 'which-derivative') {
      return piecewise(node, branch => visit(branch, depth + 1), false);
    }
    if (node.operation !== 'differentiate') {
      const result = { ...node, operands: node.operands.map(value => visit(value, depth+1)) };
      // Children have already recorded every derivative domain before a selected
      // vector/matrix component is removed from a surrounding derivative's body.
      const first = result.operands[0];
      if (result.operation === 'component' && first?.kind === 'operation' && ['list', 'matrix'].includes(first.operation)) {
        const pending = [first];
        while (pending.length > 0) {
          const value = pending.pop();
          if (value === undefined) break;
          spend();
          for (const child of value.operands) {
            if (child.kind === 'operation' && ['list', 'matrix'].includes(child.operation)) pending.push(child);
            else guards.push(child);
          }
        }
        return normalizeElementaryOperation(result, angleUnit);
      }
      if (result.operation === 'dot') {
        const [left, right] = result.operands;
        if (left.kind !== 'operation' || right.kind !== 'operation' || left.operation !== 'list' || right.operation !== 'list'
            || left.operands.length === 0 || left.operands.length !== right.operands.length) {
          throw new MathInputProblem('domain', '内積の二つのベクトルは同じ成分数で指定してください。');
        }
        // Component selection may expose a matrix row only at this stage.
        // Preserve every operand before zero products can simplify away a hole.
        guards.push(...left.operands, ...right.operands);
        return add(...left.operands.map((value, i) => mul(value, right.operands[i])));
      }
      return result;
    }
    const [body, ...variables] = node.operands;
    if (body === undefined || variables.length < 1 || variables.length > 15) throw new MathInputProblem('syntax', '微分する式と変数を指定してください。');
    let current = visit(body, depth+1);
    for (const variable of variables) {
      const name = inputName(variable);
      if (name === null || !inputs.includes(name)) throw new MathInputProblem('syntax', '微分する変数はこの作図の独立変数から指定してください。');
      guards.push(current);
      current = differentiate(current, name);
    }
    return current;
  }
  return { expression: visit(source, 0), guards };
}
