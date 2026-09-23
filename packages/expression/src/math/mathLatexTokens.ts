/** Project-owned, bounded tokenization for the mathematical input grammar. */
import { MathInputProblem, MATH_INPUT_LIMITS, validateMathSource } from './mathInputContract.js';

export type ParsedMathJson = string | number | { readonly num: string } | { readonly str: string }
  | readonly [string, ...ParsedMathJson[]];
export interface LatexToken { readonly text: string; readonly literal?: string }
const SPACING = new Set(['left', 'right', 'big', 'Big', 'bigl', 'bigr', 'biggl', 'biggr', 'displaystyle',
  'textstyle', 'limits', ',', ';', ':', '!', ' ', 'quad', 'qquad']);
export function latexTokens(source: string): readonly LatexToken[] {
  validateMathSource(source);
  const tokens: LatexToken[] = [];
  let index = 0;
  function literal(): string {
    while (/\s/u.test(source[index] ?? '') && index < source.length) index++;
    if (source[index++] !== '{') throw new MathInputProblem('syntax', '記号名を波括弧で囲んでください。');
    let value = '';
    for (; index < source.length; index++) {
      const c = source[index];
      if (c === '}') { index++; return value; }
      if (c === '\\' && ['_', '{', '}', '\\', '%', '#', '&', '$'].includes(source[index + 1])) {
        value += source[++index];
      } else if (c === '{' || c === '\\') throw new MathInputProblem('syntax', '記号名に数式命令は使えません。');
      else value += c;
    }
    throw new MathInputProblem('syntax', '記号名の閉じ括弧がありません。');
  }
  while (index < source.length) {
    if (tokens.length > MATH_INPUT_LIMITS.nodes * 8) throw new MathInputProblem('budget', '式の記号数が多すぎます。');
    const c = source[index];
    if (/\s/u.test(c)) { index++; continue; }
    if (c === '\\') {
      index++;
      const match = /^[A-Za-z]+/u.exec(source.slice(index));
      const command = match?.[0] ?? source[index] ?? '';
      index += command.length;
      if (['left', 'right'].includes(command) && source[index] === '|') {
        index++; tokens.push({ text: command === 'left' ? '\\lvert' : '\\rvert' }); continue;
      }
      if (SPACING.has(command)) continue;
      if (['operatorname', 'mathrm', 'mathit', 'mathbf', 'mathbb', 'text', 'begin', 'end'].includes(command)) {
        const value = literal();
        tokens.push(command === 'operatorname' ? { text: '@' + value }
          : command === 'text' ? { text: 'text', literal: value }
          : command === 'begin' || command === 'end' ? { text: '\\' + command, literal: value }
          : command === 'mathbb' ? { text: '\\mathbb' + value }
          : { text: command === 'mathrm' && value === 'd' ? '\\differential'
            : command === 'mathrm' && value === 'i' ? '\\imaginaryI' : value });
      } else tokens.push({ text: '\\' + command });
      continue;
    }
    const number = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/u.exec(source.slice(index));
    if (number) { tokens.push({ text: 'number', literal: number[0] }); index += number[0].length; continue; }
    const symbol = String.fromCodePoint(source.codePointAt(index) ?? 0);
    tokens.push({ text: symbol }); index += symbol.length;
  }
  return tokens;
}
