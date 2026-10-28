import { type CameraControlSettings } from '../settings/cameraControlSettings.js';
import { cameraDragAction, cameraWheelMatches } from '../viewport/cameraControlBindings.js';
import { HOME_ORBIT, MAX_DISTANCE, MIN_DISTANCE, ZOOM_FACTOR_PER_NOTCH } from '../viewport/cameraMath.js';

/** Display only: CSS pixels and a dimensionless scale, never drawing millimetres. */
export interface DrawingNavigationTransform {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}
export const INITIAL_DRAWING_NAVIGATION: DrawingNavigationTransform = { x: 0, y: 0, scale: 1 };

/** Ctrl/Shift retain ordinary selection; unmatched navigation modifiers cannot start an edit. */
export function drawingEditPointerMatches(event: Pick<PointerEvent, 'button' | 'buttons' | 'altKey' | 'metaKey'>): boolean {
  return event.button === 0 && event.buttons === 1 && !event.altKey && !event.metaKey;
}

/** Invert the actual SVG screen matrix, including the temporary CSS transform. */
export function drawingPaperPoint(matrix: Pick<DOMMatrix, 'a' | 'b' | 'c' | 'd' | 'e' | 'f'>,
  height: number, clientX: number, clientY: number): { readonly point: readonly [number, number]; readonly tolerance: number } | null {
  const { a, b, c, d, e, f } = matrix, determinant = a * d - b * c;
  if (![a, b, c, d, e, f, height, clientX, clientY, determinant].every(Number.isFinite) || determinant === 0) return null;
  const x = clientX - e, y = clientY - f;
  return { point: [(d * x - c * y) / determinant, height - (a * y - b * x) / determinant],
    tolerance: 7 / Math.max(Math.hypot(a, b), 0.01) };
}

export function zoomDrawingNavigation(current: DrawingNavigationTransform, delta: number,
  anchor: readonly [number, number]): DrawingNavigationTransform {
  if (!Number.isFinite(delta) || delta === 0 || !anchor.every(Number.isFinite)) return current;
  // Match the existing camera's zoom range relative to its home view.
  const scale = Math.max(HOME_ORBIT.distance / MAX_DISTANCE, Math.min(HOME_ORBIT.distance / MIN_DISTANCE,
    current.scale / Math.pow(ZOOM_FACTOR_PER_NOTCH, delta / 100)));
  if (scale === current.scale) return current;
  const ratio = scale / current.scale;
  return { x: current.x + anchor[0] * (1 - ratio), y: current.y + anchor[1] * (1 - ratio), scale };
}

// A small DOM surface contract also lets the input ownership be tested without a browser.
interface NavigationSurface extends EventTarget {
  setPointerCapture(id: number): void;
  hasPointerCapture(id: number): boolean;
  releasePointerCapture(id: number): void;
}
interface NavigationOptions {
  readonly view: EventTarget | null;
  readonly readSettings: () => CameraControlSettings;
  readonly canStart: (event: Event) => boolean;
  readonly sheetBounds: () => { readonly left: number; readonly top: number };
  readonly getTransform: () => DrawingNavigationTransform;
  readonly setTransform: (next: DrawingNavigationTransform) => void;
  readonly focus: () => void;
}

