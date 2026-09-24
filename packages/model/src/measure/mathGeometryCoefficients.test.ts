import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { CANDIDATE_MATH_BY_ID, MATH_INPUT_FORMAT, validateMathDecimal, type MathNode,
  type StoredMathExpression } from '@pointercad/expression/math/contracts';

import {
  GEOMETRY_DERIVED_OPERATIONS,
  checkGeometryDerivedOperations,
  mathGeometryBooleanMessage,
  mathGeometryCoefficientValue,
  mathGeometryDerivedParameters,
  mathGeometryOperationMessage,
  mathGeometryOutsideCoefficientMessage,
  mathGeometryPendingMessage,
  mathGeometryReferenceMismatchMessage,
  mathGeometryUnresolvedMessage,
  resolvableMathGeometryDefinitions,
} from './mathGeometryCoefficients.js';
import { DEFAULT_MATH_GEOMETRY_TOLERANCE, mathGeometryCoefficientId } from './mathGeometryIdentity.js';
import type { MathGeometryDefinition, MathGeometryOutcome } from './mathGeometryTypes.js';
import { createEmptyPartDocument } from '../part/createPartDocument.js';
import type { PartDocument } from '../part/types.js';
import type { Parameter } from '../parameters/types.js';

// ---------------------------------------------------------------------------
// Hand-built fixtures: these functions are pure, so no math Worker is involved here. The real engine
// path is exercised in `part/evaluateDocumentMathGeometry.test.ts`.
// ---------------------------------------------------------------------------

const DOCUMENT_ID = createEmptyPartDocument().id;

