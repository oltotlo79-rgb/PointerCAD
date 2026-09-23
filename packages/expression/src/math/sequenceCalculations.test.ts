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
{"source": "sum(sequencevalue(n^2,n,k),k,-3,3,2)", "value": 20},
{"source": "product(sequencevalue(n+1,n,k),k,4,1)", "value": 1},
{"source": "sum(sequencevalue(n+1,n,k),k,4,1)", "value": 0},
{"source": "sum(sum(sequencevalue(n+j,n,k),j,1,k),k,1,3)", "value": 24},
{"source": "sum(sequencevalue(n!,n,k),k,0,5)", "value": 154},
{"source": "recurrencevalue(a+integerremainder(n,2),[n,a],0,[0],6)", "value": 3},
{"source": "sequencevalue(integerquotient(n,-3),n,-7)", "value": 3},
{"source": "sequencevalue(integerremainder(n,-3),n,-7)", "value": 2},
{"source": "sequencevalue(mod(n,-3),n,7)", "value": -2},
{"source": "sequencevalue(gcd(n,18),n,24)", "value": 6},
{"source": "sequencevalue(lcm(n,18),n,24)", "value": 72},
{"source": "sequencevalue(binomial(n,2),n,5)", "value": 10},
{"source": "sequencevalue(permutations(n,2),n,5)", "value": 20},
{"source": "sequencevalue(nextprime(n),n,97)", "value": 101},
{"source": "sequencevalue(eulertotient(n),n,36)", "value": 12},
{"source": "sequencevalue(component(divisors(n),8),n,36)", "value": 18},
{"source": "sequencevalue(component(primefactors(n),2,2),n,360)", "value": 2},
{"source": "sequencevalue(round(n/2),n,5)", "value": 2},
{"source": "sequencevalue(round(n/2),n,-7)", "value": -4},
{"source": "sequencevalue(round(n/1000,2),n,1245)", "value": 1.24},
{"source": "sequencevalue(ceil(n/2),n,-3)", "value": -1},
{"source": "sum(sequencevalue(1/(n-2),n,k),k,1,3)", "rejected": true},
{"source": "product(sequencevalue(n/(n-2),n,k),k,0,3)", "rejected": true},
{"source": "0*sum(sequencevalue(1/(n-2),n,k),k,1,3)", "rejected": true},
{"source": "sequencevalue(0*factorial(n),n,-1)", "rejected": true},
{"source": "sequencevalue(component([1,factorial(n)],1),n,-1)", "rejected": true},
{"source": "sequencevalue(integerquotient(n,0),n,1)", "rejected": true},
{"source": "sequencevalue(isprime(n),n,13)", "rejected": true},
{"source": "sum(sequencevalue(2^(-n),n,k),k,0,∞)", "rejected": true},
{"source": "sum(recurrencevalue(a+b,[n,a,b],0,[0,1],k),k,0,10)", "value": 143},
{"source": "product(sequencevalue(n+1,n,k),k,1,4)", "value": 120},
{"source": "sequencevalue(n!,n,5)", "value": 120},
{"source": "differenceat(floor(n/2),n,3,1,1)", "value": 1},
  {
    "source": "sequencevalue(n^2,n,5)",
    "value": 25
  },
  {
    "source": "sequencevalue(n^2,n,-3)",
    "value": 9
  },
  {
    "source": "sequencevalue(sin(n),n,30)",
    "value": 0.5
  },
  {
    "source": "sequencevalue(n/n,n,2)",
    "value": 1
  },
  {
    "source": "differenceat(n^2,n,4,1,2)",
    "value": 20
  },
  {
    "source": "differenceat(n^3,n,3,3,2)",
    "value": 48
  },
  {
    "source": "differenceat(n^2,n,4,0,3)",
    "value": 16
  },
  {
    "source": "recurrencevalue(a+b,[n,a,b],0,[0,1],10)",
    "value": 55
  },
  {
    "source": "recurrencevalue(b-a,[n,a,b],0,[2,5],2)",
    "value": 3
  },
  {
    "source": "recurrencevalue(a+n,[n,a],-2,[10],1)",
    "value": 7
  },
  {
    "source": "recurrencevalue(2*a,[n,a],1,[3],5)",
    "value": 48
  },
  {
    "source": "recurrencevalue(a*a,[n,a],0,[2],3)",
    "value": 256
  },
  {
    "source": "recurrencevalue(a+1/n,[n,a],1,[0],4)",
    "value": 1.8333333333333333
  },
  {
    "source": "recurrencevalue(a+b,[n,a,b],0,[2,5],0)",
    "value": 2
  },
  {
    "source": "recurrencevalue(a+b,[n,a,b],0,[2,5],1)",
    "value": 5
  },
  {
    "source": "2*recurrencevalue(a+b,[n,a,b],0,[0,1],10)",
    "value": 110
  },
  {
    "source": "sum(sequencevalue(n^2,n,2),n,1,3)",
    "value": 12
  },
  {
    "source": "sequencevalue(n/n,n,0)",
    "rejected": true
  },
  {
    "source": "sequencevalue(n,n,1/2)",
    "rejected": true
  },
  {
    "source": "differenceat(n,n,0,-1,1)",
    "rejected": true
  },
  {
    "source": "differenceat(n,n,0,1,0)",
    "rejected": true
  },
  {
    "source": "recurrencevalue(a+1,[n,a],0,[0],-1)",
    "rejected": true
  },
  {
    "source": "recurrencevalue(1/(n-1),[n,a],0,[0],3)",
    "rejected": true
  },
  {
    "source": "0*recurrencevalue(1/(n-1),[n,a],0,[0],3)",
    "rejected": true
  },
  {
    "source": "recurrencevalue(a^a,[n,a],0,[2],10)",
    "rejected": true
  },
  {
    "source": "recurrencevalue(a+1,[n,a],0,[0],4097)",
    "rejected": true
  }
] as const;
let backend: MathExecutionBackend;
let results: readonly unknown[];
const script = fileURLToPath(new URL('./exactRuntime/cas_sequences_test.py', import.meta.url));
function request(source: string, unit: 'degree' | 'radian' = 'degree'): MathWorkRequest {
  return { source, notation: 'text', angleUnit: unit, coefficients: [],
    identity: { documentId: 'sequences', documentVersion: 2, editorId: 'X', inputRevision: 3 } };
}
function native(args: readonly string[], input?: string, program = script): string {
  const result = spawnSync('python', ['-B', '-X', 'utf8', program, ...args], {
    input, encoding: 'utf8', timeout: 90_000, maxBuffer: 2_000_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`数列と漸化式の実計算に失敗しました。\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`);
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

describe('数列・差分・漸化式を保存して計算する', () => {
  it('不要に見える成分も通常の準備経路から実計算へ渡して不成立を保つ', async () => {
    for (const source of ['component([1,sequencevalue(1/n,n,0)],1)',
      'component([1,sum(sequencevalue(1/n,n,k),k,-1,1)],1)',
      '0*sequencevalue(factorial(n),n,-1)']) {
      const input = request(source);
      const engine: ExactMathEngine = { evaluate: expression => {
        const decoded: unknown = JSON.parse(native(['--batch'], JSON.stringify([{ expression, angleUnit: input.angleUnit }])));
        if (!Array.isArray(decoded) || decoded.length !== 1) throw new Error('実計算の返信が一致しません。');
        return Promise.resolve(decoded[0]);
      } };
      const reply = await executeExactMathWorkRequest(createMathWorkEnvelope(9, input), { backend, engine, shouldStop: () => undefined });
      expect(reply.evaluation.status).not.toBe('value');
      expect(reply.evaluation).not.toHaveProperty('coordinate');
    }
  }, 30_000);
  it('有限和積・整数・分数の独立な列挙と不成立・共有予算を確認する', () => {
    native([], undefined, fileURLToPath(new URL('./exactRuntime/cas_sequence_composition_test.py', import.meta.url)));
  }, 105_000);
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
    } else {
      expect(result.evaluation.status).not.toBe('value');
      expect(result.evaluation).not.toHaveProperty('coordinate');
    }
  });
  it('係数と同名の局所添字を区別し、初期値の変更を再計算する', async () => {
    for (const [decimal, expected] of [['3', 6], ['6', 12]] as const) {
      const input: MathWorkRequest = { ...request('recurrencevalue(a+coef("n"),[n,a],0,[coef("初期値")],1)'),
        coefficients: [{ id: 'factor', label: 'n', decimal }, { id: 'mean', label: '初期値', decimal }] };
      const engine: ExactMathEngine = { evaluate: expression => {
        const values: unknown = JSON.parse(native(['--batch'], JSON.stringify([{ expression, angleUnit: input.angleUnit }])));
        if (!Array.isArray(values) || values.length !== 1) throw new Error('実計算の返信数が一致しません。');
        return Promise.resolve(values[0]);
      } };
      const result = await executeExactMathWorkRequest(createMathWorkEnvelope(7, input), { backend, engine, shouldStop: () => undefined });
      expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: expected });
      const decoded = decodeMathWorkReply(result, input, { operationsById: backend.operationsById,
        coefficientIds: new Set(['factor', 'mean']), declaredIds: new Set() }).result;
      expect(decoded.definition?.source).toBe(input.source);
    }
  }, 30_000);
  it.each(['sequencevalue(n,[n],1)', 'recurrencevalue(a,[n,n],0,[1],2)',
    'recurrencevalue(a+b,[n,a,b],0,[1],2)', 'differenceat(n,n,0,1)'])('%sの不足を補って計算しない', source => {
    const result = executeMathWorkRequest(createMathWorkEnvelope(11, request(source)), backend);
    expect(result.evaluation.status).not.toBe('value');
    expect(result.evaluation).not.toHaveProperty('coordinate');
  });
});
