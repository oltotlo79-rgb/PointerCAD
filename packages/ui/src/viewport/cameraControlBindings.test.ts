import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW_CONTROLS, withViewControlPreset, type ViewControlOptions } from '../settings/viewControlSettings.js';
import {
  dragZoomDelta, keyOrbitPixels, keyZoomDelta, pinchZoomDelta, scaledOrbitDelta, scaledPanDelta, viewDragAction, viewKeyMove,
  viewTouchAction, viewWheelAction, wheelDragEquivalent, wheelZoomDelta,
} from './cameraControlBindings.js';
import { ORBIT_RADIANS_PER_PIXEL } from './cameraMath.js';

const modifiers = { altKey: false, shiftKey: false, ctrlKey: false, metaKey: false };
const options = (changes: Partial<ViewControlOptions> = {}): ViewControlOptions => ({ ...DEFAULT_VIEW_CONTROLS.options, ...changes });

describe('exact camera gesture matching', () => {
  it('requires the exact button mask and every modifier', () => {
    const middle = { ...modifiers, pointerType: 'mouse', button: 1, buttons: 4 };
    expect(viewDragAction(DEFAULT_VIEW_CONTROLS, middle)).toBe('orbit');
    expect(viewDragAction(DEFAULT_VIEW_CONTROLS, { ...middle, shiftKey: true })).toBe('pan');
    expect(viewDragAction(DEFAULT_VIEW_CONTROLS, { ...middle, ctrlKey: true })).toBeNull();
    for (const buttons of [0, 1, 5, 6]) expect(viewDragAction(DEFAULT_VIEW_CONTROLS, { ...middle, buttons })).toBeNull();
    expect(viewDragAction(DEFAULT_VIEW_CONTROLS, { ...middle, pointerType: 'touch' })).toBeNull();
  });
  it('leaves plain and Shift/Ctrl primary selection untouched', () => {
    for (const extra of [{}, { shiftKey: true }, { ctrlKey: true }, { shiftKey: true, ctrlKey: true }]) {
      expect(viewDragAction(DEFAULT_VIEW_CONTROLS, { ...modifiers, pointerType: 'mouse', button: 0, buttons: 1, ...extra })).toBeNull();
    }
    expect(viewDragAction(DEFAULT_VIEW_CONTROLS, { ...modifiers, pointerType: 'mouse', button: 0, buttons: 1, altKey: true })).toBe('orbit');
  });
  it('does not silently retain the retired third pan or any-modifier wheel', () => {
    expect(viewDragAction(DEFAULT_VIEW_CONTROLS, { ...modifiers, pointerType: 'mouse', button: 0, buttons: 1, altKey: true, shiftKey: true })).toBeNull();
    expect(viewWheelAction(DEFAULT_VIEW_CONTROLS, { ...modifiers, buttons: 0 })).toBe('zoom');
    expect(viewWheelAction(DEFAULT_VIEW_CONTROLS, { ...modifiers, buttons: 0, ctrlKey: true })).toBe('zoom');
    expect(viewWheelAction(DEFAULT_VIEW_CONTROLS, { ...modifiers, buttons: 0, shiftKey: true })).toBeNull();
    expect(viewWheelAction(DEFAULT_VIEW_CONTROLS, { ...modifiers, buttons: 1 })).toBeNull();
  });
});

/*
 * The shipped default must resolve every input exactly as the previous version did. The oracle below re-states the
 * previous (v1) table and its exact-match rule by hand; it does not call the product settings or resolver.
 */
const V1_DEFAULT_ROWS = [
  ['orbit', 'middle', false, false, false, false], ['orbit', 'left', true, false, false, false],
  ['pan', 'right', false, false, false, false], ['pan', 'middle', false, true, false, false],
  ['zoom', 'wheel', false, false, false, false], ['zoom', 'wheel', false, false, true, false],
] as const;
interface Keys { altKey: boolean; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }
function previousAction(input: 'left' | 'middle' | 'right' | 'wheel', keys: Keys): string | null {
  return V1_DEFAULT_ROWS.find(([, rowInput, alt, shift, ctrl, meta]) => rowInput === input
    && alt === keys.altKey && shift === keys.shiftKey && ctrl === keys.ctrlKey && meta === keys.metaKey)?.[0] ?? null;
}
const BOOLS = [false, true] as const;
const ALL_KEYS: Keys[] = BOOLS.flatMap(altKey => BOOLS.flatMap(shiftKey => BOOLS.flatMap(ctrlKey =>
  BOOLS.map(metaKey => ({ altKey, shiftKey, ctrlKey, metaKey })))));

