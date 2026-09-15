import { describe, expect, it, vi } from 'vitest';
import { attachCameraControls } from '../viewport/attachCameraControls.js';
import { attachRadialMenuGesture, type RadialMenuAttachmentOptions } from './attachRadialMenuGesture.js';
import type { RadialMenuGesture } from './radialMenuGesture.js';

function fixture(clickSlot?: RadialMenuAttachmentOptions['clickSlot'], nativeClickTarget?: RadialMenuAttachmentOptions['nativeClickTarget']) {
  const view = new EventTarget(), captured = new Set<number>();
  let owner: object = {}, blocked = false;
  const show = vi.fn<(gesture: RadialMenuGesture | null) => void>(), choose = vi.fn();
  const surface = Object.assign(new EventTarget(), {
    ownerDocument: { defaultView: view }, clientHeight: 600,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    setPointerCapture: (id: number) => { captured.add(id); },
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => { captured.delete(id); }, focus: vi.fn(),
  }) as unknown as HTMLCanvasElement;
  const menu = attachRadialMenuGesture(surface, { owner: () => owner, blocked: () => blocked, show, choose,
    ...(clickSlot === undefined ? {} : { clickSlot }),
    ...(nativeClickTarget === undefined ? {} : { nativeClickTarget }) });
  const camera = attachCameraControls(surface, () => {});
  const send = (type: string, values: object = {}): Event => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      pointerId: 1, pointerType: 'mouse', button: 2, buttons: 2, clientX: 400, clientY: 300,
      altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...values,
    });
    view.dispatchEvent(event);
    if (!event.defaultPrevented) surface.dispatchEvent(event);
    return event;
  };
  return { view, surface, show, choose, menu, camera, send, captured,
    block: () => { blocked = true; }, changeDocument: () => { owner = {}; },
    close: () => { menu.detach(); camera.detach(); } };
}

