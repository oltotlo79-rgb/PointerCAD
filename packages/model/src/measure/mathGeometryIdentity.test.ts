import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { MATH_INPUT_FORMAT, type MathNode, type StoredMathExpression } from '@pointercad/expression/math/contracts';

import {
  DEFAULT_MATH_GEOMETRY_TOLERANCE,
  EMPTY_MATH_GEOMETRY_USAGE,
  MATH_GEOMETRY_COEFFICIENT_PREFIX,
  checkMathGeometryName,
  mathGeometryCoefficientId,
  mathGeometryDefinitionIdOf,
  mathGeometryReferencesOf,
  mathGeometryTargetsOf,
  mathGeometryUsage,
  type MathGeometryTarget,
} from './mathGeometryIdentity.js';
import type { MathGeometryBody, MathGeometryCurve, MathGeometryDefinition, MathGeometryPoint,
  MathGeometryQuantity } from './mathGeometryTypes.js';
import { createEmptyPartDocument } from '../part/createPartDocument.js';
import type { Configuration } from '../part/configurations.js';
import type { PartDocument } from '../part/types.js';
import type { UnresolvedMathProblem } from '../part/unresolvedMathProblems.js';
import type { Parameter } from '../parameters/types.js';

// ---------------------------------------------------------------------------
// Fixture builders. Hand-built MathNode trees (no math Worker) keep these tests pure and fast.
// ---------------------------------------------------------------------------

