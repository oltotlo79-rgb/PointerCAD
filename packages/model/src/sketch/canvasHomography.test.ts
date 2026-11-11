import { describe, expect, it } from 'vitest';

import {
  projectCanvasHomography,
  solveCanvasHomography,
  type CanvasHomography,
  type CanvasNormalizedPoint,
  type CanvasSourceQuad,
} from './canvasHomography.js';

const PIXELS = { width: 1000, height: 800 };
const OUTPUT_CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;
const INTERNAL_COORDINATES = [0.25, 0.5, 0.75] as const;

/** 既知係数の有理式で期待点を作る。製品のsolve/projectを期待値生成に使わない。 */
function knownPoint(h: CanvasHomography, [s, t]: CanvasNormalizedPoint): CanvasNormalizedPoint {
  const denominator = h[6] * s + h[7] * t + h[8];
  return [
    (h[0] * s + h[1] * t + h[2]) / denominator,
    (h[3] * s + h[4] * t + h[5]) / denominator,
  ];
}

function pixelError(actual: CanvasNormalizedPoint, expected: CanvasNormalizedPoint): number {
  return Math.hypot(
    (actual[0] - expected[0]) * PIXELS.width,
    (actual[1] - expected[1]) * PIXELS.height,
  );
}

const KNOWN_MATRICES = [
  {
    name: '穏やかな上下遠近差',
    matrix: [0.8, 0, 0.1, 0, 0.8, 0.1, 0.05, 0.08, 1],
  },
  {
    name: '上下左右で異なる台形',
    matrix: [1, 0, 0, 0, 1, 0, 0.2, 0.1, 1],
  },
  {
    name: '斜行と遠近差の組合せ',
    matrix: [0.7, 0.1, 0.1, 0.05, 0.65, 0.15, 0.2, -0.1, 1],
  },
] as const satisfies readonly { readonly name: string; readonly matrix: CanvasHomography }[];

describe('下絵の四隅の真の平面射影', () => {
  for (const { name, matrix } of KNOWN_MATRICES) {
    it(`${name}: 四隅<=1px、内部独立格子9点も既知射影に一致する`, () => {
      const sourceQuad: CanvasSourceQuad = [
        knownPoint(matrix, OUTPUT_CORNERS[0]),
        knownPoint(matrix, OUTPUT_CORNERS[1]),
        knownPoint(matrix, OUTPUT_CORNERS[2]),
        knownPoint(matrix, OUTPUT_CORNERS[3]),
      ];
      const before = JSON.stringify(sourceQuad);
      const result = solveCanvasHomography(sourceQuad);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      for (let index = 0; index < 4; index += 1) {
        const output = OUTPUT_CORNERS[index];
        const source = sourceQuad[index];
        if (output === undefined || source === undefined) throw new Error('fixture corner missing');
        const actual = projectCanvasHomography(result.homography, output);
        if (actual === null) throw new Error('valid corner projection failed');
        expect(pixelError(actual, source)).toBeLessThanOrEqual(1);
      }
      for (const s of INTERNAL_COORDINATES) {
        for (const t of INTERNAL_COORDINATES) {
          const actual = projectCanvasHomography(result.homography, [s, t]);
          if (actual === null) throw new Error('valid interior projection failed');
          const expected = knownPoint(matrix, [s, t]);
          expect(pixelError(actual, expected)).toBeLessThanOrEqual(1);
        }
      }
      expect(JSON.stringify(sourceQuad)).toBe(before);
    });
  }

  it.each([
    ['重複', [[0.1, 0.1], [0.1, 0.1], [0.8, 0.8], [0.1, 0.8]], 'duplicate'],
    ['任意3点共線', [[0.1, 0.1], [0.4, 0.1], [0.7, 0.1], [0.1, 0.8]], 'collinear'],
    ['自己交差', [[0.1, 0.1], [0.9, 0.9], [0.9, 0.1], [0.1, 0.9]], 'selfIntersection'],
    ['非有限', [[Number.NaN, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]], 'nonFinite'],
  ] as const)(`%sを文書へ採用しない`, (_name, quad, reason) => {
    const result = solveCanvasHomography(quad);
    expect(result).toEqual({ ok: false, reason });
  });

  it('凹の四角形、原画像範囲外、零分母を拒否する', () => {
    expect(solveCanvasHomography([[0.1, 0.1], [0.9, 0.1], [0.3, 0.3], [0.1, 0.9]]))
      .toEqual({ ok: false, reason: 'selfIntersection' });
    expect(solveCanvasHomography([[0.1, 0.1], [1.1, 0.1], [0.9, 0.9], [0.1, 0.9]]))
      .toEqual({ ok: false, reason: 'outOfImage' });
    expect(projectCanvasHomography([1, 0, 0, 0, 1, 0, -1, 0, 1], [1, 0])).toBeNull();
  });
});
