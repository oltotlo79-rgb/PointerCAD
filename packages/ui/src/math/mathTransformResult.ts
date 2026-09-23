import { CANDIDATE_MATH_BY_ID, formatMathText, type MathEvaluation } from '@pointercad/expression/math/contracts';
import { t } from '../i18n/t.js';

type Node = Parameters<typeof formatMathText>[0];
/** Parentheses follow precedence; variable labels and exact literals are never case-folded. */
export function readableMathResult(node: Node): string {
  function visit(value: Node): { text: string; precedence: number } {
    if (value.kind === 'number' && value.decimal.startsWith('-')) return { text: value.decimal, precedence: 25 };
    if (value.kind !== 'operation') return { text: formatMathText(value, CANDIDATE_MATH_BY_ID), precedence: 100 };
    const children = value.operands.map(visit);
    const child = (index: number, precedence: number) => children[index].precedence < precedence
      ? `(${children[index].text})` : children[index].text;
    const operation = value.operation;
    if (operation === 'power') {
      const exponent = value.operands[1];
      if (exponent.kind === 'number' && exponent.decimal === '-1') return { text: `1/${child(0, 21)}`, precedence: 20 };
      return { text: `${child(0, 31)}^${child(1, 31)}`, precedence: 30 };
    }
    if (operation === 'negate') return { text: `-${child(0, 26)}`, precedence: 25 };
    const infix: Readonly<Record<string, readonly [string, number]>> = {
      add: [' + ', 10], multiply: [' * ', 20], subtract: [' - ', 10], divide: ['/', 20],
      equal: [' = ', 5], 'not-equal': [' ≠ ', 5], less: [' < ', 5], 'less-equal': [' ≤ ', 5],
      greater: [' > ', 5], 'greater-equal': [' ≥ ', 5], and: [' かつ ', 3], or: [' または ', 2],
      implies: [' ⇒ ', 1], equivalent: [' ⇔ ', 1],
    };
    const operator = infix[operation];
    if (operator !== undefined) {
      const [separator, precedence] = operator;
      return { text: children.map((_, index) => child(index, precedence + (index > 0 ? 1 : 0))).join(separator), precedence };
    }
    const name = CANDIDATE_MATH_BY_ID.get(operation)?.engineHead.toLowerCase() ?? operation;
    return { text: `${name}(${children.map(value => value.text).join(',')})`, precedence: 100 };
  }
  return visit(node).text;
}

/** A formula with its domain is not yet a scalar coordinate. */
export function mathTransformResult(evaluation: Extract<MathEvaluation, { kind: 'transform' }>): { message: string; detail: string } {
  const { transform } = evaluation;
  const variable = transform.formula.bindings[0].variable.label;
  const formula = readableMathResult(transform.formula.body), condition = readableMathResult(transform.condition.body);
  const domain = condition === 'true' ? t('math.transform.allFinite') : condition;
  return { message: `${t('math.transform.formula')} F(${variable}) = ${formula}`,
    detail: `${t('math.transform.domain')}: ${domain}。${t(`math.transform.${transform.convention}`)} ${t('math.transform.select')}` };
}
