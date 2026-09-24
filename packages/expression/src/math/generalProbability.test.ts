import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest, type ExactMathEngine } from './exactMathWorkExecution.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { sameMathMeaning } from './mathNotationConversion.js';
import { sharedExactEngine, spawnExactRuntime } from './exactRuntimeTestSupport.js';

const examples = [
  {
    "source": "probability(x>0,[x],normaldistribution(0,1))",
    "value": 0.5
  },
  {
    "source": "probability(x<1,[x],normaldistribution(0,1))",
    "value": 0.8413447460685429
  },
  {
    "source": "probability(x>1,[x],normaldistribution(0,1))",
    "value": 0.15865525393145707
  },
  {
    "source": "probability(x<=2,[x],uniformdistribution(0,4))",
    "value": 0.5
  },
  {
    "source": "givenprobability(x>2,x>1,[x],uniformdistribution(0,4))",
    "value": 0.6666666666666666
  },
  {
    "source": "probability(x=0,[x],poissondistribution(2))",
    "value": 0.1353352832366127
  },
  {
    "source": "probability(x>=2,[x],binomialdistribution(3,1/2))",
    "value": 0.5
  },
  {
    "source": "randomexpectation(x,[x],normaldistribution(3,2))",
    "value": 3
  },
  {
    "source": "randomvariance(x,[x],normaldistribution(3,2))",
    "value": 4
  },
  {
    "source": "randomexpectation(x^2,[x],uniformdistribution(-1,1))",
    "value": 0.3333333333333333
  },
  {
    "source": "randomexpectation(x,[x],exponentialdistribution(2))",
    "value": 0.5
  },
  {
    "source": "randomvariance(x,[x],gammadistribution(2,3))",
    "value": 18
  },
  {
    "source": "randomexpectation(x,[x],betadistribution(2,3))",
    "value": 0.4
  },
  {
    "source": "randomexpectation(x,[x],chisquaredistribution(4))",
    "value": 4
  },
  {
    "source": "randomvariance(x,[x],tdistribution(4))",
    "value": 2
  },
  {
    "source": "randomexpectation(x,[x],tdistribution(3/2))",
    "value": 0
  },
  {
    "source": "probability(and(x>0,y>0),[x,y],independentdistributions([normaldistribution(0,1),normaldistribution(0,1)]))",
    "value": 0.25
  },
  {
    "source": "probability(or(x>0,y>0),[x,y],independentdistributions([normaldistribution(0,1),normaldistribution(0,1)]))",
    "value": 0.75
  },
  {
    "source": "randomexpectation(x,[x],fdistribution(3,6))",
    "value": 1.5
  },
  {
    "source": "randomexpectation(x,[x],fdistribution(1/2,6))",
    "value": 1.5
  },
  {
    "source": "randomexpectation(x,[x],poissondistribution(3))",
    "value": 3
  },
  {
    "source": "randomvariance(x,[x],binomialdistribution(4,1/2))",
    "value": 1
  },
  {
    "source": "randomcovariance(x,2*x,[x],normaldistribution(1,3))",
    "value": 18
  },
  {
    "source": "randomcorrelation(x,-2*x,[x],uniformdistribution(-1,1))",
    "value": -1
  },
  {
    "source": "randomcovariance(x,x+y,[x,y],independentdistributions([normaldistribution(0,2),normaldistribution(0,3)]))",
    "value": 4
  },
  {
    "source": "randomexpectation(x+y,[x,y],jointfinitedistribution([[0,0],[2,2]],[1/4,3/4]))",
    "value": 3
  },
  {
    "source": "randomcovariance(x,y,[x,y],jointfinitedistribution([[0,0],[2,2]],[1/4,3/4]))",
    "value": 0.75
  },
  {
    "source": "givenprobability(x=2,y=2,[x,y],jointfinitedistribution([[0,0],[2,2]],[1/4,3/4]))",
    "value": 1
  },
  {
    "source": "randomexpectation(sin(x),[x],finitedistribution([0,30],[1/2,1/2]))",
    "value": 0.25
  },
  {
    "source": "2*randomexpectation(x,[x],normaldistribution(3,2))",
    "value": 6
  },
  {
    "source": "independentevents(x>1,x<3,[x],finitedistribution([1,2,3,4],[1/4,1/4,1/4,1/4]))",
    "boolean": false
  },
  {
    "source": "independentvariables(x,x,[x],finitedistribution([0,1],[1/2,1/2]))",
    "boolean": false
  },
  {
    "source": "independentvariables(x,y,[x,y],independentdistributions([normaldistribution(0,1),normaldistribution(0,1)]))",
    "boolean": true
  },
  {
    "source": "independentvariables(x+y,x-y,[x,y],independentdistributions([normaldistribution(0,1),normaldistribution(0,1)]))",
    "boolean": true
  },
  {
    "source": "probability(x>0,[x],normaldistribution(0,1))=1/2",
    "boolean": true
  },
  {
    "source": "givenprobability(x>0,x=0,[x],normaldistribution(0,1))",
    "rejected": true
  },
  {
    "source": "randomcorrelation(x,x,[x],finitedistribution([1],[1]))",
    "rejected": true
  },
  {
    "source": "randomexpectation(x,[x],normaldistribution(0,-1))",
    "rejected": true
  },
  {
    "source": "0*randomexpectation(x,[x],normaldistribution(0,-1))",
    "rejected": true
  },
  {
    "source": "randomexpectation(x,[x],finitedistribution([0,1],[1/4,1/4]))",
    "rejected": true
  },
  {
    "source": "randomexpectation(x,[x],finitedistribution([0,1],[-1,2]))",
    "rejected": true
  },
  {
    "source": "randomexpectation(x,[x],tdistribution(1))",
    "rejected": true
  },
  {
    "source": "randomexpectation(0*(x/x),[x],normaldistribution(0,1))",
    "rejected": true
  },
  {
    "source": "randomexpectation(component([1,x/x],1),[x],uniformdistribution(-1,1))",
    "rejected": true
  },
  {
    "source": "probability(x,[x],normaldistribution(0,1))",
    "rejected": true
  },
  {
    "source": "randomexpectation(i*x,[x],normaldistribution(0,1))",
    "rejected": true
  },
  {
    "source": "randomexpectation(x,[x],binomialdistribution(2.5,1/2))",
    "rejected": true
  },
  {
    "source": "randomexpectation(x,[x],poissondistribution(-1))",
    "rejected": true
  },
  {
    "source": "independentvariables(x,x^2,[x],normaldistribution(0,1))",
    "rejected": true
  }
] as const;
let backend: MathExecutionBackend;
let results: readonly unknown[];
const script = fileURLToPath(new URL('./exactRuntime/cas_probability_test.py', import.meta.url));
function request(source: string, unit: 'degree' | 'radian' = 'degree'): MathWorkRequest {
  return { source, notation: 'text', angleUnit: unit, coefficients: [],
    identity: { documentId: 'general-probability', documentVersion: 2, editorId: 'X', inputRevision: 3 } };
}
function native(args: readonly string[], input?: string): string {
  const result = spawnExactRuntime(['-B', '-X', 'utf8', script, ...args], {
    input, encoding: 'utf8', timeout: 90_000, maxBuffer: 2_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`分布を宣言した確率の実計算に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
  }
  if (args.includes('--batch')) console.log(result.stderr.trim());
  return result.stdout;
}
beforeAll(() => {
  backend = createMathBackend();
  const payloads = examples.map(example => {
    const input = request(example.source, 'degree');
    const reply = executeMathWorkRequest(createMathWorkEnvelope(1, input), backend);
    if (reply.expression === null) throw new Error(`数式を読めません: ${example.source}: ${JSON.stringify(reply.evaluation)}`);
    return { expression: reply.expression, angleUnit: input.angleUnit };
  });
  const decoded: unknown = JSON.parse(native(['--batch'], JSON.stringify(payloads)));
  if (!Array.isArray(decoded) || decoded.length !== examples.length) throw new Error('計算の返信数が一致しません。');
  results = decoded;
}, 105_000);

describe('分布を宣言した確率・期待値・依存関係を保存して計算する', () => {
  it('独立な解析値と元の全成分の成立条件を固定した実計算部で確認する', () => { native([]); }, 105_000);
  it.each(examples)('$sourceの計算・保存再開・入力方式の往復', async example => {
    const input: MathWorkRequest = { ...request(example.source, 'degree'), presentationNotation: 'latex' };
    const envelope = createMathWorkEnvelope(2, input);
    const evaluate = vi.fn(() => Promise.resolve(results[examples.indexOf(example)]));
    expect(executeMathWorkRequest(envelope, backend).evaluation.status).not.toBe('value');
    const raw = await executeExactMathWorkRequest(envelope, { backend, engine: { evaluate }, shouldStop: () => undefined });
    const result = decodeMathWorkReply(raw, input, { operationsById: backend.operationsById,
      coefficientIds: new Set(), declaredIds: new Set() }).result;
    if ('value' in example) {
      expect(evaluate).toHaveBeenCalledOnce();
      if (result.evaluation.status !== 'value' || result.evaluation.kind !== 'real' || result.definition === null) {
        throw new Error(JSON.stringify({ native: results[examples.indexOf(example)], result }));
      }
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
    } else if ('boolean' in example) {
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'boolean', expression: { kind: 'constant', name: example.boolean ? 'true' : 'false' } });
      expect(result.definition?.source).toBe(example.source);
    } else {
      expect(result.evaluation.status).not.toBe('value');
      expect(result.evaluation).not.toHaveProperty('coordinate');
    }
  });
  it('係数と同名の局所変数を区別し、分布の変更を再計算する', async () => {
    const engine = sharedExactEngine(batch => native(['--batch'], batch));
    const runs = await Promise.all(([['3', 6], ['6', 12]] as const).map(async ([decimal, expected]) => {
      const input: MathWorkRequest = { ...request('randomexpectation(x+coef("x"),[x],normaldistribution(coef("平均"),1))'),
        coefficients: [{ id: 'factor', label: 'x', decimal }, { id: 'mean', label: '平均', decimal }] };
      return { input, expected,
        result: await executeExactMathWorkRequest(createMathWorkEnvelope(7, input), { backend, engine, shouldStop: () => undefined }) };
    }));
    for (const { input, expected, result } of runs) {
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: expected });
      const decoded = decodeMathWorkReply(result, input, { operationsById: backend.operationsById,
        coefficientIds: new Set(['factor', 'mean']), declaredIds: new Set() }).result;
      expect(decoded.definition?.source).toBe(input.source);
    }
  }, 30_000);
  it.each(['probability(x>0,[x,x],normaldistribution(0,1))',
    'probability(x>0,[x],3)', 'probability(x>0,x,normaldistribution(0,1))',
    'randomcovariance(x,y,[x,y],normaldistribution(0,1))'])('%sで変数と分布を勝手に補わない', async source => {
    const input = request(source);
    const engine: ExactMathEngine = { evaluate: expression => {
      const values: unknown = JSON.parse(native(['--batch'], JSON.stringify([{ expression, angleUnit: 'degree' }])));
      if (!Array.isArray(values) || values.length !== 1) throw new Error('実計算の返信数が一致しません。');
      return Promise.resolve(values[0]);
    } };
    const result = await executeExactMathWorkRequest(createMathWorkEnvelope(8, input), { backend, engine, shouldStop: () => undefined });
    expect(result.evaluation.status).not.toBe('value');
    expect(result.evaluation).not.toHaveProperty('coordinate');
  });
});
