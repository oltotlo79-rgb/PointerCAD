import type { ViewControlSettings } from '../settings/viewControlSettings.js';
import { attachTouchGestureInput } from '../viewport/attachTouchCamera.js';
import { pinchZoomDelta, scaledPanDelta, viewTouchAction } from '../viewport/cameraControlBindings.js';
import type { TwoFingerStep } from '../viewport/touchGestures.js';
import { zoomDrawingNavigation, type DrawingNavigationTransform } from './drawingNavigation.js';

/*
 * 図面の紙の 2 本指(設計 2-2・B-08g の続き)。3D と同じ割当と同じ指の読み取り(touchGestures.ts・attachTouchGestureInput)
 * を使う。紙は回さないので、2 本指は平行移動の割当の時だけ紙を動かし(回転の割当の時は紙の上では何もしない。ドラッグと
 * ホイールの回転の割当と同じ扱い)、つまむは拡大縮小(中心は指の中点)。どちらも割り当てていなければ今どおり。
 * 1 本指のドラッグ(B-08h)は平行移動の割当の時だけ紙を動かす(押下の持ち方と送り直しは attachTouchGestureInput)。
 */

/** 紙の上で 2 本指の操作を始めるか(紙に使える割当がある時だけ)。 */
function drawingAcceptsTouch(settings: ViewControlSettings): boolean {
  return viewTouchAction(settings, 'twoFinger') === 'pan' || viewTouchAction(settings, 'pinch') === 'zoom';
}

/** 2 本指の 1 回の動きを紙の表示へ当てる。anchor はつまむ拡大の中心(紙の面の左上からの画素)。純関数。 */
function touchMovedDrawing(current: DrawingNavigationTransform, settings: ViewControlSettings, step: TwoFingerStep,
  anchor: readonly [number, number]): DrawingNavigationTransform {
  let next = current;
  if (viewTouchAction(settings, 'twoFinger') === 'pan') {
    const [dx, dy] = scaledPanDelta(settings.options, step.dx, step.dy);
    if (dx !== 0 || dy !== 0) next = { ...next, x: next.x + dx, y: next.y + dy };
  }
  if (viewTouchAction(settings, 'pinch') === 'zoom') next = zoomDrawingNavigation(next, pinchZoomDelta(step.scale), anchor);
  return next;
}

/** 紙の上で 1 本指の押下を持つか(1 本指を平行移動に割り当てた時だけ。紙は回さない。B-08h)。 */
function drawingAcceptsOneFinger(settings: ViewControlSettings): boolean {
  return viewTouchAction(settings, 'oneFinger') === 'pan';
}

/** 紙の面へ結ぶ口(attachDrawingNavigation の選び値の一部)。 */
interface DrawingTouchOptions {
  readonly readSettings: () => ViewControlSettings;
  readonly sheetBounds: () => { readonly left: number; readonly top: number };
  readonly getTransform: () => DrawingNavigationTransform;
  readonly setTransform: (next: DrawingNavigationTransform) => void;
  /** 軽く触れた指の送り直しの押下を受け手が止めなかった時に紙へ焦点を当てる。 */
  readonly focus: () => void;
}

/** 紙の面へ結ぶ(捕捉の段)。返り値で外す。 */
export function attachDrawingTouch(surface: EventTarget, options: DrawingTouchOptions): () => void {
  const apply = (next: DrawingNavigationTransform, current: DrawingNavigationTransform): void => {
    if (next !== current && [next.x, next.y, next.scale].every(value => Number.isFinite(value))) options.setTransform(next);
  };
  return attachTouchGestureInput(surface, options.readSettings, {
    accepts: drawingAcceptsTouch,
    step: (settings, step) => {
      const bounds = options.sheetBounds(), current = options.getTransform();
      apply(touchMovedDrawing(current, settings, step, [step.centerX - bounds.left, step.centerY - bounds.top]), current);
    },
    acceptsOneFinger: drawingAcceptsOneFinger,
    drag: (settings, dx, dy) => {
      const current = options.getTransform(), [x, y] = scaledPanDelta(settings.options, dx, dy);
      apply(x === 0 && y === 0 ? current : { ...current, x: current.x + x, y: current.y + y }, current);
    },
    focus: options.focus,
  });
}
