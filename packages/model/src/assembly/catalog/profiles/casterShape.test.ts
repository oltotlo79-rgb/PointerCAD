/**
 * キャスターの形(profiles/casterShape.ts)の検査: 形が成り立つ条件、取付けの板・ねじ・取付けを作らない行で形が作れる事、上半分の円の面積の式と体積の式を、
 * 式と別の数え方(細かく刻んだ和)で確かめる。寸法は汎用の数(資料の行ではない)。
 */
import { describe, expect, it } from 'vitest';

import { buildCasterPart, casterValid, casterVolume, upperHalfDiskArea, type CasterDimensions } from './casterShape.js';

const PLATE: CasterDimensions = { wheelDiameter: 50, wheelWidth: 20, offset: 10, height: 75,
  mount: { kind: 'plate', width: 60, depth: 50, thickness: 3, holes: [[-24, -19, 6], [24, -19, 6], [-24, 19, 6], [24, 19, 6]] } };
const STEM: CasterDimensions = { wheelDiameter: 40, wheelWidth: 18, offset: 0, height: 60, mount: { kind: 'stem', thread: 'M12', length: 25 } };
const NONE: CasterDimensions = { wheelDiameter: 50, wheelWidth: 20, offset: 21, height: 70, mount: { kind: 'none' } };
const TWIN: CasterDimensions = { wheelDiameter: 75, wheelWidth: 12.5, offset: 20, height: 84.5, mount: { kind: 'stem', thread: 'M12', length: 14 },
  twinGap: 22 };

/** 上半分の円の面積を、横を細かく刻んだ和で数える(式と別の数え方)。 */
function sliced(radius: number, u1: number, u2: number, steps = 20000): number {
  const [a, b] = [Math.max(-radius, u1), Math.min(radius, u2)];
  if (!(b > a)) return 0;
  const width = (b - a) / steps;
  let sum = 0;
  for (let index = 0; index < steps; index += 1) {
    const u = a + (index + 0.5) * width;
    sum += Math.sqrt(Math.max(0, radius * radius - u * u)) * width;
  }
  return sum;
}

describe('キャスターの形', () => {
  it('上半分の円の面積の式は、細かく刻んだ和と合い、範囲の外は半径で切り詰める', () => {
    for (const [u1, u2] of [[-12.5, 12.5], [-6.25, 16.25], [-30, 30], [5, 4]] as const) {
      // 刻んだ和は円の端(√ の傾きが無限)で 1e-3 ほどずれるので、小数 2 桁で比べる。
      expect(upperHalfDiskArea(25, u1, u2), `${u1}〜${u2}`).toBeCloseTo(sliced(25, u1, u2), 2);
    }
    expect(upperHalfDiskArea(25, -25, 25)).toBeCloseTo(Math.PI * 25 * 25 / 2, 9);
  });

  it('取付けの板とねじの両方で形が作れ、体積は 車輪 + フォークの箱 − 重なり + 板 − 穴(またはねじの円柱)', () => {
    expect(buildCasterPart(PLATE)).not.toBeNull();
    expect(buildCasterPart(STEM)).not.toBeNull();
    const plateOverlap = sliced(25, -12.5, 10 + 12.5) * 20;
    const plateExpected = Math.PI * 25 * 25 * 20 + (10 + 25) * 20 * (75 - 3 - 25) - plateOverlap + (60 * 50 - 4 * Math.PI * 9) * 3;
    expect(casterVolume(PLATE)).toBeCloseTo(plateExpected, 0);
    const stemOverlap = sliced(20, -10, 10) * 18;
    const stemExpected = Math.PI * 20 * 20 * 18 + 20 * 18 * (60 - 20) - stemOverlap + Math.PI * 6 * 6 * 25;
    expect(casterVolume(STEM)).toBeCloseTo(stemExpected, 0);
  });

  it('取付けを作らない行は、車輪とフォークの箱だけ(箱の上の端は全体の高さ)で、体積は 車輪 + フォークの箱 − 重なり', () => {
    // 車輪の円柱・フォークの箱・その和の 3 つ(取付けの形は足さない)。
    expect(buildCasterPart(NONE)?.solids.map((solid) => solid.kind)).toEqual(['primitive', 'primitive', 'boolean']);
    const overlap = sliced(25, -12.5, 21 + 12.5) * 20;
    expect(casterVolume(NONE)).toBeCloseTo(Math.PI * 25 * 25 * 20 + (21 + 25) * 20 * (70 - 25) - overlap, 0);
    expect(casterValid({ ...NONE, wheelDiameter: 70 })).toBe(false);
  });

  it('双輪は 1 輪の幅の車輪 2 つと 2 輪の間の本体の箱(両輪へ t = min(幅/4, 2) 食い込む)で、体積は 2 輪 + 箱 − 2 輪ぶんの食い込みの重なり', () => {
    // 車輪 2・本体の箱・ねじの円柱の 4 つの形と、和 3 つ。
    expect(buildCasterPart(TWIN)?.solids.map((solid) => solid.kind)).toEqual(['primitive', 'primitive', 'boolean', 'primitive', 'boolean',
      'primitive', 'boolean']);
    const t = 2;
    const overlap = sliced(37.5, -18.75, 20 + 18.75) * 2 * t;
    const expected = 2 * Math.PI * 37.5 * 37.5 * 12.5 + (20 + 37.5) * (22 + 2 * t) * (84.5 - 37.5) - overlap + Math.PI * 6 * 6 * 14;
    expect(casterVolume(TWIN)).toBeCloseTo(expected, 0);
    expect(casterValid({ ...TWIN, twinGap: 0 })).toBe(false);
  });

  it('板の穴は、車輪の上の端が穴を引く円柱の下の端(板の下 1)に届く時だけ、車輪の真上を断る', () => {
    const plate = (holes: readonly (readonly [number, number, number])[]): CasterDimensions['mount'] =>
      ({ kind: 'plate', width: 60, depth: 60, thickness: 3, holes });
    // 偏り 0・径 50 の車輪は x −25〜25、右の車輪は y 11〜23.5。穴 (−20, 15) はその真上、(−20, 27) は外れる。本体の箱は y ±13・x ±12.5。
    const over = { ...TWIN, wheelDiameter: 50, offset: 0, height: 80, mount: plate([[-20, 15, 4]]) };
    expect(casterValid(over)).toBe(true);
    expect(casterValid({ ...over, height: 53.5 })).toBe(false);
    expect(casterValid({ ...over, height: 53.5, mount: plate([[-20, 27, 4]]) })).toBe(true);
  });

  it('成り立たない寸法は形を作らない(車輪が取付けの面に届く・偏りが負・穴がフォークに掛かる・穴が板からはみ出す・ねじの呼びが表に無い)', () => {
    expect(casterValid({ ...PLATE, wheelDiameter: 72 })).toBe(false);
    expect(casterValid({ ...PLATE, offset: -1 })).toBe(false);
    expect(casterValid({ ...PLATE, mount: { kind: 'plate', width: 60, depth: 50, thickness: 3, holes: [[0, 0, 6]] } })).toBe(false);
    expect(casterValid({ ...PLATE, mount: { kind: 'plate', width: 60, depth: 50, thickness: 3, holes: [[28, 19, 6]] } })).toBe(false);
    expect(casterValid({ ...STEM, mount: { kind: 'stem', thread: 'M99', length: 25 } })).toBe(false);
    expect(buildCasterPart({ ...PLATE, wheelDiameter: 72 })).toBeNull();
    expect(casterVolume({ ...STEM, offset: -1 })).toBeNull();
  });
});
