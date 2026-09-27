import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, decodeMathWorkRequest, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { mapMathSymbols } from './mathExpressionReferences.js';
import type { MathSymbolReference } from './mathInputContract.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const declarations = [{ id: 'symbol:a', label: 'a_1', meaning: '値が未指定の長さ', type: 'real' as const },
  { id: 'symbol:b', label: 'b_1', meaning: '別の実数', type: 'real' as const }];
const context = { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(['coefficient:a']),
  declaredIds: new Set(declarations.map(value => value.id)) };
function evaluate(request: MathWorkRequest) {
  const envelope = createMathWorkEnvelope(1, request);
  const raw = executeMathWorkRequest(envelope, backend);
  return { raw, result: decodeMathWorkReply(raw, envelope.request, context).result };
}
function request(source: string, notation: 'text' | 'latex' = 'text'): MathWorkRequest {
  const original: MathWorkRequest = { identity: { documentId: 'doc', documentVersion: 2, editorId: 'rename', inputRevision: 3 },
    source, notation: 'text', angleUnit: 'degree', declarations,
    coefficients: [{ id: 'coefficient:a', label: 'a_1', decimal: '5' }] };
  const result = evaluate({ ...original, ...(notation === 'latex' ? { presentationNotation: 'latex' as const } : {}) }).result;
  const definition = notation === 'text' ? result.definition : result.presentation;
  if (definition == null) throw new Error('Expected the actual parsed definition');
  return { ...original, source: definition.source, notation, definition,
    renameDeclaration: { id: 'symbol:a', label: 'length_2' } };
}

describe('自由記号の改名は名前の一致ではなく参照先を保つ', () => {
  it.each(['text', 'latex'] as const)('%sで係数と総和の局所変数を巻き込まず、原式と説明を保持する', notation => {
    const input = request('sum(a_1,a_1,1,3)+a_1+coef("a_1")', notation), before = JSON.stringify(input);
    const { result } = evaluate(input), renamed = result.renamedDefinition;
    expect(result.evaluation.status).toBe('unresolved');
    expect(renamed?.declarations).toEqual([{ ...declarations[0], label: 'length_2' }, declarations[1]]);
    expect(renamed?.inputNotation).toBe(notation); expect(renamed?.angleUnit).toBe('degree');
    if (renamed == null) throw new Error('Expected renamed expression');
    const references: MathSymbolReference[] = [];
    mapMathSymbols(renamed.expression, reference => { references.push(reference); return { kind: 'symbol', reference }; });
    expect(references).toContainEqual({ role: 'declared', id: 'symbol:a', label: 'length_2' });
    expect(references).toContainEqual({ role: 'coefficient', id: 'coefficient:a', label: 'a_1' });
    expect(references.some(value => value.role === 'bound' && value.label === 'a_1')).toBe(true);
    const reopened = evaluate({ identity: input.identity, coefficients: input.coefficients,
      source: renamed.source, notation: renamed.inputNotation, angleUnit: renamed.angleUnit,
      ...(renamed.declarations === undefined ? {} : { declarations: renamed.declarations }),
      definition: JSON.parse(JSON.stringify(renamed)) as typeof renamed });
    expect(reopened.result.evaluation.status).toBe('unresolved');
    expect(JSON.stringify(input)).toBe(before);
  });
  it('改名先が積分や総和の局所変数に取り込まれる場合は元の式を残して拒否する', () => {
    const input = { ...request('sum(a_1*k,k,1,3)'), renameDeclaration: { id: 'symbol:a', label: 'k' } };
    const { result } = evaluate(input);
    expect(result.renamedDefinition).toBeNull(); expect(result.evaluation.status).toBe('invalid');
    expect(result.definition?.source).toBe(input.source);
    expect(result.definition?.declarations).toEqual(declarations);
  });
  it('式が参照していない定義も改名できるが、改名の返信を数値として採用しない', () => {
    const { result } = evaluate(request('sum(a_1,a_1,1,3)'));
    expect(result.renamedDefinition?.declarations?.[0].label).toBe('length_2');
    expect(result.evaluation.status).toBe('unresolved');
  });
  it.each(['missing', 'duplicate', 'reserved', 'without-definition', 'coefficient', 'presentation'] as const)(
    '%sの改名依頼を処理前に拒否する', mode => {
      const input = request('a_1');
      const invalid = mode === 'missing' ? { ...input, renameDeclaration: { id: 'absent', label: 'length_2' } }
        : mode === 'duplicate' ? { ...input, renameDeclaration: { id: 'symbol:a', label: 'b_1' } }
        : mode === 'reserved' ? { ...input, renameDeclaration: { id: 'symbol:a', label: 'pi' } }
        : mode === 'without-definition' ? { ...input, definition: undefined }
        : mode === 'coefficient' ? { ...input, renameCoefficient: { id: 'coefficient:a', label: '幅' } }
        : { ...input, presentationNotation: 'latex' };
      expect(() => decodeMathWorkRequest(invalid)).toThrow();
    });
  it.each(['label', 'meaning', 'type', 'identity', 'coordinate'] as const)('返信の%sのすり替えを拒否する', mode => {
    const input = request('a_1'), { raw } = evaluate(input), renamed = raw.renamedDefinition;
    if (renamed?.declarations === undefined) throw new Error('Expected renamed declarations');
    const changed = mode === 'coordinate' ? { ...raw, evaluation: { status: 'value', kind: 'real', exact: null,
      decimal: '1', coordinate: 1, approximation: null } } : { ...raw, renamedDefinition: { ...renamed,
      declarations: renamed.declarations.map((value, index) => index !== 0 ? value : { ...value,
        ...(mode === 'label' ? { label: 'a_1' } : mode === 'meaning' ? { meaning: '別の意味' }
          : mode === 'type' ? { type: 'set' } : { id: 'symbol:b' }) }) } };
    expect(() => decodeMathWorkReply(changed, input, context)).toThrow();
  });
  it('依頼を受け取った後の呼出元の名前変更を受け付けない', () => {
    const input = request('a_1'), rename = { id: 'symbol:a', label: 'length_2' };
    const decoded = decodeMathWorkRequest({ ...input, renameDeclaration: rename });
    rename.label = 'later';
    expect(decoded.renameDeclaration?.label).toBe('length_2'); expect(Object.isFrozen(decoded.renameDeclaration)).toBe(true);
  });
});
