import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, prepareDocumentMathIdentity, synchronizeConfigurations, type PartDocument } from '@pointercad/model';
import { readExpressionItem, type ExpressionValueJson } from './guards.js';
import { serializeExpression } from './codecs/fields.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { PCAD_SCHEMA_VERSION } from './schema.js';

function expression(): ExpressionValueJson {
  return { source: 'coef("A")^2', value: 9, display: '9', mathDefinition: {
    format: 'pointercad-math/1', source: 'coef("A")^2', inputNotation: 'text', angleUnit: 'degree',
    expression: { kind: 'operation', operation: 'power', operands: [
      { kind: 'symbol', reference: { role: 'coefficient', id: 'coefficient:1', label: 'A' } },
      { kind: 'number', decimal: '2' },
    ] },
  } };
}
function document(): PartDocument {
  const base = createEmptyPartDocument();
  return synchronizeConfigurations(prepareDocumentMathIdentity({ ...base, parameters: [
    { name: 'A', mathId: 'coefficient:1', unit: 'mm', description: '', value: { source: '3', value: 3, display: '3' } },
    { name: 'B', mathId: 'coefficient:2', unit: 'mm', description: '', value: expression() },
  ] }));
}

describe('数学定義を失わないJSON保存と入力境界', () => {
  it('原式・AST・角度設定・係数ID・発行済み番号を文書JSONで往復する', () => {
    const source = document(), result = parseDocument(serializeDocument(source));
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.ok).toBe(true);
    expect(result.document.parameters).toEqual(source.parameters);
    expect(result.document.configurations).toEqual(source.configurations);
    expect(result.document.configurations[0].mathDefinitions?.B).toEqual(source.parameters[1].value.mathDefinition);
    expect(result.document.mathParameterSerial).toBe(2);
    expect(result.document.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
  });
  it('数学を使わない旧式には定義や発行番号を足さない', () => {
    const value = { source: 'rad(pi)', value: 180, display: '180' };
    expect(serializeExpression(value)).toEqual(value);
    expect(readExpressionItem(JSON.parse(JSON.stringify(value)), 'x')).toEqual({ ok: true, value });
    const source = createEmptyPartDocument();
    expect(serializeDocument(source)).not.toContain('mathDefinition');
    expect(serializeDocument(source)).not.toContain('mathParameterSerial');
  });
  it('版13の旧短式は原文と数値を変えず現行版へ移行する', () => {
    const source = createEmptyPartDocument();
    const raw: unknown = JSON.parse(serializeDocument({ ...source, schemaVersion: 13 }));
    const result = parseDocument(JSON.stringify(raw));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document).toEqual(source);
  });
  it('定義を複製して保存するため後から呼出元を変更しても保存側は変わらない', () => {
    const source = expression(), encoded = serializeExpression(source);
    expect(encoded.mathDefinition).not.toBe(source.mathDefinition);
    expect(encoded.mathDefinition?.expression).not.toBe(source.mathDefinition?.expression);
  });
  it.each([undefined, null, { format: 'future' }, { ...expression().mathDefinition, angleUnit: 'guess' },
    { ...expression().mathDefinition, source: '999' }, { ...expression().mathDefinition, expression: { kind: 'number', decimal: 'NaN' } },
    { ...expression().mathDefinition, expression: { kind: 'operation', operation: 'execute', operands: [] } }])(
    '破損した定義%jを短式として読み飛ばさない', mathDefinition => {
      expect(readExpressionItem({ ...expression(), mathDefinition }, 'point.x')).toEqual({ ok: false, problem: { path: 'point.x.mathDefinition', reason: 'type' } });
    });
  it.each([NaN, Infinity, -Infinity, null])('数学式の非有限キャッシュ%jを断る', value => {
    expect(readExpressionItem({ ...expression(), value }, 'x').ok).toBe(false);
  });
  it('外側の原式だけが変わった数学式は書き出し時も断る', () => {
    expect(() => serializeExpression({ ...expression(), source: '999' })).toThrow();
  });
  it.each([-1, 1.5, null, '2'])('発行済み番号%jの破損を場所付きで知らせる', mathParameterSerial => {
    const text = serializeDocument(document());
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !('document' in parsed) || !parsed.document || typeof parsed.document !== 'object') throw new Error('Expected document');
    const result = parseDocument(JSON.stringify({ ...parsed, document: { ...parsed.document, mathParameterSerial } }));
    expect(result.ok).toBe(false);
  });
  it.each([-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])('不正な発行番号%jをJSONのnullへ変換して保存しない', mathParameterSerial => {
    expect(() => serializeDocument({ ...document(), mathParameterSerial })).toThrow('係数の参照番号');
  });
  it('保存形式の版はpointercad-math/1に固定され、文書の往復後も変わらない', () => {
    const source = document();
    const result = parseDocument(serializeDocument(source));
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.document.parameters[1].value.mathDefinition?.format).toBe('pointercad-math/1');
    expect(result.document.configurations[0].mathDefinitions?.B?.format).toBe('pointercad-math/1');
  });
  it.each(['pointercad-math/2', 'pointercad-math'])('版番号だけが異なる%jの数学定義を短式として読み飛ばさない', format => {
    const mathDefinition = { ...expression().mathDefinition, format };
    expect(readExpressionItem({ ...expression(), mathDefinition }, 'point.x')).toEqual({ ok: false, problem: { path: 'point.x.mathDefinition', reason: 'type' } });
  });
});
