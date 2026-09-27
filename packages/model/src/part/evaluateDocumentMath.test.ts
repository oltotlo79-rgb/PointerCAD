import { beforeAll, describe, expect, it } from 'vitest';
import { evaluateExpression, mathScalarExpression, type ExpressionValue, type StoredMathExpression } from '@pointercad/expression';
import {
  createMathBackend,
  executeMathWorkRequest,
  type MathExecutionBackend,
} from '@pointercad/expression/math/worker';

import {
  CANDIDATE_MATH_BY_ID,
  decodeMathWorkReply,
} from '@pointercad/expression/math/contracts';

import type { MathWorkRequest } from '@pointercad/expression/math/client';
import { createEmptyPartDocument } from './createPartDocument.js';
import { mapDocumentExpressions } from './reevaluatePart.js';
import { evaluateDocumentMath, evaluatedDocumentMathValue, hasDocumentMath, type DocumentMathContext } from './evaluateDocumentMath.js';
import { absoluteCoordinate, createPointFeature } from '../sketch/createSketchDocument.js';
import type { Parameter } from '../parameters/types.js';
import type { PartDocument } from './types.js';
import { activateMathConfiguration, createMathConfiguration, deleteMathConfiguration } from './mathConfigurations.js';
import { synchronizeConfigurations } from './configurations.js';
import { renameDocumentMathParameter } from './renameDocumentMathParameter.js';
import { collectMathCoefficients } from '@pointercad/expression';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function calculate(request: MathWorkRequest) {
  const raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
  return decodeMathWorkReply(raw, request, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(request.coefficients.map(coefficient => coefficient.id)), declaredIds: new Set() }).result;
}
function legacy(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
const identity = { documentId: 'part-1', documentVersion: 1, editorId: 'test', inputRevision: 1 };
function math(source: string, coefficients: MathWorkRequest['coefficients'] = []): ExpressionValue {
  const result = mathScalarExpression(calculate({ identity, source, notation: 'text', angleUnit: 'degree', coefficients }));
  if (!result.ok) throw new Error(result.message);
  return result.value;
}
function row(name: string, value: ExpressionValue, mathId = name): Parameter {
  return { name, value, mathId, unit: 'mm', description: '' };
}
function part(parameters: readonly Parameter[], x?: ExpressionValue): PartDocument {
  const document = createEmptyPartDocument(), sketch = document.sketches[0];
  if (x === undefined) return { ...document, parameters };
  const at = { ...absoluteCoordinate(0, 0, 0), x };
  return { ...document, parameters, sketches: [{ ...sketch, features: [createPointFeature(sketch, at)] }] };
}
function context(document: PartDocument, changes: Partial<DocumentMathContext> = {}): DocumentMathContext {
  return { identity: { documentId: document.id, documentVersion: 1 }, isCurrent: () => true,
    client: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity, result: calculate(request) }) }, ...changes };
}
function xValue(document: PartDocument): ExpressionValue {
  const point = document.sketches[0].features[0];
  if (point.kind !== 'point' || point.at.mode !== 'absolute') throw new Error('Expected an absolute point');
  return point.at.x;
}
function withDefinition(value: ExpressionValue, definition: StoredMathExpression): ExpressionValue {
  return { ...value, mathDefinition: definition };
}