describe('the default v2 settings keep the previous default behavior', () => {
  it('every button, button mask, pointer kind and modifier combination resolves like the previous version', () => {
    const buttons = [['left', 0, 1], ['middle', 1, 4], ['right', 2, 2]] as const;
    let compared = 0;
    for (const [input, button, mask] of buttons) for (const keys of ALL_KEYS) for (const pointerType of ['mouse', 'pen', 'touch']) {
      for (const pressed of [mask, mask + 8, 0]) {
        const expected = pointerType !== 'touch' && pressed === mask ? previousAction(input, keys) : null;
        expect(viewDragAction(DEFAULT_VIEW_CONTROLS, { ...keys, pointerType, button, buttons: pressed }), `${input} ${JSON.stringify(keys)} ${pointerType} ${pressed}`)
          .toBe(expected);
        compared++;
      }
    }
    expect(compared).toBe(3 * 16 * 3 * 3);
  });

  it('every wheel modifier combination and held button resolves like the previous version', () => {
    for (const keys of ALL_KEYS) for (const buttons of [0, 1, 4]) {
      expect(viewWheelAction(DEFAULT_VIEW_CONTROLS, { ...keys, buttons })).toBe(buttons === 0 ? previousAction('wheel', keys) : null);
    }
  });

  it('default speeds and directions return the very same numbers (no rounding change)', () => {
    const defaults = DEFAULT_VIEW_CONTROLS.options;
    for (const [dx, dy] of [[0.1, -0.3], [48, 24], [-7.25, 1e-9], [0, 0]] as const) {
      expect(scaledOrbitDelta(defaults, dx, dy)).toEqual([dx, dy]);
      expect(scaledPanDelta(defaults, dx, dy)).toEqual([dx, dy]);
      expect(dragZoomDelta(defaults, dy)).toBe(dy);
    }
  });
});

