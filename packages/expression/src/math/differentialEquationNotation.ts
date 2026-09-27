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
/** Newton's dot accents count derivatives with respect to the problem's single independent variable. */
export function derivativeDotOrder(command: string): number {
  return command === '\\dot' ? 1 : command === '\\ddot' ? 2 : command === '\\dddot' ? 3 : command === '\\ddddot' ? 4 : 0;
}
export const DOT_DERIVATIVE_TARGET = 'ドット表記（\\dot・\\ddot）には、微分方程式で求める関数の名前を1つ指定してください。';

/** Raw markers that exist only until an explicit differential problem converts them; they are never stored. */
const SHORT_DERIVATIVES: Readonly<Record<string, string>> = {
  PcadPrimeDerivative: '「y′」「y″」の短い微分の表記は、微分方程式（odesolve・pde）の中だけで使えます。それ以外の式では diff(式,変数) か derivativeat(式,変数,位置,回数) を使ってください。',
  PcadDotDerivative: '「ẏ」「ÿ」のドット表記（\\dot・\\ddot）は、微分方程式（odesolve）の中で独立変数についての微分としてだけ使えます。それ以外の式では diff(式,変数) か derivativeat(式,変数,位置,回数) を使ってください。',
  PcadDifferentialQuotient: '「dy/dx」の分数の微分の表記は、微分方程式（odesolve・pde）の中だけで使えます。それ以外の式では diff(式,変数) か derivativeat(式,変数,位置,回数) を使ってください。',
};
function isRawList(value: unknown): value is readonly unknown[] { return Array.isArray(value); }
/**
 * A short derivative left outside a differential problem has no meaning. Name the notation and the
 * alternatives before operation validation would report the internal marker; oversized input is
 * left to that validation, which reports the budget.
 */
export function rejectShortDerivativeNotation(value: unknown): void {
  const pending: unknown[] = [value];
  for (let remaining = MATH_INPUT_LIMITS.nodes; pending.length > 0 && remaining > 0; remaining -= 1) {
    const item = pending.pop();
    if (!isRawList(item)) continue;
    const head = item[0];
    if (typeof head === 'string' && Object.hasOwn(SHORT_DERIVATIVES, head)) {
      throw new MathInputProblem('unsupported', SHORT_DERIVATIVES[head]);
    }
    for (let index = item.length - 1; index >= 1; index -= 1) pending.push(item[index]);
  }
}

/**
 * ∇ notation (MC-19b, Q4=A) reads into gradient/divergence/curl/laplacian with an ordered variable
 * list. Written without the list, the parsers keep this marker and the decoder substitutes only a
 * function plot's X/Y/Z axes; every other expression must name its variables.
 */
export const NABLA_DEFAULT_VARIABLES = '∇';
export const NABLA_HEADS: ReadonlySet<string> = new Set(['Gradient', 'Divergence', 'Curl', 'Laplacian']);
export const NABLA_VARIABLES_REQUIRED = '∇ の後に微分する変数の一覧を ∇_[x,y,z] のように指定してください（構造入力では \\nabla_{[x,y,z]}）。一覧を省略できるのは、X・Y・Z の軸を変数にする関数作図の式だけです。';
export const NABLA_VARIABLE_LIST = '∇ の変数の一覧は ∇_[x,y,z]（構造入力では \\nabla_{[x,y,z]}）のように角括弧で囲んで指定してください。';
export const NABLA_LAPLACIAN = 'ラプラシアンは ∇² または ∇^2（構造入力では \\nabla^{2}）と指定してください。';

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
    if (head === 'PcadDotDerivative') {
      // ẏ and ÿ always differentiate with respect to the single independent variable, like y′.
      const target = fields[1], count = fields[2];
      if (fields.length !== 3 || independent.length !== 1 || typeof target !== 'string' || !dependent.includes(target)
        || typeof count !== 'object' || !('num' in count)) return syntax();
      const order = Number(count.num);
      if (!Number.isSafeInteger(order) || order < 1 || order > 4) return syntax();
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