export function attachDrawingNavigation(surface: NavigationSurface, options: NavigationOptions): {
  cancel(): void;
  detach(): void;
  isDragging(): boolean;
} {
  let drag: { readonly action: 'pan' | 'zoom'; readonly pointer: number; readonly buttons: number;
    readonly settings: CameraControlSettings; readonly anchor: readonly [number, number]; x: number; y: number } | null = null;
  let auxiliaryButton: number | null = null;
  const own = (event: Event): void => { event.preventDefault(); event.stopImmediatePropagation(); };
  const cancel = (): void => {
    const pointer = drag?.pointer;
    drag = null;
    if (pointer !== undefined && surface.hasPointerCapture(pointer)) surface.releasePointerCapture(pointer);
  };
  const anchorAt = (x: number, y: number): readonly [number, number] => {
    const bounds = options.sheetBounds();
    return [x - bounds.left, y - bounds.top];
  };
  const down = (input: Event): void => {
    const event = input as PointerEvent;
    if (drag !== null) {
      if (event.pointerId === drag.pointer) {
        if (event.buttons !== drag.buttons) cancel();
        own(event);
      }
      return;
    }
    auxiliaryButton = null;
    if (!options.canStart(event)) return;
    const settings = options.readSettings(), action = cameraDragAction(settings, event);
    // Paper has no third dimension; an orbit binding retains no ownership here.
    if (action !== 'pan' && action !== 'zoom') return;
    drag = { action, settings, pointer: event.pointerId, buttons: event.buttons,
      x: event.clientX, y: event.clientY, anchor: anchorAt(event.clientX, event.clientY) };
    auxiliaryButton = event.button;
    surface.setPointerCapture(event.pointerId);
    options.focus();
    own(event);
  };
  const update = (event: PointerEvent): void => {
    const current = drag;
    if (current === null) return;
    const dx = event.clientX - current.x, dy = event.clientY - current.y;
    if (dx === 0 && dy === 0) return;
    const transform = options.getTransform();
    const next = current.action === 'pan' ? { ...transform, x: transform.x + dx, y: transform.y + dy }
      : zoomDrawingNavigation(transform, dy * current.settings.dragSensitivity * (current.settings.invertDrag ? -1 : 1),
        current.anchor);
    // Keep the zoom anchor fixed in screen space as its sheet-relative offset changes.
    if (current.action === 'zoom') {
      drag = { ...current, anchor: [current.anchor[0] + transform.x - next.x, current.anchor[1] + transform.y - next.y],
        x: event.clientX, y: event.clientY };
    } else { current.x = event.clientX; current.y = event.clientY; }
    if (next !== transform) options.setTransform(next);
  };
  const move = (input: Event): void => {
    const event = input as PointerEvent;
    if (drag === null || event.pointerId !== drag.pointer) return;
    if (event.buttons !== drag.buttons) cancel(); else update(event);
    own(event);
  };
  const up = (input: Event): void => {
    const event = input as PointerEvent;
    if (drag === null || event.pointerId !== drag.pointer) return;
    if (event.buttons === 0) update(event);
    cancel(); own(event);
  };
  const interrupted = (input: Event): void => {
    if (drag !== null && (input as PointerEvent).pointerId === drag.pointer) { cancel(); own(input); }
  };
  const wheel = (input: Event): void => {
    const event = input as WheelEvent, settings = options.readSettings();
    if (drag !== null || !options.canStart(event) || !cameraWheelMatches(settings, event)) return;
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
    const current = options.getTransform();
    const next = zoomDrawingNavigation(current, pixels * settings.wheelSensitivity * (settings.invertWheel ? -1 : 1),
      anchorAt(event.clientX, event.clientY));
    if (next !== current) options.setTransform(next);
    own(event);
  };
  const auxiliary = (input: Event): void => {
    const event = input as MouseEvent;
    if (auxiliaryButton === event.button && (event.button === 1 || event.button === 2)) own(event);
  };
  const key = (input: Event): void => {
    if ((input as KeyboardEvent).key === 'Escape' && drag !== null) { cancel(); own(input); }
  };
  const listeners = [
    ['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', interrupted],
    ['lostpointercapture', interrupted], ['wheel', wheel], ['mousedown', auxiliary], ['auxclick', auxiliary],
    ['contextmenu', auxiliary], ['keydown', key],
  ] as const;
  for (const [type, listener] of listeners) surface.addEventListener(type, listener, { capture: true, passive: false });
  options.view?.addEventListener('blur', cancel);
  return { cancel, isDragging: () => drag !== null, detach: () => {
    cancel();
    for (const [type, listener] of listeners) surface.removeEventListener(type, listener, true);
    options.view?.removeEventListener('blur', cancel);
  } };
}
