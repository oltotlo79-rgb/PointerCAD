import { describe, expect, it, vi } from 'vitest';
import { attachCameraControls } from '../viewport/attachCameraControls.js';
import { attachDrawingNavigation, INITIAL_DRAWING_NAVIGATION } from '../drawing/drawingNavigation.js';
import { DEFAULT_VIEW_CONTROLS, type ViewControlSettings } from '../settings/viewControlSettings.js';
import { attachRadialMenuGesture } from './attachRadialMenuGesture.js';
import type { RadialMenuGesture } from './radialMenuGesture.js';

type RadialMenuAttachmentOptions = Parameters<typeof attachRadialMenuGesture>[1];

function fixture(clickSlot?: RadialMenuAttachmentOptions['clickSlot'], nativeClickTarget?: RadialMenuAttachmentOptions['nativeClickTarget'],
  clickOnly = false, cameraFirst = false, selectionModifiers = false, cameraSettings = DEFAULT_VIEW_CONTROLS) {
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
  const earlyCamera = cameraFirst ? attachCameraControls(surface, () => {}, undefined, undefined, () => cameraSettings) : null;
  const menu = attachRadialMenuGesture(surface, { owner: () => owner, blocked: () => blocked, show, choose, clickOnly,
    allowSelectionModifiers: () => selectionModifiers,
    ...(clickSlot === undefined ? {} : { clickSlot }),
    ...(nativeClickTarget === undefined ? {} : { nativeClickTarget }) });
  const camera = earlyCamera ?? attachCameraControls(surface, () => {}, undefined, undefined, () => cameraSettings);
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

// Node has no DOM tree. Keep the actual navigation and gesture listeners, and dispatch
// capture in window -> parent -> SVG order, respecting stopImmediatePropagation.
function drawingFixture() {
  const view = new EventTarget(), captured = new Set<number>();
  const show = vi.fn(), choose = vi.fn(), focus = vi.fn(), changes = vi.fn();
  const surfaceCapture = vi.fn();
  let owner: object = {}, blocked = false, transform = INITIAL_DRAWING_NAVIGATION;
  class Surface extends EventTarget {
    readonly ownerDocument = { defaultView: view };
    readonly isConnected = true;
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
    setPointerCapture = surfaceCapture;
    hasPointerCapture(): boolean { return false; }
    releasePointerCapture = vi.fn();
    focus = vi.fn();
  }
  vi.stubGlobal('SVGElement', Surface);
  const surface = new Surface();
  if (!(surface instanceof SVGElement)) throw new Error('drawing surface fixture');
  const parent = Object.assign(new EventTarget(), {
    setPointerCapture: (id: number) => { captured.add(id); },
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => {
      captured.delete(id);
      send('lostpointercapture', { pointerId: id, buttons: 0 }, 'parent');
    },
  });
  // Register navigation first: registration order on the parent cannot rescue a child listener.
  const navigation = attachDrawingNavigation(parent, { view, focus,
    readSettings: () => DEFAULT_VIEW_CONTROLS, canStart: () => true,
    sheetBounds: () => ({ left: 0, top: 0 }), getTransform: () => transform,
    setTransform: next => { transform = next; changes(next); },
  });
  const menu = attachRadialMenuGesture(surface, { owner: () => owner, blocked: () => blocked,
    show, choose, clickOnly: true, observeDrawingDown: true });
  const afterNavigation = vi.fn();
  parent.addEventListener('pointerdown', afterNavigation, true);
  parent.addEventListener('pointerup', afterNavigation, true);
  const childDown = vi.fn(); surface.addEventListener('pointerdown', childDown, true);
  class CaptureEvent extends Event {
    stopped = false;
    constructor(type: string, private readonly path: readonly EventTarget[]) {
      super(type, { cancelable: true });
    }
    override composedPath(): EventTarget[] { return [...this.path]; }
    override stopImmediatePropagation(): void { this.stopped = true; super.stopImmediatePropagation(); }
  }
  function send(type: string, props: { pointerId?: number; buttons?: number; button?: number; clientX?: number; clientY?: number } = {},
    target: 'surface' | 'parent' | 'outside' = 'surface'): CaptureEvent {
    const pointerId = props.pointerId ?? 1;
    const recipient = target === 'outside' ? view : target === 'parent' || (type !== 'pointerdown' && captured.has(pointerId))
      ? parent : surface;
    const path = recipient === surface ? [surface, parent, view] : recipient === parent ? [parent, view] : [view];
    const event = Object.assign(new CaptureEvent(type, path), {
      pointerId, pointerType: 'mouse', button: 2, buttons: 2, clientX: 400, clientY: 300,
      altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...props,
    });
    view.dispatchEvent(event);
    if (!event.stopped && recipient !== view) parent.dispatchEvent(event);
    if (!event.stopped && recipient === surface) surface.dispatchEvent(event);
    return event;
  }
  return { view, surface, surfaceCapture, parent, navigation, menu, show, choose, focus, changes, captured, afterNavigation, childDown, send,
    get: () => transform, block: () => { blocked = true; }, changeDocument: () => { owner = {}; },
    close: () => { menu.detach(); navigation.detach(); vi.unstubAllGlobals(); } };
}

describe('drawing ancestor capture and radial click observation', () => {
  it('observes down and captured up before navigation consumes them, and opens exactly once', () => {
    const f = drawingFixture();
    try {
      expect(f.send('pointerdown').defaultPrevented).toBe(true);
      expect(f.captured.has(1)).toBe(true); expect(f.navigation.isDragging()).toBe(true);
      expect(f.focus).toHaveBeenCalledOnce(); expect(f.childDown).not.toHaveBeenCalled();
      expect(f.afterNavigation).not.toHaveBeenCalled(); expect(f.show).not.toHaveBeenCalled();
      expect(f.surfaceCapture).not.toHaveBeenCalled();
      expect(f.send('pointerup', { buttons: 0 }).defaultPrevented).toBe(true);
      expect(f.show).toHaveBeenCalledOnce(); expect(f.show).toHaveBeenLastCalledWith(expect.objectContaining({ pointerId: 1 }), true);
      expect(f.captured.size).toBe(0); expect(f.navigation.isDragging()).toBe(false);
      expect(f.afterNavigation).not.toHaveBeenCalled(); expect(f.get()).toEqual(INITIAL_DRAWING_NAVIGATION);
      f.send('pointerup', { buttons: 0 });
      expect(f.show).toHaveBeenCalledOnce(); expect(f.choose).not.toHaveBeenCalled();
      f.menu.choose(0); f.menu.choose(0);
      expect(f.choose.mock.calls).toEqual([[0]]);
    } finally { f.close(); }
  });
  it('keeps right-drag pan and release, without opening or selecting a menu', () => {
    const f = drawingFixture();
    try {
      f.send('pointerdown'); f.send('pointermove', { clientX: 437, clientY: 324 });
      expect(f.get()).toEqual({ x: 37, y: 24, scale: 1 });
      f.send('pointerup', { clientX: 437, clientY: 324, buttons: 0 });
      expect(f.captured.size).toBe(0); expect(f.navigation.isDragging()).toBe(false);
      expect(f.changes).toHaveBeenCalledOnce(); expect(f.show).not.toHaveBeenCalled(); expect(f.choose).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
  it.each(['cancel', 'owner', 'blocked', 'blur', 'detach'] as const)('cancels a pending drawing click on %s', reason => {
    const f = drawingFixture();
    try {
      f.send('pointerdown');
      if (reason === 'cancel') f.send('pointercancel', { buttons: 0 });
      if (reason === 'owner') f.changeDocument();
      if (reason === 'blocked') f.block();
      if (reason === 'blur') f.view.dispatchEvent(new Event('blur'));
      if (reason === 'detach') f.menu.detach();
      f.send('pointerup', { buttons: 0 });
      expect(f.show).not.toHaveBeenCalled(); expect(f.choose).not.toHaveBeenCalled(); expect(f.captured.size).toBe(0);
      if (reason === 'detach') {
        f.send('pointerdown'); f.send('pointerup', { buttons: 0 });
        expect(f.show).not.toHaveBeenCalled(); expect(f.choose).not.toHaveBeenCalled();
      }
    } finally { f.close(); }
  });
  it('ignores outside starts and does not finish the pending click with another pointer', () => {
    const f = drawingFixture();
    try {
      f.send('pointerdown', {}, 'outside'); f.send('pointerup', { buttons: 0 }, 'outside');
      expect(f.show).not.toHaveBeenCalled();
      f.send('pointerdown'); f.send('pointerup', { pointerId: 2, buttons: 0 });
      expect(f.show).not.toHaveBeenCalled(); expect(f.captured.has(1)).toBe(true);
      f.send('pointerup', { buttons: 0 }); expect(f.show).toHaveBeenCalledOnce();
    } finally { f.close(); }
  });
});

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
    const settings: ViewControlSettings = mode.altKey && mode.shiftKey ? {
      ...DEFAULT_VIEW_CONTROLS, bindings: { ...DEFAULT_VIEW_CONTROLS.bindings,
        pan: [{ kind: 'drag', button: 'left', alt: true, shift: true, ctrl: false, meta: false }, DEFAULT_VIEW_CONTROLS.bindings.pan[0]] },
    } : DEFAULT_VIEW_CONTROLS;
    const f = fixture(undefined, undefined, false, false, false, settings), before = f.camera.getOrbit();
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
      f.menu.detach(); f.camera.detach(); f.show.mockClear();
      expect(f.captured.size).toBe(0);
      expect(f.send('pointerdown').defaultPrevented).toBe(false);
      expect(f.send('pointerup', { clientY: 200, buttons: 0 }).defaultPrevented).toBe(false);
      expect(f.send('contextmenu').defaultPrevented).toBe(false);
      expect(f.choose).not.toHaveBeenCalled(); expect(f.show).not.toHaveBeenCalled();
    } finally { f.close(); }
  });
});

