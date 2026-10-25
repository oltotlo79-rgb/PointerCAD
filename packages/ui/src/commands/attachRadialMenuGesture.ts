import { beginRadialMenuGesture, finishRadialMenuGesture, moveRadialMenuGesture, type RadialMenuGesture } from './radialMenuGesture.js';
import { placeRadialMenu, type RadialMenuSlot, type ScreenBounds, type ScreenPoint } from './radialMenuGeometry.js';
import { exceedsRightDragThreshold, isPlainRightPointer } from '../viewport/rightPointerGesture.js';

export interface RadialMenuAttachmentOptions {
  /** Reference identity of the current document; an edit or switch cancels a held gesture. */
  readonly owner: () => object;
  readonly blocked: () => boolean;
  readonly show: (gesture: RadialMenuGesture | null, latched?: boolean, preserveFocus?: boolean) => void;
  readonly choose: (slot: RadialMenuSlot) => void;
  /** Opened buttons use their visible hit area; a held right gesture uses sectors. */
  readonly clickSlot?: (point: ScreenPoint) => RadialMenuSlot | null;
  /** Latched DOM buttons retain their ordinary pointer and click sequence. */
  readonly nativeClickTarget?: (target: EventTarget | null) => boolean;
  readonly scale?: () => number;
  /** In 3D, the camera owns right drags; open only after a stationary right release. */
  readonly clickOnly?: boolean;
  readonly allowSelectionModifiers?: () => boolean;
}

