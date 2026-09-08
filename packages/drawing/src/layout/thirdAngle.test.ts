import { describe, expect, it } from 'vitest';

import { THIRD_ANGLE_DIRECTIONS, thirdAngleLayout } from './thirdAngle.js';

describe('第三角法', () => {
  it.each([
    ['front', [0, 1, 0], [1, 0, 0]],
    ['top', [0, 0, -1], [1, 0, 0]],
    ['right', [-1, 0, 0], [0, 1, 0]],
    ['left', [1, 0, 0], [0, -1, 0]],
    ['rear', [0, -1, 0], [-1, 0, 0]],
    ['bottom', [0, 0, 1], [1, 0, 0]],
  ] as const)('%s図の向きがZ-upの表と一致する', (name, normal, xDir) => {
    expect(THIRD_ANGLE_DIRECTIONS[name]).toEqual({ normal, xDir });
  });

  it('すべての視線と横方向が直交する', () => {
    for (const { normal, xDir } of Object.values(THIRD_ANGLE_DIRECTIONS)) {
      expect(normal[0] * xDir[0] + normal[1] * xDir[1] + normal[2] * xDir[2]).toBe(0);
    }
  });

  it('正面を基準に平面を上、右側面を右へ置く', () => {
    expect(thirdAngleLayout({
      extents: [100, 40, 60], scale: 1, gap: 20,
      sheet: { left: 0, bottom: 0, right: 420, top: 297, frontCenter: [150, 120] },
    })).toEqual({ front: [150, 120], top: [150, 190], right: [240, 120] });
  });

  it('縮尺1:2でも紙上のgapは20mmのままである', () => {
    const result = thirdAngleLayout({
      extents: [100, 40, 60], scale: 0.5, gap: 20,
      sheet: { left: 0, bottom: 0, right: 420, top: 297, frontCenter: [150, 120] },
    });
    expect(result.top).toEqual([150, 165]);
  });

  it('右端からはみ出す配置を領域内へ平行移動する', () => {
    const result = thirdAngleLayout({
      extents: [100, 40, 60], scale: 1, gap: 20,
      sheet: { left: 20, bottom: 10, right: 410, top: 287, frontCenter: [380, 120] },
    });
    expect(result.right[0] + 20).toBeLessThanOrEqual(410);
    expect(result.top[0]).toBe(result.front[0]);
    expect(result.right[1]).toBe(result.front[1]);
  });
});
