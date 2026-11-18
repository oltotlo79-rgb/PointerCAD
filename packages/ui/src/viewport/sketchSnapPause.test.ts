import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNumericInput } from '../sketch/numericInput.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { createSketchSnapPause } from './sketchSnapPause.js';

/* 設計 B-09 3-2: 吸着を一時止める修飾キーは、点を置く時だけ、選んだキーを押している間だけ効く。既定では効かない。 */
beforeEach(resetTestStore);
afterEach(resetTestStore);

const KEYS_UP = { shiftKey: false, ctrlKey: false, metaKey: false };
const SHIFT = { ...KEYS_UP, shiftKey: true };
const CTRL = { ...KEYS_UP, ctrlKey: true };
/** 点の道具だけを「かき込む道具」とみなす(isDrawingTool の代わり)。 */
const pointOnly = (): ReturnType<typeof createSketchSnapPause> => createSketchSnapPause(tool => tool === 'point');

function choose(modifier: 'none' | 'shift' | 'ctrl'): void {
  const state = useAppStore.getState();
  state.setDisplaySettings({ ...state.displaySettings, snapPauseModifier: modifier });
}

describe('吸着を一時止める修飾キーの控え', () => {
  it('既定(なし)では、どの道具で何を押しても止めない(今までと同じ)', () => {
    const pause = pointOnly();
    useAppStore.getState().setActiveTool('point');
    for (const keys of [KEYS_UP, SHIFT, CTRL, { ...KEYS_UP, metaKey: true }]) {
      expect(pause.update(keys)).toBe(false);
      expect(pause.active()).toBe(false);
    }
  });

  it('点を置く道具で、選んだキーを押している間だけ止め、止まり始めた 1 回だけ知らせる', () => {
    choose('shift');
    const pause = pointOnly();
    useAppStore.getState().setActiveTool('point');
    expect(pause.update(CTRL)).toBe(false);
    expect(pause.active()).toBe(false);
    expect(pause.update(SHIFT)).toBe(true);
    expect(pause.active()).toBe(true);
    expect(pause.update(SHIFT)).toBe(false);
    expect(pause.update(KEYS_UP)).toBe(false);
    expect(pause.active()).toBe(false);
  });

  it('選択の道具・対象を選ぶ段では止めない(Shift・Ctrl は選択に足す・外すのまま)', () => {
    choose('ctrl');
    const pause = pointOnly();
    useAppStore.getState().setActiveTool('select');
    expect(pause.update(CTRL)).toBe(false);
    expect(pause.active()).toBe(false);
    useAppStore.getState().setActiveTool('extrude');
    useAppStore.getState().openNumericInput(createNumericInput('extrude', 'extrudeDistance'), [10, 10]);
    expect(pause.active()).toBe(false);
  });

  it('座標を聞いている段が開いていれば、かき込む道具でなくても止める', () => {
    choose('ctrl');
    const pause = createSketchSnapPause(() => false);
    useAppStore.getState().openNumericInput(createNumericInput('point', 'point'), [10, 10]);
    expect(pause.update({ ...KEYS_UP, metaKey: true })).toBe(true);
    expect(pause.active()).toBe(true);
  });

  it('窓が焦点を失ったら、押していない扱いへ戻す', () => {
    choose('shift');
    const pause = pointOnly();
    useAppStore.getState().setActiveTool('point');
    pause.update(SHIFT);
    pause.release();
    expect(pause.active()).toBe(false);
  });
});
