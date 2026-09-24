import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { sharedExactEngine, spawnExactRuntime } from './exactRuntimeTestSupport.js';

const examples = [
  { source: 'surfaceintegral(1,[x,y,z],[2*u,3*v,0],[u,v],[0,0],[1,1])', value: 6 },
  { source: 'surfaceintegral(x,[x,y,z],[2*u,3*v,0],[u,v],[0,0],[1,1])', value: 6 },
  { source: 'surfaceintegral(1,[x,y,z],[u,v,u+v],[u,v],[0,0],[1,1])', value: Math.sqrt(3) },
  { source: 'fluxintegral([0,0,4],[x,y,z],[2*u,3*v,0],[u,v],[0,0],[1,1])', value: 24 },
  { source: 'fluxintegral([0,0,4],[x,y,z],[2*v,3*u,0],[u,v],[0,0],[1,1])', value: -24 },
  { source: 'fluxintegral([0,0,4],[x,y,z],[2*u,3*v,0],[u,v],[1,0],[0,1])', value: -24 },
  { source: 'surfaceintegral(1,[x,y,z],[2*u,3*v,0],[u,v],[1,0],[0,1])', value: 6 },
  { source: 'volumeintegral(1,[x,y,z],[-2*u,3*v,4*w],[u,v,w],[0,0,0],[1,1,1])', value: 24 },
  { source: 'volumeintegral(x+y+z,[x,y,z],[u,v,w],[u,v,w],[0,0,0],[1,1,1])', value: 1.5 },
  { source: 'volumeintegral(1,[x,y,z],[-2*u,3*v,4*w],[u,v,w],[1,0,0],[0,1,1])', value: 24 },
  { source: 'surfaceintegral(1,[x,y,z],[cos(u),sin(u),v],[u,v],[0,0],[360,2])', value: 4*Math.PI },
  { source: 'surfaceintegral(1,[x,y,z],[sin(u)*cos(v),sin(u)*sin(v),cos(u)],[u,v],[0,0],[pi,2*pi])', value: 4*Math.PI, unit: 'radian' },
  { source: 'surfaceintegral(1,[x,y,z],[sin(u)*cos(v),sin(u)*sin(v),cos(u)],[u,v],[0,0],[180,360])', value: 4*Math.PI },
  { source: 'fluxintegral([x,y,z],[x,y,z],[sin(u)*cos(v),sin(u)*sin(v),cos(u)],[u,v],[0,0],[pi,2*pi])', value: 4*Math.PI, unit: 'radian' },
  { source: 'volumeintegral(1,[x,y,z],[u*cos(v),u*sin(v),w],[u,v,w],[0,0,0],[2,360,3])', value: 12*Math.PI },
  { source: 'surfaceintegral(1,[x,y,z],[u^2,v,0],[u,v],[-1,0],[1,1])', value: 2 },
  { source: 'fluxintegral([0,0,1],[x,y,z],[u^2,v,0],[u,v],[-1,0],[1,1])', value: 0 },
  { source: 'surfaceintegral(x,[z,y,x],[2,u,v],[u,v],[0,0],[1,1])', value: 0.5 },
  { source: 'surfaceintegral(1,[x,y,z],[x,y,0],[x,y],[0,0],[1,1]) × 2', value: 2 },
  { source: 'surfaceintegral(abs(x),[x,y,z],[u,v,0],[u,v],[-1,0],[1,1])', value: 1 },
  { source: 'surfaceintegral(3,[x,y,z],[u,0,0],[u,v],[0,0],[1,1])', value: 0 },
  { source: 'surfaceintegral(1,[x,y,z],[u,v,0],[u,v],[0,0],[0,1])', value: 0 },
  { source: '0*surfaceintegral(1/x,[x,y,z],[u,v,0],[u,v],[-1,0],[1,1])', rejected: true },
  { source: 'surfaceintegral(1/x,[x,y,z],[u,v,0],[u,v],[-1,0],[1,1])-surfaceintegral(1/x,[x,y,z],[u,v,0],[u,v],[-1,0],[1,1])', rejected: true },
  { source: 'surfaceintegral(0*(1/x),[x,y,z],[u,v,0],[u,v],[0,0],[1,1])', rejected: true },
  { source: 'surfaceintegral(component([1,x/x],1),[x,y,z],[u,v,0],[u,v],[0,0],[1,1])', rejected: true },
  { source: 'fluxintegral([1,0,z/z],[x,y,z],[u,v,0],[u,v],[0,0],[1,1])', rejected: true },
  { source: 'surfaceintegral(1,[x,y,z],[u/u,v,0],[u,v],[0,0],[1,1])', rejected: true },
  { source: 'surfaceintegral(1,[x,y,z],[abs(u),v,0],[u,v],[-1,0],[1,1])', rejected: true },
  { source: 'surfaceintegral(1,[x,y,z],[sqrt(u),v,0],[u,v],[0,0],[1,1])', rejected: true },
  { source: 'surfaceintegral(0*sqrt(-x),[x,y,z],[u,v,0],[u,v],[1,0],[2,1])', rejected: true },
  { source: 'volumeintegral(1/z,[x,y,z],[u,v,0],[u,v,w],[0,0,0],[1,1,1])', rejected: true },
  { source: 'surfaceintegral(1,[x,y,z],[i*u,v,0],[u,v],[0,0],[1,1])', rejected: true },
  { source: 'surfaceintegral(1,[x,y,z],[u,v,0],[u,v],[0,0],[∞,1])', rejected: true },
] as const;
let backend: MathExecutionBackend;
let results: readonly unknown[];
const script = fileURLToPath(new URL('./exactRuntime/cas_region_integrals_test.py', import.meta.url));
function request(source: string, unit: 'degree' | 'radian' = 'degree'): MathWorkRequest {
  return { source, notation: 'text', angleUnit: unit, coefficients: [],
    identity: { documentId: 'region-integrals', documentVersion: 2, editorId: 'X', inputRevision: 3 } };
}
function native(args: readonly string[], input?: string): string {
  const result = spawnExactRuntime(['-B', '-X', 'utf8', script, ...args], {
    input, encoding: 'utf8', timeout: 90_000, maxBuffer: 2_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`面・体積積分の実計算に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  }
  if (args.includes('--batch')) console.log(result.stderr.trim());
  return result.stdout;
}
beforeAll(() => {
  backend = createMathBackend();
  const payloads = examples.map(example => {
    const input = request(example.source, 'unit' in example ? example.unit : 'degree');
    const reply = executeMathWorkRequest(createMathWorkEnvelope(1, input), backend);
    if (reply.expression === null) throw new Error(`数式を読めません: ${example.source}: ${JSON.stringify(reply.evaluation)}`);
    return { expression: reply.expression, angleUnit: input.angleUnit };
  });
  const decoded: unknown = JSON.parse(native(['--batch'], JSON.stringify(payloads)));
  if (!Array.isArray(decoded) || decoded.length !== examples.length) throw new Error('計算の返信数が一致しません。');
  results = decoded;
}, 105_000);

describe('有限な範囲の面積分・流束・体積積分を元の式と向きを保って計算する', () => {
  it('独立な解析値と元の全成分の成立条件を固定した実計算部で確認する', () => { native([]); }, 105_000);
  it.each(examples)('$sourceの計算・保存再開・入力方式の往復', async example => {
    const input: MathWorkRequest = { ...request(example.source, 'unit' in example ? example.unit : 'degree'), presentationNotation: 'latex' };
    const envelope = createMathWorkEnvelope(2, input);
    const evaluate = vi.fn(() => Promise.resolve(results[examples.indexOf(example)]));
    expect(executeMathWorkRequest(envelope, backend).evaluation.status).not.toBe('value');
    const raw = await executeExactMathWorkRequest(envelope, { backend, engine: { evaluate }, shouldStop: () => undefined });
    const result = decodeMathWorkReply(raw, input, { operationsById: backend.operationsById,
      coefficientIds: new Set(), declaredIds: new Set() }).result;
    if ('value' in example) {
      expect(evaluate).toHaveBeenCalledOnce();
      if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real' || result.definition === null) throw new Error(JSON.stringify(result));
      expect(result.evaluation.coordinate).toBeCloseTo(example.value, 12);
      expect(result.evaluation.exact).not.toBeNull();
      expect(result.definition).toMatchObject({ source: example.source, angleUnit: input.angleUnit });
      const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(3, { ...input, definition: result.definition })));
      expect((await executeExactMathWorkRequest(saved, { backend, engine: { evaluate }, shouldStop: () => undefined })).evaluation).toEqual(result.evaluation);
      if (raw.presentation === undefined || raw.presentation === null || raw.expression === null) throw new Error(JSON.stringify(raw));
      expect(sameMathMeaning(raw.expression, raw.presentation.expression)).toBe(true);
      const back = executeMathWorkRequest(createMathWorkEnvelope(5, { ...input, source: raw.presentation.source,
        notation: 'latex', definition: raw.presentation, presentationNotation: 'text' }), backend);
      if (back.presentation === undefined || back.presentation === null) throw new Error(JSON.stringify(back));
      expect(sameMathMeaning(raw.expression, back.presentation.expression)).toBe(true);
    } else {
      expect(result.evaluation.status).not.toBe('value');
      expect(result.evaluation).not.toHaveProperty('coordinate');
    }
  });
  it('係数と同名の局所変数を分離し、量・写像・範囲の編集を反映する', async () => {
    const engine = sharedExactEngine(batch => native(['--batch'], batch));
    const runs = await Promise.all(([['2', '3', '1', 9], ['4', '2', '3', 72]] as const).map(async ([factor, scale, end, expected]) => {
      const input: MathWorkRequest = { ...request('surfaceintegral(coef("x")*x,[x,y,z],[coef("幅")*u,v,0],[u,v],[0,0],[coef("終点"),1])'),
        coefficients: [{ id: 'factor', label: 'x', decimal: factor }, { id: 'scale', label: '幅', decimal: scale },
          { id: 'end', label: '終点', decimal: end }] };
      return { input, expected,
        result: await executeExactMathWorkRequest(createMathWorkEnvelope(7, input), { backend, engine, shouldStop: () => undefined }) };
    }));
    for (const { input, expected, result } of runs) {
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: expected });
      const decoded = decodeMathWorkReply(result, input, { operationsById: backend.operationsById,
        coefficientIds: new Set(['factor', 'scale', 'end']), declaredIds: new Set() }).result;
      expect(decoded.definition?.source).toBe(input.source);
    }
  }, 30_000);
  it.each(['surfaceintegral(1,[x,x,z],[u,v,0],[u,v],[0,0],[1,1])',
    'surfaceintegral(1,[x,y,z],[u,v,0],[u,u],[0,0],[1,1])',
    'surfaceintegral(1,[x,y],[u,v,0],[u,v],[0,0],[1,1])',
    'surfaceintegral(1,[x,y,z],[u,v],[u,v],[0,0],[1,1])',
    'surfaceintegral([1,2],[x,y,z],[u,v,0],[u,v],[0,0],[1,1])',
    'fluxintegral([1,2],[x,y,z],[u,v,0],[u,v],[0,0],[1,1])',
    'volumeintegral(1,[x,y,z],[u,v,w],[u,v,w],[0,0],[1,1])',
    'surfaceintegral(1,[x,y,z],[u,v,0],u,[0,0],[1,1])',
    'surfaceintegral(1,[x,y,z],[u,v,0],[u,v],0,1)'])('%sの不正な次元・変数・範囲を拒否する', source => {
    const reply = executeMathWorkRequest(createMathWorkEnvelope(6, request(source)), backend);
    expect(reply.evaluation.status).toBe('invalid');
    expect(reply.evaluation).not.toHaveProperty('coordinate');
  });
});
