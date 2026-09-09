import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachCameraControls } from './attachCameraControls.js';
import { attachQuadInput } from './attachQuadInput.js';
import { HOME_ORBIT, pan, type OrbitState } from './cameraMath.js';
import { createQuadCameraState, resetQuadCamera, updateQuadCamera, type QuadCameraState } from './quadCamera.js';

function event(target: EventTarget, type: string, props: Record<string, unknown> = {}): void {
  target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), {
    pointerId: 1, button: 0, buttons: 0, clientX: 120, clientY: 140, shiftKey: false, altKey: false,
    deltaMode: 0, deltaY: 100, ...props,
  }));
}

function setup() {
  const windowTarget = new EventTarget();
  vi.stubGlobal('window', windowTarget);
  vi.stubGlobal('WheelEvent', { DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 });
  const captured = new Set<number>();
  const canvas = Object.assign(new EventTarget(), {
    width: 1200, height: 900, clientWidth: 800, clientHeight: 600,
    getBoundingClientRect: () => ({ left: 20, top: 40, width: 800, height: 600 }),
    setPointerCapture: (id: number) => { captured.add(id); },
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => { captured.delete(id); },
    focus: vi.fn(),
  }) as unknown as HTMLCanvasElement;
  let quad: QuadCameraState | null = null;
  const detachInput = attachQuadInput(canvas, () => quad !== null, (active) => {
    if (quad !== null) quad = { ...quad, active };
  });
  const changed = vi.fn();
  const interaction = vi.fn();
  const controls = attachCameraControls(canvas, changed, interaction, {
    getOrbit: () => quad === null ? null : quad.orbits[quad.active],
    setOrbit: (next) => { if (quad !== null) quad = updateQuadCamera(quad, quad.active, next); },
    goHome: () => { if (quad !== null) quad = resetQuadCamera(quad); },
    viewportHeight: () => 300,
    canOrbit: () => quad?.active === 'isometric',
  });
  return { canvas, controls, changed, interaction, captured, windowTarget,
    getQuad: () => quad!,
    enable: () => { quad = createQuadCameraState(controls.getOrbit()); },
    disable: () => { quad = null; },
    detach: () => { detachInput(); controls.detach(); },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('実際のポインタと4区画のカメラの接続(FR-113)', () => {
  it('起動・Homeキー・ホームボタンで同じ基準カメラを使う', () => {
    const app = setup();
    try {
      expect(app.controls.getOrbit()).toBe(HOME_ORBIT);
      const changed: OrbitState = { ...HOME_ORBIT, azimuth: 0.4, target: [11, 22, 33], distance: 75 };
      app.controls.setOrbit(changed); app.controls.goHome();
      expect(app.controls.getOrbit()).toBe(HOME_ORBIT);
      app.controls.setOrbit(changed); event(app.canvas, 'keydown', { key: 'Home' });
      expect(app.controls.getOrbit()).toBe(HOME_ORBIT);
    } finally { app.detach(); }
  });
  it.each([
    ['top', 120, 140], ['isometric', 620, 140], ['front', 120, 440], ['right', 620, 440],
  ] as const)('拡大率150%%でも%sのホイールだけを更新する', (id, clientX, clientY) => {
    const app = setup(); app.enable();
    const before = app.getQuad();
    event(app.canvas, 'wheel', { clientX, clientY });
    expect(app.getQuad().active).toBe(id);
    expect(app.getQuad().orbits[id].distance).toBeGreaterThan(before.orbits[id].distance);
    for (const pane of ['top', 'isometric', 'front', 'right'] as const) {
      if (pane !== id) expect(app.getQuad().orbits[pane]).toBe(before.orbits[pane]);
    }
    app.detach();
  });

  it('区画境界を越えるドラッグも開始した平面の高さで平行移動する', () => {
    const app = setup(); app.enable();
    const before = app.getQuad();
    event(app.canvas, 'pointerdown', { button: 1, buttons: 4, shiftKey: true });
    event(app.canvas, 'pointermove', { clientX: 620, clientY: 440, buttons: 4 });
    expect(app.getQuad().active).toBe('top');
    expect(app.getQuad().orbits.top.target).toEqual(pan(before.orbits.top, 500, 300, 300).target);
    expect(app.getQuad().orbits.right).toBe(before.orbits.right);
    event(app.canvas, 'pointerup');
    event(app.canvas, 'pointermove', { clientX: 620, clientY: 440 });
    expect(app.getQuad().active).toBe('right');
    expect(app.captured.size).toBe(0); app.detach();
  });

  it('3正投影では中ボタンの回転を始めない', () => {
    const app = setup(); app.enable(); const before = app.getQuad().orbits.top;
    event(app.canvas, 'pointerdown', { button: 1, buttons: 4 });
    event(app.canvas, 'pointermove', { clientX: 200, buttons: 4 });
    expect(app.getQuad().orbits.top).toBe(before);
    expect(app.interaction).not.toHaveBeenCalled(); app.detach();
  });

  it('等角は回転し、Homeは等角だけを戻す', () => {
    const app = setup(); app.enable(); const before = app.getQuad();
    event(app.canvas, 'pointerdown', { button: 1, buttons: 4, clientX: 620 });
    event(app.canvas, 'pointermove', { clientX: 660, buttons: 4 });
    expect(app.getQuad().orbits.isometric.azimuth).not.toBe(before.orbits.isometric.azimuth);
    event(app.canvas, 'pointerup'); event(app.canvas, 'keydown', { key: 'Home' });
    expect(app.getQuad().orbits.isometric).toEqual(before.orbits.isometric);
    expect(app.getQuad().orbits.front).toBe(before.orbits.front); app.detach();
  });

  it('単一画面へ戻すと元の向き・倍率・注視点が残る', () => {
    const app = setup();
    const single: OrbitState = { ...HOME_ORBIT, azimuth: 0.3, distance: 123, target: [10, 20, 30] };
    app.controls.setOrbit(single); app.enable();
    event(app.canvas, 'wheel'); app.controls.goHome(); app.disable();
    expect(app.controls.getOrbit()).toBe(single); app.detach();
  });

  it.each(['pointercancel', 'lostpointercapture'])('%sで区画の固定を解除する', (type) => {
    const app = setup(); app.enable();
    event(app.canvas, 'pointerdown'); event(app.canvas, type);
    event(app.canvas, 'wheel', { clientX: 620, clientY: 440 });
    expect(app.getQuad().active).toBe('right'); app.detach();
  });

  it('canvas外で左ボタンを離しても次の区画を操作できる', () => {
    const app = setup(); app.enable(); event(app.canvas, 'pointerdown');
    event(app.windowTarget, 'pointerup'); event(app.canvas, 'wheel', { clientX: 620 });
    expect(app.getQuad().active).toBe('isometric'); app.detach();
  });

  it('解除後の入力はカメラも描画要求も変えない', () => {
    const app = setup(); app.enable(); const before = app.getQuad(); app.detach();
    event(app.canvas, 'wheel'); event(app.canvas, 'pointermove');
    expect(app.getQuad()).toBe(before); expect(app.changed).not.toHaveBeenCalled();
  });
});
