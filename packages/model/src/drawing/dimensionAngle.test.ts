import { describe, expect, it } from 'vitest';
import type { Vector3 } from '@pointercad/drawing';
import { dimensionAngleDirections } from './dimensionAngle.js';

const origin: Vector3 = [100, -10, 20];
const horizontal = { from: origin, to: [120, -10, 20] as Vector3 };
const angle = (a: typeof horizontal, b: typeof horizontal): number | null => {
  const directions = dimensionAngleDirections(a, b); if (directions === null) return null;
  const cosine = directions.first.reduce((sum, value, index) => sum + value * directions.second[index], 0)
    / (Math.hypot(...directions.first) * Math.hypot(...directions.second));
  return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
};
const reverse = (line: typeof horizontal) => ({ from: line.to, to: line.from });

describe('実線の角を辺の格納向きから独立して測る', () => {
  it.each([[120, 45], [80, 135]])('斜辺の終点X=%sの角度%s°は両辺の反転と選択順で変わらない', (x, expected) => {
    const diagonal = { from: origin, to: [x, 10, 20] as Vector3 };
    for (const a of [horizontal, reverse(horizontal)]) for (const b of [diagonal, reverse(diagonal)]) {
      expect(angle(a, b)).toBeCloseTo(expected, 10); expect(angle(b, a)).toBeCloseTo(expected, 10);
    }
  });
  it('線の延長同士でも交点から各線の内側へ向かう', () => {
    const a = { from: [110, -10, 20] as Vector3, to: horizontal.to };
    const b = { from: [105, -5, 20] as Vector3, to: [120, 10, 20] as Vector3 };
    expect(angle(a, b)).toBeCloseTo(45, 10); expect(angle(reverse(a), reverse(b))).toBeCloseTo(45, 10);
  });
  it('平行・退化・交差しないねじれの2線から紙面の角度を捏造しない', () => {
    expect(dimensionAngleDirections(horizontal, horizontal)).toBeNull();
    expect(dimensionAngleDirections(horizontal, { from: origin, to: origin })).toBeNull();
    expect(dimensionAngleDirections(horizontal, { from: [100, -10, 30], to: [120, 10, 30] })).toBeNull();
  });
});
