import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { decodeExactMathResult } from './exactMathResult.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { spawnExactRuntime } from './exactRuntimeTestSupport.js';

const examples = [
  { source: 'mapping(2*x+1,x,ℝ,ℝ)', kind: 'function' },
  { source: 'mapat(mapping(2*x+1,x,ℝ,ℝ),4)', value: 9 },
  { source: 'mapat(inversemap(mapping(2*x+1,x,ℝ,ℝ)),9)', value: 4 },
  { source: 'mapat(composemaps(mapping(x+1,x,ℝ,ℝ),mapping(2*x,x,ℝ,ℝ)),3)', value: 7 },
  { source: 'mapat(composemaps(mapping(2*x,x,ℝ,ℝ),mapping(x+1,x,ℝ,ℝ)),3)', value: 8 },
  { source: 'mapimage(mapping(x^2,x,ℝ,interval(0,∞)),interval(-2,3))', kind: 'interval' },
  { source: 'mappreimage(mapping(x^2,x,ℝ,interval(0,∞)),set(4))', kind: 'set' },
  { source: 'mapat(inversemap(mapping(x^2,x,interval(0,∞),interval(0,∞))),9)', value: 3 },
  { source: 'mapat(mapping(x*i,x,set(1,2),set(i,2*i)),2)', kind: 'complex' },
  { source: 'mapat(inversemap(mapping(x*i,x,set(1,2),set(i,2*i))),i)', value: 1 },
  { source: 'mapat(mapping(sin(x),x,ℝ,interval(-1,1)),π/2)', value: 1 },
  { source: 'mapat(mapping(x/x,x,interval(1,2),set(1)),1)', value: 1 },
  { source: 'mapping(x/x,x,ℝ,ℝ)', reason: 'domain' },
  { source: '0*mapat(mapping(x/x,x,ℝ,ℝ),1)', reason: 'domain' },
  { source: 'mapat(mapping(x,x,interval(open(0),1),ℝ),0)', reason: 'domain' },
  { source: 'mapping(x+1,x,interval(0,1),interval(0,1))', reason: 'domain' },
  { source: 'inversemap(mapping(x^2,x,set(-1,1),set(1)))', reason: 'domain' },
  { source: 'inversemap(mapping(x,x,interval(0,1),ℝ))', reason: 'domain' },
  { source: 'composemaps(mapping(x,x,interval(0,1),ℝ),mapping(x,x,ℝ,ℝ))', reason: 'domain' },
  { source: 'mappreimage(mapping(x^2,x,ℝ,interval(0,∞)),interval(1,4))', kind: 'set' },
  { source: 'mapimage(mapping(x*exp(-x),x,interval(0,∞),ℝ),interval(0,∞))', kind: 'interval' },
  { source: 'mapat(inversemap(mapping(x^3,x,ℝ,ℝ)),8)', value: 2 },
  { source: 'composemaps(mapping(x+1,x,ℝ,ℝ),mapping(2*x,x,ℝ,ℝ))', kind: 'function' },
  { source: 'inversemap(mapping(2*x+1,x,ℝ,ℝ))', kind: 'function' },
  { source: 'mapat(inversemap(composemaps(mapping(x+1,x,ℝ,ℝ),mapping(2*x,x,ℝ,ℝ))),7)', value: 3 },
  { source: 'mapat(inversemap(inversemap(mapping(2*x+1,x,ℝ,ℝ))),4)', value: 9 },
  { source: 'mappreimage(composemaps(mapping(x+1,x,ℝ,ℝ),mapping(2*x,x,ℝ,ℝ)),set(7))', kind: 'set' },
] as const;
let backend: MathExecutionBackend;
let results: readonly unknown[];
const script = fileURLToPath(new URL('./exactRuntime/cas_mappings_test.py', import.meta.url));
function request(source: string): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'radian', coefficients: [],
    identity: { documentId: 'mappings', documentVersion: 2, editorId: 'X', inputRevision: 3 } };
}
function native(args: readonly string[], input?: string): string {
  const result = spawnExactRuntime(['-B', '-X', 'utf8', script, ...args], {
    input, encoding: 'utf8', timeout: 45_000, maxBuffer: 2_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`写像の実計算に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}
const context = () => ({ operationsById: backend.operationsById, coefficientIds: new Set<string>(), declaredIds: new Set<string>() });
beforeAll(() => {
  backend = createMathBackend();
  const payloads = examples.map(({ source }) => {
    const reply = executeMathWorkRequest(createMathWorkEnvelope(1, request(source)), backend);
    if (reply.expression === null) throw new Error(`数式を読めません: ${source}: ${JSON.stringify(reply.evaluation)}`);
    return { expression: reply.expression, angleUnit: 'radian' };
  });
  const decoded: unknown = JSON.parse(native(['--batch'], JSON.stringify(payloads)));
  if (!Array.isArray(decoded) || decoded.length !== examples.length) throw new Error('計算の返信数が一致しません。');
  results = decoded;
}, 60_000);

describe('写像の定義域・出力先・合成・逆写像と像を元の条件のまま保持する', () => {
  it('実計算部で像と逆像、逆数との区別、定義できない点と端点を独立に照合する', () => { native([]); }, 60_000);
  it.each(examples)('$sourceを計算し、元の範囲と原式を保存・再開する', async example => {
    const input = request(example.source), index = examples.indexOf(example);
    const options = { backend, engine: { evaluate: () => Promise.resolve(results[index]) }, shouldStop: () => undefined };
    const raw = await executeExactMathWorkRequest(createMathWorkEnvelope(2, input), options);
    const result = decodeMathWorkReply(raw, input, context()).result;
    if ('reason' in example) {
      expect(result.evaluation).toMatchObject({ status: 'invalid', reason: example.reason });
      expect(result.evaluation).not.toHaveProperty('coordinate');
      return;
    }
    if ('value' in example) {
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real' });
      if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real') throw new Error(JSON.stringify(result.evaluation));
      expect(result.evaluation.coordinate).toBeCloseTo(example.value, 12);
      expect(result.evaluation.exact).not.toBeNull();
    } else {
      expect(result.evaluation).toMatchObject({ status: 'value', kind: example.kind });
      expect(result.evaluation).not.toHaveProperty('coordinate');
    }
    expect(result.definition?.source).toBe(example.source);
    if (result.definition === null) throw new Error('保存する原式がありません。');
    const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(3, { ...input, definition: result.definition })));
    const reopened = await executeExactMathWorkRequest(saved, options);
    expect(decodeMathWorkReply(reopened, input, context()).result.evaluation).toEqual(result.evaluation);
  });
  it.each([0,1,2,3,6,7,19,22,23])('例%sの変数と定義域を構造入力の往復でも保持する', async index => {
    const input = request(examples[index].source);
    const options = { backend, engine: { evaluate: () => Promise.resolve(results[index]) }, shouldStop: () => undefined };
    const raw = await executeExactMathWorkRequest(createMathWorkEnvelope(4, { ...input, presentationNotation: 'latex' }), options);
    if (raw.presentation === undefined || raw.presentation === null || raw.expression === null) throw new Error('構造入力がありません。');
    expect(sameMathMeaning(raw.expression, raw.presentation.expression)).toBe(true);
    const restored = await executeExactMathWorkRequest(createMathWorkEnvelope(5, { ...input, source: raw.presentation.source,
      notation: 'latex', definition: raw.presentation, presentationNotation: 'text' }), options);
    if (restored.presentation === undefined || restored.presentation === null) throw new Error(`テキスト入力へ戻せません: ${JSON.stringify(restored)}`);
    expect(sameMathMeaning(raw.expression, restored.presentation.expression)).toBe(true);
    expect(restored.evaluation).toEqual(raw.evaluation);
  });
  it('写像の型へ数値の依頼や異なる定義域を混ぜた返信を拒否する', () => {
    const source = executeMathWorkRequest(createMathWorkEnvelope(1, request(examples[0].source)), backend).expression;
    if (source === null) throw new Error('写像の原式がありません。');
    const raw = { status: 'value', kind: 'function', request: source, domainConditions: [], coordinateAuthorized: false };
    expect(() => decodeExactMathResult(raw, { kind: 'number', decimal: '1' }, context())).toThrow();
    expect(() => decodeExactMathResult({ ...raw, coordinateAuthorized: true }, source, context())).toThrow();
    expect(() => decodeExactMathResult({ ...raw, request: { kind: 'number', decimal: '1' } }, source, context())).toThrow();
  });
});
