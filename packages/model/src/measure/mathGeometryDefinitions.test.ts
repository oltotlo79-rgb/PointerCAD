import { describe, expect, it } from 'vitest';
import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { MATH_INPUT_FORMAT, type MathNode, type StoredMathExpression } from '@pointercad/expression/math/contracts';

import {
  addMathGeometryDefinition,
  isMathGeometryAngleQuantity,
  mathGeometryAngleUnitOf,
  removeMathGeometryDefinition,
  replaceMathGeometryQuantity,
  setMathGeometryAngleUnit,
  setMathGeometryTolerance,
  validateMathGeometryTolerance,
  type MathGeometryDefinitionInput,
} from './mathGeometryDefinitions.js';
import { DEFAULT_MATH_GEOMETRY_TOLERANCE, mathGeometryCoefficientId } from './mathGeometryIdentity.js';
import type { MathGeometryBody, MathGeometryCurve, MathGeometryDefinition, MathGeometryQuantity,
  MathGeometryTolerance } from './mathGeometryTypes.js';
import { createEmptyPartDocument } from '../part/createPartDocument.js';
import type { Configuration } from '../part/configurations.js';
import type { PartDocument } from '../part/types.js';
import type { UnresolvedMathProblem } from '../part/unresolvedMathProblems.js';
import type { Parameter } from '../parameters/types.js';

// ---------------------------------------------------------------------------
// Fixture builders (same style as ./mathGeometryIdentity.test.ts): hand-built MathNode trees, no math
// Worker, no OCCT — every function under test is a pure PartDocument → PartDocument command.
// ---------------------------------------------------------------------------

const bodyA: MathGeometryBody = { kind: 'body', featureId: 'body-a' };
const bodyB: MathGeometryBody = { kind: 'body', featureId: 'body-b' };
const curveA: MathGeometryCurve = { kind: 'sketch-curve', sketchId: 'sketch-1', featureId: 'curve-a' };
const curveB: MathGeometryCurve = { kind: 'sketch-curve', sketchId: 'sketch-1', featureId: 'curve-b' };
const volumeOf = (body: MathGeometryBody): MathGeometryQuantity => ({ kind: 'volume', body });
const lengthOf = (curve: MathGeometryCurve): MathGeometryQuantity => ({ kind: 'length', curve });
const angleOf = (first: MathGeometryCurve, second: MathGeometryCurve, unit: 'degree' | 'radian'): MathGeometryQuantity =>
  ({ kind: 'angle', first, second, unit });

function definition(id: string, name: string, quantity: MathGeometryQuantity = volumeOf(bodyA),
  tolerance: MathGeometryTolerance = DEFAULT_MATH_GEOMETRY_TOLERANCE): MathGeometryDefinition {
  return { id, documentId: 'part-1', name, quantity, tolerance };
}
function documentWith(overrides: Partial<PartDocument>): PartDocument {
  return { ...createEmptyPartDocument(), ...overrides };
}
function row(name: string, value: ExpressionValue = expressionValueFromNumber(1)): Parameter {
  return { name, value, unit: 'mm', description: '' };
}
function coefficientNode(id: string, label: string): MathNode {
  return { kind: 'symbol', reference: { role: 'coefficient', id, label } };
}
function storedExpression(expression: MathNode): StoredMathExpression {
  return { format: MATH_INPUT_FORMAT, source: '0', inputNotation: 'text', angleUnit: 'degree', expression };
}
function configuration(name: string, mathDefinitions: Readonly<Record<string, StoredMathExpression>>): Configuration {
  return { id: `configuration-${name}`, name, values: {}, mathDefinitions };
}
function unresolvedProblem(id: string, name: string, definitionExpression: StoredMathExpression): UnresolvedMathProblem {
  return { id, name, status: 'unresolved', definition: definitionExpression };
}
function input(overrides: Partial<MathGeometryDefinitionInput> = {}): MathGeometryDefinitionInput {
  return { name: '体積1', quantity: volumeOf(bodyA), ...overrides };
}