describe('右ボタンで道具を選ぶ間の入力所有権', () => {
  it.each(['choose', 'cancel', 'owner', 'buttons'] as const)('開いたボタンの通常クリックを捕捉せず、%sを一度だけ処理する', action => {
    const f = fixture(() => 0, () => true);
    try {
      f.send('pointerdown'); f.send('pointerup', { buttons: 0 });
      expect(f.send('pointerdown', { button: 0, buttons: 1 }).defaultPrevented).toBe(false);
      expect(f.captured.size).toBe(0);
      expect(f.send('pointermove', { button: 0, buttons: 1 }).defaultPrevented).toBe(false);
      if (action === 'owner') f.changeDocument();
      expect(f.send('pointerup', { button: 0, buttons: action === 'buttons' ? 2 : 0 }).defaultPrevented).toBe(false);
      expect(f.choose).not.toHaveBeenCalled();
      if (action === 'cancel') f.menu.cancel(); else f.menu.choose(0);
      f.menu.choose(0);
      expect(f.choose.mock.calls).toEqual(action === 'choose' ? [[0]] : []);
      expect(f.captured.size).toBe(0);
      expect(f.show).toHaveBeenLastCalledWith(null);
    } finally { f.close(); }
  });
  it.each([true, false])('開いたボタンの端も選べるが、押した場所から外へ離したときは実行しない: $0', inside => {
    let hit: 0 | null = 0;
    const f = fixture(() => hit);
    try {
      f.send('pointerdown'); f.send('pointerup', { buttons: 0 });
      f.send('pointerdown', { button: 0, buttons: 1, clientX: 437, clientY: 212 });
      hit = inside ? 0 : null;
      f.send('pointerup', { button: 0, buttons: 0, clientX: 437, clientY: 212 });
      expect(f.choose.mock.calls).toEqual(inside ? [[0]] : []);
      expect(f.captured.size).toBe(0);
    } finally { f.close(); }
  });
  it('短い右クリックでは一覧を残し、次の左クリックで選んだ道具だけを一度実行する', () => {
    const f = fixture();
    try {
      f.send('pointerdown'); f.send('pointerup', { buttons: 0 });
      f.send('lostpointercapture');
      expect(f.captured.size).toBe(0); expect(f.choose).not.toHaveBeenCalled();
      expect(f.show).not.toHaveBeenLastCalledWith(null);
      f.send('pointermove', { buttons: 0, clientY: 200 });
      f.send('pointerdown', { button: 0, buttons: 1, clientY: 200 });
      f.send('pointerup', { button: 0, buttons: 0, clientY: 200 });
      expect(f.choose.mock.calls).toEqual([[0]]); expect(f.captured.size).toBe(0);
    } finally { f.close(); }
  });
  it('最後に触れた道具ではなく、実際に離した方向を一度だけ実行し視点は動かさない', () => {
    const f = fixture(), before = f.camera.getOrbit();
    try {
      f.send('pointerdown');
      f.send('pointermove', { clientX: 480, clientY: 300 });
      f.send('pointerup', { clientX: 400, clientY: 200, buttons: 0 });
      f.send('pointerup', { clientX: 480, clientY: 300, buttons: 0 });
      expect(f.choose.mock.calls).toEqual([[0]]);
      expect(f.camera.getOrbit()).toEqual(before);
      expect(f.captured.size).toBe(0);
      expect(f.show).toHaveBeenLastCalledWith(null);
    } finally { f.close(); }
  });
  it.each(['centre', 'outside', 'boundary', 'cancel', 'capture', 'escape', 'blur', 'resize', 'blocked', 'document', 'extra-button'])(
    '%sで道具も文書も変更せず捕捉を返す', reason => {
      const f = fixture();
      try {
        f.send('pointerdown'); f.send('pointermove', { clientX: 480 });
        if (reason === 'cancel') f.send('pointercancel');
        if (reason === 'capture') f.send('lostpointercapture');
        if (reason === 'escape') f.send('keydown', { key: 'Escape' });
        if (reason === 'blur' || reason === 'resize') f.send(reason);
        if (reason === 'blocked') f.block();
        if (reason === 'document') f.changeDocument();
        if (reason === 'extra-button') f.send('pointermove', { buttons: 3 });
        const point = reason === 'outside' ? { clientX: 700, clientY: 300 }
          : reason === 'boundary' ? { clientX: 400 + Math.sin(Math.PI / 8) * 100, clientY: 300 - Math.cos(Math.PI / 8) * 100 }
            : reason === 'centre' ? { clientX: 400, clientY: 300 } : { clientX: 480, clientY: 300 };
        f.send('pointerup', { ...point, buttons: 0 });
        expect(f.choose).not.toHaveBeenCalled(); expect(f.captured.size).toBe(0);
      } finally { f.close(); }
    },
  );
  it.each([
    { button: 1, buttons: 4, altKey: false, shiftKey: false },
    { button: 1, buttons: 4, altKey: false, shiftKey: true },
    { button: 0, buttons: 1, altKey: true, shiftKey: false },
    { button: 0, buttons: 1, altKey: true, shiftKey: true },
  ])('既存の視点操作$button/$altKey/$shiftKeyを奪わない', mode => {
    const f = fixture(), before = f.camera.getOrbit();
    try {
      f.send('pointerdown', mode);
      f.send('pointermove', { ...mode, clientX: 440, clientY: 340 });
      f.send('pointerup', { ...mode, buttons: 0 });
      expect(f.camera.getOrbit()).not.toEqual(before);
      expect(f.show).not.toHaveBeenCalled(); expect(f.choose).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
  it('別のポインターの離し方では確定せず、解除後は監視を残さない', () => {
    const f = fixture();
    try {
      f.send('pointerdown');
      f.send('pointerup', { pointerId: 2, clientY: 200, buttons: 0 });
      expect(f.choose).not.toHaveBeenCalled(); expect(f.captured.has(1)).toBe(true);
      f.menu.detach(); f.show.mockClear();
      expect(f.captured.size).toBe(0);
      expect(f.send('pointerdown').defaultPrevented).toBe(false);
      expect(f.send('pointerup', { clientY: 200, buttons: 0 }).defaultPrevented).toBe(false);
      expect(f.send('contextmenu').defaultPrevented).toBe(false);
      expect(f.choose).not.toHaveBeenCalled(); expect(f.show).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
});
