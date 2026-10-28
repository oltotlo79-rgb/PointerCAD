import { readFileSync } from 'node:fs';
import { createFontStore, renderDrawing, toPdf, toSvg } from '@pointercad/drawing';
import { createDrawingDocument } from '@pointercad/model';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAMERA_CONTROLS, type CameraBinding, type CameraControlSettings } from '../settings/cameraControlSettings.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachDrawingNavigation, drawingEditPointerMatches, drawingPaperPoint, INITIAL_DRAWING_NAVIGATION, zoomDrawingNavigation } from './drawingNavigation.js';

beforeEach(resetTestStore);
const binding = (input: CameraBinding['input'], modifiers: Partial<CameraBinding> = {}): CameraBinding =>
  ({ input, alt: false, shift: false, ctrl: false, meta: false, ...modifiers });
const custom: CameraControlSettings = { ...DEFAULT_CAMERA_CONTROLS,
  pan: [binding('right'), binding('middle', { shift: true })],
  zoom: [binding('left', { alt: true, ctrl: true }), binding('middle', { ctrl: true })], dragSensitivity: 2 };

function fixture(settings = DEFAULT_CAMERA_CONTROLS) {
  const capture = new Set<number>();
  const surface = Object.assign(new EventTarget(), {
    setPointerCapture: (id: number) => { capture.add(id); },
    hasPointerCapture: (id: number) => capture.has(id),
    releasePointerCapture: (id: number) => { capture.delete(id); },
  });
  const view = new EventTarget(), focus = vi.fn(), changes = vi.fn();
  let transform = INITIAL_DRAWING_NAVIGATION, currentSettings = settings, enabled = true;
  const controls = attachDrawingNavigation(surface, { view, focus,
    readSettings: () => currentSettings, canStart: () => enabled,
    // A real sheet's origin moves by the CSS translation, independently of scale.
    sheetBounds: () => ({ left: 40 + transform.x, top: 70 + transform.y }),
    getTransform: () => transform,
    setTransform: next => { transform = next; changes(next); },
  });
  const send = (type: string, props: object = {}): Event => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      pointerId: 1, pointerType: 'mouse', button: 2, buttons: 2, clientX: 240, clientY: 170,
      altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, deltaY: 100, deltaMode: 0, ...props,
    });
    surface.dispatchEvent(event); return event;
  };
  return { surface, controls, view, capture, focus, changes, send, get: () => transform,
    settings: (next: CameraControlSettings) => { currentSettings = next; }, enabled: (next: boolean) => { enabled = next; } };
}

