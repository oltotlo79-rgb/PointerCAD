import { describe, expect, it } from 'vitest';
import { FEM_REFUSAL_CODES, FemCodedError, FemRefusalError, femRefusalField, nativeFailureCode, nativeRefusal,
  type FemRefusalCode } from './femCodedError.js';
import { translateSolidBuckling } from './solidBucklingTranslation.js';
import { singleTetBenchmark } from './solidBuckling.testSupport.js';

/** 投げた断りの符号(投げなければ null、符号の無い誤りなら undefined)。 */
function thrownRefusal(run: () => unknown): FemRefusalCode | null | undefined {
  try { run(); } catch (error) { return femRefusalField(error).refusal; }
  return null;
}

describe('計算部の文から種類を読む境目の 1 か所(0b-4)', () => {
  it.each([
    ['solid-buckling-no-positive-mode: 0 positive load factor(s) for 2 requested', 'no-positive-mode'],
    ['solid-buckling-mechanism: reduced stiffness is not positive definite', 'mechanism'],
    ['solid-input: unrestrained component rigid-body motion', 'rigid-body'],
    ['solid-buckling-budget: dense buckling reservation exceeds the numeric budget', 'budget'],
    ['solid-buckling-supports: free DOFs must be between the mode count and 1536', 'supports'],
    // Python の包み直した誤り: 文の途中・最後の行にあっても読む(今までの ui の includes と同じ)。
    ['PythonError: Traceback (most recent call last):\n  File "/pcad_fem/solidBuckling.py", line 86\nValueError: solid-buckling-mechanism: reduced stiffness is numerically singular', 'mechanism'],
    // 頭はあるが上のどれでもない: 黙って一般の断りにせず unknown(元の文は message に残る)。
    ['solid-buckling-native: native element initial-stress matrix differs', 'unknown'],
    ['solid-buckling-numeric: eigen residual exceeds 1e-8', 'unknown'],
  ] as const)('%s → %s', (message, refusal) => {
    expect(nativeRefusal(message)).toBe(refusal);
  });

  it('座屈の頭が無い文は符号を持たない(ほかの解析の文・入力ファイルの名前)', () => {
    for (const message of ['solid-modal-mechanism: nonpositive eigenvalue', 'finite-equilibrium: rejected commit', 'FEM Worker error',
      "open('/pcad_fem/solid-buckling-input.json')", '']) expect(nativeRefusal(message)).toBeUndefined();
  });

  it('並びは今までの ui の分けと同じ(正の荷重係数が機構より先、機構と剛体の動きが予算・支持より先)', () => {
    expect(nativeRefusal('solid-buckling-mechanism: x; solid-buckling-no-positive-mode: y')).toBe('no-positive-mode');
    expect(nativeRefusal('solid-buckling-supports: x; unrestrained component rigid-body motion')).toBe('rigid-body');
  });

  it('取得の拒否の印は、文のどこにあっても offline-request-denied(計算部が包み直しても読む)', () => {
    expect(nativeFailureCode('offline-request-denied: https://outside.invalid/a.py')).toBe('offline-request-denied');
    expect(nativeFailureCode('Failed to load package: offline-request-denied: 1 attempted fallback requests')).toBe('offline-request-denied');
    expect(nativeFailureCode('offline-request-denied')).toBeUndefined();
    expect(nativeFailureCode('asset-missing: pyodide.asm.js (HTTP 404)')).toBeUndefined();
  });
});

describe('符号を持つ誤り(0b-4)', () => {
  it('文はそのまま、符号は欄に持つ', () => {
    const cause = new Error('inner');
    const coded = new FemCodedError('invalid-protocol', 'native-preload-input: invalid plan', { cause });
    expect([coded.code, coded.message, coded.cause, coded.name]).toEqual(['invalid-protocol', 'native-preload-input: invalid plan', cause, 'Error']);
    const refused = new FemRefusalError('stale-source', 'CAD source changed during analysis');
    expect([refused.refusal, refused.message, refused.name]).toEqual(['stale-source', 'CAD source changed during analysis', 'Error']);
    // 計算部が文で包み直す時の頭(記録に残る文)も前の Error と同じ「Error: …」。
    expect([String(coded), String(refused), String(new FemCodedError('offline-request-denied', 'offline-request-denied: unexpected script'))])
      .toEqual(['Error: native-preload-input: invalid plan', 'Error: CAD source changed during analysis', 'Error: offline-request-denied: unexpected script']);
    expect(femRefusalField(refused)).toEqual({ refusal: 'stale-source' });
    expect(femRefusalField(coded)).toEqual({});
    expect(femRefusalField('not an error')).toEqual({});
  });

  it('符号の一覧(返事の照らしが使う)は型の和の全部で、重ならない', () => {
    const every: Record<FemRefusalCode, true> = { 'no-positive-mode': true, mechanism: true, budget: true, supports: true,
      'rigid-body': true, 'stale-source': true, 'support-conflict': true, 'support-all-free': true, unknown: true };
    expect([...FEM_REFUSAL_CODES].sort()).toEqual(Object.keys(every).sort());
  });

  it('座屈の翻訳の断りは符号を持つ(支持の自由度・剛体の動き)。文は今のまま', () => {
    const base = singleTetBenchmark();
    expect(() => translateSolidBuckling({ ...base, modeCount: 3 })).toThrow('solid-buckling-supports: insufficient free degrees of freedom');
    expect(thrownRefusal(() => translateSolidBuckling({ ...base, modeCount: 3 }))).toBe('supports');
    const rigid = { ...base, reference: { ...base.reference, constraints: [{ node: 0, fixed: [true, true, true] }] } };
    expect(() => translateSolidBuckling(rigid)).toThrow('solid-input: unrestrained component rigid-body motion');
    expect(thrownRefusal(() => translateSolidBuckling(rigid))).toBe('rigid-body');
    expect(thrownRefusal(() => translateSolidBuckling({ ...base, schema: 'pointercad-beam-buckling/1' }))).toBeUndefined();
  });
});