describe('原式・係数・作図座標の非同期再計算を一括で成立させる', () => {
  it('分数の係数を旧形式と数学入力で引き継ぎ、差の増幅と関数へ渡す原式も保つ', async () => {
    const coordinate = math('(coef("R")*3-1)*10^40', [{ id: 'R', label: 'R', decimal: '0.3333333333333333' }]);
    const document = part([row('R', legacy('1/3')), row('B', { source: '(R*3-1)*10^40', value: -1, display: '-1' })], coordinate);
    const before = JSON.stringify(document);
    const result = await evaluateDocumentMath(document, context(document));
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    expect(xValue(result.document).value).toBe(0);
    expect(result.document.parameters[1].value.value).toBe(0);
    expect(result.analysis.mathCoefficients?.get('R')?.exactExpression).toEqual({ kind: 'operation', operation: 'divide',
      operands: [{ kind: 'number', decimal: '1' }, { kind: 'number', decimal: '3' }] });
    expect(result.document.parameters[0].value.source).toBe('1/3');
    expect(JSON.stringify(document)).toBe(before);
  });

  it('プロパティの値は検証した文書だけに紐付き、係数変更・再読込・失敗した再評価で旧値を表示しない', async () => {
    const coordinate = math('coef("A")*2', [{ id: 'A', label: 'A', decimal: '3' }]);
    const document = part([row('A', legacy('4'))], coordinate);
    expect(evaluatedDocumentMathValue(document, coordinate)).toBeNull();
    const result = await evaluateDocumentMath(document, context(document));
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    expect(coordinate.value).toBe(6);
    expect(evaluatedDocumentMathValue(document, coordinate)?.value).toBe(8);
    expect(evaluatedDocumentMathValue(result.document, xValue(result.document))?.value).toBe(8);
    const changed = { ...document, parameters: [row('A', legacy('5'))] };
    expect(evaluatedDocumentMathValue(changed, coordinate)).toBeNull();
    expect(evaluatedDocumentMathValue(structuredClone(document), coordinate)).toBeNull();
    await evaluateDocumentMath(document, context(document, { client: { evaluate: () => { throw new Error('Stopped worker'); } } }));
    expect(evaluatedDocumentMathValue(document, coordinate)).toBeNull();
  });
  it('旧係数→数学係数→旧係数→数学座標を表の逆順でも評価し、原文書と原式を維持する', async () => {
    const middle = math('coef("A") / 3', [{ id: 'A', label: 'A', decimal: '9' }]);
    const coordinate = math('coef("C") + sin(30)', [{ id: 'C', label: 'C', decimal: '6' }]);
    const document = part([row('C', { ...legacy('6'), source: 'B*2' }), row('B', middle), row('A', legacy('30'))], coordinate);
    const before = JSON.stringify(document);
    const result = await evaluateDocumentMath(document, context(document));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    expect(result.document.parameters.map(parameter => parameter.value.value)).toEqual([20, 10, 30]);
    expect(xValue(result.document).value).toBe(20.5);
    expect(xValue(result.document).mathDefinition).toEqual(coordinate.mathDefinition);
    expect(result.analysis.unused).toEqual([]);
    expect(JSON.stringify(document)).toBe(before);
  });
  it('係数表が空でも定数の積分を再計算し、偽のキャッシュを使用しない', async () => {
    const value = math('integrate(t^2,t,0,3)');
    const document = part([], { ...value, value: 999 });
    expect(hasDocumentMath(document)).toBe(true);
    const result = await evaluateDocumentMath(document, context(document));
    expect(result.ok).toBe(true);
    if (result.ok) expect(xValue(result.document).value).toBe(9);
  });
  it('数学係数の精密十進値を旧式の次段へ渡し、途中でdoubleへ丸めない', async () => {
    const value = math('1/3');
    const document = part([row('A', value), row('B', { ...legacy('0'), source: 'A*3-1' })]);
    const result = await evaluateDocumentMath(document, context(document));
    expect(result.ok).toBe(true);
    if (result.ok) expect(Math.abs(result.document.parameters[1].value.value)).toBeLessThan(1e-35);
  });
  it('係数の計算失敗を下流へ伝え、旧キャッシュを持つ文書を返さない', async () => {
    const value = math('coef("A")+1', [{ id: 'A', label: 'A', decimal: '8' }]);
    const document = part([row('A', { ...legacy('8'), source: '1/0' }), row('B', value)], value);
    const result = await evaluateDocumentMath(document, context(document));
    expect(result).toMatchObject({ ok: false, cancelled: false });
    expect(result).not.toHaveProperty('document');
    if (!result.ok) expect(result.failures.map(failure => failure.ownerId)).toContain('B');
  });
  it('循環する数学係数とそれを使う座標を決定済みにしない', async () => {
    const a = math('coef("B")+1', [{ id: 'B', label: 'B', decimal: '1' }]);
    const b = math('coef("A")+1', [{ id: 'A', label: 'A', decimal: '1' }]);
    const document = part([row('A', a), row('B', b)], a);
    const result = await evaluateDocumentMath(document, context(document));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures.filter(failure => failure.message.includes('循環'))).toHaveLength(2);
  });
  it('削除済みIDを同名の新しい係数へ勝手に結び直さない', async () => {
    const value = math('coef("A")+1', [{ id: 'removed', label: 'A', decimal: '3' }]);
    const document = part([row('A', legacy('99'), 'replacement')], value);
    const result = await evaluateDocumentMath(document, context(document));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('document');
  });
  it('原式と一致しないASTを実エンジンへ通して拒否する', async () => {
    const value = math('1+2');
    if (!value.mathDefinition) throw new Error('Expected definition');
    const document = part([], withDefinition(value, { ...value.mathDefinition, expression: { kind: 'number', decimal: '999' } }));
    expect((await evaluateDocumentMath(document, context(document))).ok).toBe(false);
  });
  it('外側だけ変更した原式も拒否する', async () => {
    const document = part([], { ...math('1+2'), source: '8' });
    expect((await evaluateDocumentMath(document, context(document))).ok).toBe(false);
  });
  it('構造化複製後も同じ係数IDで現在値を反映する', async () => {
    const original = part([row('A', legacy('20'))], math('coef("A")*2', [{ id: 'A', label: 'A', decimal: '3' }]));
    const document: PartDocument = structuredClone(original);
    const result = await evaluateDocumentMath(document, context(document));
    expect(result.ok).toBe(true);
    if (result.ok) expect(xValue(result.document).value).toBe(40);
  });
  it.each(['cancel', 'generation', 'document'] as const)('%sが変化した返信を採用しない', async mode => {
    const document = part([], math('1+2'));
    const controller = new AbortController();
    let current = true;
    const options = context(document, { signal: controller.signal, isCurrent: () => current });
    const result = await evaluateDocumentMath(document, { ...options,
      identity: { ...options.identity, documentId: mode === 'document' ? 'another-part' : document.id },
      client: { evaluate: request => {
        if (mode === 'cancel') controller.abort(); else current = false;
        return Promise.resolve({ status: 'result', identity: request.identity, result: calculate(request) });
      } } });
    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(result).not.toHaveProperty('document');
  });
  it('数学定義のない文書を検出し、既存巡回で追加の定義がある全座標を数える', () => {
    expect(hasDocumentMath(part([]))).toBe(false);
    const value = math('1+2'), document = part([], value);
    const found: ExpressionValue[] = [];
    mapDocumentExpressions(document, expression => { if (expression.mathDefinition) found.push(expression); return expression; });
    expect(found).toEqual([value]);
  });
});

