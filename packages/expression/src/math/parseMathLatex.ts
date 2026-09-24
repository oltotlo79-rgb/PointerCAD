import { derivativeDotOrder, derivativePrimeOrder, DOT_DERIVATIVE_TARGET, NABLA_DEFAULT_VARIABLES, NABLA_LAPLACIAN,
  NABLA_VARIABLE_LIST } from './differentialEquationNotation.js';
import { CLOSED_INTEGRAL_UNAVAILABLE, closedIntegralHead } from './lineIntegrals.js';
/** Parse only PointerCAD's mathematical notation; commands never execute code. */
import { MathInputProblem, MATH_INPUT_LIMITS, validateMathDecimal } from './mathInputContract.js';
import { latexTokens, type ParsedMathJson, type LatexToken } from './mathLatexTokens.js';
import { LATEX_FUNCTIONS, latexFunction } from './mathLatexFunctions.js';
import { RATIO_DEFINITION, RATIO_IN_LIST, RATIO_TERMS, RATIO_TIME, repeatingDecimalFraction } from './mathTextSyntax.js';

const CONSTANTS: Readonly<Record<string, string>> = {
  '\\pi': 'Pi', 'π': 'Pi', '\\exponentialE': 'ExponentialE', '\\imaginaryI': 'ImaginaryUnit',
  '\\imaginaryJ': 'ImaginaryUnit', '\\infty': 'PositiveInfinity', '\\emptyset': 'EmptySet',
  '\\varnothing': 'EmptySet', '\\top': 'True', '\\bot': 'False', '\\mathbbR': 'RealNumbers',
  '\\mathbbC': 'ComplexNumbers', '\\mathbbZ': 'Integers', '\\mathbbN': 'NonNegativeIntegers', '\\mathbbQ': 'RationalNumbers',
};
const INFIX: Readonly<Record<string, readonly [string, number]>> = {
  '+': ['Add', 30], '-': ['Subtract', 30], '*': ['Multiply', 40], '/': ['Divide', 40],
  '\\pm': ['PlusMinus', 30], '\\mp': ['MinusPlus', 30],
  '\\cdot': ['PcadDotToken', 40], '\\times': ['PcadTimesToken', 40], '\\otimes': ['TensorProduct', 40],
  '\\odot': ['HadamardProduct', 40], '^': ['Power', 60], '=': ['Equal', 20], '<': ['Less', 20], '>': ['Greater', 20],
  '\\le': ['LessEqual', 20], '\\leq': ['LessEqual', 20], '\\ge': ['GreaterEqual', 20], '\\geq': ['GreaterEqual', 20],
  '\\ne': ['NotEqual', 20], '\\neq': ['NotEqual', 20], '\\in': ['Element', 20], '\\cup': ['Union', 25],
  '\\notin': ['NotElement', 20], '\\subset': ['Subset', 20], '\\subseteq': ['SubsetEqual', 20],
  '\\supset': ['Superset', 20], '\\supseteq': ['SupersetEqual', 20], '\\approx': ['ApproxEqual', 20],
  '\\cap': ['Intersection', 25], '\\setminus': ['SetMinus', 25], '\\land': ['And', 15], '\\wedge': ['And', 15],
  '\\lor': ['Or', 10], '\\vee': ['Or', 10], '\\implies': ['Implies', 5], '\\iff': ['Equivalent', 5],
};
const CLOSERS = new Set(['', '}', ']', ')', '\\}', '\\rvert', '\\rangle', '|', '&', '\\\\', '\\end', '\\differential', '\\partial']);
const SYMBOLS: Readonly<Record<string, string>> = {
  '±': '\\pm', '∓': '\\mp', '∉': '\\notin', '⊂': '\\subset', '⊆': '\\subseteq',
  '⊃': '\\supset', '⊇': '\\supseteq', '≈': '\\approx', '∁': '\\complement',
  '⟨': '\\langle', '⟩': '\\rangle', '×': '\\times',
  '∇': '\\nabla', '∮': '\\oint', '∯': '\\oiint', '∶': ':', '：': ':',
};
const CLOSED_INTEGRALS = new Set(['\\oint', '\\oiint', '\\oiiint']);
/** a:b is its value a÷b, looser than + and −, tighter than = (MC-19c, Q1=A); \% is ÷100 like the plain-text %. */
const RATIO_BINDING = 26;
const clockDigits = (token: LatexToken | undefined): boolean => token?.text === 'number' && /^0[0-9]/u.test(token.literal ?? '');

