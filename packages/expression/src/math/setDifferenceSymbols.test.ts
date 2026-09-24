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

// MC-23b: SymPy's own Complement of two FiniteSets removes a left element whenever
// it is not structurally found in the right set, even when an unknown element of the
// right set might coincide with it. {1, k} minus {k} silently became {1}, which is
// wrong when k = 1 (the true difference is then empty); a sum over k = 1..3 of
// "is 1 in {1,k} minus {k}" wrongly totalled 3 instead of 2
// (scratchpad/claude/agents/w14b-mc12-cardinality/probe_setminus.py). The fix lives in
// cas_sets.py (set-minus) and cas_set_relations.py (complement, the same construction
// under an explicit universe); see cas_sets_test.py/cas_set_relations_test.py for the
// Python-level cases.
const script = fileURLToPath(new URL('./exactRuntime/cas_sets_test.py', import.meta.url));
const context = { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set<string>(), declaredIds: new Set<string>() };

describe('集合差(setminus)の計算部の起動口', () => {
  it('固定の計算部で集合の境界・集合差の独立検査13件を実行する', () => {
    const result = spawnExactRuntime(['-B', '-X', 'utf8', script], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: 2_000_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/Ran 13 tests/u);
  }, 65_000);
});

const number = (value: number): MathNode => ({ kind: 'number', decimal: String(value) });
const operation = (name: string, ...operands: readonly MathNode[]): MathNode => ({ kind: 'operation', operation: name, operands });
const boolean = (value: boolean): MathNode => ({ kind: 'constant', name: value ? 'true' : 'false' });
const UNKNOWN: MathNode = { kind: 'symbol', reference: { role: 'declared', id: 'unknown', label: 'x' } };

const examples = [
  { source: 'setminus(set(1,2,3),set(2))', kind: 'set', expected: operation('set', number(1), number(3)) },
  { source: 'element(1,setminus(set(1,2,3),set(2)))', kind: 'boolean', expected: boolean(true) },
  { source: 'element(2,setminus(set(1,2,3),set(2)))', kind: 'boolean', expected: boolean(false) },
  { source: 'complement(set(2),set(1,2,3))', kind: 'set', expected: operation('set', number(1), number(3)) },
  // probe_setminus.py (w14b-mc12-cardinality): before the fix this summed to the
  // wrong value 3 ("1 in {1,k} minus {k}" was always true). The whole indexed
  // family is decoded once with a symbolic index (see cas_input.py's binder), so
  // the same unevaluated guard that protects a single set-minus also keeps this
  // sum from asserting a wrong total; it does not resolve to the true value 2
  // (matching cas_cardinality.py's identical `sum(|{1,k}|,k,1,3)` precedent).
  { source: 'sum(which(element(1,setminus(set(1,k),set(k))),1,true,0),k,1,3)', unresolved: true },
] as const;

function request(source: string): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'radian', coefficients: [],
    identity: { documentId: 'set-difference-symbols', documentVersion: 1, editorId: 'X', inputRevision: 1 } };
}
const backend = createMathBackend();
const engine = sharedExactEngine(exactRuntimeBatch(script, 60_000));
const options = { backend, engine, shouldStop: () => undefined };
let replies: readonly MathExecutionReply[];
let restored: readonly MathExecutionReply[];
const uncertain = [
  // The same construction reached directly (no sum around it) ...
  operation('set-minus', operation('set', number(1), UNKNOWN), operation('set', UNKNOWN)),
  operation('element', number(1), operation('set-minus', operation('set', number(1), UNKNOWN), operation('set', UNKNOWN))),
  // ... and through the explicit-universe complement, which shares the fix.
  operation('complement', operation('set', UNKNOWN), operation('set', number(1), UNKNOWN)),
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

describe('未知の記号が絡む集合差・補集合は未確定のまま返し、証明できる場合は保存後も同じ結果にする', () => {
  it.each(uncertain)('判定不能な集合差・補集合を真偽や具体的な集合へ変えず未確定として受け取る: %j', source => {
    expect(decodeExactMathResult(uncertainReplies[uncertain.indexOf(source)], source, context)).toEqual({
      status: 'unresolved', reason: 'unevaluated', coordinateAuthorized: false,
    });
  });
  it.each(examples)('$source', example => {
    const index = examples.indexOf(example), input = request(example.source);
    const result = decodeMathWorkReply(replies[index], input, context).result;
    if ('unresolved' in example) {
      expect(result.evaluation).toMatchObject({ status: 'unresolved', reason: 'unevaluated' });
    } else {
      expect(result.evaluation).toEqual({ status: 'value', kind: example.kind, expression: example.expected });
    }
    expect(result.definition?.source).toBe(example.source);
    expect(decodeMathWorkReply(restored[index], input, context).result.evaluation).toEqual(result.evaluation);
  });
});
