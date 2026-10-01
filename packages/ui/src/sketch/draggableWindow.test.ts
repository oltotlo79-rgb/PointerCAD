import { describe, expect, it, vi } from 'vitest';
import { attachWindowDrag, containWindow, fitWindowPlacement, type WindowBounds, type WindowPoint } from './draggableWindow.js';

const area: WindowBounds = { left: 108, top: 58, width: 784, height: 584 };
const size = { width: 260, height: 220 };

function fixture() {
  const view = new EventTarget(), captures = new Set<number>(), active = vi.fn();
  const handle = Object.assign(new EventTarget(), {
    setPointerCapture: (id: number) => { captures.add(id); },
    hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture: (id: number) => { captures.delete(id); },
  });
  let position: WindowPoint = { left: 200, top: 150 }, interactive = false;
  const move = vi.fn<(point: WindowPoint) => void>(point => { position = containWindow(point, size, area); });
  const detach = attachWindowDrag(handle, { view, move, position: () => position,
    interactive: () => interactive, dragging: active });
  const send = (type: string, values: object = {}): Event => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
      clientX: 220, clientY: 170, ...values,
    });
    handle.dispatchEvent(event);
    return event;
  };
  return { view, captures, active, move, detach, send, position: () => position,
    setInteractive: () => { interactive = true; } };
}

describe('floating input window bounds', () => {
  it.each([
    [{ left: 200, top: 150 }, { left: 200, top: 150 }],
    [{ left: -500, top: -100 }, { left: 108, top: 58 }],
    [{ left: 2000, top: 3000 }, { left: 632, top: 422 }],
    [{ left: 108.25, top: 58.5 }, { left: 108.25, top: 58.5 }],
  ])('contains %j without rounding away fractional pointer movement', (point, expected) => {
    expect(containWindow(point, size, area)).toEqual(expected);
  });
  it('keeps the top and left reachable when the available area becomes smaller than the form', () => {
    expect(containWindow({ left: 600, top: 400 }, size, { left: 8, top: 8, width: 100, height: 80 }))
      .toEqual({ left: 8, top: 8 });
  });
  it('fits a growing form and a shrinking viewport using their current dimensions', () => {
    const original = containWindow({ left: 1000, top: 1000 }, size, area);
    expect(containWindow(original, { width: 300, height: 500 }, area)).toEqual({ left: 592, top: 142 });
    expect(containWindow(original, size, { left: 108, top: 58, width: 500, height: 300 }))
      .toEqual({ left: 348, top: 138 });
  });
  it('keeps following the click anchor until the first drag and does not accumulate clamping offsets', () => {
    const initial = { translation: { left: 0, top: 0 }, draggedPosition: null };
    const first = fitWindowPlacement(initial, { left: 800, top: 500, ...size }, area);
    expect(first).toEqual({ translation: { left: -168, top: -78 }, draggedPosition: null });
    // The browser's next measurement includes the translation just applied.
    expect(fitWindowPlacement(first, { left: 632, top: 422, ...size }, area)).toEqual(first);
    const reanchored = fitWindowPlacement(first, { left: 200 - 168, top: 150 - 78, ...size }, area);
    expect(reanchored).toEqual(initial);
  });
  it('preserves a dragged position through changed anchors, then fits a larger form and a smaller screen', () => {
    const dragged = fitWindowPlacement({ translation: { left: 0, top: 0 }, draggedPosition: { left: 400, top: 300 } },
      { left: 200, top: 150, ...size }, area);
    expect(dragged.translation).toEqual({ left: 200, top: 150 });
    const recentered = fitWindowPlacement(dragged, { left: 500, top: 450, ...size }, area);
    expect(recentered).toEqual({ translation: { left: 100, top: 0 }, draggedPosition: { left: 400, top: 300 } });
    const grown = fitWindowPlacement(recentered, { left: 400, top: 300, width: 300, height: 450 }, area);
    expect(grown.draggedPosition).toEqual({ left: 400, top: 192 });
    const smallArea = { left: 8, top: 8, width: 400, height: 500 };
    const resized = fitWindowPlacement(grown, { left: 250, top: 100, width: 300, height: 450 }, smallArea);
    expect(resized.draggedPosition).toEqual({ left: 108, top: 58 });
    // Repeated observer notifications must leave both position and translation unchanged.
    const measured = { left: 108, top: 58, width: 300, height: 450 };
    expect(fitWindowPlacement(resized, measured, smallArea)).toEqual(resized);
  });
});