describe('addMathGeometryDefinition', () => {
  it('既定の比べる幅で追加し、元の文書は変えない', () => {
    const document = createEmptyPartDocument();
    const result = addMathGeometryDefinition(document, input(), 'def-1');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.document.mathGeometry).toEqual([
      { id: 'def-1', documentId: document.id, name: '体積1', quantity: volumeOf(bodyA), tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE },
    ]);
    expect(document.mathGeometry).toBeUndefined();
  });

  it('明示した妥当な比べる幅で追加できる', () => {
    const tolerance: MathGeometryTolerance = { linearMm: 1e-4, angularRadians: 0.01 };
    const result = addMathGeometryDefinition(createEmptyPartDocument(), input({ tolerance }), 'def-1');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.document.mathGeometry?.[0]?.tolerance).toEqual(tolerance);
  });

  it.each([
    ['', 'empty'],
    ['1体積', 'startsWithDigit'],
  ] as const)('checkMathGeometryNameの理由をそのまま伝え、文書を変えない(%j → %s)', (name, reason) => {
    const document = createEmptyPartDocument();
    const result = addMathGeometryDefinition(document, input({ name }), 'def-1');
    expect(result).toMatchObject({ ok: false, reason });
    if (result.ok) throw new Error('unreachable');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('既存の係数と同じ名前は duplicateName で拒否し、文書を変えない', () => {
    const document = documentWith({ parameters: [row('体積1')] });
    const result = addMathGeometryDefinition(document, input({ name: '体積1' }), 'def-1');
    expect(result).toMatchObject({ ok: false, reason: 'duplicateName' });
    expect(document.mathGeometry).toBeUndefined();
  });

  it('既存の別の図形の測定値と同じ名前は duplicateName で拒否する', () => {
    const document = documentWith({ mathGeometry: [definition('def-1', '体積1')] });
    const result = addMathGeometryDefinition(document, input({ name: '体積1' }), 'def-2');
    expect(result).toMatchObject({ ok: false, reason: 'duplicateName' });
  });

  it('同じ識別番号の定義が既にあれば duplicateId で拒否し、文書を変えない', () => {
    const document = documentWith({ mathGeometry: [definition('def-1', '既存')] });
    const result = addMathGeometryDefinition(document, input({ name: '新規' }), 'def-1');
    expect(result).toMatchObject({ ok: false, reason: 'duplicateId' });
    expect(document.mathGeometry).toHaveLength(1);
  });

  it('明示した比べる幅が範囲外なら invalidTolerance で拒否する', () => {
    const result = addMathGeometryDefinition(createEmptyPartDocument(),
      input({ tolerance: { linearMm: 0, angularRadians: 1e-6 } }), 'def-1');
    expect(result).toMatchObject({ ok: false, reason: 'invalidTolerance' });
  });
});

describe('replaceMathGeometryQuantity', () => {
  it('同じ種類の量なら参照先を差し替え、id・名前・比べる幅は保つ', () => {
    const original = definition('def-1', '体積1', volumeOf(bodyA), { linearMm: 5e-5, angularRadians: 0.02 });
    const document = documentWith({ mathGeometry: [original] });
    const result = replaceMathGeometryQuantity(document, 'def-1', volumeOf(bodyB));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.document.mathGeometry).toEqual([{ ...original, quantity: volumeOf(bodyB) }]);
    // Purity: the original document's own array is untouched.
    expect(document.mathGeometry).toEqual([original]);
  });

  it('存在しないIDは notFound で拒否する', () => {
    const document = documentWith({ mathGeometry: [definition('def-1', '体積1')] });
    const result = replaceMathGeometryQuantity(document, 'no-such-id', volumeOf(bodyB));
    expect(result).toMatchObject({ ok: false, reason: 'notFound' });
  });

  it('量の種類が変わる選び直しは kindMismatch で拒否し、文書を変えない', () => {
    const document = documentWith({ mathGeometry: [definition('def-1', '体積1', volumeOf(bodyA))] });
    const result = replaceMathGeometryQuantity(document, 'def-1', lengthOf(curveA));
    expect(result).toMatchObject({ ok: false, reason: 'kindMismatch' });
    expect(document.mathGeometry?.[0]?.quantity).toEqual(volumeOf(bodyA));
  });

  it('角度の単位が変わる選び直しは unitMismatch で拒否する', () => {
    const document = documentWith({ mathGeometry: [definition('def-1', '角度1', angleOf(curveA, curveB, 'degree'))] });
    const result = replaceMathGeometryQuantity(document, 'def-1', angleOf(curveA, curveB, 'radian'));
    expect(result).toMatchObject({ ok: false, reason: 'unitMismatch' });
  });
});

