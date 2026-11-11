import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAMERA_CONTROLS, type CameraControlSettings } from '../settings/cameraControlSettings.js';
import { useAppStore } from '../store/useAppStore.js';
import { partWithPoint, resetTestStore } from '../store/testing/createTestStore.js';
import { attachCameraControls } from './attachCameraControls.js';
import type { OrbitState } from './cameraMath.js';

// No product zoom/normalizer/constants are used to calculate an expected distance.
const INITIAL: OrbitState = { distance: 240, azimuth: 0.37, elevation: -0.21,
  target: [11, -7, 3], up: [0, 0, 1], zoom: 1.25 };
const MODES = [{ mode: 0, unit: 'pixel', conversion: 1 }, { mode: 1, unit: 'line', conversion: 16 },
  { mode: 2, unit: 'page', conversion: 100 }] as const;
const CASES = MODES.flatMap(mode => [-1, 1].flatMap(direction => [0.1, 1, 10].flatMap(sensitivity =>
  [false, true].map(invert => ({ ...mode, direction, sensitivity, invert })))));

function send(target: EventTarget, type: string, properties: Record<string, unknown> = {}): Event {
  const input = Object.assign(new Event(type, { cancelable: true }), { pointerId: 7, pointerType: 'mouse',
    button: 0, buttons: 0, clientX: 120, clientY: 140, altKey: false, shiftKey: false, ctrlKey: false,
    metaKey: false, deltaMode: 0, deltaY: 100, ...properties });
  target.dispatchEvent(input);
  return input;
}

function setup(readSettings: () => CameraControlSettings = () => DEFAULT_CAMERA_CONTROLS) {
  const view = new EventTarget(), captured = new Set<number>();
  // EventTarget dispatches through the installed product listener; no onWheel mock.
  const canvas = Object.assign(new EventTarget() as HTMLCanvasElement, { clientHeight: 600, ownerDocument: { defaultView: view },
    setPointerCapture: (id: number) => { captured.add(id); }, hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => { captured.delete(id); }, focus: vi.fn() });
  vi.stubGlobal('WheelEvent', { DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 });
  const changed = vi.fn(), interaction = vi.fn();
  // This dispatcher uses only the canvas members supplied above.
  const controls = attachCameraControls(canvas, changed, interaction, undefined, readSettings);
  controls.setOrbit(INITIAL); changed.mockClear();
  return { canvas, view, captured, changed, interaction, controls };
}

function expectRelative(actual: number, expected: number): void {
  expect(Number.isFinite(actual)).toBe(true);
  expect(Math.abs(actual / expected - 1)).toBeLessThanOrEqual(1e-9);
}

afterEach(() => vi.unstubAllGlobals());

