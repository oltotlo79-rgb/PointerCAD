import { attachWindowDrag, fitWindowPlacement, type WindowBounds, type WindowPlacement } from './draggableWindow.js';

const MARGIN = 8;
const CONTROLS = 'input, textarea, select, button, a, summary, [role="button"], [contenteditable]:not([contenteditable="false"]), math-field';

/** Retain existing absolute/fixed/modal placement; translation belongs only to this open window. */
export function attachDraggableWindow(element: HTMLElement, handle: HTMLElement): { refresh: () => void; dispose: () => void } {
  const view = element.ownerDocument.defaultView;
  if (view === null) return { refresh: () => {}, dispose: () => {} };
  const original = { translate: element.style.translate, maxWidth: element.style.maxWidth,
    maxHeight: element.style.maxHeight, overflowX: element.style.overflowX, overflowY: element.style.overflowY };
  let placement: WindowPlacement = { translation: { left: 0, top: 0 }, draggedPosition: null };
  let disposed = false;
  let frame: number | null = null;
  const parent = view.getComputedStyle(element).position === 'fixed' ? null : element.offsetParent;
  const bounds = (): WindowBounds => {
    const visual = view.visualViewport;
    let left = visual?.offsetLeft ?? 0, top = visual?.offsetTop ?? 0;
    let right = left + (visual?.width ?? element.ownerDocument.documentElement.clientWidth);
    let bottom = top + (visual?.height ?? element.ownerDocument.documentElement.clientHeight);
    // Nonmodal popovers are painted inside the CAD viewport, which clips its children.
    if (parent instanceof HTMLElement && parent !== element.ownerDocument.body) {
      const rect = parent.getBoundingClientRect();
      left = Math.max(left, rect.left + parent.clientLeft);
      top = Math.max(top, rect.top + parent.clientTop);
      right = Math.min(right, rect.left + parent.clientLeft + parent.clientWidth);
      bottom = Math.min(bottom, rect.top + parent.clientTop + parent.clientHeight);
    }
    const insetX = Math.min(MARGIN, Math.max(0, right - left) / 2);
    const insetY = Math.min(MARGIN, Math.max(0, bottom - top) / 2);
    return { left: left + insetX, top: top + insetY,
      width: Math.max(0, right - left - insetX * 2), height: Math.max(0, bottom - top - insetY * 2) };
  };
  const refresh = (): void => {
    if (disposed || element.getClientRects().length === 0) return;
    const area = bounds();
    element.style.maxWidth = `${String(area.width)}px`;
    element.style.maxHeight = `${String(area.height)}px`;
    const rect = element.getBoundingClientRect();
    placement = fitWindowPlacement(placement, rect, area);
    element.style.translate = `${String(placement.translation.left)}px ${String(placement.translation.top)}px`;
    // Preserve ordinary popup menus when the contents fit; scroll oversized forms and dialogs.
    const scroll = element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1;
    element.style.overflowX = scroll ? 'auto' : original.overflowX;
    element.style.overflowY = scroll ? 'auto' : original.overflowY;
  };
  element.classList.add('pcad-draggable-window');
  const detach = attachWindowDrag(handle, {
    view,
    position: () => element.getBoundingClientRect(),
    move: point => { placement = { ...placement, draggedPosition: point }; refresh(); },
    interactive: target => target instanceof Element && target.closest(CONTROLS) !== null,
    dragging: active => handle.classList.toggle('pcad-window-title--dragging', active),
  });
  // Resizing an observed form inside the notification itself can produce a ResizeObserver loop.
  const observer = new ResizeObserver(() => {
    if (frame !== null || disposed) return;
    frame = view.requestAnimationFrame(() => { frame = null; refresh(); });
  });
  observer.observe(element);
  if (parent instanceof Element) observer.observe(parent);
  view.addEventListener('resize', refresh);
  view.addEventListener('scroll', refresh, true);
  view.visualViewport?.addEventListener('resize', refresh);
  view.visualViewport?.addEventListener('scroll', refresh);
  refresh();
  return { refresh, dispose: () => {
    disposed = true;
    if (frame !== null) view.cancelAnimationFrame(frame);
    detach(); observer.disconnect();
    view.removeEventListener('resize', refresh);
    view.removeEventListener('scroll', refresh, true);
    view.visualViewport?.removeEventListener('resize', refresh);
    view.visualViewport?.removeEventListener('scroll', refresh);
    element.classList.remove('pcad-draggable-window');
    Object.assign(element.style, original);
  } };
}