describe('setMathGeometryAngleUnit', () => {
  it('度からラジアンへ切り替えられる', () => {
    const document = documentWith({ mathGeometry: [definition('def-1', '角度1', angleOf(curveA, curveB, 'degree'))] });
    const result = setMathGeometryAngleUnit(document, 'def-1', 'radian');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.document.mathGeometry?.[0]?.quantity).toEqual(angleOf(curveA, curveB, 'radian'));
  });

  it('既に同じ単位なら同じ文書参照を返す(無駄な再計算を起こさない)', () => {
    const document = documentWith({ mathGeometry: [definition('def-1', '角度1', angleOf(curveA, curveB, 'degree'))] });
    const result = setMathGeometryAngleUnit(document, 'def-1', 'degree');
    expect(result).toEqual({ ok: true, document });
    if (result.ok) expect(result.document).toBe(document);
  });

  it('角度以外の定義には notAngle で拒否する', () => {
    const document = documentWith({ mathGeometry: [definition('def-1', '体積1', volumeOf(bodyA))] });
    const result = setMathGeometryAngleUnit(document, 'def-1', 'radian');
    expect(result).toMatchObject({ ok: false, reason: 'notAngle' });
  });

  it('存在しないIDは notFound で拒否する', () => {
    const result = setMathGeometryAngleUnit(createEmptyPartDocument(), 'no-such-id', 'radian');
    expect(result).toMatchObject({ ok: false, reason: 'notFound' });
  });
});

describe('removeMathGeometryDefinition', () => {
  it('未使用の定義を削除できる', () => {
    const document = documentWith({ mathGeometry: [definition('def-1', '体積1'), definition('def-2', '体積2')] });
    const result = removeMathGeometryDefinition(document, 'def-1');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.document.mathGeometry).toEqual([definition('def-2', '体積2')]);
    expect(document.mathGeometry).toHaveLength(2); // purity: original untouched
  });

  it('係数の式で使われていれば inUse で拒否し、その係数の名前を含める。文書は変えない', () => {
    const geometryId = mathGeometryCoefficientId('def-1');
    const document = documentWith({
      mathGeometry: [definition('def-1', '体積1')],
      parameters: [row('幅B', { ...expressionValueFromNumber(24), mathDefinition: storedExpression(coefficientNode(geometryId, '体積1')) })],
    });
    const result = removeMathGeometryDefinition(document, 'def-1');
    expect(result).toMatchObject({ ok: false, reason: 'inUse' });
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('幅B');
    expect(document.mathGeometry).toHaveLength(1);
  });

  it('構成の上書き式から使われていても inUse で拒否する', () => {
    const geometryId = mathGeometryCoefficientId('def-1');
    const document = documentWith({
      mathGeometry: [definition('def-1', '体積1')],
      configurations: [configuration('サイズ違い', { 幅B: storedExpression(coefficientNode(geometryId, '体積1')) })],
    });
    const result = removeMathGeometryDefinition(document, 'def-1');
    expect(result).toMatchObject({ ok: false, reason: 'inUse' });
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('サイズ違い');
  });

  it('未解決の式から使われていても inUse で拒否する', () => {
    const geometryId = mathGeometryCoefficientId('def-1');
    const document = documentWith({
      mathGeometry: [definition('def-1', '体積1')],
      unresolvedMathProblems: [unresolvedProblem('math-problem:p1', '解けない式', storedExpression(coefficientNode(geometryId, '体積1')))],
    });
    const result = removeMathGeometryDefinition(document, 'def-1');
    expect(result).toMatchObject({ ok: false, reason: 'inUse' });
    if (result.ok) throw new Error('unreachable');
    expect(result.message).toContain('解けない式');
  });

  it('存在しないIDは notFound で拒否する', () => {
    const result = removeMathGeometryDefinition(createEmptyPartDocument(), 'no-such-id');
    expect(result).toMatchObject({ ok: false, reason: 'notFound' });
  });
});

