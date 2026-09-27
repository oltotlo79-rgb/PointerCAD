import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { decodeExactMathResult } from './exactMathResult.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { exactRuntimeBatch, sharedExactEngine, spawnExactRuntime } from './exactRuntimeTestSupport.js';
import type { MathNode } from './mathInputContract.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import type { MathExecutionReply } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';

const script = fileURLToPath(new URL('./exactRuntime/cas_set_relations_test.py', import.meta.url));
const number = (value: number): MathNode => ({ kind: 'number', decimal: String(value) });
const operation = (name: string, ...operands: readonly MathNode[]): MathNode => ({ kind: 'operation', operation: name, operands });
const real: MathNode = { kind: 'constant', name: 'real-numbers' };
const context = { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set<string>(), declaredIds: new Set<string>() };
const transport = (expression: MathNode, kind = 'set') => ({
  status: 'value', kind, expression, domainConditions: [], coordinateAuthorized: false,
});

describe('集合の関係と直積の実計算・受渡し', () => {
  it('計算部が未導入でも登録表を読み取れ、SymPyを先に読み込まない', () => {
    const source = [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(fileURLToPath(new URL('./exactRuntime/', import.meta.url)))})`,
      'import cas_set_relations',
      "assert 'sympy' not in sys.modules",
      'assert len(cas_set_relations.IMPLEMENTATIONS) == 7',
    ].join('\n');
    const result = spawnExactRuntime(['-I', '-S', '-B', '-X', 'utf8', '-c', source], {
      encoding: 'utf8', timeout: 10_000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it('固定の計算部で包含・未確定・補集合・直積の独立検査42件を実行する', () => {
    const result = spawnExactRuntime(['-B', '-X', 'utf8', script], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: 2_000_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/Ran 42 tests/u);
  }, 65_000);

  it.each([
    operation('set', operation('list', number(1), number(2))),
    operation('set', operation('list', operation('list', number(1), number(2)), number(3))),
    operation('cartesian-product', real, operation('interval', number(0), number(1))),
    operation('set', operation('list', ...Array.from({ length: 16 }, (_, index) => number(index)))),
  ])('順序付きの組と無限の直積を座標へ読み替えず受け取る: %j', expression => {
    expect(decodeExactMathResult(transport(expression), expression, context)).toEqual({
      status: 'value', reportedKind: 'set', expression, domainConditions: [], coordinateAuthorized: false,
    });
    expect(() => decodeExactMathResult(transport(expression, 'vector'), expression, context)).toThrow();
  });

  it.each([
    operation('cartesian-product', real, number(2)),
    operation('cartesian-product', real),
    operation('cartesian-product', ...Array.from({ length: 17 }, () => real)),
    operation('set', operation('list')),
    operation('set', operation('list', number(1))),
    operation('set', operation('list', ...Array.from({ length: 17 }, () => number(1)))),
    operation('set', operation('list', real, number(2))),
    operation('set', operation('list', { kind: 'constant', name: 'true' }, number(2))),
  ])('組や因子の型・大きさが不正な直積返信を拒否する: %j', expression => {
    expect(() => decodeExactMathResult(transport(expression), number(1), context)).toThrow();
  });
});

const boolean = (value: boolean): MathNode => ({ kind: 'constant', name: value ? 'true' : 'false' });
const examples = [
  { source: 'notelement(3,set(1,2))', kind: 'boolean', expected: boolean(true) },
  { source: 'notelement(2,set(1,2))', kind: 'boolean', expected: boolean(false) },
  { source: 'notelement(0,interval(open(0),1))', kind: 'boolean', expected: boolean(true) },
  { source: 'notelement(i,ℝ)', kind: 'boolean', expected: boolean(true) },
  { source: 'subset(set(1),set(1,2))', kind: 'boolean', expected: boolean(true) },
  { source: 'subset(set(1,2),set(2,1,1))', kind: 'boolean', expected: boolean(false) },
  { source: 'subsetequal(set(1,2),set(2,1,1))', kind: 'boolean', expected: boolean(true) },
  { source: 'subsetequal(set(1,3),set(1,2))', kind: 'boolean', expected: boolean(false) },
  { source: 'superset(set(1,2),set(1))', kind: 'boolean', expected: boolean(true) },
  { source: 'superset(set(1),set(1))', kind: 'boolean', expected: boolean(false) },
  { source: 'supersetequal(set(1),set(1))', kind: 'boolean', expected: boolean(true) },
  { source: 'subset(ℕ,ℤ)', kind: 'boolean', expected: boolean(true) },
  { source: 'subsetequal(ℂ,ℝ)', kind: 'boolean', expected: boolean(false) },
  { source: 'subset(interval(open(0),open(1)),interval(0,1))', kind: 'boolean', expected: boolean(true) },
  { source: 'subsetequal(interval(0,1),interval(open(0),1))', kind: 'boolean', expected: boolean(false) },
  { source: 'subset(∅,ℝ)', kind: 'boolean', expected: boolean(true) },
  { source: 'subset(∅,∅)', kind: 'boolean', expected: boolean(false) },
  { source: 'complement(set(2),set(1,2,3))', kind: 'set', expected: operation('set', number(1), number(3)) },
  { source: 'complement(interval(open(0),open(1)),interval(0,1))', kind: 'set', expected: operation('set', number(0), number(1)) },
  { source: 'complement(ℝ,ℝ)', kind: 'set', expected: { kind: 'constant', name: 'empty-set' } },
  { source: 'complement(ℤ,ℝ)', kind: 'set', expected: operation('set-minus', real, { kind: 'constant', name: 'integers' }) },
  { source: 'cartesianproduct(set(1,2),set(3,4))', kind: 'set', expected: operation('set',
    operation('list', number(1), number(3)), operation('list', number(1), number(4)),
    operation('list', number(2), number(3)), operation('list', number(2), number(4))) },
  { source: 'cartesianproduct(set(3),set(1),set(2))', kind: 'set', expected: operation('set', operation('list', number(3), number(1), number(2))) },
  { source: 'cartesianproduct(ℝ,ℤ)', kind: 'set', expected: operation('cartesian-product', real, { kind: 'constant', name: 'integers' }) },
  { source: 'cartesianproduct(ℝ,∅)', kind: 'set', expected: { kind: 'constant', name: 'empty-set' } },
  { source: 'cartesianproduct(cartesianproduct(set(1),set(2)),set(3))', kind: 'set',
    expected: operation('set', operation('list', operation('list', number(1), number(2)), number(3))) },
  { source: 'notelement([1,2],cartesianproduct(set(1),set(2)))', kind: 'boolean', expected: boolean(false) },
  { source: 'which(subset(set(1),set(1,2)),7,true,9)', coordinate: 7 },
  { source: 'which(notelement(1,set(1)),7,true,9)', coordinate: 9 },
  { source: 'complement(set(3),set(1,2))', reason: 'domain' },
  { source: 'complement(set(1))', reason: 'syntax' },
  { source: 'subset(1,set(1))', reason: 'domain' },
  { source: 'notelement(1,2)', reason: 'domain' },
  { source: 'cartesianproduct(set(1),2)', reason: 'domain' },
  { source: 'cartesianproduct(∅,set(1/0))', reason: 'domain' },
  { source: '0*complement(set(3),set(1,2))', reason: 'domain' },
] as const;

function request(source: string): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'radian', coefficients: [],
    identity: { documentId: 'set-relations', documentVersion: 1, editorId: 'X', inputRevision: 1 } };
}
const backend = createMathBackend();
const engine = sharedExactEngine(exactRuntimeBatch(script, 60_000));
const options = { backend, engine, shouldStop: () => undefined };
let replies: readonly MathExecutionReply[];
let restored: readonly MathExecutionReply[];
const unknown: MathNode = { kind: 'symbol', reference: { role: 'declared', id: 'unknown', label: 'x' } };
const uncertain = [
  operation('subset-equal', operation('set-minus', real, operation('set', unknown)), operation('set-minus', real, operation('set', number(0)))),
  operation('subset', operation('set', number(0)), operation('set', number(0), unknown)),
  operation('not-element', unknown, { kind: 'constant', name: 'integers' }),
];
let uncertainReplies: readonly unknown[];

beforeAll(async () => {
  [replies, uncertainReplies] = await Promise.all([
    Promise.all(examples.map(({ source }) => executeExactMathWorkRequest(createMathWorkEnvelope(1, request(source)), options))),
    engine.evaluateMany(uncertain.map(expression => ({ expression, angleUnit: 'radian' }))),
  ]);
  restored = await Promise.all(replies.map((reply, index) => {
    const input = request(examples[index].source);
    const result = decodeMathWorkReply(reply, input, context).result;
    if (result.definition === null) return Promise.resolve(reply);
    const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(2, { ...input, definition: result.definition })));
    return executeExactMathWorkRequest(saved, options);
  }));
}, 120_000);

describe('公開入力から集合の関係と演算を計算し、原式を保存して再計算する', () => {
  it.each(uncertain)('判定不能の実計算結果を真偽へ変えず未確定として受け取る: %j', source => {
    expect(decodeExactMathResult(uncertainReplies[uncertain.indexOf(source)], source, context)).toEqual({
      status: 'unresolved', reason: 'unevaluated', coordinateAuthorized: false,
    });
  });
  it.each(examples)('$source', example => {
    const index = examples.indexOf(example), input = request(example.source);
    const result = decodeMathWorkReply(replies[index], input, context).result;
    if ('reason' in example) {
      expect(result.evaluation).toMatchObject({ status: 'invalid', reason: example.reason });
      expect(result.evaluation).not.toHaveProperty('coordinate');
      return;
    }
    if ('coordinate' in example) {
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: example.coordinate });
    } else {
      expect(result.evaluation).toEqual({ status: 'value', kind: example.kind, expression: example.expected });
      expect(result.evaluation).not.toHaveProperty('coordinate');
    }
    expect(result.definition?.source).toBe(example.source);
    expect(decodeMathWorkReply(restored[index], input, context).result.evaluation).toEqual(result.evaluation);
  });
});