function numberNode(decimal: string): MathNode {
  return { kind: 'number', decimal };
}
function coefficientNode(id: string, label: string): MathNode {
  return { kind: 'symbol', reference: { role: 'coefficient', id, label } };
}
function sumNode(...operands: readonly MathNode[]): MathNode {
  return { kind: 'operation', operation: 'add', operands };
}
function storedExpression(expression: MathNode): StoredMathExpression {
  return { format: MATH_INPUT_FORMAT, source: '0', inputNotation: 'text', angleUnit: 'degree', expression };
}
function row(name: string, value: ExpressionValue = expressionValueFromNumber(1)): Parameter {
  return { name, value, unit: 'mm', description: '' };
}
function definition(id: string, name: string, documentId = 'part-1'): MathGeometryDefinition {
  return { id, documentId, name, quantity: { kind: 'volume', body: { kind: 'body', featureId: 'feature-1' } },
    tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
}
function configuration(name: string, mathDefinitions: Readonly<Record<string, StoredMathExpression>>): Configuration {
  return { id: `configuration-${name}`, name, values: {}, mathDefinitions };
}
function unresolvedProblem(id: string, name: string, definitionExpression: StoredMathExpression): UnresolvedMathProblem {
  return { id, name, status: 'unresolved', definition: definitionExpression };
}
function documentWith(overrides: Partial<PartDocument>): PartDocument {
  return { ...createEmptyPartDocument(), ...overrides };
}

describe('math-geometry の係数ID(接頭辞つき名前空間、R61・R22)', () => {
  it.each(['abc', 'a1b2-c3d4-uuid-like', '00000000-0000-4000-8000-000000000000'])(
    '定義ID %s をそのまま往復できる',
    (definitionId) => {
      const coefficientId = mathGeometryCoefficientId(definitionId);
      expect(coefficientId).toBe(`${MATH_GEOMETRY_COEFFICIENT_PREFIX}${definitionId}`);
      expect(mathGeometryDefinitionIdOf(coefficientId)).toBe(definitionId);
    },
  );

  it.each(['coefficient:1', 'math-problem:abc', '無関係な文字列', MATH_GEOMETRY_COEFFICIENT_PREFIX, ''])(
    '他の接頭辞・空の定義IDは自分の参照として受け付けない: %j',
    (coefficientId) => {
      expect(mathGeometryDefinitionIdOf(coefficientId)).toBeNull();
    },
  );
});

describe('DEFAULT_MATH_GEOMETRY_TOLERANCE(Q5=T1)', () => {
  it('長さ1e-6mm・角度1e-6radを返す(誤差保証ではなく表示用の比べる幅)', () => {
    expect(DEFAULT_MATH_GEOMETRY_TOLERANCE).toEqual({ linearMm: 1e-6, angularRadians: 1e-6 });
  });
});

describe('checkMathGeometryName', () => {
  it('識別子として正しく重複もなければ null', () => {
    expect(checkMathGeometryName(createEmptyPartDocument(), '体積1')).toBeNull();
  });

  it.each([
    ['', 'empty'],
    ['1体積', 'startsWithDigit'],
    ['sqrt', 'reserved'],
    ['名前\u0000後', 'invalidCharacter'],
    ['mm', 'lengthUnitName'],
  ] as const)('checkNewParameterNameの理由をそのまま伝える(%j → %s)', (name, issue) => {
    expect(checkMathGeometryName(createEmptyPartDocument(), name)).toBe(issue);
  });

  it('128文字までは通り、129文字は tooLong', () => {
    const document = createEmptyPartDocument();
    expect(checkMathGeometryName(document, 'a'.repeat(128))).toBeNull();
    expect(checkMathGeometryName(document, 'a'.repeat(129))).toBe('tooLong');
  });

  it.each([' 名前', '名前 ', ' 名前 '])('前後に空白があると whitespace: %j', (name) => {
    expect(checkMathGeometryName(createEmptyPartDocument(), name)).toBe('whitespace');
  });

  it('既存の係数(パラメータ)と同じ名前は duplicateName', () => {
    const document = documentWith({ parameters: [row('幅B')] });
    expect(checkMathGeometryName(document, '幅B')).toBe('duplicateName');
  });

  it('既存の別の図形の測定値と同じ名前は duplicateName', () => {
    const document = documentWith({ mathGeometry: [definition('def-1', '体積1')] });
    expect(checkMathGeometryName(document, '体積1')).toBe('duplicateName');
  });

  it('exceptIdで自分自身を除くので、同じ名前のままの変更はduplicateNameにならないが、他の定義が使っていれば拒否する', () => {
    const document = documentWith({ mathGeometry: [definition('def-1', '体積1')] });
    expect(checkMathGeometryName(document, '体積1', 'def-1')).toBeNull();
    expect(checkMathGeometryName(document, '体積1', 'def-2')).toBe('duplicateName');
  });
});

describe('mathGeometryReferencesOf', () => {
  it('math-geometry接頭辞の参照だけを、通常の係数参照と混在していてもlabel付きで取り出す', () => {
    const geometryId = mathGeometryCoefficientId('def-1');
    const expression = storedExpression(sumNode(
      coefficientNode(geometryId, '体積1'),
      coefficientNode('coefficient:1', '幅B'),
    ));
    expect(mathGeometryReferencesOf(expression)).toEqual([
      { coefficientId: geometryId, definitionId: 'def-1', label: '体積1' },
    ]);
  });

  it('図形の測定値を参照していない式は空配列', () => {
    const expression = storedExpression(sumNode(coefficientNode('coefficient:1', '幅B'), numberNode('2')));
    expect(mathGeometryReferencesOf(expression)).toEqual([]);
  });

  it('定義が改名されlabelが古いままでも識別番号で抽出できる(一致の判定は呼び出し側の責務)', () => {
    const geometryId = mathGeometryCoefficientId('def-1');
    const expression = storedExpression(coefficientNode(geometryId, '古い名前'));
    expect(mathGeometryReferencesOf(expression)).toEqual([
      { coefficientId: geometryId, definitionId: 'def-1', label: '古い名前' },
    ]);
  });
});

describe('mathGeometryUsage', () => {
  it('係数の現在値から参照している定義を名前で拾う', () => {
    const geometryId = mathGeometryCoefficientId('def-1');
    const document = documentWith({
      parameters: [row('幅B', { ...expressionValueFromNumber(24), mathDefinition: storedExpression(coefficientNode(geometryId, '体積1')) })],
    });
    expect(mathGeometryUsage(document).get('def-1')).toEqual({ parameterNames: ['幅B'], configurationNames: [], unresolvedProblemNames: [] });
  });

  it('構成の上書き式からも拾い、同じ構成内の複数の係数が参照していても構成名は一度だけ', () => {
    const geometryId = mathGeometryCoefficientId('def-1');
    const document = documentWith({
      configurations: [configuration('サイズ違い', {
        幅B: storedExpression(coefficientNode(geometryId, '体積1')),
        奥行D: storedExpression(coefficientNode(geometryId, '体積1')),
      })],
    });
    expect(mathGeometryUsage(document).get('def-1')).toEqual({ parameterNames: [], configurationNames: ['サイズ違い'], unresolvedProblemNames: [] });
  });

  it('未解決の式からも拾う', () => {
    const geometryId = mathGeometryCoefficientId('def-1');
    const document = documentWith({
      unresolvedMathProblems: [unresolvedProblem('math-problem:p1', '解けない式', storedExpression(coefficientNode(geometryId, '体積1')))],
    });
    expect(mathGeometryUsage(document).get('def-1')).toEqual({ parameterNames: [], configurationNames: [], unresolvedProblemNames: ['解けない式'] });
  });

  it('どこからも参照されていなければマップに現れず、既定値で読み取れる', () => {
    const document = documentWith({ mathGeometry: [definition('def-1', '体積1')] });
    const usage = mathGeometryUsage(document);
    expect(usage.has('def-1')).toBe(false);
    expect(usage.get('def-1') ?? EMPTY_MATH_GEOMETRY_USAGE).toEqual(EMPTY_MATH_GEOMETRY_USAGE);
  });
});

describe('mathGeometryTargetsOf(量の種類ごとの対象一覧、§4(d)・§4(f))', () => {
  const pointA: MathGeometryPoint = { kind: 'sketch-point', sketchId: 's1', reference: { kind: 'point', pointId: 'p1' } };
  const pointB: MathGeometryPoint = { kind: 'sketch-point', sketchId: 's1', reference: { kind: 'point', pointId: 'p2' } };
  const curveA: MathGeometryCurve = { kind: 'sketch-curve', sketchId: 's1', featureId: 'c1' };
  const curveB: MathGeometryCurve = { kind: 'sketch-curve', sketchId: 's1', featureId: 'c2' };
  const bodyA: MathGeometryBody = { kind: 'body', featureId: 'b1' };
  const bodyB: MathGeometryBody = { kind: 'body', featureId: 'b2' };

  const cases: ReadonlyArray<{ readonly description: string; readonly quantity: MathGeometryQuantity; readonly expected: readonly MathGeometryTarget[] }> = [
    { description: 'coordinate', quantity: { kind: 'coordinate', point: pointA, component: 'X' }, expected: [pointA] },
    { description: 'point-distance', quantity: { kind: 'point-distance', first: pointA, second: pointB }, expected: [pointA, pointB] },
    { description: 'shape-distance', quantity: { kind: 'shape-distance', first: bodyA, second: bodyB }, expected: [bodyA, bodyB] },
    { description: 'length', quantity: { kind: 'length', curve: curveA }, expected: [curveA] },
    { description: 'area', quantity: { kind: 'area', shape: bodyA }, expected: [bodyA] },
    { description: 'volume', quantity: { kind: 'volume', body: bodyA }, expected: [bodyA] },
    { description: 'angle', quantity: { kind: 'angle', first: curveA, second: curveB, unit: 'degree' }, expected: [curveA, curveB] },
    { description: 'parallel', quantity: { kind: 'parallel', first: curveA, second: curveB }, expected: [curveA, curveB] },
    { description: 'perpendicular', quantity: { kind: 'perpendicular', first: curveA, second: curveB }, expected: [curveA, curveB] },
  ];

  for (const testCase of cases) {
    it(`${testCase.description} の対象を正しく返す`, () => {
      expect(mathGeometryTargetsOf(testCase.quantity)).toEqual(testCase.expected);
    });
  }
});