describe('setMathGeometryTolerance(Q5=T3、GR-03への追加)', () => {
  it('正常な比べる幅の変更ができる', () => {
    const document = documentWith({ mathGeometry: [definition('def-1', '体積1')] });
    const tolerance: MathGeometryTolerance = { linearMm: 2.5e-5, angularRadians: 0.001 };
    const result = setMathGeometryTolerance(document, 'def-1', tolerance);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.document.mathGeometry?.[0]?.tolerance).toEqual(tolerance);
    expect(document.mathGeometry?.[0]?.tolerance).toEqual(DEFAULT_MATH_GEOMETRY_TOLERANCE); // purity
  });

  it('既に同じ値なら同じ文書参照を返す(無駄な再計算を起こさない)', () => {
    const document = documentWith({ mathGeometry: [definition('def-1', '体積1')] });
    const result = setMathGeometryTolerance(document, 'def-1', DEFAULT_MATH_GEOMETRY_TOLERANCE);
    expect(result).toEqual({ ok: true, document });
    if (result.ok) expect(result.document).toBe(document);
  });

  it.each([
    ['linearMmが0', { linearMm: 0, angularRadians: 1e-6 }],
    ['linearMmが負', { linearMm: -1e-6, angularRadians: 1e-6 }],
    ['linearMmが非有限(NaN)', { linearMm: Number.NaN, angularRadians: 1e-6 }],
    ['linearMmが非有限(Infinity)', { linearMm: Number.POSITIVE_INFINITY, angularRadians: 1e-6 }],
    ['angularRadiansが0', { linearMm: 1e-6, angularRadians: 0 }],
    ['angularRadiansが負', { linearMm: 1e-6, angularRadians: -1e-6 }],
    ['angularRadiansが範囲外(45度=π/4ちょうど)', { linearMm: 1e-6, angularRadians: Math.PI / 4 }],
    ['angularRadiansが範囲外(π/2)', { linearMm: 1e-6, angularRadians: Math.PI / 2 }],
    ['angularRadiansが非有限(NaN)', { linearMm: 1e-6, angularRadians: Number.NaN }],
  ] as const)('%s は invalidTolerance で拒否し、文書を変えない', (_label, tolerance) => {
    const document = documentWith({ mathGeometry: [definition('def-1', '体積1')] });
    const result = setMathGeometryTolerance(document, 'def-1', tolerance);
    expect(result).toMatchObject({ ok: false, reason: 'invalidTolerance' });
    expect(document.mathGeometry?.[0]?.tolerance).toEqual(DEFAULT_MATH_GEOMETRY_TOLERANCE);
  });

  it('存在しないIDは notFound で拒否する', () => {
    const result = setMathGeometryTolerance(createEmptyPartDocument(), 'no-such-id', DEFAULT_MATH_GEOMETRY_TOLERANCE);
    expect(result).toMatchObject({ ok: false, reason: 'notFound' });
  });
});

