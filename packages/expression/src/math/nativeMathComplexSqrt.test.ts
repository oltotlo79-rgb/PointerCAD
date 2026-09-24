import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { EngineMathJson } from './encodeMathJson.js';
import { complexOperation } from './nativeMathComplex.js';
import { numberJson, rationalJson } from './nativeMathNumber.js';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { exactRuntimeBatch, sharedExactEngine } from './exactRuntimeTestSupport.js';
import { createMathWorkEnvelope } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';

const N = numberJson;
// The rewrite under test never reaches the exponent-reduction loop, so a passthrough is enough here.
const identity = (value: EngineMathJson): EngineMathJson => value;

describe('指数の分母が2のPowerをPower(Sqrt(base),分子)へ書き換える際、分子がちょうど1なら冗長な^1を作らずSqrt(base)を返す(MC-12cでMC-21のE2Eから見つかった不具合の修正)', () => {
  it('分子が1のとき、Power(base,1/2)はSqrt(base)そのものを返す(Power(Sqrt(base),1)にしない)', () => {
    const result = complexOperation('Power', [N(30), rationalJson({ numerator: 1n, denominator: 2n })], false, identity);
    expect(result).toEqual(['Sqrt', N(30)]);
  });
  it('分子が3のときは従来どおりPower(Sqrt(base),3)を返す(1以外の分子の扱いは変えない)', () => {
    const result = complexOperation('Power', [N(30), rationalJson({ numerator: 3n, denominator: 2n })], false, identity);
    expect(result).toEqual(['Power', ['Sqrt', N(30)], N(3)]);
  });
  it('分子が-1のときは従来どおりPower(Sqrt(base),-1)を返す(1以外の分子の扱いは変えない)', () => {
    const result = complexOperation('Power', [N(30), rationalJson({ numerator: -1n, denominator: 2n })], false, identity);
    expect(result).toEqual(['Power', ['Sqrt', N(30)], N(-1)]);
  });
});

describe('|x|の行列の実計算の候補の節そのものがsqrt(30)であり、power(sqrt(30),1)で包まれないことを模擬でなく実計算部で確かめる(MC-21のE2Eで見つかった不具合)', () => {
  it('|[[1,2],[3,4]]|の実計算のノルム候補の節はsqrt(30)そのもの(powerノードで包まれない)', async () => {
    const backend = createMathBackend();
    // absoluteValueCandidates.test.ts と同じ計算部起動口(spawnExactRuntime経由)とスクリプトを使う(rules/06 §10.323)。
    const script = fileURLToPath(new URL('./exactRuntime/cas_cardinality_test.py', import.meta.url));
    const engine = sharedExactEngine(exactRuntimeBatch(script, 30_000));
    const request = { identity: { documentId: 'sqrt-power-candidate', documentVersion: 1, editorId: 'X', inputRevision: 1 },
      source: '|[[1,2],[3,4]]|', notation: 'text' as const, angleUnit: 'radian' as const, coefficients: [] };
    const raw = await executeExactMathWorkRequest(createMathWorkEnvelope(1, request), { backend, engine, shouldStop: () => undefined });
    const result = decodeMathWorkReply(raw, request, { operationsById: CANDIDATE_MATH_BY_ID,
      coefficientIds: new Set(), declaredIds: new Set() }).result.evaluation;
    if (result.status !== 'multiple') throw new Error(JSON.stringify(result));
    // The determinant candidate stays the plain -2; the norm candidate must be the bare sqrt(30) node,
    // never a power node wrapping it with exponent 1 (the MC-21 display bug's real root cause).
    expect(result.candidates[1]).toEqual({ kind: 'operation', operation: 'sqrt', operands: [{ kind: 'number', decimal: '30' }] });
  }, 45_000);
});
