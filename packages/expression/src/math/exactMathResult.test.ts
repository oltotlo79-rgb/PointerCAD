import { describe, expect, it } from 'vitest';
import { decodeExactMathResult } from './exactMathResult.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { type MathNode, type MathSymbolReference } from './mathInputContract.js';

const number = (decimal: string): MathNode => ({ kind: 'number', decimal });
const constant = (name: Extract<MathNode, { kind: 'constant' }>['name']): MathNode => ({ kind: 'constant', name });
const operation = (name: string, ...operands: readonly MathNode[]): MathNode => ({ kind: 'operation', operation: name, operands });
const symbol = (reference: MathSymbolReference): MathNode => ({ kind: 'symbol', reference });
const a = symbol({ role: 'coefficient', id: 'a-id', label: 'a' });
const context = { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(['a-id', 'b-id']), declaredIds: new Set(['declared-id']) };
const reply = (expression: MathNode, kind = 'real', domainConditions: readonly MathNode[] = []) => ({
  status: 'value', kind, expression, domainConditions, coordinateAuthorized: false,
});
const decode = (value: unknown, source: MathNode = a) => decodeExactMathResult(value, source, context);

describe('厳密な式と成立条件を受け取り、数値座標の判定を別に保つ', () => {
  it('丸めない有理数と微小な値を独立した構造へ戻し、座標へ変換しない', () => {
    const exact = operation('divide', number('1'), number('30000000000000000000000000000000000000000'));
    const raw = reply(exact), result = decode(raw);
    expect(result).toEqual({ status: 'value', reportedKind: 'real', expression: exact, domainConditions: [], coordinateAuthorized: false });
    expect(result).not.toHaveProperty('coordinate');
    if (result.status !== 'value') throw new Error('Exact result missing');
    expect(result.expression).not.toBe(raw.expression);
  });

  it('約分後に消えた分母の条件と係数IDを保持する', () => {
    const condition = operation('not-equal', a, number('0'));
    const result = decode(reply(number('1'), 'real', [condition]), operation('divide', a, a));
    expect(result).toMatchObject({ status: 'value', domainConditions: [condition], coordinateAuthorized: false });
  });

  it.each([
    ['boolean', constant('false')],
    ['complex', operation('add', number('2'), constant('imaginary-unit'))],
    ['vector', operation('list', number('1'), constant('imaginary-unit'))],
    ['vector', operation('list')],
    ['matrix', operation('matrix', operation('list', operation('list', number('1'), number('2')), operation('list', number('3'), number('4'))))],
    ['set', constant('naturals')],
    ['interval', operation('interval', operation('open-endpoint', operation('negate', constant('infinity'))), number('2'))],
    ['symbolic', operation('sin', a)],
  ])('%sの値を数値へ読み替えず受け取る', (kind, exact) => {
    // The tuple union is narrowed without treating unknown data as a MathNode.
    if (typeof kind !== 'string' || typeof exact === 'string') throw new Error('Invalid fixture');
    expect(decode(reply(exact, kind))).toMatchObject({ status: 'value', reportedKind: kind, expression: exact });
  });

  it.each([
    ['real', constant('true')],
    ['boolean', number('1')],
    ['real', constant('infinity')],
    ['real', operation('multiply', number('0'), constant('infinity'))],
    ['vector', operation('list', operation('list', number('1')))],
    ['real', operation('list')],
    ['matrix', operation('matrix', operation('list'))],
    ['matrix', operation('matrix', operation('list', operation('list', number('1')), operation('list', number('2'), number('3'))))],
    ['real', operation('open-endpoint', number('1'))],
  ])('宣言%sと式の形が合わない結果を拒否する', (kind, exact) => {
    if (typeof kind !== 'string' || typeof exact === 'string') throw new Error('Invalid fixture');
    expect(() => decode(reply(exact, kind))).toThrow();
  });

  it.each([
    { role: 'coefficient', id: 'b-id', label: 'a' },
    { role: 'coefficient', id: 'a-id', label: 'changed' },
    { role: 'coefficient', id: 'missing', label: 'a' },
    { role: 'axis', name: 'X' },
    { role: 'bound', id: 'local', label: 'a' },
  ] satisfies readonly MathSymbolReference[])('入力にない参照や表示名の差し替えを拒否する: %j', reference => {
    expect(() => decode(reply(symbol(reference), 'symbolic'))).toThrow();
    expect(() => decode(reply(number('1'), 'real', [operation('not-equal', symbol(reference), number('0'))]))).toThrow();
  });

  it('構造が正しい軸と宣言記号も元の式で指定した役割だけ許可する', () => {
    for (const reference of [{ role: 'axis', name: 'X' }, { role: 'declared', id: 'declared-id', label: 'x' }] satisfies readonly MathSymbolReference[]) {
      const source = symbol(reference);
      expect(decode(reply(source, 'symbolic'), source)).toMatchObject({ status: 'value', expression: source });
    }
  });

  it('保存用の未解決係数の許可を計算結果へ持ち込まない', () => {
    const source = symbol({ role: 'coefficient', id: 'missing', label: 'a' });
    const fileContext = { ...context, allowUnresolvedCoefficients: true };
    expect(() => decodeExactMathResult(reply(source, 'symbolic'), source, fileContext)).toThrow();
  });

  it('条件は真偽式に限定し、座標や未知の項目を受け取らない', () => {
    expect(() => decode(reply(number('1'), 'real', [number('1')]))).toThrow();
    expect(() => decode({ ...reply(number('1')), coordinateAuthorized: true })).toThrow();
    expect(() => decode({ ...reply(number('1')), coordinate: 1 })).toThrow();
    expect(() => decode({ ...reply(number('1')), angleUnit: 'radian' })).toThrow();
  });

  it('個々の式が小さくても、条件の合計が4096節を超えたら拒否する', () => {
    const condition = operation('and', ...Array.from({ length: 64 }, () => operation('not-equal', a, number('0'))));
    expect(() => decode(reply(number('1'), 'real', Array.from({ length: 22 }, () => condition)))).toThrow(/多すぎ/u);
  });

  it('循環・取得処理つきの値・穴のある配列を実行や展開の前に拒否する', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => decode(cycle)).toThrow();
    let called = false;
    const accessor = Object.defineProperty({}, 'status', { enumerable: true, get: () => { called = true; return 'value'; } });
    expect(() => decode(accessor)).toThrow(); expect(called).toBe(false);
    expect(() => decode({ ...reply(number('1')), domainConditions: new Array<unknown>(2) })).toThrow();
  });

  it.each([
    { status: 'unresolved', reason: 'unevaluated' },
    { status: 'invalid', reason: 'domain' },
    { status: 'invalid', reason: 'non-finite' },
    { status: 'invalid', reason: 'dimension' },
    { status: 'stopped', reason: 'budget' },
  ])('未評価・定義域・資源上限の区別を保つ: $status/$reason', value => {
    const raw = { ...value, coordinateAuthorized: false };
    expect(decode(raw)).toEqual(raw);
    expect(() => decode({ ...raw, expression: number('0') })).toThrow();
  });
});