describe('validateMathGeometryTolerance(GR-03b、比べる幅の欄ごとの検査)', () => {
  it('既定の比べる幅は妥当(null)', () => {
    expect(validateMathGeometryTolerance(DEFAULT_MATH_GEOMETRY_TOLERANCE)).toBeNull();
  });

  it.each([
    ['0', 0],
    ['負', -1e-6],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ] as const)('長さの幅が%sなら linear を返す', (_label, linearMm) => {
    expect(validateMathGeometryTolerance({ linearMm, angularRadians: 1e-6 })).toBe('linear');
  });

  it.each([
    ['0', 0],
    ['負', -1e-6],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['π/4ちょうど(45度)', Math.PI / 4],
    ['π/2(90度)', Math.PI / 2],
  ] as const)('角度の幅が%sなら angular を返す', (_label, angularRadians) => {
    expect(validateMathGeometryTolerance({ linearMm: 1e-6, angularRadians })).toBe('angular');
  });

  it('境界は0と45度の側だけを除く(0より大きい最小の数、π/4 よりわずかに小さい数は妥当)', () => {
    expect(validateMathGeometryTolerance({ linearMm: Number.MIN_VALUE, angularRadians: Number.MIN_VALUE })).toBeNull();
    expect(validateMathGeometryTolerance({ linearMm: 1e300, angularRadians: Math.PI / 4 - Number.EPSILON })).toBeNull();
    // The screen's input is in degrees (GR-19a converts before calling): 44.9° is valid, 45° is not.
    expect(validateMathGeometryTolerance({ linearMm: 1e-6, angularRadians: 44.9 * Math.PI / 180 })).toBeNull();
    expect(validateMathGeometryTolerance({ linearMm: 1e-6, angularRadians: 45 * Math.PI / 180 })).toBe('angular');
  });

  it('両方の欄が範囲外なら先の欄(長さ)を返す', () => {
    expect(validateMathGeometryTolerance({ linearMm: 0, angularRadians: Math.PI })).toBe('linear');
  });
});

describe('比べる幅の拒否文(付録C、GR-03b。角度は45度と書く)', () => {
  const LINEAR_MESSAGE = '長さの比べる幅は0より大きい有限の数にしてください。';
  const ANGULAR_MESSAGE = '角度の比べる幅は0より大きく45度より小さい数にしてください。';

  it('setMathGeometryTolerance は長さの欄の誤りを長さの文で断る', () => {
    const document = documentWith({ mathGeometry: [definition('def-1', '体積1')] });
    expect(setMathGeometryTolerance(document, 'def-1', { linearMm: -1, angularRadians: 1e-6 }))
      .toEqual({ ok: false, reason: 'invalidTolerance', message: LINEAR_MESSAGE });
  });

  it('setMathGeometryTolerance は角度の欄の誤りを45度の文で断り、90度とは書かない', () => {
    const document = documentWith({ mathGeometry: [definition('def-1', '体積1')] });
    const result = setMathGeometryTolerance(document, 'def-1', { linearMm: 1e-6, angularRadians: Math.PI / 4 });
    expect(result).toEqual({ ok: false, reason: 'invalidTolerance', message: ANGULAR_MESSAGE });
    if (result.ok) throw new Error('unreachable');
    expect(result.message).not.toContain('90度');
  });

  it.each([
    ['長さ', { linearMm: Number.NaN, angularRadians: 1e-6 }, LINEAR_MESSAGE],
    ['角度', { linearMm: 1e-6, angularRadians: 0 }, ANGULAR_MESSAGE],
  ] as const)('addMathGeometryDefinition も%sの欄の誤りを同じ文で断る', (_label, tolerance, message) => {
    expect(addMathGeometryDefinition(createEmptyPartDocument(), input({ tolerance }), 'def-1'))
      .toEqual({ ok: false, reason: 'invalidTolerance', message });
  });
});