/**
 * GR-19d (w15a's e2e finding, `scratchpad/claude/instructions/w19a-gr19d-list-headings.md`): a legacy
 * (name-referencing, no `mathDefinition`) formula naming an already-failed coefficient must relay that
 * coefficient's own reason, not claim the name is undefined. Before this fix, referencing a coefficient
 * that failed for any reason (not just GR-02's geometry cycle; see the sibling test in
 * `evaluateDocumentMathGeometry.test.ts` for that one) always produced `決まっていない名前です`
 * (`packages/expression/src/errors.ts`, code `unknownVariable`), because the legacy evaluator's
 * `variables`/`exactVariables` maps never receive an entry for a coefficient that failed to evaluate.
 */
describe('GR-19d: 旧式の式が失敗済みの係数を名前で使うとき、決まっていない名前ではなく元の理由を示す', () => {
  it('循環する係数(数学定義)を旧式の名前参照で使うと、循環の理由を含む', async () => {
    const a = math('coef("B")+1', [{ id: 'B', label: 'B', decimal: '1' }]);
    const b = math('coef("A")+1', [{ id: 'A', label: 'A', decimal: '1' }]);
    const document = part([row('A', a), row('B', b), row('C', { ...legacy('0'), source: 'A*2' })]);
    const result = await evaluateDocumentMath(document, context(document));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const c = result.failures.find(failure => failure.ownerId === 'C');
    expect(c?.message).not.toContain('決まっていない名前');
    expect(c?.message).toContain('循環');
  });

  it('本当に存在しない名前を旧式で参照したときは、決まっていない名前のまま示す(回帰確認)', async () => {
    const document = part([row('C', { ...legacy('0'), source: 'Z+1' })]);
    const result = await evaluateDocumentMath(document, context(document));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const c = result.failures.find(failure => failure.ownerId === 'C');
    expect(c?.message).toContain('決まっていない名前');
    expect(c?.message).toContain('Z');
  });
});

