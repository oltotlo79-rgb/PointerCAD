import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { exactRuntimeBatch, sharedExactEngine, spawnExactRuntime } from './exactRuntimeTestSupport.js';
import { CANDIDATE_MATH_OPERATIONS } from './mathOperations.js';
import { parseMathText } from './mathTextSyntax.js';
import type { MathExecutionBackend, MathExecutionReply } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';

const script = fileURLToPath(new URL('./exactRuntime/cas_logic_extended_test.py', import.meta.url));
const examples = [
  ['approxequal(0.3,0.2,0.1)', true],
  ['approxequal(0.3000000000000000000000000000000000000001,0.2,0.1)', false],
  ['approxequal(1,1,0)', true],
  ['approxequal(1.0000000000000000000000000000000000000001,1,0)', false],
  ['approxequal(3+4*i,0,5)', true],
  ['approxequal(3+4*i,0,4.99)', false],
  ['approxequal(1e-400,0,9e-401)', false],
  ['forall(x,{1,2,3},x>0)', true],
  ['forall(x,{-1,2,3},x>0)', false],
  ['exists(x,{1,2,3},x^2==4)', true],
  ['exists(x,{0,1,3},x^2==4)', false],
  ['forall(x,∅,false)', true],
  ['exists(x,∅,true)', false],
  ['forall(x,{1,2},exists(y,{1,2},x==y))', true],
  ['forall(x,{1,3},exists(y,{1,2},x==y))', false],
  ['forall(x,{0.9,1,1.1},approxequal(x,1,0.1))', true],
  ['and(forall(x,{1,2},x>0),not(approxequal(1,2,0.1)))', true],
] as const;
const rejected = [
  ['approxequal(1,1)', 'invalid', 'domain'],
  ['approxequal(1,1,-0.1)', 'invalid', 'domain'],
  ['approxequal(1,1,i)', 'invalid', 'domain'],
  ['approxequal(1,1,∞)', 'invalid', 'domain'],
  ['approxequal(∞,∞,0)', 'invalid', 'domain'],
  ['approxequal(0/0,0,1)', 'invalid', 'domain'],
  ['forall(x,ℝ,x==x)', 'unresolved', 'unevaluated'],
  ['exists(x,ℕ,true)', 'unresolved', 'unevaluated'],
  ['exists(x,interval(0,1),x==0)', 'unresolved', 'unevaluated'],
  ['exists(x,{0,1},1/(x-1)==-1)', 'invalid', 'domain'],
] as const;
let results: readonly unknown[];
let publicReplies: readonly MathExecutionReply[];
let backend: MathExecutionBackend;
function request(source: string): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'radian', coefficients: [],
    identity: { documentId: 'logic-extended', documentVersion: 1, editorId: 'value', inputRevision: 1 } };
}
const context = () => ({ operationsById: backend.operationsById, coefficientIds: new Set<string>(), declaredIds: new Set<string>() });
beforeAll(async () => {
  backend = createMathBackend();
  const engine = sharedExactEngine(exactRuntimeBatch(script, 30_000));
  const raw = Promise.all([...examples, ...rejected].map(([source]) => {
    const expression = parseMathText(source, { operations: CANDIDATE_MATH_OPERATIONS,
      names: { axes: new Set(), parameters: new Set(), declared: [], coefficients: [] } });
    return engine.evaluate(expression, 'radian');
  }));
  const replies = Promise.all([...examples, ...rejected].map(([source]) =>
    executeExactMathWorkRequest(createMathWorkEnvelope(1, request(source)), { backend, engine, shouldStop: () => undefined })));
  [results, publicReplies] = await Promise.all([raw, replies]);
}, 90_000);

describe('許容差つきの近似等号と有限集合の量化', () => {
  it('Pythonの独立した境界・束縛・三値・資源検査を実行する', () => {
    const execution = spawnExactRuntime(['-B', '-X', 'utf8', script], {
      encoding: 'utf8', timeout: 90_000, maxBuffer: 2_000_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    });
    expect(execution.error, execution.stderr).toBeUndefined();
    expect(execution.status, execution.stderr).toBe(0);
    expect(execution.stderr).toMatch(/Ran \d+ tests/u);
    console.log(execution.stderr.trim());
  }, 95_000);
  it.each(examples)('%s の真偽を厳密に判定する', (source, expected) => {
    const index = examples.findIndex(([candidate]) => source === candidate);
    expect(results[index]).toEqual({ status: 'value', kind: 'boolean',
      expression: { kind: 'constant', name: expected ? 'true' : 'false' },
      domainConditions: [], coordinateAuthorized: false });
    const result = decodeMathWorkReply(publicReplies[index], request(source), context()).result;
    expect(result.evaluation).toEqual({ status: 'value', kind: 'boolean',
      expression: { kind: 'constant', name: expected ? 'true' : 'false' } });
    expect(result.definition).toMatchObject({ format: 'pointercad-math/1', source });
    expect(result.evaluation).not.toHaveProperty('coordinate');
  });
  it.each(rejected)('%s を理由付きで保持し、真偽を捏造しない', (source, status, reason) => {
    const index = examples.length + rejected.findIndex(([candidate]) => source === candidate);
    expect(results[index]).toEqual({ status, reason, coordinateAuthorized: false });
    const result = decodeMathWorkReply(publicReplies[index], request(source), context()).result;
    expect(result.evaluation.status).toBe(status);
    expect(result.evaluation).not.toHaveProperty('coordinate');
    if (status === 'invalid') expect(result.evaluation).toHaveProperty('detail', expect.stringMatching(/\S/u));
  });
  it('元の許容差と束縛を保存し、開き直して同じ真偽を再計算する', async () => {
    const sources = ['approxequal(0.3,0.2,0.1)', 'forall(x,{1,2},exists(y,{1,2},x==y))'];
    const engine = sharedExactEngine(exactRuntimeBatch(script, 30_000));
    const inputs = sources.map(request);
    const originals = await Promise.all(inputs.map(input => executeExactMathWorkRequest(createMathWorkEnvelope(2, input),
      { backend, engine, shouldStop: () => undefined })));
    const reopened = await Promise.all(originals.map((reply, index) => {
      const definition = decodeMathWorkReply(reply, inputs[index], context()).result.definition;
      if (definition === null) throw new Error(`元の式を保存できません: ${sources[index]}`);
      const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(3, { ...inputs[index], definition })));
      return executeExactMathWorkRequest(saved, { backend, engine, shouldStop: () => undefined });
    }));
    for (const [index, reply] of reopened.entries()) {
      expect(reply.evaluation).toEqual(originals[index].evaluation);
      expect(reply.evaluation).toMatchObject({ status: 'value', kind: 'boolean', expression: { kind: 'constant', name: 'true' } });
      expect(reply.source).toBe(sources[index]);
    }
  }, 90_000);
  it('有限集合の判定を場合分けに渡し、選ばない枝の計算を行わない', async () => {
    const engine = sharedExactEngine(exactRuntimeBatch(script, 30_000));
    const input = request('which(forall(x,{0.9,1,1.1},approxequal(x,1,0.1)),7,true,1/0)');
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(4, input), { backend, engine, shouldStop: () => undefined });
    expect(decodeMathWorkReply(reply, input, context()).result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 7 });
  }, 45_000);
});