describe('GR-10 新しい角度の単位の共通判定', () => {
  const face = { kind: 'face' as const, reference: { bodyFeatureId: 'box', index: 0,
    fingerprint: { kind: 'face' as const, surfaceKind: 'plane' as const, area: 100,
      position: [0, 0, 0] as const, axis: [0, 0, 1] as const, radius: null } } };
  const point = { kind: 'sketch-point' as const, sketchId: 'sketch-1', reference: { kind: 'point' as const, pointId: 'p1' } };
  const angles = [
    { kind: 'plane-angle', first: face, second: face, unit: 'degree' },
    { kind: 'line-plane-angle', line: curveA, plane: face, unit: 'degree' },
    { kind: 'point-angle', first: point, second: point, third: point, unit: 'degree' },
    { kind: 'central-angle', curve: curveA, unit: 'degree' },
  ] as const satisfies readonly MathGeometryQuantity[];
  describe.each(angles)('$kind', quantity => {
    it('単位を往復変更しても識別子・参照・名前・比べる幅を保持する', () => {
      const existing = definition('angle', '測定角', quantity), document = documentWith({ mathGeometry: [existing] });
      const switched = setMathGeometryAngleUnit(document, existing.id, 'radian');
      if (!switched.ok) throw new Error(switched.message);
      expect(switched.document).not.toBe(document);
      expect(switched.document.mathGeometry).toEqual([{ ...existing, quantity: { ...quantity, unit: 'radian' } }]);
      const returned = setMathGeometryAngleUnit(switched.document, existing.id, 'degree');
      if (!returned.ok) throw new Error(returned.message);
      expect(returned.document).toEqual(document);
      expect(document.mathGeometry?.[0]).toBe(existing);
    });
    it.each(['degree', 'radian'] as const)('同じ単位%sの指定は同じ文書参照を返す', unit => {
      const document = documentWith({ mathGeometry: [definition('angle', '測定角', { ...quantity, unit })] });
      const result = setMathGeometryAngleUnit(document, 'angle', unit);
      if (!result.ok) throw new Error(result.message);
      expect(result.document).toBe(document);
    });
    it('単位が違う選び直しはunitMismatch', () => {
      const document = documentWith({ mathGeometry: [definition('angle', '測定角', quantity)] });
      expect(replaceMathGeometryQuantity(document, 'angle', { ...quantity, unit: 'radian' }))
        .toMatchObject({ ok: false, reason: 'unitMismatch' });
      expect(document.mathGeometry?.[0].quantity).toBe(quantity);
    });
    it('同じ単位の選び直しを受理し、公開ガードは単位を読み取る', () => {
      expect(isMathGeometryAngleQuantity(quantity)).toBe(true);
      expect(mathGeometryAngleUnitOf(quantity)).toBe('degree');
      expect(mathGeometryAngleUnitOf({ ...quantity, unit: 'radian' })).toBe('radian');
      const document = documentWith({ mathGeometry: [definition('angle', '測定角', quantity)] });
      expect(replaceMathGeometryQuantity(document, 'angle', { ...quantity })).toMatchObject({ ok: true });
    });
  });
  it.each([
    { kind: 'radius', curve: curveA }, { kind: 'contour-length', sketchId: 'sketch-1', featureId: 'rectangle' },
    { kind: 'coordinate', point, component: 'X' }, { kind: 'volume', body: bodyA },
    { kind: 'parallel', first: curveA, second: curveB },
  ] as const satisfies readonly MathGeometryQuantity[])('角度でない$kindはnotAngleのまま', quantity => {
    const document = documentWith({ mathGeometry: [definition('non-angle', '測定', quantity)] });
    expect(isMathGeometryAngleQuantity(quantity)).toBe(false);
    expect(mathGeometryAngleUnitOf(quantity)).toBeNull();
    expect(setMathGeometryAngleUnit(document, 'non-angle', 'radian')).toMatchObject({ ok: false, reason: 'notAngle' });
    expect(document.mathGeometry?.[0].quantity).toBe(quantity);
  });
});