describe('構成切替でも数学定義と参照IDを保持する', () => {
  function configured(): PartDocument {
    return synchronizeConfigurations(part([row('A', legacy('3')), row('B', math('coef("A")*2', [{ id: 'A', label: 'A', decimal: '3' }]))]));
  }
  it('構成の作成・切替を実エンジンで評価し、元の式とIDを保つ', async () => {
    const first = configured();
    const created = await createMathConfiguration(first, '大', context(first), { A: '10' });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.reason);
    expect(created.document.parameters).toBe(first.parameters);
    const target = created.document.configurations[1];
    expect(target.mathDefinitions?.B).toEqual(first.parameters[1].value.mathDefinition);
    const switched = await activateMathConfiguration(created.document, target.id, context(created.document));
    expect(switched.ok).toBe(true);
    if (!switched.ok) throw new Error(switched.reason);
    expect(switched.document.parameters.map(parameter => parameter.value.value)).toEqual([10, 20]);
    expect(switched.document.parameters[1].value.mathDefinition).toEqual(first.parameters[1].value.mathDefinition);
    const back = await activateMathConfiguration(switched.document, first.configurations[0].id, context(switched.document));
    expect(back.ok).toBe(true);
    if (back.ok) expect(back.document.parameters.map(parameter => parameter.value.value)).toEqual([3, 6]);
  });
  it('短式へ変更した構成だけ数学定義を外し、元の構成の定義を変更しない', async () => {
    const first = configured();
    const created = await createMathConfiguration(first, '短式', context(first), { B: '8' });
    if (!created.ok) throw new Error(created.reason);
    expect(created.document.configurations[1]).not.toHaveProperty('mathDefinitions');
    const result = await activateMathConfiguration(created.document, created.document.configurations[1].id, context(created.document));
    if (!result.ok) throw new Error(result.reason);
    expect(result.document.parameters[1].value).toEqual(legacy('8'));
    expect(result.document.configurations[0].mathDefinitions?.B).toBe(first.parameters[1].value.mathDefinition);
  });
  it('同期は未選択構成の定義を保ち、同じ内容の同期は元の文書を返す', () => {
    const first = configured();
    expect(synchronizeConfigurations(first)).toBe(first);
    const next = synchronizeConfigurations({ ...first, parameters: [first.parameters[0], { ...first.parameters[1], value: legacy('8') }] });
    expect(next.configurations[0]).not.toHaveProperty('mathDefinitions');
    expect(first.configurations[0].mathDefinitions?.B).toBeDefined();
  });
  it('切替で数式が定義域外になる構成の作成を断る', async () => {
    const first = configured();
    expect((await createMathConfiguration(first, '不正', context(first), { A: '1/0' })).ok).toBe(false);
    expect(first.configurations).toHaveLength(1);
  });
  it('選択中の構成を削除すると次の構成も数学計算を通してから適用する', async () => {
    const first = configured(), created = await createMathConfiguration(first, '次', context(first), { A: '12' });
    if (!created.ok) throw new Error(created.reason);
    const result = await deleteMathConfiguration(created.document, first.activeConfigurationId ?? '', context(created.document));
    if (!result.ok) throw new Error(result.reason);
    expect(result.document.parameters[1].value.value).toBe(24);
    expect(result.document.configurations).toHaveLength(1);
  });
});