describe('3Dの右クリックと右ドラッグの振り分け', () => {
  it.each(['shiftKey', 'ctrlKey'])('%sを保持した2点選択の右クリックだけを開き、長い移動は実行しない', modifier => {
    const f = fixture(undefined, undefined, true, true, true), before = f.camera.getOrbit();
    try {
      f.send('pointerdown', { [modifier]: true });
      f.send('pointerup', { [modifier]: true, buttons: 0 });
      expect(f.show).toHaveBeenCalledTimes(1);
      expect(f.show.mock.lastCall?.[0]).not.toBeNull();
      expect(f.send('contextmenu', { [modifier]: true }).defaultPrevented).toBe(true);
      f.menu.choose(1); expect(f.choose.mock.calls).toEqual([[1]]);
      f.show.mockClear(); f.choose.mockClear();
      f.send('pointerdown', { [modifier]: true });
      f.send('pointermove', { [modifier]: true, clientX: 430 });
      f.send('pointerup', { [modifier]: true, buttons: 0 });
      expect(f.show).not.toHaveBeenCalled(); expect(f.choose).not.toHaveBeenCalled();
      expect(f.camera.getOrbit()).toEqual(before); expect(f.captured.size).toBe(0);
    } finally { f.close(); }
  });
  it.each(['ContextMenu', 'F10'])('%sで開いた後も文書切替とEscで古い操作を捨てる', key => {
    const f = fixture(undefined, undefined, true);
    try {
      const event = Object.assign(new Event('keydown', { cancelable: true }),
        { key, shiftKey: key === 'F10', ctrlKey: false, altKey: false, metaKey: false, isComposing: false, repeat: false });
      Object.defineProperty(event, 'target', { value: f.surface });
      f.view.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true); expect(f.show).toHaveBeenCalledTimes(1);
      f.changeDocument(); f.menu.choose(1); expect(f.choose).not.toHaveBeenCalled();
      f.view.dispatchEvent(event); f.send('keydown', { key: 'Escape' }); f.menu.choose(1);
      expect(f.choose).not.toHaveBeenCalled(); expect(f.show).toHaveBeenLastCalledWith(null);
    } finally { f.close(); }
  });
  it('日本語説明の実サイズを含めて表示と選択領域を同時に画面内へ移す', () => {
    const f = fixture(undefined, undefined, true);
    try {
      f.send('pointerdown', { clientX: 795, clientY: 595 });
      f.send('pointerup', { clientX: 795, clientY: 595, buttons: 0 });
      const original = f.show.mock.lastCall?.[0];
      if (original == null) throw new Error('menu');
      const { center, outerRadius: radius } = original.geometry;
      f.menu.fit({ left: center.x - radius, top: center.y - radius, width: radius * 2, height: radius * 2 + 140 });
      const fitted = f.show.mock.lastCall?.[0];
      if (fitted == null) throw new Error('menu');
      expect(f.show).toHaveBeenLastCalledWith(fitted, true, true);
      expect(fitted.geometry.center.y + radius + 140).toBeLessThanOrEqual(600);
      expect(fitted.geometry.center.x).toBe(center.x);
      f.menu.choose(1); expect(f.choose.mock.calls).toEqual([[1]]);
    } finally { f.close(); }
  });
  it.each([false, true])('カメラの先行登録=%sでも、6px以下では離した時だけ一覧を開く', cameraFirst => {
    const f = fixture(undefined, undefined, true, cameraFirst), before = f.camera.getOrbit();
    try {
      f.send('pointerdown');
      expect(f.camera.isDragging()).toBe(true);
      expect(f.captured.has(1)).toBe(true);
      expect(f.show).not.toHaveBeenCalled();
      f.send('pointermove', { clientX: 406 });
      expect(f.camera.getOrbit()).toBe(before);
      expect(f.show).not.toHaveBeenCalled();
      f.send('pointerup', { clientX: 406, buttons: 0 });
      f.send('lostpointercapture');
      expect(f.show.mock.lastCall?.[0]).not.toBeNull();
      expect(f.show).toHaveBeenCalledTimes(1);
      expect(f.camera.getOrbit()).toBe(before);
      expect(f.camera.isDragging()).toBe(false);
      expect(f.captured.size).toBe(0);
      f.send('pointerdown', { button: 0, buttons: 1, clientY: 200 });
      f.send('pointerup', { button: 0, buttons: 0, clientY: 200 });
      expect(f.choose.mock.calls).toEqual([[0]]);
      expect(f.camera.getOrbit()).toBe(before);
    } finally { f.close(); }
  });

  it.each([false, true])('6pxを超えて戻ってもメニューを開かず平行移動を続ける（先行登録=%s）', cameraFirst => {
    const f = fixture(undefined, undefined, true, cameraFirst), before = f.camera.getOrbit();
    try {
      f.send('pointerdown');
      f.send('pointermove', { clientX: 406.001 });
      expect(f.camera.getOrbit().target).not.toEqual(before.target);
      f.send('pointermove');
      expect(f.camera.isDragging()).toBe(true);
      f.send('pointermove', { clientX: 460, clientY: 325 });
      f.send('pointerup', { clientX: 460, clientY: 325, buttons: 0 });
      expect(f.camera.getOrbit().target).not.toEqual(before.target);
      expect(f.camera.getOrbit().azimuth).toBe(before.azimuth);
      expect(f.camera.getOrbit().elevation).toBe(before.elevation);
      expect(f.camera.isDragging()).toBe(false);
      expect(f.captured.size).toBe(0);
      expect(f.show).not.toHaveBeenCalled(); expect(f.choose).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('moveが届かなくても実際の解放位置が6pxを超えれば平行移動する', () => {
    const f = fixture(undefined, undefined, true), before = f.camera.getOrbit();
    try {
      f.send('pointerdown'); f.send('pointerup', { clientY: 307, buttons: 0 });
      expect(f.camera.getOrbit().target).not.toEqual(before.target);
      expect(f.show).not.toHaveBeenCalled(); expect(f.choose).not.toHaveBeenCalled();
      expect(f.captured.size).toBe(0);
    } finally { f.close(); }
  });

  it.each(['pointercancel', 'lostpointercapture', 'blur', 'resize', 'escape', 'document', 'blocked', 'extra-button', 'detach'])(
    '%sで保留したクリックを開かない', reason => {
      const f = fixture(undefined, undefined, true);
      try {
        f.send('pointerdown');
        if (reason === 'escape') f.send('keydown', { key: 'Escape' });
        else if (reason === 'document') f.changeDocument();
        else if (reason === 'blocked') f.block();
        else if (reason === 'extra-button') f.send('pointermove', { buttons: 3 });
        else if (reason === 'detach') f.menu.detach();
        else f.send(reason);
        f.send('pointerup', { buttons: 0 });
        expect(f.show).not.toHaveBeenCalled(); expect(f.choose).not.toHaveBeenCalled();
        expect(f.camera.isDragging()).toBe(false); expect(f.captured.size).toBe(0);
      } finally { f.close(); }
    },
  );

  it('別ポインターでは保留中のクリックもカメラも終了しない', () => {
    const f = fixture(undefined, undefined, true);
    try {
      f.send('pointerdown');
      f.send('pointermove', { pointerId: 2, clientX: 600 });
      f.send('pointerup', { pointerId: 2, buttons: 0 });
      f.send('lostpointercapture', { pointerId: 2 });
      expect(f.camera.isDragging()).toBe(true); expect(f.captured.has(1)).toBe(true);
      expect(f.show).not.toHaveBeenCalled();
      f.send('pointerup', { buttons: 0 });
      expect(f.show).toHaveBeenCalledTimes(1); expect(f.captured.size).toBe(0);
    } finally { f.close(); }
  });
});
