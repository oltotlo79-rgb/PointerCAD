import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';

const backend = createMathBackend();
const D = Decimal.clone({ precision: 230 });

function evaluate(source: string, angleUnit: 'degree' | 'radian' = 'degree') {
  const request = { source, angleUnit, notation: 'text' as const, coefficients: [],
    identity: { documentId: 'complex-operations', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
  const output = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
  return decodeMathWorkReply(output, request, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(), declaredIds: new Set() }).result;
}
function decimal(source: string, angleUnit: 'degree' | 'radian' = 'degree'): Decimal {
  const { evaluation } = evaluate(source, angleUnit);
  if (evaluation.status !== 'value' || evaluation.kind !== 'real') throw new Error(`${source}: ${JSON.stringify(evaluation)}`);
  return new D(evaluation.decimal);
}
/** Compare two independently computed decimals without dividing by a reference that may be exactly zero. */
function assertClose(actual: Decimal, expected: string) {
  const reference = new D(expected);
  if (reference.isZero()) expect(actual.toString()).toBe('0');
  else expect(actual.sub(reference).abs().div(reference.abs()).toNumber()).toBeLessThan(1e-30);
}

describe('複素演算(共役・arg・cis)は主値・角度・元の不成立を保持する', () => {
  describe('共役(conjugate)は実部を保ち虚部の符号だけを反転する', () => {
    it.each([
      ['3+4*i', '3', '-4'],
      ['3-4*i', '3', '4'],
      ['-2+5*i', '-2', '-5'],
      ['complex(0,-7)', '0', '7'],
    ])('conjugate(%s)の実部・虚部が独立計算値と一致する', (source, expectedRe, expectedIm) => {
      expect(decimal(`re(conjugate(${source}))`).toString()).toBe(expectedRe);
      expect(decimal(`im(conjugate(${source}))`).toString()).toBe(expectedIm);
    });
    it('別名conjがconjugateと同じ結果を返す', () => {
      expect(decimal('re(conj(1-2*i))').toString()).toBe('1');
      expect(decimal('im(conj(1-2*i))').toString()).toBe('2');
    });
    it('共役を2回適用すると元の値へ戻る', () => {
      expect(decimal('re(conjugate(conjugate(2+5*i)))').toString()).toBe('2');
      expect(decimal('im(conjugate(conjugate(2+5*i)))').toString()).toBe('5');
    });
    it('共役は絶対値(長さ)を変えない', () => {
      expect(decimal('abs(conjugate(3+4*i))').toString()).toBe('5');
      expect(decimal('abs(conjugate(-5+12*i))').toString()).toBe('13');
    });
    it('実数の共役は虚部が0のまま実部を保つ', () => {
      expect(decimal('re(conjugate(7))').toString()).toBe('7');
      expect(decimal('im(conjugate(7))').toString()).toBe('0');
    });
  });

  describe('偏角(arg)は象限ごとの既知値と角度規約を保つ', () => {
    it.each([
      ['1+i', 45], ['-1+i', 135], ['-1-i', -135], ['1-i', -45], ['i', 90], ['-i', -90],
    ])('arg(%s)を度で求めると%s度になる', (source, expected) => {
      expect(decimal(`arg(${source})`, 'degree').toNumber()).toBeCloseTo(expected, 10);
    });
    it.each([
      ['i', Math.PI / 2], ['-i', -Math.PI / 2], ['-1', Math.PI], ['1', 0],
    ])('arg(%s)をラジアンで求めると既知値になる', (source, expected) => {
      expect(decimal(`arg(${source})`, 'radian').toNumber()).toBeCloseTo(expected, 10);
    });
    it.each([
      'arg(0)', '0*arg(0)', 'component([9,arg(0)],1)',
      'arg(complex(0,0))', '0*arg(complex(0,0))', 'component([9,arg(complex(0,0))],1)',
    ])('%sは複素0でも実0でも0倍や選択外の成分でも不成立のままにする', source => {
      expect(evaluate(source).evaluation, source).toMatchObject({ status: 'invalid', reason: 'domain' });
    });
  });

  describe('cis(θ)=cosθ+i・sinθは角度規約に従い、極形式r・cis(θ)=r・e^{iθ}と一致する', () => {
    it('cis(0)は実部1・虚部0の厳密値になる', () => {
      expect(decimal('re(cis(0))', 'degree').toString()).toBe('1');
      expect(decimal('im(cis(0))', 'degree').toString()).toBe('0');
    });
    it.each([
      ['30', 'degree', Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)],
      ['90', 'degree', Math.cos(Math.PI / 2), Math.sin(Math.PI / 2)],
      ['150', 'degree', Math.cos(5 * Math.PI / 6), Math.sin(5 * Math.PI / 6)],
    ] as const)('cis(%s)を%sで求めるとcos・sinの既知値と一致する', (angle, unit, expectedRe, expectedIm) => {
      expect(decimal(`re(cis(${angle}))`, unit).toNumber()).toBeCloseTo(expectedRe, 10);
      expect(decimal(`im(cis(${angle}))`, unit).toNumber()).toBeCloseTo(expectedIm, 10);
    });
    it('度指定とラジアン指定で同じ角度なら同じ値になる', () => {
      expect(decimal('re(cis(45))', 'degree').toNumber()).toBeCloseTo(decimal('re(cis(pi/4))', 'radian').toNumber(), 10);
      expect(decimal('im(cis(45))', 'degree').toNumber()).toBeCloseTo(decimal('im(cis(pi/4))', 'radian').toNumber(), 10);
    });
    it('cisは常に単位円上にある(絶対値が1)', () => {
      expect(decimal('abs(cis(37))', 'degree').toNumber()).toBeCloseTo(1, 10);
      expect(decimal('abs(cis(2))', 'radian').toNumber()).toBeCloseTo(1, 10);
    });
    it('極形式r・cis(θ)=r・e^{iθ}が度指定でも成り立つ(r=5, θ=37度)', () => {
      const re1 = decimal('re(5*cis(37))', 'degree'), im1 = decimal('im(5*cis(37))', 'degree');
      const re2 = decimal('re(5*exp(i*(37*pi/180)))', 'radian'), im2 = decimal('im(5*exp(i*(37*pi/180)))', 'radian');
      assertClose(re1, re2.toString());
      assertClose(im1, im2.toString());
    });
    it('極形式r・cis(θ)=r・e^{iθ}がラジアン指定でも成り立つ(r=2, θ=π/5)', () => {
      const re1 = decimal('re(2*cis(pi/5))', 'radian'), im1 = decimal('im(2*cis(pi/5))', 'radian');
      const re2 = decimal('re(2*exp(i*pi/5))', 'radian'), im2 = decimal('im(2*exp(i*pi/5))', 'radian');
      assertClose(re1, re2.toString());
      assertClose(im1, im2.toString());
    });
  });
});