describe('数学係数の改名はIDと束縛変数と全構成を保つ', () => {
  it.each(['text', 'latex'] as const)('%sの入力方式を保ち、係数iと積分変数iを混同しない', async notation => {
    const request: MathWorkRequest = { identity, source: 'integrate(i,i,0,coef("i"))', notation: 'text', angleUnit: 'radian',
      coefficients: [{ id: 'coefficient:1', label: 'i', decimal: '4' }], presentationNotation: notation };
    const conversion = calculate(request), definition = conversion.presentation;
    if (definition == null) throw new Error('Expected presentation');
    const value: ExpressionValue = { source: definition.source, value: 8, display: '8', mathDefinition: definition };
    const original = synchronizeConfigurations(part([row('i', legacy('4'), 'coefficient:1'), row('B', value, 'coefficient:2')], value));
    const created = await createMathConfiguration(original, '別の構成', context(original), { i: '6' });
    if (!created.ok) throw new Error(created.reason);
    const before = JSON.stringify(created.document);
    const result = await renameDocumentMathParameter(created.document, 'i', '積分上限', context(created.document));
    if (!result.ok) throw new Error(result.message);
    expect(result.document.parameters.map(parameter => parameter.name)).toEqual(['積分上限', 'B']);
    expect(result.document.parameters[0].mathId).toBe('coefficient:1');
    expect(xValue(result.document).value).toBe(8);
    expect(xValue(result.document).mathDefinition?.inputNotation).toBe(notation);
    expect(collectMathCoefficients(xValue(result.document).mathDefinition!.expression)).toEqual([
      { role: 'coefficient', id: 'coefficient:1', label: '積分上限' },
    ]);
    const switched = await activateMathConfiguration(result.document, result.document.configurations[1].id, context(result.document));
    if (!switched.ok) throw new Error(switched.reason);
    expect(xValue(switched.document).value).toBe(18);
    expect(switched.document.configurations[1].values).toHaveProperty('積分上限', '6');
    expect(switched.document.configurations[1].values).not.toHaveProperty('i');
    expect(JSON.stringify(created.document)).toBe(before);
  });
  it('改名中に文書が変更されたら部分的な書換を返さない', async () => {
    const value = math('coef("A")+1', [{ id: 'A', label: 'A', decimal: '3' }]);
    const original = synchronizeConfigurations(part([row('A', legacy('3'))], value));
    let current = true;
    const result = await renameDocumentMathParameter(original, 'A', '幅', context(original, {
      isCurrent: () => current, client: { evaluate: request => {
        const result = calculate(request); current = false;
        return Promise.resolve({ status: 'result', identity: request.identity, result });
      } },
    }));
    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(result).not.toHaveProperty('document');
    expect(original.parameters[0].name).toBe('A');
  });
  it('二重名と未知の名前をWorker起動前に拒否する', async () => {
    const original = part([row('A', legacy('3')), row('B', legacy('5'))]);
    const ctx = context(original, { client: { evaluate: () => { throw new Error('Must not evaluate'); } } });
    expect((await renameDocumentMathParameter(original, 'A', 'B', ctx)).ok).toBe(false);
    expect((await renameDocumentMathParameter(original, 'missing', '幅', ctx)).ok).toBe(false);
  });
});
