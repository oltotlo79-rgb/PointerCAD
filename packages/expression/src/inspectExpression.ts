import type { Node } from './ast.js';
import { evaluateExpressionExact, type ExactEvaluateOptions, type ExactExpressionResult } from './evaluate.js';
import type { ExpressionError } from './errors.js';
import type { ExpressionLengthUnit } from './lengthUnits.js';
import { parse } from './parse.js';

/** 元の入力文字列における、変数参照1回分のUTF-16範囲。終端は含まない。 */
export interface ExpressionReference {
  /** 評価器が参照する正規化済みの名前。元の綴りはsource.slice(start,end)で読める。 */
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/** 元の入力文字列に明記された長さ単位。終端は含まない。 */
export interface ExpressionUnitReference {
  /** 評価器が使う正規形。元の綴りはsource.slice(start,end)で読める。 */
  readonly unit: ExpressionLengthUnit;
  readonly start: number;
  readonly end: number;
}

/** 評価値と元式の位置情報。構文木やtokenは公開しない。 */
export interface ExpressionInspection {
  readonly source: string;
  readonly references: readonly ExpressionReference[];
  readonly units: readonly ExpressionUnitReference[];
  readonly result: ExactExpressionResult;
  readonly error: ExpressionError | null;
}

function visit(node: Node, references: ExpressionReference[], units: ExpressionUnitReference[]): void {
  switch (node.kind) {
    case 'variable':
      references.push(Object.freeze({ name: node.name, start: node.position, end: node.position + node.name.length }));
      return;
    case 'unit':
      units.push(Object.freeze({ unit: node.unit, start: node.position, end: node.position + node.unit.length }));
      visit(node.operand, references, units);
      return;
    case 'unary':
      visit(node.operand, references, units);
      return;
    case 'binary':
      visit(node.left, references, units);
      visit(node.right, references, units);
      return;
    case 'call':
      for (const argument of node.args) {
        visit(argument, references, units);
      }
      return;
    case 'number':
    case 'constant':
      return;
  }
}

/**
 * 式の参照・明示単位・評価結果を、元sourceのUTF-16位置とともに読み取る。
 * 構文が不完全なら参照を推測しない。名前解決や評価だけが失敗した場合は、
 * 読み取れた参照・単位を保ち、既存の安全評価器が返したエラーをそのまま伝える。
 */
export function inspectExpression(source: string, options: ExactEvaluateOptions = {}): ExpressionInspection {
  const evaluated = evaluateExpressionExact(source, options);
  const result: ExactExpressionResult = evaluated.ok
    ? Object.freeze({ ok: true, value: Object.freeze({ ...evaluated.value }) })
    : Object.freeze({ ok: false, error: Object.freeze({ ...evaluated.error }) });
  const references: ExpressionReference[] = [];
  const units: ExpressionUnitReference[] = [];
  try {
    visit(parse(source), references, units);
  } catch {
    // 構文・走査が完了しなければ、途中までの参照を確定情報として出さない。
    references.length = 0;
    units.length = 0;
  }
  references.sort((left, right) => left.start - right.start);
  units.sort((left, right) => left.start - right.start);
  return Object.freeze({
    source,
    references: Object.freeze(references),
    units: Object.freeze(units),
    result,
    error: result.ok ? null : result.error,
  });
}
