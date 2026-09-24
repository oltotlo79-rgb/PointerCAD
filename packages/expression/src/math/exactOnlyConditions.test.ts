/** MC-31c (MC-24 の残り): a "which" branch condition built only from ≈/∀/∃ can never resolve to
 * true/false inside prepareMathCalculation.ts's own pruneMathPiecewise pass (they need the exact
 * runtime's own comparison/enumeration), so the whole request must defer to the exact runtime instead
 * of reporting a permanently missing condition. */
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeExactMathWorkRequest } from './exactMathWorkExecution.js';
import { executeMathWorkRequest } from './mathWorkExecution.js';
import { exactRuntimeBatch, sharedExactEngine } from './exactRuntimeTestSupport.js';
import { coordinateFromMath, type MathEvaluation } from './mathInputContract.js';
import { createMathWorkEnvelope, type MathWorkRequest } from './mathWorkRequest.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';

const script = fileURLToPath(new URL('./exactRuntime/cas_logic_extended_test.py', import.meta.url));
const backend = createMathBackend();
const references = { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set<string>(), declaredIds: new Set<string>() };
const sources = [
  ['which(approxequal(0.3,0.2,0.1),1,true,2)', 1],
  ['which(approxequal(1,2,0.5),1,true,2)', 2],
  ['which(forall(x,{1,2,3},x>0),1,true,2)', 1],
  // The branch not taken divides by zero; it must never be evaluated (mirrors logicExtended.test.ts's
  // '有限集合の判定を場合分けに渡し、選ばない枝の計算を行わない').
  ['which(approxequal(0.3,0.2,0.1),7,true,1/0)', 7],
] as const;
function request(source: string): MathWorkRequest {
  return { source, notation: 'text', angleUnit: 'radian', coefficients: [],
    identity: { documentId: 'exact-only-conditions', documentVersion: 1, editorId: 'which', inputRevision: 1 } };
}
let evaluations: MathEvaluation[];
beforeAll(async () => {
  const engine = sharedExactEngine(exactRuntimeBatch(script, 30_000));
  evaluations = await Promise.all(sources.map(async ([source]) => {
    const envelope = createMathWorkEnvelope(1, request(source));
    const reply = await executeExactMathWorkRequest(envelope, { backend, engine, shouldStop: () => undefined });
    return decodeMathWorkReply(reply, envelope.request, references).result.evaluation;
  }));
}, 60_000);

describe('≈・∀・∃だけを条件にした場合分けを、未確定にせず追加計算部へ委ねる', () => {
  it.each(sources)('%sが%sになる', (source, expected) => {
    const index = sources.findIndex(([candidate]) => candidate === source);
    const evaluation = evaluations[index];
    expect(evaluation, source).toMatchObject({ status: 'value', kind: 'real' });
    if (evaluation.status !== 'value' || evaluation.kind !== 'real') throw new Error(JSON.stringify(evaluation));
    expect(coordinateFromMath(evaluation)).toBeCloseTo(expected, 12);
  });
  it('ネイティブの計算単独では未確定とせず、追加の計算部が要ると理由付きで返す(自動で再試行される形)', () => {
    for (const [source] of sources) {
      const result = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: request(source) }, backend).evaluation;
      expect(result, source).toMatchObject({ status: 'invalid', reason: 'unsupported' });
      if (result.status !== 'invalid') throw new Error(JSON.stringify(result));
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });
  it('条件に≈・∀・∃を含まない通常の場合分けは、従来どおり追加計算部なしで解決する', () => {
    const result = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1,
      request: request('which(1<2,1,true,2)') }, backend).evaluation;
    expect(result).toMatchObject({ status: 'value', kind: 'real' });
    if (result.status !== 'value' || result.kind !== 'real') throw new Error(JSON.stringify(result));
    expect(coordinateFromMath(result)).toBeCloseTo(1, 12);
  });
});