/** Right drag chooses on release; a short right click leaves the menu for a subsequent left click. */
export function attachRadialMenuGesture(
  surface: HTMLElement | SVGElement, options: RadialMenuAttachmentOptions,
): { readonly cancel: () => void; readonly choose: (slot: RadialMenuSlot) => void;
  readonly fit: (bounds: ScreenBounds) => void; readonly detach: () => void } {
  const view = surface.ownerDocument.defaultView;
  if (view === null) return { cancel: () => {}, choose: () => {}, fit: () => {}, detach: () => {} };
  // HTML and SVG share these typed DOM events; keep one registration contract.
  const surfaceEvents: GlobalEventHandlers = surface;
  const captureOptions = { capture: true };
  const wheelOptions = { capture: true, passive: false };
  let active: { readonly gesture: RadialMenuGesture; readonly owner: object; readonly start: ScreenPoint;
    readonly holding: 'right' | 'left' | 'native' | null; readonly moved: boolean; readonly clicked?: RadialMenuSlot | null;
    readonly nativeTarget?: EventTarget | null } | null = null;
  let pending: { readonly gesture: RadialMenuGesture; readonly owner: object; readonly start: ScreenPoint } | null = null;

  const cancel = (): void => {
    pending = null;
    const previous = active;
    active = null;
    if (previous === null) return;
    options.show(null);
    if (surface.hasPointerCapture(previous.gesture.pointerId)) surface.releasePointerCapture(previous.gesture.pointerId);
    if (surface.isConnected) surface.focus({ preventScroll: true });
  };
  const stop = (event: Event): void => { event.preventDefault(); event.stopImmediatePropagation(); };
  const changed = (): boolean => active !== null && (options.blocked() || options.owner() !== active.owner);
  const choose = (slot: RadialMenuSlot): void => {
    const allowed = active !== null && !changed();
    cancel();
    if (allowed) options.choose(slot);
  };
  const down = (event: PointerEvent): void => {
    const modifiedClick = options.clickOnly === true && options.allowSelectionModifiers?.() === true
      && event.button === 2 && event.buttons === 2 && event.pointerType === 'mouse' && !event.altKey && !event.metaKey;
    if ((!isPlainRightPointer(event) && !modifiedClick) || options.blocked()) return;
    cancel();
    const bounds = surface.getBoundingClientRect();
    const scale = options.scale?.() ?? 1;
    if (!Number.isFinite(scale) || scale <= 0) return;
    const geometry = placeRadialMenu({ x: event.clientX, y: event.clientY },
      { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height - 80 * scale }, 152 * scale, 32 * scale);
    if (geometry === null) return;
    const gesture = beginRadialMenuGesture({ x: event.clientX, y: event.clientY }, event.pointerId, geometry);
    if (options.clickOnly === true) {
      pending = { gesture, owner: options.owner(), start: { x: event.clientX, y: event.clientY } };
      return;
    }
    stop(event);
    active = { gesture, owner: options.owner(), start: { x: event.clientX, y: event.clientY }, holding: 'right', moved: false };
    surface.setPointerCapture(event.pointerId);
    surface.focus({ preventScroll: true });
    options.show(gesture);
  };
  const nextDown = (event: PointerEvent): void => {
    if (pending !== null && event.pointerId === pending.gesture.pointerId) pending = null;
    if (active === null || event.pointerId !== active.gesture.pointerId) return;
    if (active.holding !== null) { cancel(); return; }
    if (event.button !== 0 || event.buttons !== 1 || event.altKey || event.metaKey
      || ((event.ctrlKey || event.shiftKey) && options.allowSelectionModifiers?.() !== true)) {
      cancel(); return;
    }
    if (changed()) { cancel(); return; }
    if (options.nativeClickTarget?.(event.target)) {
      active = { ...active, holding: 'native', nativeTarget: event.target };
      return;
    }
    stop(event);
    // A deliberate click on the visible menu needs no centre-crossing gesture at a screen edge.
    const gesture = moveRadialMenuGesture({ ...active.gesture, armed: true }, event.pointerId, { x: event.clientX, y: event.clientY });
    active = { ...active, gesture, holding: 'left', moved: true,
      ...(options.clickSlot === undefined ? {} : { clicked: options.clickSlot({ x: event.clientX, y: event.clientY }) }) };
    surface.setPointerCapture(event.pointerId);
    options.show(gesture);
  };
  const move = (event: PointerEvent): void => {
    if (pending !== null && event.pointerId === pending.gesture.pointerId) {
      if (options.blocked() || options.owner() !== pending.owner || event.buttons !== 2
        || exceedsRightDragThreshold(pending.start, event)) pending = null;
      return;
    }
    if (active === null || event.pointerId !== active.gesture.pointerId) return;
    if (active.holding === 'native') {
      if (changed() || event.buttons !== 1) cancel();
      return;
    }
    stop(event);
    const expectedButtons = active.holding === 'right' ? 2 : active.holding === 'left' ? 1 : 0;
    if (changed() || event.buttons !== expectedButtons) { cancel(); return; }
    let gesture = moveRadialMenuGesture(active.gesture, event.pointerId, { x: event.clientX, y: event.clientY });
    if (active.holding !== 'right' && options.clickSlot !== undefined) {
      gesture = { ...gesture, selected: options.clickSlot({ x: event.clientX, y: event.clientY }) };
    }
    active = { ...active, gesture, moved: active.moved || exceedsRightDragThreshold(active.start, event) };
    options.show(gesture, active.holding === null);
  };
  const up = (event: PointerEvent): void => {
    if (pending !== null && event.pointerId === pending.gesture.pointerId) {
      const click = pending;
      pending = null;
      if (!options.blocked() && options.owner() === click.owner && event.button === 2 && event.buttons === 0
        && !exceedsRightDragThreshold(click.start, event)) {
        active = { ...click, holding: null, moved: false };
        options.show(click.gesture, true);
      }
      // Do not consume the release: the camera still owns pointer capture.
      return;
    }
    if (active === null || event.pointerId !== active.gesture.pointerId) return;
    if (active.holding === 'native') {
      if (changed() || event.button !== 0 || event.buttons !== 0 || event.target !== active.nativeTarget) cancel();
      else active = { ...active, holding: null };
      return;
    }
    stop(event);
    if (active.holding === null) return;
    if (!changed() && active.holding === 'right' && !active.moved && event.button === 2 && event.buttons === 0
      && !exceedsRightDragThreshold(active.start, event)) {
      // Keep the visible menu after a click, but release native pointer ownership.
      active = { ...active, holding: null };
      if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
      options.show(active.gesture, true);
      return;
    }
    const invalid = changed() || event.button !== (active.holding === 'right' ? 2 : 0) || event.buttons !== 0;
    const released = active.holding === 'left' ? options.clickSlot?.({ x: event.clientX, y: event.clientY }) : undefined;
    const slot = released !== undefined ? !invalid && released === active.clicked ? released : null
      : finishRadialMenuGesture(active.gesture, event.pointerId,
        { x: event.clientX, y: event.clientY }, invalid);
    cancel();
    if (slot !== null) options.choose(slot);
  };
  const cancelled = (event: PointerEvent): void => {
    if (event.pointerId === pending?.gesture.pointerId) pending = null;
    if (event.pointerId === active?.gesture.pointerId && (event.type !== 'lostpointercapture' || active.holding !== null)) cancel();
  };
  const key = (event: KeyboardEvent): void => {
    if ((event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) && event.target === surface
      && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing && !event.repeat && !options.blocked()) {
      cancel();
      const bounds = surface.getBoundingClientRect(), scale = options.scale?.() ?? 1;
      const centre = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      const geometry = placeRadialMenu(centre,
        { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height - 80 * scale }, 152 * scale, 32 * scale);
      if (geometry === null) return;
      stop(event);
      const gesture = beginRadialMenuGesture(centre, -1, geometry);
      active = { gesture, owner: options.owner(), start: centre, holding: null, moved: false };
      options.show(gesture, true);
      return;
    }
    pending = null;
    if (active === null) return;
    // The opened menu retains ordinary keyboard navigation and activation.
    if (event.key === 'Escape') stop(event);
    else if (active.holding === null && event.target instanceof Element && event.target.closest('.pcad-radial-menu') !== null) return;
    cancel();
  };
  const wheel = (event: WheelEvent): void => { pending = null; if (active !== null) stop(event); };
  const context = (event: MouseEvent): void => {
    if (!event.altKey && !event.metaKey && (!event.ctrlKey && !event.shiftKey || options.allowSelectionModifiers?.() === true)
      && !options.blocked()) event.preventDefault();
  };
  // The translated hint can be taller than the initial allowance. Move both visible geometry
  // and gesture sectors together, using the rendered menu and the actual owning surface.
  const fit = (rendered: ScreenBounds): void => {
    if (active === null) return;
    const previous = active.gesture.geometry, radius = previous.outerRadius;
    const bounds = surface.getBoundingClientRect();
    const extraLeft = Math.max(0, previous.center.x - radius - rendered.left);
    const extraTop = Math.max(0, previous.center.y - radius - rendered.top);
    const extraRight = Math.max(0, rendered.left + rendered.width - previous.center.x - radius);
    const extraBottom = Math.max(0, rendered.top + rendered.height - previous.center.y - radius);
    const geometry = placeRadialMenu(previous.center,
      { left: bounds.left + extraLeft, top: bounds.top + extraTop,
        width: bounds.width - extraLeft - extraRight, height: bounds.height - extraTop - extraBottom },
      radius, previous.cancelRadius);
    if (geometry === null) { cancel(); return; }
    if (Math.abs(geometry.center.x - previous.center.x) < 0.5 && Math.abs(geometry.center.y - previous.center.y) < 0.5) return;
    active = { ...active, gesture: { ...active.gesture, geometry, selected: null } };
    options.show(active.gesture, active.holding === null, true);
  };

  surfaceEvents.addEventListener('pointerdown', down, captureOptions);
  surfaceEvents.addEventListener('contextmenu', context);
  view.addEventListener('pointerdown', nextDown, captureOptions);
  view.addEventListener('pointermove', move, captureOptions);
  view.addEventListener('pointerup', up, captureOptions);
  view.addEventListener('pointercancel', cancelled, captureOptions);
  surfaceEvents.addEventListener('lostpointercapture', cancelled);
  view.addEventListener('keydown', key, captureOptions);
  view.addEventListener('wheel', wheel, wheelOptions);
  view.addEventListener('blur', cancel);
  view.addEventListener('resize', cancel);
  return { cancel, choose, fit, detach: () => {
    cancel();
    surfaceEvents.removeEventListener('pointerdown', down, captureOptions);
    surfaceEvents.removeEventListener('contextmenu', context);
    view.removeEventListener('pointerdown', nextDown, captureOptions);
    view.removeEventListener('pointermove', move, captureOptions);
    view.removeEventListener('pointerup', up, captureOptions);
    view.removeEventListener('pointercancel', cancelled, captureOptions);
    surfaceEvents.removeEventListener('lostpointercapture', cancelled);
    view.removeEventListener('keydown', key, captureOptions);
    view.removeEventListener('wheel', wheel, wheelOptions);
    view.removeEventListener('blur', cancel);
    view.removeEventListener('resize', cancel);
  } };
}