export function parseMathLatex(source: string): ParsedMathJson {
  return parseTokens(latexTokens(source).map(token => SYMBOLS[token.text] ? { ...token, text: SYMBOLS[token.text] } : token));
}
function parseTokens(tokens: readonly LatexToken[]): ParsedMathJson {
  let position = 0, depth = 0, remaining = MATH_INPUT_LIMITS.nodes;
  const peek = (): string => tokens[position]?.text ?? '';
  const take = (): LatexToken => {
    const token = tokens[position++];
    if (!token) throw new MathInputProblem('syntax', '数式が途中で終わっています。');
    return token;
  };
  const expect = (text: string): void => {
    if (take().text !== text) throw new MathInputProblem('syntax', `数式の「${text}」を確認してください。`);
  };
  function node(head: string, ...args: ParsedMathJson[]): ParsedMathJson {
    if (--remaining < 0 || args.length > MATH_INPUT_LIMITS.arguments) throw new MathInputProblem('budget', '数式が複雑すぎます。');
    return [head, ...args];
  }
  // True while an element of [ ], \{ \} or a matrix is read directly; ( ), { } and the other delimiters reset it.
  const groups: boolean[] = [];
  function within<T>(listed: boolean, read: () => T): T {
    groups.push(listed);
    try { return read(); } finally { groups.pop(); }
  }
  function enclosed(close: string, listed = false): ParsedMathJson[] {
    const values: ParsedMathJson[] = [];
    if (peek() === close) { take(); return values; }
    for (;;) {
      values.push(within(listed, () => expression(0)));
      if (values.length > MATH_INPUT_LIMITS.arguments) throw new MathInputProblem('budget', '引数が多すぎます。');
      if (peek() === close) { take(); return values; }
      expect(',');
    }
  }
  function group(): ParsedMathJson {
    expect('{');
    const values = enclosed('}');
    if (values.length !== 1) throw new MathInputProblem('syntax', '波括弧には式を1つ指定してください。');
    return values[0];
  }
  function bound(): ParsedMathJson { return peek() === '{' ? group() : atom(); }
  function argumentsOf(): ParsedMathJson[] {
    if (peek() === '(') { take(); return enclosed(')'); }
    return [expression(50)];
  }
  function range(head: string): ParsedMathJson {
    let lower: ParsedMathJson | undefined, upper: ParsedMathJson | undefined;
    for (let i = 0; i < 2 && (peek() === '_' || peek() === '^'); i++) {
      const marker = take().text;
      if (marker === '_') { if (lower !== undefined) throw new MathInputProblem('syntax', '下限が重複しています。'); lower = bound(); }
      else { if (upper !== undefined) throw new MathInputProblem('syntax', '上限が重複しています。'); upper = bound(); }
    }
    const body = peek() === '{' ? group() : expression(0);
    if (head === 'Integrate') {
      if (peek() !== '\\differential' && peek() !== 'd') throw new MathInputProblem('syntax', '積分する変数を指定してください。');
      take(); const variable = bound();
      if (lower === undefined && upper === undefined) return node(head, body, variable);
      if (lower === undefined || upper === undefined) throw new MathInputProblem('syntax', '積分の下限と上限を指定してください。');
      return node(head, body, node('Tuple', variable, lower, upper));
    }
    if (!Array.isArray(lower) || lower[0] !== 'Equal' || lower.length !== 3 || upper === undefined) {
      throw new MathInputProblem('syntax', '和・積の添字と範囲を指定してください。');
    }
    const values: readonly ParsedMathJson[] = lower;
    return node(head, body, node('Tuple', values[1], values[2], upper));
  }
  function environment(name: string | undefined): ParsedMathJson {
    if (!name || !['matrix', 'pmatrix', 'bmatrix', 'vmatrix', 'cases'].includes(name)) {
      throw new MathInputProblem('unsupported', 'この種類の数式枠は使用できません。');
    }
    const rows: ParsedMathJson[][] = [[]];
    while (peek() !== '\\end') {
      rows[rows.length - 1].push(within(name !== 'cases', () => expression(0)));
      if (peek() === '&') take();
      else if (peek() === '\\\\') { take(); rows.push([]); }
      else if (peek() !== '\\end') throw new MathInputProblem('syntax', '行列の区切りを確認してください。');
      if (rows.length > MATH_INPUT_LIMITS.arguments) throw new MathInputProblem('budget', '行列の行数が多すぎます。');
    }
    if (take().literal !== name) throw new MathInputProblem('syntax', '数式枠の終わりが一致しません。');
    if (rows.some(row => row.length === 0 || row.length !== rows[0].length)) throw new MathInputProblem('syntax', '行列の列数を揃えてください。');
    if (name === 'cases') {
      if (rows[0].length !== 2) throw new MathInputProblem('syntax', '場合分けは値と条件を指定してください。');
      return node('Which', ...rows.flatMap(([value, condition]) => [condition, value]));
    }
    const matrix = node('Matrix', node('List', ...rows.map(row => node('List', ...row))));
    return name === 'vmatrix' ? node('Determinant', matrix) : matrix;
  }
  function fraction(): ParsedMathJson {
    const marker = (text: string | undefined): string | undefined => text === 'd' || text === '\\differential'
      ? 'ordinary' : text === '\\partial' ? 'partial' : undefined;
    const numerator = marker(tokens[position + 1]?.text), denominator = marker(tokens[position + 5]?.text);
    const target = tokens[position + 2]?.text, axis = tokens[position + 6]?.text;
    if (peek() === '{' && numerator !== undefined && numerator === denominator
      && tokens[position + 3]?.text === '}' && tokens[position + 4]?.text === '{' && tokens[position + 7]?.text === '}'
      && target !== undefined && axis !== undefined && /^[\p{L}_][\p{L}\p{M}\p{N}_]*$/u.test(target)
      && /^[\p{L}_][\p{L}\p{M}\p{N}_]*$/u.test(axis)) {
      position += 8;
      return node('PcadDifferentialQuotient', target, axis, numerator);
    }
    // A differential is a binder, not a quotient of free symbols named d.
    if (peek() === '{' && ['\\differential', '\\partial'].includes(tokens[position + 1]?.text ?? '')
      && tokens[position + 2]?.text === '}') {
      take(); const differential = take().text; expect('}'); expect('{'); expect(differential);
      const variable = atom(); expect('}');
      return node('D', peek() === '{' ? group() : expression(0), variable);
    }
    return node('Divide', group(), group());
  }
  function limit(head = 'Limit'): ParsedMathJson {
    expect('_'); expect('{'); const variable = atom();
    if (!['\\to', '\\rightarrow'].includes(take().text)) throw new MathInputProblem('syntax', '極限で近づける値を指定してください。');
    const target: LatexToken[] = []; let nesting = 0;
    while (peek() !== '}' || nesting > 0) {
      const token = take();
      if (token.text === '{') nesting++;
      if (token.text === '}') nesting--;
      target.push(token);
    }
    expect('}');
    let direction: ParsedMathJson | undefined;
    if (target.length >= 4 && target.at(-4)?.text === '^' && target.at(-3)?.text === '{'
      && ['+', '-'].includes(target.at(-2)?.text ?? '') && target.at(-1)?.text === '}') {
      direction = target.at(-2)?.text === '+' ? 1 : -1; target.splice(-4);
    } else if (target.at(-2)?.text === '^' && ['+', '-'].includes(target.at(-1)?.text ?? '')) {
      direction = target.at(-1)?.text === '+' ? 1 : -1; target.splice(-2);
    }
    const value = parseTokens(target), body = peek() === '{' ? group() : expression(0);
    return node(head, node('Function', body, variable), value, ...(direction === undefined ? [] : [direction]));
  }
  /** \nabla_{[x,y,z]}, \nabla\cdot, \nabla\times and \nabla^{2}; without a list only a plot's X/Y/Z are implied. */
  function nabla(): ParsedMathJson {
    let variables: ParsedMathJson = NABLA_DEFAULT_VARIABLES, listed = false, laplacian = false;
    for (let i = 0; i < 2; i++) {
      const marker = peek();
      if (marker === '_' && !listed) {
        take(); const value = bound();
        if (!Array.isArray(value) || value[0] !== 'List') throw new MathInputProblem('syntax', NABLA_VARIABLE_LIST);
        variables = value; listed = true;
      } else if ((marker === '^' || marker === '²') && !laplacian) {
        take();
        if (marker === '^' && bound() !== 2) throw new MathInputProblem('syntax', NABLA_LAPLACIAN);
        laplacian = true;
      } else break;
    }
    let head = laplacian ? 'Laplacian' : 'Gradient';
    if (!laplacian && ['\\cdot', '·', '\\times'].includes(peek())) head = take().text === '\\times' ? 'Curl' : 'Divergence';
    return node(head, expression(50), variables);
  }
  /**
   * 0.1\overline{6} and 0.\bar{3}: an overline over digits only, directly after a plain decimal, marks the
   * repeating digits (MC-19c, Q1=A; approved 09:52). Every other overline, including \overline{1.5} or
   * \overline{3+4\mathrm{i}} after a decimal and one without braces, keeps the product with a conjugate.
   */
  function repeatingOverline(decimal: string): string | null {
    if (!decimal.includes('.') || /[eE]/u.test(decimal) || !['\\overline', '\\bar'].includes(peek())) return null;
    const digits = tokens[position + 2];
    return tokens[position + 1]?.text === '{' && digits?.text === 'number' && /^[0-9]+$/u.test(digits.literal ?? '')
      && tokens[position + 3]?.text === '}' ? digits.literal ?? null : null;
  }
  function atom(): ParsedMathJson {
    const token = take(), text = token.text;
    if (--remaining < 0) throw new MathInputProblem('budget', '式の要素が多すぎます。');
    if (text === 'number') {
      const value = token.literal ?? ''; validateMathDecimal(value);
      const repetend = repeatingOverline(value);
      if (repetend !== null) {
        position += 4;
        const { numerator, denominator } = repeatingDecimalFraction(value, repetend);
        return denominator === '1' ? { num: numerator } : node('Divide', { num: numerator }, { num: denominator });
      }
      const numeric = Number(value);
      return Number.isSafeInteger(numeric) && !/[.eE]/u.test(value) ? numeric : { num: value };
    }
    if (text === 'text') return { str: token.literal ?? '' };
    if (CONSTANTS[text]) return CONSTANTS[text];
    if (text === '{') { position--; return group(); }
    if (text === '(') { const args = enclosed(')'); return args.length === 1 ? args[0] : node('Tuple', ...args); }
    if (text === '[') return node('List', ...enclosed(']', true));
    if (text === '\\{') return node('Set', ...enclosed('\\}', true));
    if (text === '\\langle' || text === '\\complement') {
      if (text === '\\complement') expect('(');
      const args = enclosed(text === '\\langle' ? '\\rangle' : ')');
      if (args.length !== 2) throw new MathInputProblem('syntax', text === '\\langle'
        ? '内積には2つの値を指定してください。' : '補集合には集合と母集合を指定してください。');
      return node(text === '\\langle' ? 'Dot' : 'Complement', ...args);
    }
    if (text === '\\pm' || text === '\\mp') return node(text === '\\pm' ? 'PlusMinus' : 'MinusPlus', expression(50));
    if (text === '+' || text === '-') return text === '+' ? expression(50) : node('Negate', expression(50));
    if (text === '\\neg' || text === '\\lnot') return node('Not', expression(19));
    if (text === '\\lvert' || text === '|') {
      const value = within(false, () => expression(0)); expect(text === '|' ? '|' : '\\rvert'); return node('Abs', value);
    }
    if (text === '\\frac' || text === '\\dfrac' || text === '\\tfrac') return fraction();
    if (text === '\\sqrt') {
      if (peek() === '[') {
        take(); const degree = expression(0); expect(']'); return node('Root', group(), degree);
      }
      return node('Sqrt', group());
    }
    if (text === '\\overline' || text === '\\bar') return node('Conjugate', bound());
    if (text === '\\sum' || text === '\\prod' || text === '\\int') {
      return range(text === '\\sum' ? 'Sum' : text === '\\prod' ? 'Product' : 'Integrate');
    }
    if (text === '\\nabla') return nabla();
    // \oint(…) and \oiint(…) are the closed integrals (MC-19d); \oiiint and a symbol without arguments stay rejected.
    if (CLOSED_INTEGRALS.has(text)) {
      if (text === '\\oiiint' || peek() !== '(') throw new MathInputProblem('unsupported', CLOSED_INTEGRAL_UNAVAILABLE);
      take();
      const args = enclosed(')');
      return latexFunction(closedIntegralHead(text === '\\oint' ? '∮' : '∯', args[0]), args);
    }
    // \dot{y}: Newton's notation, meaningful only inside a differential problem. \dot(…) keeps its old reading.
    const dots = derivativeDotOrder(text);
    if (dots > 0 && peek() === '{') {
      const target = group();
      if (typeof target !== 'string') throw new MathInputProblem('syntax', DOT_DERIVATIVE_TARGET);
      return node('PcadDotDerivative', target, { num: String(dots) });
    }
    if (text === '\\begin') return environment(token.literal);
    if (text === '\\lim') return limit();
    if (text === '\\limsup' || text === '\\liminf') return limit(text === '\\limsup' ? 'LimSup' : 'LimInf');
    if (text === '\\log') {
      if (peek() !== '_') throw new MathInputProblem('syntax', '対数は底を指定してください。自然対数はlnを使えます。');
      take(); const base = bound(), args = argumentsOf();
      if (args.length !== 1) throw new MathInputProblem('syntax', '対数の真数を1つ指定してください。');
      return node('Log', args[0], base);
    }
    if (text.startsWith('@') || text.startsWith('\\')) {
      const head = LATEX_FUNCTIONS.get(text.slice(1).toLowerCase());
      if (!head) throw new MathInputProblem('unsupported', `数式記号「${text}」の定義を確認してください。`);
      return latexFunction(head, argumentsOf());
    }
    if (/^[\p{L}\p{M}][\p{L}\p{M}\p{N}_]*$/u.test(text)) return text;
    throw new MathInputProblem('syntax', `数式の「${text}」を確認してください。`);
  }
  /** Recognize only a pure prime exponent; never consume a general power on a failed match. */
  function primePower(): number {
    if (peek() !== '^') return 0;
    let index = position + 1, order = 0;
    const grouped = tokens[index]?.text === '{';
    if (grouped) index++;
    while (index < tokens.length) {
      const count = derivativePrimeOrder(tokens[index].text);
      if (count === 0) break;
      order += count; index++;
      if (!grouped) break;
    }
    if (order === 0 || (grouped && tokens[index]?.text !== '}')) return 0;
    position = grouped ? index + 1 : index;
    return order;
  }
  function expression(minimum: number): ParsedMathJson {
    if (++depth > MATH_INPUT_LIMITS.depth) throw new MathInputProblem('budget', '数式の入れ子が深すぎます。');
    try {
      let left = atom();
      for (;;) {
        const next = peek();
        if (CLOSERS.has(next) || next === ',' || next === '_') break;
        if (70 >= minimum) {
          const directPrime = derivativePrimeOrder(next);
          const order = directPrime || primePower();
          if (order > 0) {
            if (directPrime > 0) take();
            left = node('PcadPrimeDerivative', left, { num: String(order) }); continue;
          }
        }
        if (next === '!') {
          if (70 < minimum) break;
          take(); const double = peek() === '!'; if (double) take();
          left = node(double ? 'Factorial2' : 'Factorial', left); continue;
        }
        if (next === '\\%') {
          if (70 < minimum) break;
          take(); left = node('Divide', left, { num: '100' }); continue;
        }
        if (next === ':') {
          if (RATIO_BINDING < minimum) break;
          take();
          if (peek() === '=') throw new MathInputProblem('syntax', `${RATIO_DEFINITION}。`);
          if (groups.at(-1) === true) throw new MathInputProblem('syntax', `${RATIO_IN_LIST}。`);
          if (clockDigits(tokens[position - 2]) || clockDigits(tokens[position])) throw new MathInputProblem('syntax', `${RATIO_TIME}。`);
          left = node('Divide', left, expression(RATIO_BINDING + 1));
          if (peek() === ':') throw new MathInputProblem('syntax', `${RATIO_TERMS}。`);
          continue;
        }
        const operation = INFIX[next];
        if (operation) {
          if (operation[1] < minimum) break;
          take(); const right = expression(operation[1] + (next === '^' ? 0 : 1));
          left = node(operation[0], left, right);
        } else {
          if (40 < minimum) break;
          left = node('InvisibleOperator', left, expression(41));
        }
      }
      return left;
    } finally { depth--; }
  }
  const result = expression(0);
  if (position !== tokens.length) throw new MathInputProblem('syntax', '数式の終わりに解釈できない記号があります。');
  return result;
}