describe('drawing navigation geometry and exact binding ownership', () => {
  it('ordinary left selection permits Ctrl/Shift but unmatched Alt/Meta, chords and other buttons cannot begin a model drag', () => {
    const left = { button: 0, buttons: 1, altKey: false, metaKey: false, shiftKey: false, ctrlKey: false };
    for (const modifiers of [{}, { shiftKey: true }, { ctrlKey: true }, { ctrlKey: true, shiftKey: true }]) {
      expect(drawingEditPointerMatches({ ...left, ...modifiers })).toBe(true);
    }
    for (const props of [{ altKey: true }, { altKey: true, shiftKey: true, ctrlKey: true }, { metaKey: true },
      { buttons: 3 }, { buttons: 5 }, { button: 1, buttons: 4 }, { button: 2, buttons: 2 }]) {
      expect(drawingEditPointerMatches({ ...left, ...props })).toBe(false);
    }
  });
  it.each([
    { name: 'pan slot 1', button: 2, buttons: 2, modifiers: {}, action: 'pan' },
    { name: 'pan slot 2', button: 1, buttons: 4, modifiers: { shiftKey: true }, action: 'pan' },
    { name: 'zoom slot 1', button: 0, buttons: 1, modifiers: { altKey: true, ctrlKey: true }, action: 'zoom' },
    { name: 'zoom slot 2', button: 1, buttons: 4, modifiers: { ctrlKey: true }, action: 'zoom' },
  ])('$name moves only the display and keeps the grabbed point at the independent screen position', mode => {
    const test = fixture(custom), props = { button: mode.button, buttons: mode.buttons, ...mode.modifiers };
    const fallback = vi.fn(); test.surface.addEventListener('pointerdown', fallback);
    expect(test.send('pointerdown', props).defaultPrevented).toBe(true);
    expect(fallback).not.toHaveBeenCalled(); expect(test.focus).toHaveBeenCalledOnce();
    test.send('pointermove', { ...props, clientX: 277.125, clientY: 193.75 });
    const actual = test.get();
    if (mode.action === 'pan') {
      expect(Math.abs(actual.x - 37.125)).toBeLessThanOrEqual(1);
      expect(Math.abs(actual.y - 23.75)).toBeLessThanOrEqual(1);
      expect(actual.scale).toBe(1);
    } else {
      const expectedScale = 1.1 ** (-23.75 * 2 / 100);
      expect(Math.abs(actual.scale - expectedScale)).toBeLessThan(1e-12);
      expect(Math.abs(40 + actual.x + 200 * actual.scale - 240)).toBeLessThan(1e-9);
      expect(Math.abs(70 + actual.y + 100 * actual.scale - 170)).toBeLessThan(1e-9);
      test.send('pointermove', { ...props, clientX: 280, clientY: 210 });
      expect(test.get().scale).toBeCloseTo(1.1 ** (-40 * 2 / 100), 12);
      expect(40 + test.get().x + 200 * test.get().scale).toBeCloseTo(240, 10);
    }
    test.send('pointerup', { ...props, buttons: 0, clientX: 280, clientY: 210 });
    expect(test.capture.size).toBe(0); expect(test.controls.isDragging()).toBe(false); test.controls.detach();
  });

  const wheelCases = [0, 1, 2].flatMap(deltaMode => [0.1, 2].flatMap(sensitivity => [false, true].flatMap(invert =>
    [-12, 0, 25].map(deltaY => ({ deltaMode, sensitivity, invert, deltaY })))));
  it.each(wheelCases)('wheel mode=$deltaMode delta=$deltaY sensitivity=$sensitivity invert=$invert has an independent 16/100 oracle', value => {
    const test = fixture({ ...DEFAULT_CAMERA_CONTROLS, wheelSensitivity: value.sensitivity, invertWheel: value.invert });
    expect(test.send('wheel', { ...value, buttons: 0 }).defaultPrevented).toBe(true);
    const factor = value.deltaMode === 1 ? 16 : value.deltaMode === 2 ? 100 : 1;
    const expectedScale = 1.1 ** (-value.deltaY * factor * value.sensitivity * (value.invert ? -1 : 1) / 100);
    const actual = test.get();
    expect(Math.abs(actual.scale / expectedScale - 1)).toBeLessThan(1e-12);
    expect(40 + actual.x + 200 * actual.scale).toBeCloseTo(240, 10);
    expect(70 + actual.y + 100 * actual.scale).toBeCloseTo(170, 10);
    test.controls.detach();
  });

  it.each([false, true])('both existing wheel slots work (Ctrl=$ctrl), including modified zoom drag inversion', ctrl => {
    const test = fixture();
    expect(test.send('wheel', { buttons: 0, ctrlKey: ctrl }).defaultPrevented).toBe(true);
    expect(test.get().scale).toBeCloseTo(1 / 1.1, 12); test.controls.detach();
    const drag = fixture({ ...custom, invertDrag: true, dragSensitivity: 0.5 });
    drag.send('pointerdown', { button: 1, buttons: 4, ctrlKey: true });
    drag.send('pointermove', { buttons: 4, clientY: 190 });
    expect(drag.get().scale).toBeCloseTo(1.1 ** 0.1, 12); drag.controls.detach();
  });

  it.each(['pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'escape', 'cancel', 'detach'])('%s releases capture and never leaks an old drag', ending => {
    const test = fixture(); test.send('pointerdown');
    if (ending === 'blur') test.view.dispatchEvent(new Event('blur'));
    else if (ending === 'escape') test.send('keydown', { key: 'Escape' });
    else if (ending === 'cancel' || ending === 'detach') test.controls[ending]();
    else test.send(ending, { buttons: 0 });
    expect(test.controls.isDragging()).toBe(false); expect(test.capture.size).toBe(0);
    test.send('pointermove', { clientX: 300, clientY: 240 });
    expect(test.get()).toBe(INITIAL_DRAWING_NAVIGATION); test.controls.detach();
  });

  it('owns the initial drag despite released modifiers/settings changes; rejects button chords, unrelated pointer and held wheel', () => {
    const test = fixture(custom);
    test.send('pointerdown', { button: 1, buttons: 4, ctrlKey: true });
    test.settings(DEFAULT_CAMERA_CONTROLS);
    test.send('pointermove', { pointerId: 2, buttons: 4, clientY: 190 }); expect(test.changes).not.toHaveBeenCalled();
    expect(test.send('wheel', { buttons: 4 }).defaultPrevented).toBe(false);
    expect(test.send('wheel', { buttons: 0 }).defaultPrevented).toBe(false);
    test.send('pointermove', { buttons: 4, clientY: 190 }); expect(test.get().scale).toBeCloseTo(1.1 ** -0.4, 12);
    const before = test.get(); test.send('pointermove', { buttons: 5, clientY: 210 });
    expect(test.controls.isDragging()).toBe(false); expect(test.get()).toBe(before);
    test.send('pointermove', { buttons: 4, clientY: 250 }); expect(test.get()).toBe(before); test.controls.detach();
  });

  it('leaves plain selection, orbit, nonassigned buttons, extra modifiers, touch and disabled surfaces unowned', () => {
    const test = fixture(), fallback = vi.fn(); test.surface.addEventListener('pointerdown', fallback);
    for (const props of [{ button: 0, buttons: 1 }, { button: 1, buttons: 4 }, { button: 0, buttons: 1, altKey: true },
      { button: 3, buttons: 8 }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { metaKey: true },
      { buttons: 3 }, { pointerType: 'touch' }]) expect(test.send('pointerdown', props).defaultPrevented).toBe(false);
    expect(fallback).toHaveBeenCalledTimes(10);
    for (const props of [{ altKey: true }, { shiftKey: true }, { metaKey: true }, { ctrlKey: true, altKey: true }, { buttons: 1 }]) {
      expect(test.send('wheel', { buttons: 0, ...props }).defaultPrevented).toBe(false);
    }
    test.enabled(false); expect(test.send('pointerdown').defaultPrevented).toBe(false);
    expect(test.send('wheel', { buttons: 0 }).defaultPrevented).toBe(false);
    expect(test.changes).not.toHaveBeenCalled(); test.controls.detach();
  });

  it('suppresses auxiliary browser defaults only for assigned pan/zoom sequences', () => {
    const test = fixture();
    expect(test.send('contextmenu').defaultPrevented).toBe(false);
    test.send('pointerdown'); expect(test.send('contextmenu').defaultPrevented).toBe(true);
    test.send('pointerup', { buttons: 0 }); test.send('pointerdown', { ctrlKey: true });
    expect(test.send('contextmenu', { ctrlKey: true }).defaultPrevented).toBe(false); test.controls.detach();
  });

  it('paper point round trips within 1e-9mm using independent affine projection after pan/zoom', () => {
    for (const scale of [0.01, 0.2, 1, 3.75, 100]) for (const angle of [0, 0.3]) {
      const a = scale * Math.cos(angle), b = scale * Math.sin(angle), c = -b, d = a;
      const matrix = { a, b, c, d, e: 51.25, f: -13.75 };
      for (const point of [[0, 0], [420, 297], [123.456789012, 237.890123456]] as const) {
        const actual = drawingPaperPoint(matrix, 297, a * point[0] + c * (297 - point[1]) + matrix.e,
          b * point[0] + d * (297 - point[1]) + matrix.f);
        expect(actual).not.toBeNull();
        expect(Math.abs((actual?.point[0] ?? Infinity) - point[0])).toBeLessThanOrEqual(1e-9);
        expect(Math.abs((actual?.point[1] ?? Infinity) - point[1])).toBeLessThanOrEqual(1e-9);
        expect(actual?.tolerance).toBeCloseTo(7 / scale, 10);
      }
    }
    expect(drawingPaperPoint({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }, 297, 0, 0)).toBeNull();
    expect(zoomDrawingNavigation(INITIAL_DRAWING_NAVIGATION, 0, [20, 10])).toBe(INITIAL_DRAWING_NAVIGATION);
    expect(zoomDrawingNavigation(INITIAL_DRAWING_NAVIGATION, NaN, [20, 10])).toBe(INITIAL_DRAWING_NAVIGATION);
    for (const delta of [-1e9, 1e9]) {
      const value = zoomDrawingNavigation(INITIAL_DRAWING_NAVIGATION, delta, [20, 10]);
      expect([value.x, value.y, value.scale].every(Number.isFinite)).toBe(true);
      expect(value.scale).toBe(delta < 0 ? 2000 : 0.002);
    }
  });

  it('100 display operations and four negative cases make zero document/store updates and preserve SVG/PDF paper dimensions and bytes', async () => {
    const document = createDrawingDocument('navigation', { sourceRef: 'source', sourceKind: 'part', fileName: 'box.pcad',
      path: '', contentHash: 'hash', importedAt: '' });
    useAppStore.getState().openDrawing(document);
    const before = useAppStore.getState(), updates = vi.fn(), unsubscribe = useAppStore.subscribe(updates);
    const font = createFontStore({ read: () => Promise.resolve(Uint8Array.from(readFileSync(
      new URL('../../../../apps/web/public/fonts/NotoSansJP-Regular.otf', import.meta.url))).buffer) });
    expect(await font.load()).toBe('ready');
    const output = () => {
      const drawing = useAppStore.getState().drawing;
      if (drawing === null) throw new Error('Drawing required');
      const rendered = renderDrawing({ document: drawing, views: [] }, { forPrint: true, outlineText: font.outline });
      return { svg: toSvg(rendered.document), pdf: toPdf(rendered.document), width: rendered.document.widthMm, height: rendered.document.heightMm };
    };
    const original = output(), test = fixture();
    for (let index = 0; index < 100; index++) {
      if (index % 2 === 0) test.send('wheel', { buttons: 0, deltaY: index % 4 === 0 ? 5 : -5 });
      else { test.send('pointerdown'); test.send('pointermove', { clientX: 241, clientY: 171 }); test.send('pointerup', { buttons: 0, clientX: 241, clientY: 171 }); }
    }
    test.send('pointerdown'); test.send('pointerup', { buttons: 0 }); // zero pixels
    test.send('pointerdown', { metaKey: true }); // extra modifier
    test.send('pointerdown'); test.send('pointercancel'); // cancelled
    test.send('pointerdown', { button: 3, buttons: 8 }); // non-target button
    expect(test.changes).toHaveBeenCalledTimes(100);
    expect(updates).not.toHaveBeenCalled(); expect(useAppStore.getState()).toBe(before);
    expect(before.drawing?.id).toBe(document.id); expect(before.drawing?.source).toBe(document.source);
    expect(before.drawingUndoStack?.past).toHaveLength(0);
    expect(original.pdf.ok).toBe(true); expect(output()).toEqual(original);
    expect([original.width, original.height]).toEqual([420, 297]);
    unsubscribe(); test.controls.detach();
  });
});