describe('wheel distance at the actual camera dispatcher with an independent oracle', () => {
  it.each(CASES)('$unit direction=$direction sensitivity=$sensitivity invert=$invert', entry => {
    const settings = { ...DEFAULT_CAMERA_CONTROLS, wheelSensitivity: entry.sensitivity, invertWheel: entry.invert };
    const app = setup(() => settings);
    try {
      const delta = entry.direction * 0.75;
      send(app.canvas, 'wheel', { deltaMode: entry.mode, deltaY: delta });
      const expectedRatio = 1.1 ** (delta * entry.conversion * entry.sensitivity * (entry.invert ? -1 : 1) / 100);
      expectRelative(app.controls.getOrbit().distance, INITIAL.distance * expectedRatio);
      expect(app.controls.getOrbit()).toEqual({ ...INITIAL, distance: app.controls.getOrbit().distance });
      expect(app.changed).toHaveBeenCalledTimes(1);
    } finally { app.controls.detach(); }
  });

  it.each(MODES)('continuous fractional $unit input equals its sum without clamping', ({ mode, conversion }) => {
    const deltas = [-0.25, -0.5, 0.125, -0.375], sensitivity = 2.5;
    const app = setup(() => ({ ...DEFAULT_CAMERA_CONTROLS, wheelSensitivity: sensitivity, invertWheel: true }));
    try {
      for (const deltaY of deltas) send(app.canvas, 'wheel', { deltaMode: mode, deltaY });
      const continuous = app.controls.getOrbit().distance;
      const total = deltas.reduce((sum, delta) => sum + delta, 0);
      expectRelative(continuous, 240 * 1.1 ** (-total * conversion * sensitivity / 100));
      expect(app.changed).toHaveBeenCalledTimes(deltas.length);
      app.controls.setOrbit(INITIAL); app.changed.mockClear();
      send(app.canvas, 'wheel', { deltaMode: mode, deltaY: total });
      expectRelative(app.controls.getOrbit().distance, continuous);
      expect(app.changed).toHaveBeenCalledTimes(1);
    } finally { app.controls.detach(); }
  });

  it.each([NaN, Infinity, -Infinity, 0])('keeps the exact finite view and sends no notification for delta %s', deltaY => {
    const app = setup();
    try {
      send(app.canvas, 'wheel', { deltaY });
      expect(app.controls.getOrbit()).toBe(INITIAL);
      expect([app.controls.getOrbit().distance, ...app.controls.getOrbit().target,
        ...(app.controls.getOrbit().up ?? [])].every(Number.isFinite)).toBe(true);
      expect(app.changed).not.toHaveBeenCalled();
    } finally { app.controls.detach(); }
  });

  it('retains pixel behavior for an unknown deltaMode and reads sensitivity live', () => {
    let settings = DEFAULT_CAMERA_CONTROLS;
    const app = setup(() => settings);
    try {
      send(app.canvas, 'wheel', { deltaMode: 99, deltaY: 25 });
      expectRelative(app.controls.getOrbit().distance, 240 * 1.1 ** 0.25);
      settings = { ...settings, wheelSensitivity: 2, invertWheel: true };
      send(app.canvas, 'wheel', { deltaMode: 99, deltaY: 25, ctrlKey: true });
      expectRelative(app.controls.getOrbit().distance, 240 * 1.1 ** -0.25);
      expect(app.changed).toHaveBeenCalledTimes(2);
    } finally { app.controls.detach(); }
  });

  it.each([0, 4])('wheel buttons=%s cannot change or release a held drag', buttons => {
    const app = setup();
    try {
      send(app.canvas, 'pointerdown', { button: 1, buttons: 4 });
      expect(app.controls.isDragging()).toBe(true);
      send(app.canvas, 'wheel', { buttons });
      expect(app.controls.getOrbit()).toBe(INITIAL);
      expect(app.changed).not.toHaveBeenCalled();
      expect(app.controls.isDragging()).toBe(true); expect(app.captured.has(7)).toBe(true);
      expect(app.interaction.mock.calls).toEqual([[true]]);
      send(app.canvas, 'pointermove', { buttons: 4, clientX: 130 });
      expect(app.controls.getOrbit().azimuth).toBeCloseTo(0.37 - 10 * 0.008, 12);
      expect(app.controls.getOrbit().distance).toBe(240);
      expect(app.changed).toHaveBeenCalledTimes(1);
    } finally { app.controls.detach(); }
  });

  it.each(['pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'buttons-changed', 'detach'] as const)(
    '%s releases ownership; stale movement is inert', ending => {
      const app = setup();
      try {
        send(app.canvas, 'pointerdown', { button: 1, buttons: 4 });
        send(app.canvas, 'wheel');
        if (ending === 'detach') app.controls.detach();
        else if (ending === 'buttons-changed') send(app.canvas, 'pointermove', { buttons: 5 });
        else send(ending === 'blur' ? app.view : app.canvas, ending);
        expect(app.controls.isDragging()).toBe(false); expect(app.captured.size).toBe(0);
        expect(app.interaction.mock.calls).toEqual([[true], [false]]);
        const before = app.controls.getOrbit(); app.changed.mockClear();
        send(app.canvas, 'pointermove', { buttons: 4, clientX: 300, clientY: 300 });
        expect(app.controls.getOrbit()).toBe(before); expect(app.changed).not.toHaveBeenCalled();
        send(app.canvas, 'wheel', { deltaY: 100 });
        if (ending === 'detach') expect(app.controls.getOrbit()).toBe(before);
        else expectRelative(app.controls.getOrbit().distance, before.distance * 1.1);
      } finally { app.controls.detach(); }
    });

  it.each([{ shiftKey: true }, { altKey: true }, { metaKey: true }, { ctrlKey: true, shiftKey: true },
    { buttons: 1 }, { buttons: 2 }, { buttons: 4 }, { buttons: 5 }, { buttons: 6 }, { buttons: 7 }])(
    'rejects extra modifiers/buttons %j before the wheel changes a view', properties => {
      const app = setup();
      try {
        const event = send(app.canvas, 'wheel', properties);
        expect(app.controls.getOrbit()).toBe(INITIAL); expect(app.changed).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);
      } finally { app.controls.detach(); }
    });

  it('distinguishes line x16 from x1 and live sensitivity from ignoring it', () => {
    const app = setup(() => ({ ...DEFAULT_CAMERA_CONTROLS, wheelSensitivity: 2 }));
    try {
      send(app.canvas, 'wheel', { deltaMode: 1, deltaY: 2 });
      const expected = 255.0953606071081; // 240 * 1.1 ** (2 * 16 * 2 / 100)
      const unitMistake = 240 * 1.1 ** 0.04, sensitivityMistake = 240 * 1.1 ** 0.32;
      expectRelative(app.controls.getOrbit().distance, expected);
      expect(Math.abs(expected - unitMistake)).toBeGreaterThan(10);
      expect(Math.abs(expected - sensitivityMistake)).toBeGreaterThan(7);
      const before = app.controls.getOrbit();
      send(app.canvas, 'wheel', { deltaY: 100, shiftKey: true });
      expect(app.controls.getOrbit()).toBe(before);
      expect(Math.abs(before.distance * 1.1 ** 2 - before.distance)).toBeGreaterThan(50);
      expect(app.changed).toHaveBeenCalledTimes(1);
    } finally { app.controls.detach(); }
  });

  it('100 wheel operations leave document notifications, ID, version, inputs and history unchanged', () => {
    resetTestStore();
    useAppStore.setState({ document: partWithPoint() });
    const before = useAppStore.getState(), bytes = JSON.stringify(before.document);
    const notifications = vi.fn(), unsubscribe = useAppStore.subscribe(notifications);
    const app = setup();
    try {
      for (let index = 0; index < 100; index++) send(app.canvas, 'wheel', { deltaY: index % 2 === 0 ? 0.25 : -0.25 });
      expect(app.changed).toHaveBeenCalledTimes(100);
      expectRelative(app.controls.getOrbit().distance, 240);
      const after = useAppStore.getState();
      expect(notifications).not.toHaveBeenCalled();
      expect(after.document).toBe(before.document); expect(JSON.stringify(after.document)).toBe(bytes);
      expect(after.document.id).toBe(before.document.id); expect(after.activeDocumentId).toBe(before.activeDocumentId);
      expect(after.documentVersion).toBe(before.documentVersion); expect(after.requestedGeneration).toBe(before.requestedGeneration);
      expect(after.undoStack).toBe(before.undoStack);
      expect(after.numericInput).toBe(before.numericInput); expect(after.pendingStart).toBe(before.pendingStart);
    } finally { unsubscribe(); app.controls.detach(); }
  });
});
