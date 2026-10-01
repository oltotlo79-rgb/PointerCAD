import type { EffectCallback } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HOME_ORBIT, type OrbitState } from '../viewport/cameraMath.js';
import { ViewCube } from './ViewCube.js';
import type { ViewCubeRegion } from './viewCubeMath.js';

const harness = vi.hoisted(() => ({
  effect: null as EffectCallback | null,
  canvas: null as EventTarget | null,
  render: vi.fn(), resize: vi.fn(), dispose: vi.fn(), setThemeColors: vi.fn(),
  pick: vi.fn<() => ViewCubeRegion | null>(),
  storeListener: null as ((next: { displaySettings: { theme: string }; homeViewRequestCount: number }, previous: { displaySettings: { theme: string }; homeViewRequestCount: number }) => void) | null,
}));

vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useRef: () => ({ current: harness.canvas }),
  useEffect: (effect: EffectCallback) => { harness.effect = effect; },
}));
vi.mock('../store/useAppStore.js', () => ({ useAppStore: {
  subscribe: (listener: typeof harness.storeListener) => { harness.storeListener = listener; return vi.fn(); },
  getState: () => ({ requestHomeView: vi.fn() }),
} }));
vi.mock('../viewport/themeColors.js', () => ({ readThemeColors: () => ({}) }));
vi.mock('./createViewCubeScene.js', () => ({ createViewCubeScene: () => harness }));

class Canvas extends EventTarget {
  clientWidth = 144;
  originLeft = 107.5;
  originTop = 175.5;
  dataset: Record<string, string> = {};
  captured = false;
  parentElement = {
    parentElement: null,
    style: { translate: '0px 0px' },
    getBoundingClientRect: (): { left: number; top: number; width: number; height: number } => {
      const [x, y] = this.parentElement.style.translate.split(' ').map(Number.parseFloat);
      return { left: this.originLeft + x, top: this.originTop + y, width: this.clientWidth, height: this.clientWidth };
    },
  };
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 144, height: 144 };
  }
  setPointerCapture(): void { this.captured = true; }
  hasPointerCapture(): boolean { return this.captured; }
  releasePointerCapture(): void {
    this.captured = false;
    this.dispatchEvent(new Event('lostpointercapture'));
  }
  pointer(type: string, x = 72, y = 72, button = 0): void {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { clientX: x, clientY: y, pointerId: 1, button });
    this.dispatchEvent(event);
  }
}

let canvas: Canvas;
let current: OrbitState;
let onDraw: () => void;
let cleanup: ReturnType<EffectCallback>;
let loadedFont: () => void;
let nextFrame: FrameRequestCallback | null;
let now: number;
let resizeControl: () => void;
const setOrbit = vi.fn((next: OrbitState) => { current = next; onDraw(); });

beforeEach(() => {
  vi.clearAllMocks();
  canvas = new Canvas();
  harness.canvas = canvas;
  harness.pick.mockReturnValue({ x: 0, y: -1, z: 0 });
  current = { ...HOME_ORBIT, target: [4, 5, 6], distance: 77 };
  now = 1000;
  nextFrame = null;
  vi.stubGlobal('performance', { now: () => now });
  vi.stubGlobal('devicePixelRatio', 1.5);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resizeControl = callback; }
    observe(): void { /* explicit initial resize */ }
    disconnect(): void { /* no DOM */ }
  });
  vi.stubGlobal('addEventListener', vi.fn());
  vi.stubGlobal('removeEventListener', vi.fn());
  vi.stubGlobal('document', { fonts: { load: () => new Promise<void>(resolve => { loadedFont = resolve; }) } });
  ViewCube({ getOrbit: () => current, setOrbit, subscribeDraw: listener => { onDraw = listener; return vi.fn(); } });
  cleanup = harness.effect?.();
});
afterEach(() => {
  if (typeof cleanup === 'function') cleanup();
  cleanup = undefined;
  vi.unstubAllGlobals();
});

function finishTransition(): void {
  now += 301;
  const frame = nextFrame;
  nextFrame = null;
  frame?.(now);
}