describe('wheel units, speeds and directions in one place', () => {
  it.each([
    { deltaMode: 0, factor: 1 }, { deltaMode: 1, factor: 16 }, { deltaMode: 2, factor: 100 }, { deltaMode: 99, factor: 1 },
  ])('deltaMode $deltaMode converts both axes by $factor', ({ deltaMode, factor }) => {
    expect(wheelZoomDelta(options(), { deltaMode, deltaX: 3, deltaY: -1.5, shiftKey: false })).toBe(-1.5 * factor);
    expect(wheelZoomDelta(options({ wheelSensitivity: 2.5, invertWheel: true }), { deltaMode, deltaX: 0, deltaY: 2, shiftKey: false }))
      .toBe(2 * factor * 2.5 * -1);
    expect(wheelDragEquivalent({ deltaMode, deltaX: 3, deltaY: -1.5 })).toEqual([-3 * factor, 1.5 * factor]);
  });

  it('zooms with the horizontal amount only when the browser moved Shift+wheel to the horizontal axis', () => {
    expect(wheelZoomDelta(options(), { deltaMode: 0, deltaX: 40, deltaY: 0, shiftKey: true })).toBe(40);
    // A plain horizontal swipe still does not zoom (the previous behavior).
    expect(wheelZoomDelta(options(), { deltaMode: 0, deltaX: 40, deltaY: 0, shiftKey: false })).toBe(0);
    expect(wheelZoomDelta(options(), { deltaMode: 1, deltaX: 40, deltaY: 2, shiftKey: true })).toBe(32);
  });

  it('applies the rotation and pan speeds and the two rotation inversions', () => {
    expect(scaledOrbitDelta(options({ orbitSensitivity: 2 }), 10, -4)).toEqual([20, -8]);
    expect(scaledOrbitDelta(options({ orbitSensitivity: 0.5, invertOrbitX: true }), 10, -4)).toEqual([-5, -2]);
    expect(scaledOrbitDelta(options({ invertOrbitY: true }), 10, -4)).toEqual([10, 4]);
    expect(scaledPanDelta(options({ panSensitivity: 3, orbitSensitivity: 9, invertOrbitX: true }), 10, -4)).toEqual([30, -12]);
    expect(dragZoomDelta(options({ zoomDragSensitivity: 2, invertZoomDrag: true }), 10)).toBe(-20);
  });

  it('the 3D view and the drawing no longer keep their own copy of the wheel unit conversion', () => {
    for (const file of ['./attachCameraControls.ts', '../drawing/drawingNavigation.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/deltaMode|PIXELS_PER_WHEEL|DOM_DELTA/u);
    }
  });
});

describe('view key bindings (B-08)', () => {
  const keyboard = withViewControlPreset(DEFAULT_VIEW_CONTROLS, 'keyboard');
  it('matches the physical key group and every modifier exactly', () => {
    expect(viewKeyMove(keyboard, { ...modifiers, code: 'ArrowLeft' })).toEqual({ action: 'orbit', direction: [-1, 0] });
    expect(viewKeyMove(keyboard, { ...modifiers, code: 'ArrowDown' })).toEqual({ action: 'orbit', direction: [0, 1] });
    expect(viewKeyMove(keyboard, { ...modifiers, shiftKey: true, code: 'ArrowRight' })).toEqual({ action: 'pan', direction: [1, 0] });
    expect(viewKeyMove(keyboard, { ...modifiers, code: 'Equal' })).toEqual({ action: 'zoom', direction: [0, -1] });
    expect(viewKeyMove(keyboard, { ...modifiers, code: 'NumpadSubtract' })).toEqual({ action: 'zoom', direction: [0, 1] });
    // Ctrl+arrow and Alt+arrow belong to no binding; the numeric keypad is its own group, unbound in this preset.
    expect(viewKeyMove(keyboard, { ...modifiers, ctrlKey: true, code: 'ArrowLeft' })).toBeNull();
    expect(viewKeyMove(keyboard, { ...modifiers, altKey: true, code: 'ArrowUp' })).toBeNull();
    expect(viewKeyMove(keyboard, { ...modifiers, code: 'Numpad4' })).toBeNull();
    expect(viewKeyMove(keyboard, { ...modifiers, code: 'KeyA' })).toBeNull();
  });
  it('binds no key by default, so the default settings leave every key to the commands', () => {
    for (const code of ['ArrowLeft', 'ArrowUp', 'Numpad8', 'NumpadAdd', 'Equal', 'Minus']) {
      expect(viewKeyMove(DEFAULT_VIEW_CONTROLS, { ...modifiers, code }), code).toBeNull();
    }
  });
  it('turns by the set angle per press whatever the rotation speed, and keeps the inversion', () => {
    const radians = (changes: Partial<ViewControlOptions>): number => {
      const settings = options(changes);
      return scaledOrbitDelta(settings, keyOrbitPixels(settings), 0)[0] * ORBIT_RADIANS_PER_PIXEL;
    };
    expect(radians({})).toBeCloseTo(Math.PI / 12, 12);
    expect(radians({ orbitSensitivity: 3 })).toBeCloseTo(Math.PI / 12, 12);
    expect(radians({ keyStepDegrees: 90, orbitSensitivity: 0.1 })).toBeCloseTo(Math.PI / 2, 12);
    expect(radians({ keyStepDegrees: 1, invertOrbitX: true })).toBeCloseTo(-Math.PI / 180, 12);
  });
  it('zooms one wheel notch per press, with the wheel speed and inversion', () => {
    expect(keyZoomDelta(options(), -1)).toBe(-100);
    expect(keyZoomDelta(options({ wheelSensitivity: 2 }), 1)).toBe(200);
    expect(keyZoomDelta(options({ invertWheel: true }), -1)).toBe(100);
  });
});

describe('タッチの指の操作(B-08g)', () => {
  const OFF = { alt: false, shift: false, ctrl: false, meta: false } as const;
  it('既定には割当が無く、割り当てた指の操作だけが当たる', () => {
    expect(viewTouchAction(DEFAULT_VIEW_CONTROLS, 'twoFinger')).toBeNull();
    expect(viewTouchAction(DEFAULT_VIEW_CONTROLS, 'pinch')).toBeNull();
    const bindings = DEFAULT_VIEW_CONTROLS.bindings;
    const touched = { ...DEFAULT_VIEW_CONTROLS, bindings: { ...bindings,
      orbit: [...bindings.orbit, { kind: 'touch' as const, gesture: 'twoFinger' as const, ...OFF }],
      zoom: [...bindings.zoom, { kind: 'touch' as const, gesture: 'pinch' as const, ...OFF }] } };
    expect(viewTouchAction(touched, 'twoFinger')).toBe('orbit');
    expect(viewTouchAction(touched, 'pinch')).toBe('zoom');
  });

  it('つまむ量は、指の間の比の逆数だけ距離が変わるホイールの量(1.1 倍で 1 目盛り=100)', () => {
    // 1.1 倍に広げると 1 目盛り分近づく(-100)、1/1.1 にすぼめると 1 目盛り分遠ざかる(+100)。
    expect(pinchZoomDelta(1.1)).toBeCloseTo(-100, 9);
    expect(pinchZoomDelta(1 / 1.1)).toBeCloseTo(100, 9);
    expect(pinchZoomDelta(1.21)).toBeCloseTo(-200, 9);
    expect(pinchZoomDelta(1)).toBeCloseTo(0, 12);
    for (const scale of [0, -1, Number.NaN, Infinity]) expect(pinchZoomDelta(scale)).toBe(0);
    // 速さと反転は掛けない(直接さわる操作)。
    expect(pinchZoomDelta(2)).toBeCloseTo(-100 * Math.log(2) / Math.log(1.1), 9);
  });
});
