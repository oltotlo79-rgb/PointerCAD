import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { normalizeIntegerMathOperation } from './integerMathOperations.js';
import { rationalOfExpression } from './exactRational.js';
import { coordinateFromMath, type MathNode } from './mathInputContract.js';

const n = (value: bigint): MathNode => ({ kind: 'number', decimal: String(value) });
const operation = (name: string, ...values: readonly bigint[]): Extract<MathNode, { kind: 'operation' }> =>
  ({ kind: 'operation', operation: name, operands: values.map(n) });
const result = (name: string, ...values: readonly bigint[]) => normalizeIntegerMathOperation(operation(name,...values));
const integer = (name: string, ...values: readonly bigint[]): bigint => {
  const value = rationalOfExpression(result(name,...values));
  if (value === null || value.denominator !== 1n) throw new Error('Expected an exact integer');
  return value.numerator;
};
let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function evaluate(source: string) {
  const request = { source, angleUnit: 'degree' as const, notation: 'text' as const, coefficients: [],
    presentationNotation: 'latex' as const,
    identity: { documentId: 'integer', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
  return decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
    { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set() }).result;
}

describe('整数演算で近似と確定を分け、符号と法の規約を保持する', () => {
  it.each([[-7n,3n,-3n,2n],[-7n,-3n,3n,2n],[7n,-3n,-2n,1n],[7n,3n,2n,1n],
    [0n,3n,0n,0n],[10n**40n,3n,(10n**40n-1n)/3n,1n]]) (
    '%sを%sで割る商と余りを丸めず、a=bq+rと0≤r<|b|を満たす', (a,b,q,r) => {
      expect(integer('integer-quotient',a,b)).toBe(q);
      expect(integer('integer-remainder',a,b)).toBe(r);
      expect(b*q+r).toBe(a);
      expect(r >= 0n && r < (b < 0n ? -b : b)).toBe(true);
    });
  it.each([[-5n,false],[0n,false],[1n,false],[2n,true],[3n,true],[4n,false],[97n,true],
    [561n,false],[1105n,false],[1729n,false],[2147483647n,true],[9007199254740993n,false]]) (
    '%sを確定判定し、擬素数やdoubleで丸められる整数も取り違えない', (value, prime) => {
      expect(result('is-prime',value)).toEqual({ kind: 'constant', name: prime ? 'true' : 'false' });
    });
  it.each([[-1n,2n],[1n,2n],[2n,3n],[3n,5n],[97n,101n],[1000n,1009n]]) (
    '%sより大きい最初の素数は%s', (value, prime) => { expect(integer('next-prime',value)).toBe(prime); });
  it('100桁近い反復因数でも因数と指数をそのまま保持する', () => {
    const source = operation('prime-factors',2n**100n * 3n**50n), before = JSON.stringify(source);
    expect(normalizeIntegerMathOperation(source)).toEqual({ kind: 'operation', operation: 'list', operands: [
      { kind: 'operation', operation: 'list', operands: [n(2n),n(100n)] },
      { kind: 'operation', operation: 'list', operands: [n(3n),n(50n)] },
    ] });
    expect(JSON.stringify(source)).toBe(before);
  });
  it('約数は重複なく昇順、φ(1)=1、φ(36)=12を返す', () => {
    expect(result('divisors',36n)).toEqual({ kind: 'operation', operation: 'list',
      operands: [1n,2n,3n,4n,6n,9n,12n,18n,36n].map(n) });
    expect(result('prime-factors',1n)).toEqual({ kind: 'operation', operation: 'list', operands: [] });
    expect(result('divisors',1n)).toEqual({ kind: 'operation', operation: 'list', operands: [n(1n)] });
    expect(integer('euler-totient',1n)).toBe(1n);
    expect(integer('euler-totient',36n)).toBe(12n);
  });
  it.each([
    ['integerquotient(-7,3)',-3], ['integerremainder(-7,-3)',2], ['nextprime(97)',101],
    ['component(divisors(36),8)',18], ['component(primefactors(360),2,2)',2], ['eulertotient(36)',12],
    ['2*component(divisors(36),8)',36], ['3*component(primefactors(360),2,2)',6],
    ['which(isprime(13),5,true,0)',5], ['which(congruentmodulo(-1,5,3),7,true,0)',7],
    ['which(divides(4,20),9,true,0)',9], ['2*integerquotient(7,3)',4],
  ] as const)('%sを表示変換してから座標または条件に利用する', (source, expected) => {
    const value = evaluate(source);
    expect(coordinateFromMath(value.evaluation)).toBe(expected);
    expect(value.presentation).not.toBeNull();
  });
  it.each(['integerquotient(1,0)', 'integerremainder(1,0)', 'congruentmodulo(1,2,0)',
    'isprime(1.00000000000000001)', 'eulertotient(0)', 'divisors(-1)', 'primefactors(0)']) (
    '%sを無効とし、0倍による簡約でも不正入力を消さない', source => {
      expect(evaluate(source).evaluation.status).toBe('invalid');
      expect(evaluate(`0*${source}`).evaluation.status).toBe('invalid');
    });
  it('0による整除と負の法にも定義を固定する', () => {
    expect(result('divides',0n,0n)).toEqual({ kind: 'constant', name: 'true' });
    expect(result('divides',0n,1n)).toEqual({ kind: 'constant', name: 'false' });
    expect(result('congruent-modulo',-1n,5n,-3n)).toEqual({ kind: 'constant', name: 'true' });
  });
  it('実際に選択した条件だけを評価し、選ばれない枝の不正な整数計算は実行しない', () => {
    expect(coordinateFromMath(evaluate('which(false,isprime(1/0),true,5)').evaluation)).toBe(5);
    expect(coordinateFromMath(evaluate('which(isprime(13),5,true,1/0)').evaluation)).toBe(5);
    expect(evaluate('which(isprime(13),1/0,true,5)').evaluation.status).toBe('invalid');
    expect(evaluate('which(isprime(1/0),5,true,0)').evaluation.status).toBe('invalid');
  });
  it('探索が上限に達しても素数・合成数のどちらも捏造しない', () => {
    expect(() => result('is-prime',2n**61n-1n)).toThrow(expect.objectContaining({ code: 'budget' }));
    expect(() => result('prime-factors',2n**61n-1n)).toThrow(expect.objectContaining({ code: 'budget' }));
  });
  it('256個を超える約数を部分結果のまま返さない', () => {
    expect(() => result('divisors',2n**256n)).toThrow(expect.objectContaining({ code: 'budget' }));
  });
});
