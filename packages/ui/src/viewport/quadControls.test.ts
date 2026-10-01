import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { createAssemblyDocument } from '@pointercad/model';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { startMate } from '../assembly/mateActions.js';
import { FACE_REGIONS, interpolateOrbit, orbitStateForRegion } from '../viewcube/viewCubeMath.js';
import { attachCameraControls } from './attachCameraControls.js';
import { attachQuadInput } from './attachQuadInput.js';
import { HOME_ORBIT, pan, type OrbitState } from './cameraMath.js';
import { createQuadCameraState, resetQuadCamera, updateQuadCamera, type QuadCameraState } from './quadCamera.js';
import { namedCameraFromOrbit, orbitFromNamedCamera } from './namedCamera.js';
import { attachAssemblyInteraction } from './attachAssemblyInteraction.js';

function event(target: EventTarget, type: string, props: Record<string, unknown> = {}): void {
  target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), {
    pointerId: 1, button: 0, buttons: 0, clientX: 120, clientY: 140, shiftKey: false, altKey: false,
    pointerType: 'mouse', ctrlKey: false, metaKey: false,
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
    ownerDocument: { defaultView: windowTarget },
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

describe('右ドラッグによる視点の平行移動', () => {
  it('組立の合致を選ぶ途中でも視点だけを動かし、文書・履歴・選択・入力を保持する', () => {
    resetTestStore();
    useAppStore.getState().openAssembly(createAssemblyDocument('pan'));
    startMate('coincident');
    const app = setup();
    const scene = { pickAssemblyFace: vi.fn(() => null), pickComponent: vi.fn(() => null),
      worldToScreen: vi.fn((): readonly [number, number] => [0, 0]) };
    const assembly = attachAssemblyInteraction(app.canvas, scene);
    const before = useAppStore.getState();
    try {
      expect(before.assemblyMateDraft).not.toBeNull();
      event(app.canvas, 'pointerdown', { button: 2, buttons: 2 });
      for (let i = 0; i < 100; i++) event(app.canvas, 'pointermove', { clientX: 130 + i, buttons: 2 });
      event(app.canvas, 'pointerup', { button: 2, clientX: 229 });
      expect(app.controls.getOrbit().target).not.toEqual(HOME_ORBIT.target);
      const after = useAppStore.getState();
      expect(after.document).toBe(before.document); expect(after.assembly).toBe(before.assembly);
      expect(after.selection).toBe(before.selection); expect(after.assemblyMateDraft).toBe(before.assemblyMateDraft);
      expect(after.undoStack).toBe(before.undoStack); expect(after.assemblyUndoStack).toBe(before.assemblyUndoStack);
      expect(after.requestedGeneration).toBe(before.requestedGeneration);
      expect(scene.pickAssemblyFace).not.toHaveBeenCalled(); expect(scene.pickComponent).not.toHaveBeenCalled();
    } finally { assembly.detach(); app.detach(); resetTestStore(); }
  });

  it.each(['perspective', 'orthographic'] as const)('%sで注視点の面の点がマウスと同じCSS画素数だけ動く', projection => {
    const app = setup();
    const initial: OrbitState = { azimuth: 0.73, elevation: 0.44, distance: 123, target: [11, -7, 5], up: [0.2, 0.8, 1], zoom: 2.5 };
    const cameraFor = (state: OrbitState) => {
      // Use Three's actual projection independently of pan's pixel-to-world formula.
      const height = 2 * state.distance * Math.tan(25 * Math.PI / 180);
      const camera = projection === 'perspective' ? new PerspectiveCamera(50, 800 / 600, 0.01, 100000)
        : new OrthographicCamera(-height * 800 / 1200, height * 800 / 1200, height / 2, -height / 2, -100000, 100000);
      const snapshot = namedCameraFromOrbit(state, projection);
      camera.position.set(...snapshot.position); camera.up.set(...snapshot.up); camera.zoom = snapshot.zoom;
      camera.lookAt(...snapshot.target); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
      return camera;
    };
    const camera = cameraFor(initial);
    const grabbed = new Vector3(12, 7, 0).applyQuaternion(camera.quaternion).add(new Vector3(...initial.target));
    const before = grabbed.clone().project(camera);
    try {
      app.controls.setOrbit(initial); app.changed.mockClear();
      event(app.canvas, 'pointerdown', { button: 2, buttons: 2 });
      event(app.canvas, 'pointermove', { clientX: 124, clientY: 142, buttons: 2 });
      expect(app.controls.getOrbit()).toBe(initial); expect(app.changed).not.toHaveBeenCalled();
      event(app.canvas, 'pointermove', { clientX: 162, clientY: 115, buttons: 2 });
      event(app.canvas, 'pointerup', { button: 2, clientX: 162, clientY: 115 });
      const moved = app.controls.getOrbit(), after = grabbed.clone().project(cameraFor(moved));
      expect((after.x - before.x) * 400).toBeCloseTo(42, 9);
      expect((before.y - after.y) * 300).toBeCloseTo(-25, 9);
      expect(moved).toMatchObject({ azimuth: initial.azimuth, elevation: initial.elevation, distance: initial.distance, up: initial.up, zoom: initial.zoom });
      expect(app.captured.size).toBe(0); expect(app.controls.isDragging()).toBe(false);
      expect(app.interaction.mock.calls).toEqual([[true], [false]]);
    } finally { app.detach(); }
  });

  it.each([0, 6, 6.001])('開始位置から%s CSS pxの境界でクリックと平行移動を区別する', dx => {
    const app = setup(), before = app.controls.getOrbit();
    try {
      event(app.canvas, 'pointerdown', { button: 2, buttons: 2, clientX: 0 });
      event(app.canvas, 'pointermove', { clientX: dx, buttons: 2 });
      event(app.canvas, 'pointerup', { button: 2, clientX: dx });
      if (dx <= 6) { expect(app.controls.getOrbit()).toBe(before); expect(app.changed).not.toHaveBeenCalled(); }
      else expect(app.controls.getOrbit().target).toEqual(pan(before, dx, 0, 600).target);
      expect(app.captured.size).toBe(0);
    } finally { app.detach(); }
  });

  it.each(['pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'detach'])(
    '%sで終了し、別ポインターや別ボタンの解放は操作を終わらせない', end => {
      const app = setup();
      try {
        event(app.canvas, 'pointerdown', { button: 2, buttons: 2 });
        event(app.canvas, 'pointermove', { pointerId: 9, clientX: 200, buttons: 2 });
        event(app.canvas, 'pointerup', { pointerId: 9, button: 2 });
        event(app.canvas, 'lostpointercapture', { pointerId: 9 });
        event(app.canvas, 'pointerup', { button: 0, buttons: 2 });
        expect(app.controls.getOrbit()).toBe(HOME_ORBIT);
        expect(app.controls.isDragging()).toBe(true); expect(app.captured.has(1)).toBe(true);
        event(app.canvas, 'pointermove', { clientX: 180, buttons: 2 });
        if (end === 'detach') app.controls.detach();
        else if (end === 'blur') event(app.windowTarget, end);
        else event(app.canvas, end, { button: 2, clientX: 180 });
        const ended = app.controls.getOrbit();
        event(app.canvas, 'pointermove', { clientX: 250, buttons: 2 });
        expect(app.controls.getOrbit()).toBe(ended);
        expect(app.controls.isDragging()).toBe(false); expect(app.captured.size).toBe(0);
        expect(app.interaction.mock.calls).toEqual([[true], [false]]);
      } finally { app.detach(); }
    },
  );

  it.each([
    ['top', 120, 140], ['isometric', 620, 140], ['front', 120, 440], ['right', 620, 440],
  ] as const)('%sの右ドラッグは区画境界を越えても開始区画だけを移動しHomeで注視点も戻る', (id, x, y) => {
    const app = setup(); app.enable(); const before = app.getQuad();
    try {
      const dx = x === 120 ? 500 : -500, dy = y === 140 ? 300 : -300;
      event(app.canvas, 'pointerdown', { button: 2, buttons: 2, clientX: x, clientY: y });
      event(app.canvas, 'pointermove', { buttons: 2, clientX: x + dx, clientY: y + dy });
      expect(app.getQuad().active).toBe(id);
      expect(app.getQuad().orbits[id].target).toEqual(pan(before.orbits[id], dx, dy, 300).target);
      for (const pane of ['top', 'isometric', 'front', 'right'] as const) {
        if (pane !== id) expect(app.getQuad().orbits[pane]).toBe(before.orbits[pane]);
      }
      event(app.canvas, 'pointerup', { button: 2, clientX: x + dx, clientY: y + dy });
      event(app.canvas, 'keydown', { key: 'Home' });
      expect(app.getQuad().orbits[id].target).toEqual([0, 0, 0]);
    } finally { app.detach(); }
  });

  it('移動後の中心をキューブの回転と保存視点が保ち、HomeとgoHomeは原点に戻す', () => {
    const app = setup();
    try {
      event(app.canvas, 'pointerdown', { button: 2, buttons: 2 });
      event(app.canvas, 'pointerup', { button: 2, clientX: 165, clientY: 175 });
      const moved = app.controls.getOrbit();
      expect(moved.target).not.toEqual([0, 0, 0]);
      const turned = orbitStateForRegion(FACE_REGIONS.front, moved);
      for (const ratio of [0, 0.5, 1]) {
        app.controls.setOrbit(interpolateOrbit(moved, turned, ratio));
        expect(app.controls.getOrbit().target).toBe(moved.target);
      }
      const saved = namedCameraFromOrbit(app.controls.getOrbit(), 'orthographic');
      const restored = orbitFromNamedCamera(saved);
      if (restored === null) throw new Error('Saved camera must restore');
      app.controls.goHome(); expect(app.controls.getOrbit().target).toEqual([0, 0, 0]);
      app.controls.setOrbit(restored); expect(app.controls.getOrbit().target).toEqual(moved.target);
      event(app.canvas, 'keydown', { key: 'Home' });
      expect(app.controls.getOrbit()).toBe(HOME_ORBIT);
    } finally { app.detach(); }
  });
});
