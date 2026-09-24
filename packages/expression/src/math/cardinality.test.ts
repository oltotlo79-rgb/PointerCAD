import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { INFINITE_CARDINALITY_MESSAGE } from './absoluteValueCandidates.js';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { exactRuntimeBatch, sharedExactEngine, spawnExactRuntime } from './exactRuntimeTestSupport.js';
import { EXTENDED_OPERATION_DEFINITIONS } from './mathExtendedOperations.js';
import { coordinateFromMath } from './mathInputContract.js';
import type { MathDeclaration } from './mathDeclarations.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import type { MathExecutionReply } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';

const runtime = new URL('./exactRuntime/', import.meta.url);
const script = fileURLToPath(new URL('cas_cardinality_test.py', runtime));

describe('要素数の計算部と検査の起動口', () => {
  it('計算部が未導入でも登録表を読み取れ、SymPyを先に読み込まない', () => {
    const source = [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(fileURLToPath(runtime))})`,
      'import cas_cardinality',
      "assert 'sympy' not in sys.modules",
      "assert cas_cardinality.IMPLEMENTATIONS == {'cardinality': cas_cardinality.cardinality}",
    ].join('\n');
    const result = spawnExactRuntime(['-I', '-S', '-B', '-X', 'utf8', '-c', source], { encoding: 'utf8', timeout: 10_000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it('固定の計算部で要素数の独立検査26件を実行する', () => {
    const result = spawnExactRuntime(['-B', '-X', 'utf8', script], {
      encoding: 'utf8', timeout: 60_000, maxBuffer: 2_000_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/Ran 26 tests/u);
  }, 65_000);

  it('要素数は計算を接続した実装済みの演算として登録されている', () => {
    expect(EXTENDED_OPERATION_DEFINITIONS.find(value => value.id === 'cardinality'))
      .toMatchObject({ head: 'Cardinality', minimumArguments: 1, maximumArguments: 1, task: 'MC-12', status: 'implemented' });
  });
});

const set = (valueSource: string): MathDeclaration => ({ id: 'symbol:s', label: 's', meaning: '点の集合', type: 'set', valueSource });
type Example = { readonly source: string; readonly declaration?: MathDeclaration }
  & ({ readonly value: number } | { readonly detail: string } | { readonly reason: string } | { readonly unresolved: true });
const examples: readonly Example[] = [
  { source: 'cardinality({1,2,3})', value: 3 },
  { source: '|{1,2,3}|', value: 3 },
  { source: 'abs({1,1,2})', value: 2 },
  { source: '|{1/2,0.5,2/4}|', value: 1 },
  { source: '|{(1+sqrt(2))^2,3+2*sqrt(2)}|', value: 1 },
  { source: '|∅|', value: 0 },
  { source: 'cardinality(set())', value: 0 },
  { source: '|union({1,2},{2,3})|', value: 3 },
  { source: '|intersection(ℤ,interval(0,3))|', value: 4 },
  { source: '|cartesianproduct({1,2},{3,4})|', value: 4 },
  { source: '2*|{1,2}|+1', value: 5 },
  { source: 'sum(|{k,k+1}|,k,1,3)', value: 6 },
  { source: '|s|', declaration: set('{1,2,3}'), value: 3 },
  { source: 'cardinality(interval(0,1))', detail: INFINITE_CARDINALITY_MESSAGE },
  { source: '|ℕ|', detail: INFINITE_CARDINALITY_MESSAGE },
  { source: '|interval(open(0),1)|', detail: INFINITE_CARDINALITY_MESSAGE },
  { source: '|union({5},interval(0,1))|', detail: INFINITE_CARDINALITY_MESSAGE },
  { source: '0*cardinality(ℝ)', detail: INFINITE_CARDINALITY_MESSAGE },
  { source: 'cardinality([1,2])', reason: 'domain' },
  { source: 'cardinality(3)', reason: 'domain' },
  { source: 'sum(|{1,k}|,k,1,3)', unresolved: true },
  { source: '|setminus(ℝ,ℤ)|', unresolved: true },
];

function request(example: Example): MathWorkRequest {
  return { identity: { documentId: 'cardinality', documentVersion: 1, editorId: 'value', inputRevision: 1 },
    source: example.source, notation: 'text', angleUnit: 'radian', coefficients: [],
    ...(example.declaration === undefined ? {} : { declarations: [example.declaration] }) };
}
const context = (input: MathWorkRequest) => ({ operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set<string>(),
  declaredIds: new Set(input.declarations?.map(value => value.id)) });
const backend = createMathBackend();
const engine = sharedExactEngine(exactRuntimeBatch(script, 60_000));
const options = { backend, engine, shouldStop: () => undefined };
let replies: readonly MathExecutionReply[];
let restored: readonly MathExecutionReply[];

beforeAll(async () => {
  replies = await Promise.all(examples.map(example => executeExactMathWorkRequest(createMathWorkEnvelope(1, request(example)), options)));
  // Reopen each saved formula and calculate it again from the stored definition.
  restored = await Promise.all(replies.map((reply, index) => {
    const input = request(examples[index]);
    const { definition } = decodeMathWorkReply(reply, input, context(input)).result;
    if (definition === null) return Promise.resolve(reply);
    const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(2, { ...input, definition })));
    return executeExactMathWorkRequest(saved, options);
  }));
}, 180_000);

describe('集合の要素数を厳密に数え、無限や判定できない集合は値にしない', () => {
  it.each(examples)('$source', example => {
    const index = examples.indexOf(example), input = request(example);
    const result = decodeMathWorkReply(replies[index], input, context(input)).result;
    expect(result.definition?.source).toBe(example.source);
    if ('value' in example) {
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', decimal: String(example.value),
        exact: { kind: 'number', decimal: String(example.value) }, approximation: null });
      expect(coordinateFromMath(result.evaluation)).toBe(example.value);
    } else if ('detail' in example) {
      expect(result.evaluation).toEqual({ status: 'invalid', reason: 'domain', detail: example.detail });
    } else if ('reason' in example) {
      expect(result.evaluation).toMatchObject({ status: 'invalid', reason: example.reason });
    } else {
      expect(result.evaluation).toMatchObject({ status: 'unresolved', reason: 'unevaluated' });
    }
    if (!('value' in example)) expect(() => coordinateFromMath(result.evaluation)).toThrow();
    // The saved formula keeps |x| or cardinality(...) and reopens with the same result.
    expect(decodeMathWorkReply(restored[index], input, context(input)).result).toEqual(result);
  });
});
