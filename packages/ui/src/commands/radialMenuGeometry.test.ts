import { describe, expect, it } from 'vitest';
import { placeRadialMenu, radialMenuSlotAt, radialMenuSlotPoint, type RadialMenuSlot } from './radialMenuGeometry.js';

const geometry = { center: { x: 200, y: 200 }, cancelRadius: 28, outerRadius: 116 };
describe('8方向のメニューの位置と取消領域', () => {
  it.each([
    [0, 200, 128], [1, 251, 149], [2, 272, 200], [3, 251, 251],
    [4, 200, 272], [5, 149, 251], [6, 128, 200], [7, 149, 149],
  ])('方向%sは画面上の独立した座標から選べる', (slot, x, y) => {
    expect(radialMenuSlotAt({ x, y }, geometry)).toBe(slot);
  });
  it('表示する8ボタンと選択する方向は同じ中心と半径を使う', () => {
    for (const slot of [0, 1, 2, 3, 4, 5, 6, 7] satisfies RadialMenuSlot[]) {
      const point = radialMenuSlotPoint(slot, geometry);
      expect(radialMenuSlotAt(point, geometry)).toBe(slot);
      expect(Math.hypot(point.x - 200, point.y - 200)).toBeCloseTo(72, 10);
    }
  });
  it('中央、その境界、外側、不正座標では道具を選ばない', () => {
    for (const point of [{ x: 200, y: 200 }, { x: 228, y: 200 }, { x: 317, y: 200 },
      { x: Number.NaN, y: 200 }, { x: 200, y: Number.POSITIVE_INFINITY }]) {
      expect(radialMenuSlotAt(point, geometry)).toBeNull();
    }
  });
  it('隣り合う全8方向の境界と両側1度未満はどちらも実行しない', () => {
    for (let boundary = 22.5; boundary < 360; boundary += 45) {
      for (const delta of [-0.5, 0, 0.5]) {
        const angle = (boundary + delta) * Math.PI / 180;
        expect(radialMenuSlotAt({ x: 200 + 72 * Math.sin(angle), y: 200 - 72 * Math.cos(angle) }, geometry)).toBeNull();
      }
    }
  });
  it.each([[0, 0, 116, 116], [640, 0, 524, 116], [0, 480, 116, 364], [640, 480, 524, 364]])(
    '画面端%s,%sでも全方向を同じ画面内へ配置する', (x, y, centerX, centerY) => {
      expect(placeRadialMenu({ x, y }, { left: 0, top: 0, width: 640, height: 480 })).toEqual({
        ...geometry, center: { x: centerX, y: centerY },
      });
    },
  );
  it('小さすぎる画面、無限の範囲、逆転した半径を断る', () => {
    const point = { x: 50, y: 60 }, bounds = { left: 10, top: 20, width: 640, height: 480 };
    expect(placeRadialMenu(point, { ...bounds, width: 231 })).toBeNull();
    expect(placeRadialMenu(point, { ...bounds, height: Number.POSITIVE_INFINITY })).toBeNull();
    expect(placeRadialMenu(point, bounds, 20, 28)).toBeNull();
    expect(placeRadialMenu(point, bounds, 116, 0)).toBeNull();
    expect(placeRadialMenu(point, bounds, Number.NaN)).toBeNull();
  });
});
