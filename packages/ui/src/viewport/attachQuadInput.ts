import { quadLayout, quadPointer, type QuadViewId } from './quadLayout.js';

/** 先に区画を決め、続く選択・ドラッグ・ホイールを同じ視点へ渡す。 */
export function attachQuadInput(
  canvas: HTMLCanvasElement,
  enabled: () => boolean,
  activate: (pane: QuadViewId) => void,
): () => void {
  let lockedPointer: number | null = null;
  const select = (event: MouseEvent): void => {
    if (!enabled() || lockedPointer !== null) return;
    const rect = canvas.getBoundingClientRect();
    const hit = quadPointer(quadLayout(canvas.width, canvas.height),
      { x: event.clientX - rect.left, y: event.clientY - rect.top }, rect, canvas);
    if (hit !== null) activate(hit.pane.id);
  };
  const down = (event: PointerEvent): void => {
    select(event);
    if (enabled() && lockedPointer === null) lockedPointer = event.pointerId;
  };
  const move = (event: PointerEvent): void => {
    if (event.buttons === 0) select(event);
  };
  const release = (event: PointerEvent): void => {
    if (event.pointerId === lockedPointer) lockedPointer = null;
  };
  canvas.addEventListener('pointerdown', down, true);
  canvas.addEventListener('pointermove', move, true);
  canvas.addEventListener('pointerup', release, true);
  canvas.addEventListener('pointercancel', release, true);
  canvas.addEventListener('lostpointercapture', release, true);
  canvas.addEventListener('wheel', select, { capture: true, passive: true });
  // 左クリックでcanvas外へ出た場合も、次の操作をロックしたままにしない。
  window.addEventListener('pointerup', release, true);
  return () => {
    canvas.removeEventListener('pointerdown', down, { capture: true });
    canvas.removeEventListener('pointermove', move, { capture: true });
    canvas.removeEventListener('pointerup', release, { capture: true });
    canvas.removeEventListener('pointercancel', release, { capture: true });
    canvas.removeEventListener('lostpointercapture', release, { capture: true });
    canvas.removeEventListener('wheel', select, { capture: true });
    window.removeEventListener('pointerup', release, { capture: true });
  };
}
