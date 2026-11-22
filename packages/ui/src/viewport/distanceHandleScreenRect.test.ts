import { describe, expect, it } from 'vitest';
import { distanceHandleScreenRect } from './distanceHandleScreenRect.js';
import { HANDLE_PICK_RADIUS_PIXELS } from './sectionHandleDrag.js';

describe('距離のつまみの画面の外形(入力の窓が覆わないための避ける箱)', () => {
  it('根もとと先端を囲み、掴める半径だけ広げる。どちらかが写せなければ null', () => {
    const project = (point: readonly [number, number, number]): readonly [number, number] => [point[0] * 10, 500 - point[2] * 10];
    const r = HANDLE_PICK_RADIUS_PIXELS;
    expect(distanceHandleScreenRect({ base: [20, 15, 0], origin: [20, 15, 10] }, project))
      .toEqual({ left: 200 - r, top: 400 - r, right: 200 + r, bottom: 500 + r });
    // 向きを反転して下へ伸びたつまみも、同じ式で囲む。
    expect(distanceHandleScreenRect({ base: [30, 0, 0], origin: [10, 0, -5] }, project))
      .toEqual({ left: 100 - r, top: 500 - r, right: 300 + r, bottom: 550 + r });
    expect(distanceHandleScreenRect({ base: [0, 0, 0], origin: [0, 0, 1] }, point => point[2] > 0 ? null : [0, 0])).toBeNull();
  });
});
