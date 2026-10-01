export interface WindowPoint { readonly left: number; readonly top: number }
export interface WindowBounds extends WindowPoint { readonly width: number; readonly height: number }
export interface WindowPlacement {
  readonly translation: WindowPoint;
  readonly draggedPosition: WindowPoint | null;
}

/** All dimensions are CSS pixels in the same (client) coordinate system. */
export function containWindow(point: WindowPoint, size: Pick<WindowBounds, 'width' | 'height'>, bounds: WindowBounds): WindowPoint {
  return {
    left: Math.max(bounds.left, Math.min(point.left, bounds.left + Math.max(0, bounds.width - size.width))),
    top: Math.max(bounds.top, Math.min(point.top, bounds.top + Math.max(0, bounds.height - size.height))),
  };
}

/** Account for the original CSS anchor moving (including native dialog centering) after a resize. */
export function fitWindowPlacement(placement: WindowPlacement, measured: WindowBounds, bounds: WindowBounds): WindowPlacement {
  const base = { left: measured.left - placement.translation.left, top: measured.top - placement.translation.top };
  const next = containWindow(placement.draggedPosition ?? base, measured, bounds);
  return { translation: { left: next.left - base.left, top: next.top - base.top },
    draggedPosition: placement.draggedPosition === null ? null : next };
}

type DragHandle = Pick<HTMLElement, 'addEventListener' | 'removeEventListener' | 'setPointerCapture' | 'hasPointerCapture' | 'releasePointerCapture'>;
export interface WindowDragOptions {
  readonly view: EventTarget;
  readonly position: () => WindowPoint;
  readonly move: (point: WindowPoint) => void;
  readonly interactive: (target: EventTarget | null) => boolean;
  readonly dragging: (active: boolean) => void;
}

/** The handle owns only a primary pointer gesture; it never focuses anything or handles keys. */
export function attachWindowDrag(handle: DragHandle, options: WindowDragOptions): () => void {
  let active: { readonly id: number; x: number; y: number } | null = null;
  const stop = (): void => {
    const previous = active;
    active = null;
    if (previous === null) return;
    options.dragging(false);
    if (handle.hasPointerCapture(previous.id)) handle.releasePointerCapture(previous.id);
  };
  const down = (event: PointerEvent): void => {
    if (active !== null || !event.isPrimary || event.button !== 0 || options.interactive(event.target)) return;
    handle.setPointerCapture(event.pointerId);
    active = { id: event.pointerId, x: event.clientX, y: event.clientY };
    options.dragging(true);
    // In particular, do not blur an expression field or select the heading's text.
    event.preventDefault();
    event.stopPropagation();
  };
  const move = (event: PointerEvent): void => {
    if (active === null || active.id !== event.pointerId) return;
    if ((event.buttons & 1) === 0) { stop(); return; }
    const point = options.position();
    options.move({ left: point.left + event.clientX - active.x, top: point.top + event.clientY - active.y });
    active.x = event.clientX; active.y = event.clientY;
    event.preventDefault();
    event.stopPropagation();
  };
  const up = (event: PointerEvent): void => {
    if (active === null || active.id !== event.pointerId) return;
    // Include a final movement even if the browser coalesced the last pointermove.
    const point = options.position();
    options.move({ left: point.left + event.clientX - active.x, top: point.top + event.clientY - active.y });
    event.preventDefault(); event.stopPropagation(); stop();
  };
  const cancel = (event: PointerEvent): void => {
    if (active?.id === event.pointerId) stop();
  };
  handle.addEventListener('pointerdown', down);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', cancel);
  handle.addEventListener('lostpointercapture', cancel);
  options.view.addEventListener('blur', stop);
  return () => {
    stop();
    handle.removeEventListener('pointerdown', down);
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', cancel);
    handle.removeEventListener('lostpointercapture', cancel);
    options.view.removeEventListener('blur', stop);
  };
}
