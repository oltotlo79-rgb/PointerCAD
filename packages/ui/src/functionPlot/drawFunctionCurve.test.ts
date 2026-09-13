import { describe, expect, it, vi } from 'vitest';
import type { ResolvedSpline, Vec3 } from '@pointercad/model';
import { drawFunctionCurve } from './drawFunctionCurve.js';

const parabola: ResolvedSpline = { kind: 'spline', featureId: 'function', mode: 'control', closed: false,
  points: [[-2, 4, 0], [-2 / 3, -4 / 3, 0], [2 / 3, -4 / 3, 0], [2, 4, 0]] };
const project = ([x, y, z]: Vec3): readonly [number, number] => [50 + 3 * x - y, 30 - 2 * y + z];
const context = () => ({ moveTo: vi.fn<(x: number, y: number) => void>(),
  lineTo: vi.fn<(x: number, y: number) => void>(),
  bezierCurveTo: vi.fn<(...points: [number, number, number, number, number, number]) => void>(), closePath: vi.fn() });

describe('関数曲線のプレビューも原式の形を描く', () => {
  it('投影後の実描画命令は制御多角形でなく放物線上を通り、回転・倍率にも追従する', () => {
    for (const projection of [project, ([x, y, z]: Vec3): readonly [number, number] => [100 - y + z, 10 + 4 * x]]) {
      const canvas = context(); drawFunctionCurve(canvas, parabola, projection);
      expect(canvas.bezierCurveTo).toHaveBeenCalledTimes(1); expect(canvas.lineTo).not.toHaveBeenCalled();
      const points = [...canvas.moveTo.mock.calls[0], ...canvas.bezierCurveTo.mock.calls[0]];
      for (let i = 0; i <= 100; i++) {
        const t = i / 100, s = 1 - t, x = -2 + 4 * t, expected = projection([x, x * x, 0]);
        for (const axis of [0, 1]) {
          const actual = s ** 3 * points[axis] + 3 * s * s * t * points[2 + axis]
            + 3 * s * t * t * points[4 + axis] + t ** 3 * points[6 + axis];
          expect(actual).toBeCloseTo(expected[axis], 11);
        }
      }
    }
  });
  it('4点の折れ線を三次曲線と混同せず、切断で分かれた曲線の隙間を結ばない', () => {
    const canvas = context();
    for (const sign of [-1, 1]) drawFunctionCurve(canvas, { ...parabola, degree: 1,
      points: [[sign, 1, 0], [2 * sign, 0.5, 0], [3 * sign, 1 / 3, 0], [4 * sign, 0.25, 0]] }, project);
    expect(canvas.bezierCurveTo).not.toHaveBeenCalled(); expect(canvas.moveTo).toHaveBeenCalledTimes(2);
    expect(canvas.lineTo).toHaveBeenCalledTimes(6); expect(canvas.closePath).not.toHaveBeenCalled();
  });
  it('閉じた関数の輪郭は最後の区間も閉じる', () => {
    const canvas = context();
    drawFunctionCurve(canvas, { ...parabola, degree: 1, closed: true }, project);
    expect(canvas.bezierCurveTo).not.toHaveBeenCalled(); expect(canvas.closePath).toHaveBeenCalledOnce();
  });
});
