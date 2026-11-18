import {
  VIEW_ACTIONS, viewKeyStepDegrees, type ViewAction, type ViewControlOptions, type ViewControlSettings, type ViewKeyGroup,
  type ViewPenButton, type ViewTouchGesture, type ViewTrigger,
} from '../settings/viewControlSettings.js';
import { ORBIT_RADIANS_PER_PIXEL, ZOOM_FACTOR_PER_NOTCH } from './cameraMath.js';

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

type DragButton = Extract<ViewTrigger, { readonly kind: 'drag' }>['button'];

function dragActionFor(settings: ViewControlSettings, button: DragButton, event: Modifiers): ViewAction | null {
  return VIEW_ACTIONS.find(action => settings.bindings[action].some(trigger => trigger.kind === 'drag'
    && trigger.button === button && cameraModifiersMatch(trigger, event))) ?? null;
}

/** ペンの側面のボタン(button 2・押下の印 2)と消しゴムの端(button 5・押下の印 32)。 */
const PEN_INPUTS: Readonly<Record<number, { readonly button: ViewPenButton; readonly buttons: number }>> = {
  2: { button: 'penBarrel', buttons: 2 }, 5: { button: 'penEraser', buttons: 32 },
};

/**
 * ペンの側面のボタン・消しゴムの端の割当の操作(B-09 3-4)。決まらなければ undefined(マウスと同じ判定へ進む)。
 * 側面のボタンをどの操作にも割り当てていない時は、今までどおり右ボタンとして扱う(既定の動きを変えない)。
 */
function penDragAction(settings: ViewControlSettings,
  event: Modifiers & Pick<PointerEvent, 'button' | 'buttons'>): ViewAction | null | undefined {
  const pen = PEN_INPUTS[event.button];
  if (pen === undefined) return undefined;
  const assigned = VIEW_ACTIONS.some(action => settings.bindings[action].some(trigger => trigger.kind === 'drag' && trigger.button === pen.button));
  if (pen.button === 'penBarrel' && !assigned) return undefined;
  return event.buttons === pen.buttons ? dragActionFor(settings, pen.button, event) : null;
}

/** 押したボタンと修飾キーが完全に一致したドラッグの割当の操作。ほかのボタンを同時に押していれば当たらない。 */
export function viewDragAction(settings: ViewControlSettings,
  event: Modifiers & Pick<PointerEvent, 'pointerType' | 'button' | 'buttons'>): ViewAction | null {
  if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return null;
  const pen = event.pointerType === 'pen' ? penDragAction(settings, event) : undefined;
  if (pen !== undefined) return pen;
  const button = event.button === 0 ? 'left' : event.button === 1 ? 'middle' : event.button === 2 ? 'right' : null;
  const buttons = button === 'left' ? 1 : button === 'middle' ? 4 : button === 'right' ? 2 : 0;
  if (button === null || event.buttons !== buttons) return null;
  return dragActionFor(settings, button, event);
}

/** タッチの指の操作(2 本指ドラッグ・つまむ。B-08g)の割当の操作。割当が無ければ null(既定は無し)。 */
export function viewTouchAction(settings: ViewControlSettings, gesture: ViewTouchGesture): ViewAction | null {
  return VIEW_ACTIONS.find(action => settings.bindings[action].some(trigger => trigger.kind === 'touch'
    && trigger.gesture === gesture)) ?? null;
}

/**
 * つまむ拡大の量を、ホイールの量(zoom・zoomToward の wheelDeltaY)で表す。指の間の距離の比 scale の逆数だけ距離が
 * 変わる(広げると近づく。指の下の物が指についてくる)。速さと反転は掛けない(直接さわる操作のため)。
 * 比が正の有限の数でなければ 0(動かさない)。
 */
export function pinchZoomDelta(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 0;
  return -100 * Math.log(scale) / Math.log(ZOOM_FACTOR_PER_NOTCH);
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

/**
 * キーで視点を動かす入力(第 2 段、B-08)。物理の位置(KeyboardEvent.code)ごとの組と、ドラッグに相当する向き(右・下が正)。
 * ＋はホイールを上へ回すのと同じ拡大、−は縮小。押している間はキーの繰り返しで同じ量ずつ動かす。
 */
const KEY_MOVES: Readonly<Record<string, { readonly group: ViewKeyGroup; readonly direction: readonly [number, number] }>> = {
  ArrowLeft: { group: 'arrows', direction: [-1, 0] }, ArrowRight: { group: 'arrows', direction: [1, 0] },
  ArrowUp: { group: 'arrows', direction: [0, -1] }, ArrowDown: { group: 'arrows', direction: [0, 1] },
  Numpad4: { group: 'numpad', direction: [-1, 0] }, Numpad6: { group: 'numpad', direction: [1, 0] },
  Numpad8: { group: 'numpad', direction: [0, -1] }, Numpad2: { group: 'numpad', direction: [0, 1] },
  NumpadAdd: { group: 'plusMinus', direction: [0, -1] }, Equal: { group: 'plusMinus', direction: [0, -1] },
  NumpadSubtract: { group: 'plusMinus', direction: [0, 1] }, Minus: { group: 'plusMinus', direction: [0, 1] },
};
/** キー 1 回で平行移動する画面の画素(平行移動の速さを掛ける)。 */
export const KEY_PAN_PIXELS = 40;
/** キー 1 回の拡大縮小(ホイール 1 目盛りの量。ホイールの速さと反転を掛ける)。 */
const KEY_ZOOM_WHEEL_DELTA = 100;

interface ViewKeyMove {
  readonly action: ViewAction;
  /** ドラッグに相当する向き(-1・0・1)。拡大縮小は縦だけを使う。 */
  readonly direction: readonly [number, number];
}

/** 押したキーと修飾キーが完全に一致したキーの割当の操作と向き。割当が無いキーは null。 */
export function viewKeyMove(settings: ViewControlSettings, event: Modifiers & Pick<KeyboardEvent, 'code'>): ViewKeyMove | null {
  const move = KEY_MOVES[event.code];
  if (move === undefined) return null;
  const action = VIEW_ACTIONS.find(candidate => settings.bindings[candidate].some(trigger => trigger.kind === 'keys'
    && trigger.keys === move.group && cameraModifiersMatch(trigger, event)));
  return action === undefined ? null : { action, direction: move.direction };
}

/**
 * キー 1 回の回転を、ドラッグに相当する画素で表す(角度 ÷ 1 画素の角度)。呼び手が scaledOrbitDelta で回転の速さと反転を
 * 掛けるので、ここで速さを割り戻す(設定の「キーで回す角度」がそのまま 1 回の角度になる。反転は効く)。
 */
export function keyOrbitPixels(options: ViewControlOptions): number {
  return viewKeyStepDegrees(options) * Math.PI / 180 / ORBIT_RADIANS_PER_PIXEL / options.orbitSensitivity;
}

/** キー 1 回の拡大縮小の量(向き -1 が拡大)。ホイールの速さと反転を掛ける。 */
export function keyZoomDelta(options: ViewControlOptions, direction: number): number {
  return direction * KEY_ZOOM_WHEEL_DELTA * options.wheelSensitivity * (options.invertWheel ? -1 : 1);
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
