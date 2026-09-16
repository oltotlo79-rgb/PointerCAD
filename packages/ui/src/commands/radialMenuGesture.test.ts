import { describe, expect, it } from 'vitest';
import { beginRadialMenuGesture, finishRadialMenuGesture, moveRadialMenuGesture } from './radialMenuGesture.js';

const geometry = { center: { x: 200, y: 200 }, cancelRadius: 28, outerRadius: 116 };
describe('8方向メニューの確定と中断', () => {
  it('中央から右へ動かして離した時だけ右の操作を選ぶ', () => {
    const initial = beginRadialMenuGesture({ x: 200, y: 200 }, 7, geometry);
    expect(initial.selected).toBeNull();
    const moved = moveRadialMenuGesture(initial, 7, { x: 270, y: 200 });
    expect(moved.selected).toBe(2);
    expect(finishRadialMenuGesture(moved, 7, { x: 270, y: 200 }, false)).toBe(2);
  });
  it('取消、別の指、最後の中央への移動では直前の選択を実行しない', () => {
    const initial = beginRadialMenuGesture({ x: 200, y: 200 }, 7, geometry);
    const moved = moveRadialMenuGesture(initial, 7, { x: 270, y: 200 });
    expect(moveRadialMenuGesture(moved, 8, { x: 130, y: 200 })).toBe(moved);
    expect(finishRadialMenuGesture(moved, 7, { x: 270, y: 200 }, true)).toBeNull();
    expect(finishRadialMenuGesture(moved, 8, { x: 270, y: 200 }, false)).toBeNull();
    expect(finishRadialMenuGesture(moved, 7, { x: 200, y: 200 }, false)).toBeNull();
    expect(finishRadialMenuGesture(moved, 7, { x: 400, y: 200 }, false)).toBeNull();
  });
  it('画面端でメニュー中心を動かしても、押した場所から勝手に道具を選ばない', () => {
    const initial = beginRadialMenuGesture({ x: 130, y: 200 }, 7, geometry);
    expect(initial.armed).toBe(false);
    const outside = moveRadialMenuGesture(initial, 7, { x: 130, y: 210 });
    expect(outside.selected).toBeNull();
    expect(finishRadialMenuGesture(outside, 7, { x: 130, y: 210 }, false)).toBeNull();
    const centered = moveRadialMenuGesture(outside, 7, { x: 200, y: 200 });
    expect(centered.armed).toBe(true);
    const selected = moveRadialMenuGesture(centered, 7, { x: 200, y: 130 });
    expect(finishRadialMenuGesture(selected, 7, { x: 200, y: 130 }, false)).toBe(0);
  });
});
