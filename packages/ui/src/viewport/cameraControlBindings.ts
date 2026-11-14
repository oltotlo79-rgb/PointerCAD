import { VIEW_ACTIONS, type ViewAction, type ViewControlOptions, type ViewControlSettings, type ViewTrigger } from '../settings/viewControlSettings.js';

/*
 * 入力から視点の操作への判定と、速さ・向きの換算(FR-101)。3D(attachCameraControls)・図面(attachDrawingNavigation)・
 * ビューキューブのドラッグ・下絵の寸法合わせは、ここの純関数だけを呼ぶ(同じ入力は同じ操作になる)。
 * 図面は回転を使わない(呼び手が回転の結果を受けない)。
 */

type Modifiers = Pick<MouseEvent, 'altKey' | 'shiftKey' | 'ctrlKey' | 'metaKey'>;
export function cameraModifiersMatch(binding: Pick<ViewTrigger, 'alt' | 'shift' | 'ctrl' | 'meta'>, event: Modifiers): boolean {
  return binding.alt === event.altKey && binding.shift === event.shiftKey
    && binding.ctrl === event.ctrlKey && binding.meta === event.metaKey;
}

/** 押したボタンと修飾キーが完全に一致したドラッグの割当の操作。ほかのボタンを同時に押していれば当たらない。 */
export function viewDragAction(settings: ViewControlSettings,
  event: Modifiers & Pick<PointerEvent, 'pointerType' | 'button' | 'buttons'>): ViewAction | null {
  if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return null;
  const button = event.button === 0 ? 'left' : event.button === 1 ? 'middle' : event.button === 2 ? 'right' : null;
  const buttons = button === 'left' ? 1 : button === 'middle' ? 4 : button === 'right' ? 2 : 0;
  if (button === null || event.buttons !== buttons) return null;
  return VIEW_ACTIONS.find(action => settings.bindings[action].some(trigger => trigger.kind === 'drag'
    && trigger.button === button && cameraModifiersMatch(trigger, event))) ?? null;
}

/** 修飾キーが完全に一致したホイールの割当の操作。ボタンを押している間(ドラッグ中)は当たらない。 */
export function viewWheelAction(settings: ViewControlSettings, event: Modifiers & Pick<WheelEvent, 'buttons'>): ViewAction | null {
  if (event.buttons !== 0) return null;
  return VIEW_ACTIONS.find(action => settings.bindings[action].some(trigger => trigger.kind === 'wheel'
    && cameraModifiersMatch(trigger, event))) ?? null;
}

/**
 * ホイールの目盛りを画素相当へ揃える係数(1 か所)。
 * Firefox などは 1 目盛りを「行」「頁」で送ってくるため、そのままでは拡大縮小が効かない。
 */
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
const PIXELS_PER_WHEEL_LINE = 16;
const PIXELS_PER_WHEEL_PAGE = 100;

/** ホイールの縦と横の量(画素相当)。知らない単位は画素として扱う。 */
function wheelDeltaInPixels(event: Pick<WheelEvent, 'deltaMode' | 'deltaX' | 'deltaY'>): { readonly dx: number; readonly dy: number } {
  const scale = event.deltaMode === DOM_DELTA_LINE ? PIXELS_PER_WHEEL_LINE : event.deltaMode === DOM_DELTA_PAGE ? PIXELS_PER_WHEEL_PAGE : 1;
  return { dx: event.deltaX * scale, dy: event.deltaY * scale };
}

/**
 * ホイールの拡大縮小の量。縦の量を使う。ブラウザーが Shift＋ホイールを横の量へ振り替えた時(縦が 0 で Shift)だけ
 * 横の量を使う(修飾の無い横スクロールで拡大縮小しない今の動きを保つ)。
 */
export function wheelZoomDelta(options: ViewControlOptions, event: Pick<WheelEvent, 'deltaMode' | 'deltaX' | 'deltaY' | 'shiftKey'>): number {
  const { dx, dy } = wheelDeltaInPixels(event);
  return (dy === 0 && event.shiftKey ? dx : dy) * options.wheelSensitivity * (options.invertWheel ? -1 : 1);
}

/** ドラッグの拡大縮小の量(縦の移動だけを使う)。 */
export function dragZoomDelta(options: ViewControlOptions, deltaY: number): number {
  return deltaY * options.zoomDragSensitivity * (options.invertZoomDrag ? -1 : 1);
}

/** 回転の量に速さと左右・上下の反転を掛ける。既定(1 倍・反転なし)では入力と同じ値になる。 */
export function scaledOrbitDelta(options: ViewControlOptions, dx: number, dy: number): readonly [number, number] {
  return [dx * options.orbitSensitivity * (options.invertOrbitX ? -1 : 1), dy * options.orbitSensitivity * (options.invertOrbitY ? -1 : 1)];
}

/** 平行移動の量に速さを掛ける。既定(1 倍)では入力と同じ値になる。 */
export function scaledPanDelta(options: ViewControlOptions, dx: number, dy: number): readonly [number, number] {
  return [dx * options.panSensitivity, dy * options.panSensitivity];
}

/**
 * ホイールで回転・平行移動する時の、ドラッグに相当する画面上の移動。ページを送る向き(下へ送ると内容が上へ動く)に
 * 合わせ、縦と横の量の符号を反転する。
 */
export function wheelDragEquivalent(event: Pick<WheelEvent, 'deltaMode' | 'deltaX' | 'deltaY'>): readonly [number, number] {
  const { dx, dy } = wheelDeltaInPixels(event);
  return [-dx, -dy];
}
