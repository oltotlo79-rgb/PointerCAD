import { describe, expect, it, vi } from 'vitest';
import { attachPointerCommands } from './attachPointerCommands.js';
import type { MouseButtonCommands } from './pointerCommandGesture.js';

/* 設計 2-4・B-08e: 割り当てた入力だけ命令を行い、割り当てた戻る・進むだけページの移動を止める。 */
function fixture(commands: MouseButtonCommands) {
  const target = new EventTarget(), run = vi.fn();
  const detach = attachPointerCommands(target, () => commands, run);
  const send = (type: string, button: number, timeStamp = 0, clientX = 10): Event => {
    const event = Object.assign(new Event(type, { cancelable: true }), { button, clientX, clientY: 10 });
    Object.defineProperty(event, 'timeStamp', { value: timeStamp });
    target.dispatchEvent(event);
    return event;
  };
  return { target, run, detach, send };
}

describe('マウスのボタンの命令の受け手', () => {
  it('戻る・進むは割り当てた命令を 1 回行い、押下・離し・mouseup・auxclick の既定の動き(ページの移動)を止める', () => {
    const app = fixture({ back: 'history.undo', forward: 'history.redo' });
    expect(app.send('pointerdown', 3).defaultPrevented).toBe(true);
    expect(app.send('pointerup', 3).defaultPrevented).toBe(true);
    expect(app.send('mouseup', 3).defaultPrevented).toBe(true);
    expect(app.send('auxclick', 3).defaultPrevented).toBe(true);
    app.send('pointerdown', 4); app.send('pointerup', 4);
    expect(app.run.mock.calls).toEqual([['history.undo'], ['history.redo']]);
    app.detach();
  });

  it('割り当てていない入力は命令を行わず、ページの移動も止めない', () => {
    const app = fixture({ middleDouble: 'toolbar.view.fitAll' });
    expect(app.send('pointerdown', 3).defaultPrevented).toBe(false);
    expect(app.send('pointerup', 3).defaultPrevented).toBe(false);
    expect(app.send('auxclick', 4).defaultPrevented).toBe(false);
    app.send('pointerdown', 1, 0); app.send('pointerup', 1, 50);
    expect(app.run).not.toHaveBeenCalled();
    app.send('pointerdown', 1, 100);
    expect(app.send('pointerup', 1, 150).defaultPrevented).toBe(true);
    expect(app.run.mock.calls).toEqual([['toolbar.view.fitAll']]);
    app.detach();
    app.send('pointerdown', 3); app.send('pointerup', 3);
    expect(app.run).toHaveBeenCalledOnce();
  });

  it('捕捉の段で結ぶ(視点の操作・組立の入力が中ボタンの押下を stopImmediatePropagation で自分の物にする前に見る)', () => {
    const target = new EventTarget();
    const add = vi.spyOn(target, 'addEventListener'), remove = vi.spyOn(target, 'removeEventListener');
    const detach = attachPointerCommands(target, () => ({}), vi.fn());
    expect(add.mock.calls.map(([type, , options]) => [type, options])).toEqual(
      ['pointerdown', 'pointerup', 'mouseup', 'auxclick'].map(type => [type, { capture: true }]));
    detach();
    expect(remove.mock.calls.map(([type, , options]) => [type, options])).toEqual(
      ['pointerdown', 'pointerup', 'mouseup', 'auxclick'].map(type => [type, true]));
  });
});