describe('window heading pointer ownership', () => {
  it.each(['mouse', 'touch', 'pen'])('moves with %s and prevents the focus-changing default action', pointerType => {
    const f = fixture();
    try {
      expect(f.send('pointerdown', { pointerType }).defaultPrevented).toBe(true);
      expect(f.captures.has(1)).toBe(true);
      expect(f.send('pointermove', { pointerType, clientX: 270, clientY: 205 }).defaultPrevented).toBe(true);
      expect(f.position()).toEqual({ left: 250, top: 185 });
      f.send('pointerup', { pointerType, buttons: 0, clientX: 280, clientY: 210 });
      expect(f.position()).toEqual({ left: 260, top: 190 });
      expect(f.captures.size).toBe(0);
      expect(f.active.mock.calls).toEqual([[true], [false]]);
    } finally { f.detach(); }
  });
  it('reverses immediately at an edge without accumulating offscreen movement', () => {
    const f = fixture();
    try {
      f.send('pointerdown'); f.send('pointermove', { clientX: 2000, clientY: 3000 });
      expect(f.position()).toEqual({ left: 632, top: 422 });
      f.send('pointermove', { clientX: 1980, clientY: 2990 });
      expect(f.position()).toEqual({ left: 612, top: 412 });
    } finally { f.detach(); }
  });
  it.each([{ button: 1 }, { button: 2 }, { isPrimary: false }])('ignores a non-primary gesture %j', values => {
    const f = fixture();
    try {
      expect(f.send('pointerdown', values).defaultPrevented).toBe(false);
      f.send('pointermove', { clientX: 300 });
      expect(f.move).not.toHaveBeenCalled(); expect(f.captures.size).toBe(0);
    } finally { f.detach(); }
  });
  it('does not start dragging from interactive content in the heading', () => {
    const f = fixture();
    try {
      f.setInteractive();
      expect(f.send('pointerdown').defaultPrevented).toBe(false);
      f.send('pointermove', { clientX: 300 });
      expect(f.move).not.toHaveBeenCalled(); expect(f.captures.size).toBe(0);
    } finally { f.detach(); }
  });
  it('ignores other pointers during an active gesture', () => {
    const f = fixture();
    try {
      f.send('pointerdown'); f.send('pointerdown', { pointerId: 2 });
      f.send('pointermove', { pointerId: 2, clientX: 500 });
      f.send('pointerup', { pointerId: 2 }); f.send('pointercancel', { pointerId: 2 });
      expect(f.captures).toEqual(new Set([1])); expect(f.move).not.toHaveBeenCalled();
      f.send('pointermove', { clientX: 230 });
      expect(f.position()).toEqual({ left: 210, top: 150 });
    } finally { f.detach(); }
  });
  it.each(['pointercancel', 'lostpointercapture', 'blur', 'buttons', 'detach'])('releases the gesture on %s', reason => {
    const f = fixture();
    try {
      f.send('pointerdown'); f.send('pointermove', { clientX: 250 });
      const before = f.position();
      if (reason === 'blur') f.view.dispatchEvent(new Event('blur'));
      else if (reason === 'buttons') f.send('pointermove', { buttons: 0 });
      else if (reason === 'detach') f.detach();
      else f.send(reason);
      f.send('pointermove', { clientX: 400 }); f.send('pointerup', { clientX: 400 });
      expect(f.position()).toEqual(before); expect(f.captures.size).toBe(0);
      expect(f.active.mock.calls).toEqual([[true], [false]]);
    } finally { f.detach(); }
  });
  it('leaves Tab, Enter and Escape to the existing window and removes all listeners on close', () => {
    const f = fixture();
    for (const key of ['Tab', 'Enter', 'Escape']) expect(f.send('keydown', { key }).defaultPrevented).toBe(false);
    f.detach();
    expect(f.send('pointerdown').defaultPrevented).toBe(false);
    f.send('pointermove', { clientX: 600 }); f.view.dispatchEvent(new Event('blur'));
    expect(f.move).not.toHaveBeenCalled(); expect(f.active).not.toHaveBeenCalled();
  });
  it('starts each new window at its own anchor', () => {
    const first = fixture();
    first.send('pointerdown'); first.send('pointermove', { clientX: 500 }); first.detach();
    const second = fixture();
    try { expect(second.position()).toEqual({ left: 200, top: 150 }); } finally { second.detach(); }
  });
});
