import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest, type ExactMathEngine } from './exactMathWorkExecution.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { sameMathMeaning } from './mathNotationConversion.js';

const examples = [
  { source: 'lineintegral(1,[x,y],[3*t,4*t],t,0,1)', value: 5 },
  { source: 'lineintegral(x,[x,y],[3*t,4*t],t,1,0)', value: 7.5 },
  { source: 'circulation([2*x,2*y],[x,y],[t,t^2],t,0,1)', value: 2 },
  { source: 'circulation([2*x,2*y],[x,y],[t^2,t^4],t,0,1)', value: 2 },
  { source: 'lineintegral(1,[x,y],[cos(t),sin(t)],t,0,360)', value: 2*Math.PI },
  { source: 'circulation([-y,x],[x,y],[cos(t),sin(t)],t,360,0)', value: -2*Math.PI },
  { source: 'lineintegral(1,[x,y,z],[cos(t),sin(t),t],t,0,2*pi)', value: 2*Math.PI*Math.SQRT2, unit: 'radian' },
  { source: 'lineintegral(1/sqrt(x),[x],[t],t,0,1)', value: 2 },
  { source: 'lineintegral(exp(-x),[x],[t],t,0,∞)', value: 1 },
  { source: 'lineintegral(x,[y,x],[2,t],t,0,1)', value: 0.5 },
  { source: 'lineintegral(x,[x],[x],x,0,2)', value: 2 },
  { source: 'lineintegral(x·y,[x,y],[t,2*t],t,0,1)', value: 2*Math.sqrt(5)/3 },
  { source: 'lineintegral(1,[x,y],[3*t,4*t],t,0,1) × 2', value: 10 },
  { source: 'lineintegral(7,[x,y],[2,3],t,0,1)', value: 0 },
  { source: 'lineintegral(1,[x],[t/t],t,0,1)', invalid: 'domain' },
  { source: 'lineintegral(1,[x],[1/t],t,-1,1)', invalid: 'domain' },
  { source: 'lineintegral(1,[x],[sqrt(t)],t,-1,1)', invalid: 'domain' },
  { source: 'lineintegral(1,[x],[(-1)^t],t,0,1)', invalid: 'domain' },
  { source: 'lineintegral(1,[x],[i*t],t,0,1)', invalid: 'domain' },
  { source: 'circulation([1,y/y],[x,y],[t,0],t,0,1)', invalid: 'domain' },
  { source: 'lineintegral(component([1,y/y],1),[x,y],[t,0],t,0,1)', invalid: 'domain' },
  { source: 'lineintegral(0*sqrt(-x),[x],[t],t,1,2)', invalid: 'domain' },
  { source: 'lineintegral(1/x,[x],[t],t,-1,1)', invalid: 'divergent' },
  { source: '0*lineintegral(1/x,[x],[t],t,-1,1)', invalid: 'divergent' },
  { source: 'lineintegral(1/x,[x],[t],t,-1,1)-lineintegral(1/x,[x],[t],t,-1,1)', invalid: 'divergent' },
] as const;
let backend: MathExecutionBackend;
let results: readonly unknown[];
const script = fileURLToPath(new URL('./exactRuntime/cas_line_integrals_test.py', import.meta.url));
function request(source: string, unit: 'degree' | 'radian' = 'degree'): MathWorkRequest {
  return { source, notation: 'text', angleUnit: unit, coefficients: [],
    identity: { documentId: 'line-integrals', documentVersion: 2, editorId: 'X', inputRevision: 3 } };
}
function native(args: readonly string[], input?: string): string {
  const result = spawnSync('python', ['-B', '-X', 'utf8', script, ...args], {
    input, encoding: 'utf8', timeout: 90_000, maxBuffer: 2_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`線積分の実計算に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  }
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

describe('弧長による線積分と向き付きの仕事を、元の式の成立条件を保って座標へ渡す', () => {
  it('同名の座標変数と係数を区別し、経路と端点の編集を保存した原式へ反映する', async () => {
    const source = 'lineintegral(coef("x")*x,[x],[coef("経路")*t],t,0,coef("終点"))';
    for (const [factor, path, end, expected] of [['2', '3', '1', 9], ['4', '2', '3', 72]] as const) {
      const input: MathWorkRequest = { ...request(source), coefficients: [
        { id: 'factor-id', label: 'x', decimal: factor }, { id: 'path-id', label: '経路', decimal: path },
        { id: 'end-id', label: '終点', decimal: end },
      ] };
      const engine: ExactMathEngine = { evaluate: expression => {
        const values: unknown = JSON.parse(native(['--batch'], JSON.stringify([{ expression, angleUnit: input.angleUnit }])));
        if (!Array.isArray(values) || values.length !== 1) throw new Error('実計算の返信数が一致しません。');
        return Promise.resolve(values[0]);
      } };
      const raw = await executeExactMathWorkRequest(createMathWorkEnvelope(7, input), { backend, engine, shouldStop: () => undefined });
      const result = decodeMathWorkReply(raw, input, { operationsById: backend.operationsById,
        coefficientIds: new Set(['factor-id', 'path-id', 'end-id']), declaredIds: new Set() }).result;
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: expected });
      expect(result.definition?.source).toBe(source);
      if (result.definition === null) throw new Error('保存する原式がありません。');
      const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(8, { ...input, definition: result.definition })));
      expect((await executeExactMathWorkRequest(saved, { backend, engine, shouldStop: () => undefined })).evaluation).toEqual(result.evaluation);
    }
  }, 30_000);
  it('円周・保存場・再媒介化・らせん・広義積分を独立な解析値で確認する', () => { native([]); }, 105_000);
  it.each(examples)('$sourceの通常入力と原式の保存再開', async example => {
    const input = request(example.source, 'unit' in example ? example.unit : 'degree');
    const envelope = createMathWorkEnvelope(2, input);
    const evaluate = vi.fn(() => Promise.resolve(results[examples.indexOf(example)]));
    expect(executeMathWorkRequest(envelope, backend).evaluation.status).not.toBe('value');
    const raw = await executeExactMathWorkRequest(envelope, { backend, engine: { evaluate }, shouldStop: () => undefined });
    const result = decodeMathWorkReply(raw, input, { operationsById: backend.operationsById,
      coefficientIds: new Set(), declaredIds: new Set() }).result;
    expect(evaluate).toHaveBeenCalledOnce();
    if ('value' in example) {
      if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real' || result.definition === null) throw new Error(JSON.stringify(result));
      expect(result.evaluation.coordinate).toBeCloseTo(example.value, 12);
      expect(result.evaluation.exact).not.toBeNull();
      expect(result.definition).toMatchObject({ source: example.source, angleUnit: input.angleUnit });
      const saved: unknown = JSON.parse(JSON.stringify(createMathWorkEnvelope(3, { ...input, definition: result.definition })));
      expect((await executeExactMathWorkRequest(saved, { backend, engine: { evaluate }, shouldStop: () => undefined })).evaluation).toEqual(result.evaluation);
    } else {
      expect(result.evaluation).toMatchObject({ status: 'invalid', reason: example.invalid });
      expect(result.evaluation).not.toHaveProperty('coordinate');
    }
  });
  it.each([0, 2, 5, 6, 10, 11])('式%sの場・曲線・向き・角度と局所変数を表示往復で保つ', async index => {
    const example = examples[index], input = request(example.source, 'unit' in example ? example.unit : 'degree');
    const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(4, { ...input, presentationNotation: 'latex' }), {
      backend, engine: { evaluate: () => Promise.resolve(results[index]) }, shouldStop: () => undefined,
    });
    if (reply.presentation === undefined || reply.presentation === null || reply.expression === null) throw new Error(JSON.stringify(reply));
    expect(sameMathMeaning(reply.expression, reply.presentation.expression)).toBe(true);
    const back = executeMathWorkRequest(createMathWorkEnvelope(5, { ...input, source: reply.presentation.source,
      notation: 'latex', definition: reply.presentation, presentationNotation: 'text' }), backend);
    if (back.presentation === undefined || back.presentation === null) throw new Error(JSON.stringify(back));
    expect(sameMathMeaning(reply.expression, back.presentation.expression)).toBe(true);
  });
  it.each(['lineintegral(1,[x,x],[t,t],t,0,1)', 'lineintegral(1,[],[],t,0,1)',
    'lineintegral(1,[x,y],[t],t,0,1)', 'circulation([x],[x,y],[t,t],t,0,1)',
    'lineintegral([x,y],[x,y],[t,t],t,0,1)', 'lineintegral(1,[x],[[t]],t,0,1)',
    'lineintegral(1,[x],[t],[t,u],0,1)'])('%sの不正な次元や変数を拒否する', source => {
    const reply = executeMathWorkRequest(createMathWorkEnvelope(6, request(source)), backend);
    expect(reply.evaluation.status).toBe('invalid');
    expect(reply.evaluation).not.toHaveProperty('coordinate');
  });
});