function numberNode(decimal: string): MathNode {
  return { kind: 'number', decimal };
}
function coefficientNode(id: string, label: string): MathNode {
  return { kind: 'symbol', reference: { role: 'coefficient', id, label } };
}
function geometryNode(definitionId: string, label: string): MathNode {
  return coefficientNode(mathGeometryCoefficientId(definitionId), label);
}
function operation(id: string, ...operands: readonly MathNode[]): MathNode {
  return { kind: 'operation', operation: id, operands };
}
function stored(expression: MathNode): StoredMathExpression {
  return { format: MATH_INPUT_FORMAT, source: '0', inputNotation: 'text', angleUnit: 'degree', expression };
}
function mathValue(expression: MathNode): ExpressionValue {
  const definition = stored(expression);
  return { source: definition.source, value: 0, display: '0', mathDefinition: definition };
}
function legacyValue(source: string): ExpressionValue {
  return { ...expressionValueFromNumber(0), source };
}
function row(name: string, value: ExpressionValue, mathId?: string): Parameter {
  return { name, value, ...(mathId === undefined ? {} : { mathId }), unit: 'mm', description: '' };
}
function definition(id: string, name: string): MathGeometryDefinition {
  return { id, documentId: DOCUMENT_ID, name, quantity: { kind: 'volume', body: { kind: 'body', featureId: 'box-1' } },
    tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
}
function documentWith(parameters: readonly Parameter[], definitions: readonly MathGeometryDefinition[]): PartDocument {
  return { ...createEmptyPartDocument(), parameters, mathGeometry: definitions };
}
const identity = { id: 'g1', documentId: DOCUMENT_ID, generation: 4 } as const;
function realOutcome(value: number): MathGeometryOutcome {
  return { ...identity, status: 'value', kind: 'real', value, unit: 'mm', representation: 'geometry-double',
    tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
}

describe('checkGeometryDerivedOperations(Q4=S1 の許可範囲)', () => {
  it('許可する演算IDはすべて実在し、三角・双曲線とその逆の24種を含み、境目で飛ぶ演算を含まない', () => {
    for (const id of GEOMETRY_DERIVED_OPERATIONS) expect(CANDIDATE_MATH_BY_ID.has(id), id).toBe(true);
    // 17 (四則〜対数) + 24 (三角・双曲線とその逆) + 3 (arctan-two・reciprocal・clamp) + 6 (ベクトル) + 5 (構造用)
    expect(GEOMETRY_DERIVED_OPERATIONS.size).toBe(55);
    for (const id of ['sin', 'arccsc', 'csch', 'arsinh', 'arcsch', 'arctan-two', 'clamp', 'norm', 'coefficient-reference']) {
      expect(GEOMETRY_DERIVED_OPERATIONS.has(id), id).toBe(true);
    }
    for (const id of ['floor', 'ceiling', 'round', 'sign', 'modulo', 'less', 'equal', 'which', 'element', 'set', 'sum', 'integrate']) {
      expect(GEOMETRY_DERIVED_OPERATIONS.has(id), id).toBe(false);
    }
  });

  it('四則・累乗・根・絶対値・最小最大・指数対数・三角・atan2・clamp・ベクトルの連続な演算だけの式は通す', () => {
    const g = geometryNode('g1', 'G');
    const expression = operation('add',
      operation('multiply', operation('sqrt', operation('square', g)), { kind: 'constant', name: 'pi' }),
      operation('divide', operation('absolute', operation('negate', g)), operation('power', g, numberNode('2'))),
      operation('maximum', operation('minimum', g, numberNode('1e-7')), operation('clamp', g, numberNode('0'), numberNode('100'))),
      operation('natural-log', operation('exponential', operation('log-ten', operation('log-two', operation('log-base', g, numberNode('3')))))),
      operation('arctan-two', operation('sin', g), operation('arcsch', operation('reciprocal', g))),
      operation('norm', operation('cross', operation('list', g, g, g), operation('tuple', g, g, g))),
      operation('component', operation('list', g, g), numberNode('1')),
      operation('delimiter', operation('root', g, numberNode('3'))),
      operation('implicit-operation', g, operation('times-token', g, operation('dot-token', g, { kind: 'constant', name: 'e' }))),
    );
    expect(checkGeometryDerivedOperations(expression)).toBeNull();
  });

  it.each([
    ['floor', 'floor'], ['ceiling', 'ceil'], ['round', 'round'], ['sign', 'sign'], ['modulo', 'mod'], ['gcd', 'gcd'],
    ['factorial', 'factorial'], ['less', 'less'], ['equal', 'equal'], ['which', 'which'], ['element', 'element'], ['set', 'set'],
  ])('%s は値の境目で結果が飛ぶので拒否し、文字の表記(%s)で理由に出す', (id, name) => {
    const expression = operation('multiply', numberNode('2'), operation(id, geometryNode('g1', 'G')));
    expect(checkGeometryDerivedOperations(expression)).toEqual({ operation: id,
      message: `図形の測定値から計算する式では「${name}」を使えません。値の境目で結果が変わる計算は使えません。` });
  });

  it.each([['sum', 'sum'], ['integrate', 'integrate'], ['lambda', 'function']])(
    '束縛を持つ %s(和・積分・関数など)は中身に関わらず拒否する',
    (id, name) => {
      const variable = { role: 'bound', id: 'bound:k', label: 'k' } as const;
      const binder: MathNode = { kind: 'binder', operation: id, body: operation('multiply', geometryNode('g1', 'G'), { kind: 'symbol', reference: variable }),
        bindings: [{ variable, domain: { kind: 'range', lower: numberNode('1'), upper: numberNode('3'), step: null } }] };
      expect(checkGeometryDerivedOperations(operation('add', numberNode('1'), binder))).toEqual({ operation: id,
        message: mathGeometryOperationMessage(name) });
    },
  );

  it('入れ子の中の拒否対象は、前から順に最初のものを返す', () => {
    const g = geometryNode('g1', 'G');
    const expression = operation('add', operation('sqrt', g), operation('multiply', operation('round', g), operation('floor', g)));
    expect(checkGeometryDerivedOperations(expression)?.operation).toBe('round');
  });
});

describe('mathGeometryDerivedParameters(図形由来の係数の静的な判定)', () => {
  it('直接の参照・数式の係数経由・旧式の名前経由をたどり、表の順・自分の参照が先・重複なしで返す', () => {
    const parameters = [
      row('A', mathValue(operation('add', geometryNode('g1', 'G1'), geometryNode('g2', 'G2'))), 'coefficient:1'),
      row('B', mathValue(operation('multiply', coefficientNode('coefficient:1', 'A'), geometryNode('g3', 'G3'))), 'coefficient:2'),
      row('C', legacyValue('B*2'), 'coefficient:3'),
      row('D', legacyValue('3'), 'coefficient:4'),
      row('E', mathValue(operation('add', geometryNode('g1', 'G1'), coefficientNode('coefficient:1', 'A'))), 'coefficient:5'),
    ];
    expect([...mathGeometryDerivedParameters(parameters)]).toEqual([
      ['A', ['g1', 'g2']],
      ['B', ['g3', 'g1', 'g2']],
      ['C', ['g3', 'g1', 'g2']],
      ['E', ['g1', 'g2']],
    ]);
  });

  it('循環する係数でも止まり、存在しない定義への参照も図形由来として残す', () => {
    const parameters = [
      row('P', mathValue(operation('add', geometryNode('missing', 'M'), coefficientNode('coefficient:2', 'Q'))), 'coefficient:1'),
      row('Q', mathValue(operation('add', coefficientNode('coefficient:1', 'P'), numberNode('1'))), 'coefficient:2'),
    ];
    expect([...mathGeometryDerivedParameters(parameters)]).toEqual([['P', ['missing']], ['Q', ['missing']]]);
  });

  it('図形の測定値を使わない表は空で返す', () => {
    const parameters = [row('A', legacyValue('1/3'), 'coefficient:1'),
      row('B', mathValue(operation('multiply', coefficientNode('coefficient:1', 'A'), numberNode('3'))), 'coefficient:2')];
    expect(mathGeometryDerivedParameters(parameters).size).toBe(0);
  });
});

describe('mathGeometryCoefficientValue(測った値を係数として渡す契約)', () => {
  it.each([[20, '20'], [1e-7, '1e-7'], [1.5e21, '1.5e+21'], [-12.5, '-12.5'], [0.1, '0.1']] as const)(
    '%s は最短の十進表記 %s だけで渡し、exactExpression を付けない',
    (value, decimal) => {
      const document = documentWith([], [definition('g1', 'G')]);
      const input = mathGeometryCoefficientValue(document, definition('g1', 'G'), realOutcome(value));
      expect(input).toEqual({ status: 'value', coefficient: { id: 'math-geometry:g1', label: 'G', decimal } });
      if (input.status !== 'value') throw new Error('Expected a value');
      expect(input.coefficient).not.toHaveProperty('exactExpression');
      expect(() => validateMathDecimal(input.coefficient.decimal)).not.toThrow();
      expect(Number(input.coefficient.decimal)).toBe(value);
    },
  );

  it('真偽・未解決・未計算・他の文書・他の定義・有限でない値を区別し、現在の値として使わない', () => {
    const document = documentWith([], [definition('g1', 'G')]), target = definition('g1', 'G');
    const boolean: MathGeometryOutcome = { ...identity, status: 'value', kind: 'boolean', value: true,
      representation: 'geometry-double', tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
    const unresolved: MathGeometryOutcome = { ...identity, status: 'unresolved', reason: 'ambiguous-reference',
      message: '形が変わり、参照先を1つに決められません。選び直してください。' };
    expect(mathGeometryCoefficientValue(document, target, boolean)).toEqual({ status: 'boolean' });
    expect(mathGeometryCoefficientValue(document, target, unresolved)).toEqual({ status: 'unresolved',
      reason: 'ambiguous-reference', message: '形が変わり、参照先を1つに決められません。選び直してください。' });
    expect(mathGeometryCoefficientValue(document, target, undefined)).toEqual({ status: 'pending' });
    expect(mathGeometryCoefficientValue(document, target, { ...realOutcome(20), documentId: 'another-part' })).toEqual({ status: 'pending' });
    expect(mathGeometryCoefficientValue(document, target, { ...realOutcome(20), id: 'g2' })).toEqual({ status: 'pending' });
    expect(mathGeometryCoefficientValue(document, target, realOutcome(Number.NaN))).toMatchObject({ status: 'unresolved', reason: 'failed-geometry' });
  });

  it('識別番号・名前が重なる定義と、係数と同じ名前の定義は参照先に使わない', () => {
    const document = documentWith([row('P', legacyValue('1'), 'coefficient:1')], [
      definition('g1', 'A'), definition('g2', 'B'), definition('g2', 'C'), definition('g3', 'D'), definition('g4', 'D'),
      definition('g5', 'P'), definition('g6', 'E'),
    ]);
    expect([...resolvableMathGeometryDefinitions(document).keys()]).toEqual(['g1', 'g6']);
    expect(resolvableMathGeometryDefinitions(documentWith([], [])).size).toBe(0);
  });
});

describe('理由の文(付録C。検査で文字列を照合する)', () => {
  it('付録Cの文と一字一句同じで、付録Cに無い2つの文も固定する', () => {
    expect(mathGeometryReferenceMismatchMessage('箱1体積')).toBe('図形の測定値の参照先を確認できません: 箱1体積');
    expect(mathGeometryUnresolvedMessage('箱1体積', '幅B', '参照先の形を正しく計算できませんでした。'))
      .toBe('図形の測定値「箱1体積」を測れないため、係数「幅B」を計算できません: 参照先の形を正しく計算できませんでした。');
    expect(mathGeometryBooleanMessage('平行1')).toBe('平行・垂直などの判定の結果は係数の式に使えません: 平行1');
    expect(mathGeometryOperationMessage('floor'))
      .toBe('図形の測定値から計算する式では「floor」を使えません。値の境目で結果が変わる計算は使えません。');
    expect(mathGeometryPendingMessage('箱1体積')).toBe('図形の測定値「箱1体積」を計算中です。形の計算が終わると使えます。');
    expect(mathGeometryOutsideCoefficientMessage('箱1体積')).toBe('図形の測定値は係数の式の中でだけ使えます: 箱1体積');
  });
});
