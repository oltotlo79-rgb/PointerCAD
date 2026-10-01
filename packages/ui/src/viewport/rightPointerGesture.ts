/** A click may drift by six CSS pixels; once exceeded, returning to the start remains a drag. */
export const RIGHT_DRAG_THRESHOLD_PX = 6;

export function isPlainRightPointer(event: PointerEvent): boolean {
  return event.button === 2 && event.buttons === 2 && event.pointerType === 'mouse'
    && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
}

export function exceedsRightDragThreshold(start: { readonly x: number; readonly y: number }, event: PointerEvent): boolean {
  return Math.hypot(event.clientX - start.x, event.clientY - start.y) > RIGHT_DRAG_THRESHOLD_PX;
}