describe('view cube pointer feedback and lifecycle', () => {
  it('aligns a fractional viewport origin on CSS and device pixels without resizing the square', () => {
    const bounds = canvas.parentElement.getBoundingClientRect();
    expect(bounds.left).toBe(108);
    expect(bounds.top).toBe(176);
    expect(bounds.width).toBe(144);
    expect(bounds.height).toBe(144);
    expect(harness.resize).toHaveBeenLastCalledWith(144);
  });

  it('keeps pixel alignment stable when a theme redraws the same control', () => {
    const before = canvas.parentElement.style.translate;
    harness.storeListener?.({ displaySettings: { theme: 'light' }, homeViewRequestCount: 0 }, { displaySettings: { theme: 'dark' }, homeViewRequestCount: 0 });
    onDraw();
    expect(canvas.parentElement.style.translate).toBe(before);
  });

  it('keeps the 150% control at 324 square pixels after toolbar wrapping and theme spacing change', () => {
    canvas.clientWidth = 216;
    canvas.originLeft = 925.5;
    canvas.originTop = 175.75;
    resizeControl();
    let bounds = canvas.parentElement.getBoundingClientRect();
    expect(bounds).toEqual({ left: 926, top: 176, width: 216, height: 216 });
    expect((Math.ceil(bounds.top + bounds.height) - Math.floor(bounds.top)) * 1.5).toBe(324);
    canvas.originTop = 190.25;
    harness.storeListener?.({ displaySettings: { theme: 'darkModern' }, homeViewRequestCount: 0 }, { displaySettings: { theme: 'dark' }, homeViewRequestCount: 0 });
    onDraw();
    bounds = canvas.parentElement.getBoundingClientRect();
    expect(bounds).toEqual({ left: 926, top: 190, width: 216, height: 216 });
    expect(harness.resize).toHaveBeenLastCalledWith(216);
  });

  it('shows press feedback immediately and clears it without requiring pointer movement', () => {
    canvas.pointer('pointerdown');
    expect(harness.render).toHaveBeenLastCalledWith(current, { x: 0, y: -1, z: 0 }, true);
    expect(canvas.dataset.interaction).toBe('pressed');
    canvas.pointer('pointerup');
    expect(harness.render).toHaveBeenLastCalledWith(current, null, false);
    expect(canvas.dataset.interaction).toBeUndefined();
    finishTransition();
    expect(current.azimuth).toBeCloseTo(-Math.PI / 2, 12);
    expect(current.elevation).toBe(0);
    expect(current.target).toEqual([4, 5, 6]);
    expect(current.distance).toBe(77);
    expect(nextFrame).toBeNull();
  });

  it.each(['pointercancel', 'lostpointercapture'])('clears a held press on %s without moving the view', type => {
    canvas.pointer('pointerdown');
    canvas.pointer(type);
    expect(harness.render).toHaveBeenLastCalledWith(current, null, false);
    expect(canvas.dataset.interaction).toBeUndefined();
    canvas.pointer('pointerup');
    expect(setOrbit).not.toHaveBeenCalled();
    expect(nextFrame).toBeNull();
  });

  it('retains the 4px drag threshold and never snaps after dragging', () => {
    canvas.pointer('pointerdown');
    canvas.pointer('pointermove', 74, 74);
    expect(setOrbit).not.toHaveBeenCalled();
    canvas.pointer('pointermove', 84, 76);
    expect(setOrbit).toHaveBeenCalledTimes(1);
    expect(canvas.dataset.interaction).toBe('dragging');
    canvas.pointer('pointerup', 84, 76);
    expect(nextFrame).toBeNull();
    expect(current.target).toEqual([4, 5, 6]);
  });

  it('ignores secondary buttons and does not animate clicks outside the cube', () => {
    canvas.pointer('pointerdown', 72, 72, 2);
    expect(canvas.captured).toBe(false);
    harness.pick.mockReturnValue(null);
    canvas.pointer('pointerdown');
    canvas.pointer('pointerup');
    expect(nextFrame).toBeNull();
    expect(setOrbit).not.toHaveBeenCalled();
  });

  it('lets an external home request cancel a click transition', () => {
    canvas.pointer('pointerdown');
    canvas.pointer('pointerup');
    current = HOME_ORBIT;
    harness.storeListener?.({ displaySettings: { theme: 'dark' }, homeViewRequestCount: 1 }, { displaySettings: { theme: 'dark' }, homeViewRequestCount: 0 });
    finishTransition();
    expect(current).toBe(HOME_ORBIT);
    expect(setOrbit).not.toHaveBeenCalled();
  });

  it('rebuilds the labels when the font arrives but never draws after unmount', async () => {
    const before = harness.setThemeColors.mock.calls.length;
    loadedFont();
    await Promise.resolve();
    expect(harness.setThemeColors).toHaveBeenCalledTimes(before + 1);
    if (typeof cleanup === 'function') cleanup();
    cleanup = undefined;
    const renders = harness.render.mock.calls.length;
    canvas.pointer('pointerdown');
    expect(harness.render).toHaveBeenCalledTimes(renders);
    expect(harness.dispose).toHaveBeenCalledTimes(1);
  });

  it('ignores font completion after unmount', async () => {
    if (typeof cleanup === 'function') cleanup();
    cleanup = undefined;
    const renders = harness.render.mock.calls.length;
    loadedFont();
    await Promise.resolve();
    expect(harness.render).toHaveBeenCalledTimes(renders);
    expect(harness.dispose).toHaveBeenCalledTimes(1);
  });
});
