import { describe, expect, it } from 'vitest';
import { decodeExactMathResult, indefiniteIntegralBinding, isAntiderivativeOf } from './exactMathResult.js';
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

describe('不定積分の答え(原始関数のlambda)だけを関数として受け取り、数として扱わない(MC-20)', () => {
  const t = { role: 'bound', id: 'bound-t', label: 't' } as const;
  const lambda = (body: MathNode, variable: Extract<MathSymbolReference, { role: 'bound' }> = t,
    domain: Extract<MathNode, { kind: 'binder' }>['bindings'][number]['domain'] = { kind: 'unrestricted' }): MathNode =>
    ({ kind: 'binder', operation: 'lambda', bindings: [{ variable, domain }], body });
  const integral = (body: MathNode, domain: Extract<MathNode, { kind: 'binder' }>['bindings'][number]['domain'] = { kind: 'unrestricted' }): MathNode =>
    ({ kind: 'binder', operation: 'integrate', bindings: [{ variable: t, domain }], body });
  const source = integral(operation('power', symbol(t), number('2')));
  const answer = lambda(operation('divide', operation('power', symbol(t), number('3')), number('3')));
  const closedCondition = operation('not-equal', operation('subtract', constant('pi'), number('3')), number('0'));

  it('原式の積分と同じ変数のlambdaを受け取り、その変数を含まない元の条件は保つ(定数の原始関数も関数)', () => {
    expect(decode(reply(answer, 'antiderivative', [closedCondition]), source)).toEqual({ status: 'value', reportedKind: 'antiderivative',
      expression: answer, domainConditions: [closedCondition], coordinateAuthorized: false });
    expect(decode(reply(lambda(number('0')), 'antiderivative'), source)).toMatchObject({ reportedKind: 'antiderivative', expression: lambda(number('0')) });
  });

  it.each([
    ['定積分の原式', answer, integral(operation('power', symbol(t), number('2')), { kind: 'range', lower: number('0'), upper: number('3'), step: null }), []],
    ['式の内側の不定積分', answer, operation('multiply', number('2'), source), []],
    ['変数が2つの積分', answer, { kind: 'binder', operation: 'integrate', body: symbol(t), bindings: [{ variable: t, domain: { kind: 'unrestricted' } },
      { variable: { role: 'bound', id: 'bound-u', label: 'u' }, domain: { kind: 'unrestricted' } }] }, []],
    ['別の識別子の変数', lambda(symbol({ role: 'bound', id: 'other', label: 't' }), { role: 'bound', id: 'other', label: 't' }), source, []],
    ['別の表示名の変数', lambda(symbol({ role: 'bound', id: 'bound-t', label: 's' }), { role: 'bound', id: 'bound-t', label: 's' }), source, []],
    ['lambdaでない答え', operation('divide', operation('power', symbol(t), number('3')), number('3')), source, []],
    ['積分のままの答え', source, source, []],
    ['真偽の本体', lambda(operation('less', symbol(t), number('0'))), source, []],
    ['入れ子のlambda', lambda(lambda(symbol(t), { role: 'bound', id: 'bound-s', label: 's' })), source, []],
    ['範囲の外の束縛変数を含む本体', lambda(symbol({ role: 'bound', id: 'bound-k', label: 'k' })), source, []],
    ['積分の変数を含む条件', answer, source, [operation('not-equal', symbol(t), number('0'))]],
  ] as const)('%sは原始関数の答えとして受け取らない', (_name, expression, original, conditions) => {
    expect(() => decode(reply(expression, 'antiderivative', conditions), original)).toThrow();
  });

  it('原始関数の答えに座標や未知の項目を付けた返信を受け取らない', () => {
    expect(() => decode({ ...reply(answer, 'antiderivative'), coordinateAuthorized: true }, source)).toThrow();
    expect(() => decode({ ...reply(answer, 'antiderivative'), coordinate: 1 }, source)).toThrow();
    expect(() => decode({ ...reply(answer, 'antiderivative'), request: source }, source)).toThrow();
  });

  it.each(['real', 'complex', 'symbolic', 'boolean', 'vector', 'matrix', 'set', 'interval', 'infinite-bound'])(
    'lambdaは%sの値として受け取らず、演算の引数としても受け取らない', kind => {
      expect(() => decode(reply(answer, kind), source)).toThrow('数式の厳密な計算結果の形式が不正です。');
      expect(() => decode(reply(operation('add', answer, number('1')), kind), source)).toThrow();
      expect(() => decode(reply(operation('list', answer), kind), source)).toThrow();
    });

  it('isAntiderivativeOfは原式の最上位が境界の無い積分のときだけ真で、写像などの関数値の原式には偽になる', () => {
    expect(indefiniteIntegralBinding(source)).toEqual({ variable: t, domain: { kind: 'unrestricted' } });
    expect(isAntiderivativeOf(answer, source)).toBe(true);
    expect(isAntiderivativeOf(answer, integral(symbol(t), { kind: 'range', lower: number('0'), upper: number('1'), step: null }))).toBe(false);
    expect(isAntiderivativeOf(answer, operation('multiply', number('2'), source))).toBe(false);
    const mapping = operation('mapping', lambda(symbol(t)), constant('real-numbers'), constant('real-numbers'));
    expect(indefiniteIntegralBinding(mapping)).toBeNull();
    expect(isAntiderivativeOf(mapping, mapping)).toBe(false);
    expect(isAntiderivativeOf(lambda(symbol(t)), mapping)).toBe(false);
    expect(isAntiderivativeOf(source, source)).toBe(false);
  });
});
