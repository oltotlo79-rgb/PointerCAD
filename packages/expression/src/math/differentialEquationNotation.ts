/** Resolve short derivative notation only inside an explicit differential problem. */
import { MathInputProblem, MATH_INPUT_LIMITS } from './mathInputContract.js';
import type { ParsedMathJson } from './mathLatexTokens.js';

function syntax(): never {
  throw new MathInputProblem('syntax', '微分の表記は、指定した未知関数と独立変数に合わせてください。変数が複数ある場合はdiffで微分する変数を指定してください。');
}
export function derivativePrimeOrder(symbol: string): number {
  return symbol === "'" || symbol === '′' || symbol === '\\prime' ? 1
    : symbol === '″' ? 2 : symbol === '‴' ? 3 : symbol === '⁗' ? 4 : 0;
}

export function differentialEquationNotation(value: ParsedMathJson,
  independent: readonly ParsedMathJson[], dependent: readonly ParsedMathJson[]): ParsedMathJson {
  if (independent.some(name => typeof name !== 'string') || dependent.some(name => typeof name !== 'string')) return syntax();
  let remaining = MATH_INPUT_LIMITS.nodes;
  const all = new Set([...independent, ...dependent]);
  function visit(raw: ParsedMathJson, depth: number): ParsedMathJson {
    if (--remaining < 0 || depth > MATH_INPUT_LIMITS.depth) throw new MathInputProblem('budget', '微分の表記が複雑すぎます。');
    if (!Array.isArray(raw)) return raw;
    const fields: readonly ParsedMathJson[] = raw;
    const head = fields[0];
    if (typeof head !== 'string') return syntax();
    if (head === 'PcadPrimeDerivative') {
      let target = fields[1], order = 0;
      const count = fields[2];
      if (fields.length !== 3 || count === null || typeof count !== 'object' || !('num' in count)) return syntax();
      order += Number(count.num);
      while (Array.isArray(target) && target[0] === 'PcadPrimeDerivative') {
        const nested: readonly ParsedMathJson[] = target, amount = nested[2];
        if (--remaining < 0 || nested.length !== 3 || amount === null || typeof amount !== 'object' || !('num' in amount)) return syntax();
        order += Number(amount.num); target = nested[1];
      }
      if (independent.length !== 1 || typeof target !== 'string' || !dependent.includes(target)
        || !Number.isSafeInteger(order) || order < 1 || order > 8) return syntax();
      return ['D', target, ...Array.from({ length: order }, () => independent[0])];
    }
    if (head === 'PcadDifferentialQuotient') {
      if (fields.length !== 4 || typeof fields[1] !== 'string' || typeof fields[2] !== 'string'
        || !dependent.includes(fields[1]) || !independent.includes(fields[2])) return syntax();
      const marker = fields[3];
      if ((marker === 'ordinary' && independent.length !== 1) || (marker !== 'ordinary' && marker !== 'partial')) return syntax();
      return ['D', fields[1], fields[2]];
    }
    if (head === 'Divide' && fields.length === 3 && independent.length === 1) {
      const numerator = fields[1], denominator = fields[2];
      if (typeof numerator === 'string' && typeof denominator === 'string'
        && !all.has(numerator) && !all.has(denominator)) {
        const from = dependent.find(name => typeof name === 'string' && numerator === 'd' + name);
        if (from !== undefined && typeof independent[0] === 'string' && denominator === 'd' + independent[0]) return ['D', from, independent[0]];
      }
    }
    // A nested binder owns its names; this problem must not rewrite them.
    if (['Function', 'ODESolve', 'PDE'].includes(head)) return raw;
    return [head, ...fields.slice(1).map(child => visit(child, depth + 1))];
  }
  return visit(value, 0);
}
