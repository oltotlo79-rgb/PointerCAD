import type { ViewControlSettings } from '../settings/viewControlSettings.js';
import { pinchZoomDelta, scaledOrbitDelta, scaledPanDelta, viewTouchAction } from './cameraControlBindings.js';
import { orbit, pan, zoom, zoomToward, type OrbitState } from './cameraMath.js';
import { RIGHT_DRAG_THRESHOLD_PX } from './rightPointerGesture.js';
import { createTouchGestureTracker, type TwoFingerStep } from './touchGestures.js';

/*
 * タッチ画面の指で視点を動かす(設計 2-2・B-08g・B-08h)。既定には割当が無いので、割り当てるまでは今どおり
 * (1 本目の指は作図・選択へ届き、2 本目の指は使われない)。
 *
 * 2 本指(2 本指ドラッグ・つまむ)を割り当てた時:
 * - 2 本目の指が触れたら、1 本目の指の作図の押下を取り消す(その指の pointercancel を、1 本目の押下の宛先へ送る。
 *   スケッチ・組立・図面の受け手は、取り消しを今の pointercancel と同じ道で受ける)。
 * - 2 本指の間の指の入力は、捕捉の段で受けて後ろの受け手(作図・選択・視点のドラッグ)へ渡さない。
 * - 中点の移動を平行移動か回転へ、指の間の距離の比を拡大縮小へ当てる(割当のある方だけ)。
 * - 押した時に働く道具(点を置くなど)が 1 本目の指の押下で済ませた事は、取り消しでは戻らない(元に戻すで戻す)。
 *
 * 1 本指のドラッグを割り当てた時(B-08h。統括の決定: 視点が勝つ):
 * - 1 本指の押下は後ろへすぐ渡さずに持つ。右ドラッグと同じ閾値(RIGHT_DRAG_THRESHOLD_PX)を超えて動いたら、離すまで
 *   視点のドラッグ(閾値までの動きも含める)。超えずに離したら、押下と離しを同じ宛先・同じ座標・同じ pointerId で
 *   この順に送り直す(軽く触れて離す操作は今どおり作図・選択になる。離した時の受け手の中で送るので、送り直しの押下で
 *   ポインターを捕らえる受け手もまだ指が有効な間に捕らえられる)。
 * - 割り当てている間は、1 本指で点や部品を引っぱる操作はできない(窓の注意で知らせる)。
 */

/** 視点を読み書きする口(attachCameraControls の CameraControls と、4 分割の区画の高さ・回転の可否)。 */
interface TouchCameraTarget {
  getOrbit(): OrbitState;
  setOrbit(next: OrbitState): void;
  /** 平行移動の換算に使う画面の高さ(4 分割の時は区画の高さ)。 */
  viewportHeight(): number;
  /** 回してよいか(4 分割の正投影の区画は回さない)。 */
  canOrbit(): boolean;
  /** つまむ拡大の中心の点(拡大の中心の設定がポインターの時)。決まらなければ null(注視点へ寄せる)。 */
  zoomPoint(clientX: number, clientY: number, current: OrbitState): readonly [number, number, number] | null;
  /** 軽く触れた指の送り直しの押下を受け手が止めなかった時に canvas へ焦点を当てる(持った押下の既定の動きを止めたため)。 */
  focus(): void;
}

/** 平行移動か回転の 1 回分(画素)。回してはいけない区画では回さない。 */
function draggedOrbit(current: OrbitState, settings: ViewControlSettings, action: 'orbit' | 'pan' | 'zoom' | null,
  dx: number, dy: number, target: Pick<TouchCameraTarget, 'viewportHeight' | 'canOrbit'>): OrbitState {
  if (action === 'pan') {
    const [x, y] = scaledPanDelta(settings.options, dx, dy);
    return pan(current, x, y, target.viewportHeight());
  }
  if (action === 'orbit' && target.canOrbit()) {
    const [x, y] = scaledOrbitDelta(settings.options, dx, dy);
    return orbit(current, x, y);
  }
  return current;
}

/** 2 本指の 1 回の動きを視点へ当てる(割当の無い方は動かさない)。純関数。 */
function touchMovedOrbit(current: OrbitState, settings: ViewControlSettings, step: TwoFingerStep,
  target: Pick<TouchCameraTarget, 'viewportHeight' | 'canOrbit' | 'zoomPoint'>): OrbitState {
  let next = draggedOrbit(current, settings, viewTouchAction(settings, 'twoFinger'), step.dx, step.dy, target);
  if (viewTouchAction(settings, 'pinch') === 'zoom') {
    const delta = pinchZoomDelta(step.scale);
    if (delta !== 0) {
      const point = target.zoomPoint(step.centerX, step.centerY, next);
      next = point === null ? zoom(next, delta) : zoomToward(next, delta, point);
    }
  }
  return next;
}

/** 1 本指のドラッグの 1 回の動きを視点へ当てる(B-08h)。純関数。 */
function oneFingerMovedOrbit(current: OrbitState, settings: ViewControlSettings, dx: number, dy: number,
  target: Pick<TouchCameraTarget, 'viewportHeight' | 'canOrbit'>): OrbitState {
  return draggedOrbit(current, settings, viewTouchAction(settings, 'oneFinger'), dx, dy, target);
}

/** タッチの指の出来事の読み取り(指でない・形の違う出来事は null)。型の決めつけをせずに欄を確かめる。 */
function touchInput(event: Event): { readonly event: Event; readonly id: number; readonly x: number; readonly y: number } | null {
  if (!('pointerType' in event) || event.pointerType !== 'touch' || !('pointerId' in event) || !('clientX' in event)
    || !('clientY' in event)) return null;
  const { pointerId, clientX, clientY } = event;
  return typeof pointerId === 'number' && typeof clientX === 'number' && typeof clientY === 'number'
    ? { event, id: pointerId, x: clientX, y: clientY } : null;
}

/** 指の操作の受け手(3D と図面で違う所)。 */
interface TouchGestureHandler {
  /** この設定で 2 本指の操作を始めるか(この画面で使える割当がある時だけ。無ければ今どおり)。 */
  accepts(settings: ViewControlSettings): boolean;
  /** 2 本指の 1 回の動きを当てる。 */
  step(settings: ViewControlSettings, step: TwoFingerStep): void;
  /** この設定で 1 本指の押下を持つか(この画面で使える 1 本指の割当がある時だけ。B-08h)。 */
  acceptsOneFinger(settings: ViewControlSettings): boolean;
  /** 1 本指のドラッグの 1 回の動き(画素)。 */
  drag(settings: ViewControlSettings, dx: number, dy: number): void;
  /** 軽く触れた指の送り直しの押下を受け手が止めなかった時に焦点を当てる(押下の既定の動きの代わり)。 */
  focus(): void;
}

/** canvas へ結ぶ(3D の視点)。返り値で外す。 */
export function attachTouchCamera(canvas: EventTarget, target: TouchCameraTarget, readSettings: () => ViewControlSettings): () => void {
  return attachTouchGestureInput(canvas, readSettings, {
    accepts: settings => viewTouchAction(settings, 'twoFinger') !== null || viewTouchAction(settings, 'pinch') !== null,
    step: (settings, step) => { target.setOrbit(touchMovedOrbit(target.getOrbit(), settings, step, target)); },
    acceptsOneFinger: settings => viewTouchAction(settings, 'oneFinger') !== null,
    drag: (settings, dx, dy) => { target.setOrbit(oneFingerMovedOrbit(target.getOrbit(), settings, dx, dy, target)); },
    focus: () => { target.focus(); },
  });
}

/** 持っている 1 本指(まだ後ろへ渡していない押下)。 */
interface HeldFinger {
  readonly id: number;
  readonly target: EventTarget;
  readonly settings: ViewControlSettings;
  readonly downX: number;
  readonly downY: number;
  /** ドラッグの前回の位置(閾値を超えるまでは押した所のまま。閾値までの動きもドラッグに含める)。 */
  x: number;
  y: number;
  dragging: boolean;
}

/** 送り直し・取り消しの出来事(PointerEvent の欄だけを持つ出来事。受け手は欄を読む)。 */
function touchEvent(type: string, id: number, x: number, y: number, buttons: number): Event {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), { pointerId: id, pointerType: 'touch', isPrimary: true,
    button: 0, buttons, clientX: x, clientY: y, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false });
}

/**
 * 指の出来事を捕捉の段で受ける共通の口(3D の canvas と図面の面)。2 本目の指で 1 本目の指の押下を取り消し、
 * 2 本指の間の指の出来事は後ろへ渡さない。1 本指の割当がある時は 1 本指の押下を持つ。返り値で外す。
 */
export function attachTouchGestureInput(surface: EventTarget, readSettings: () => ViewControlSettings,
  handler: TouchGestureHandler): () => void {
  const tracker = createTouchGestureTracker();
  /** この 2 本指の操作で使う設定(2 本目の指の時に 1 回読む)。null は割当が無い(今どおり)。 */
  let gesture: ViewControlSettings | null = null;
  /** 後ろへ渡した 1 本目の指(id と押下の宛先。取り消しはその宛先へ送り、後ろの受け手と同じ道で届ける)。 */
  let first: { readonly id: number; readonly target: EventTarget } | null = null;
  let held: HeldFinger | null = null;
  /** 自分で取り消し・送り直しを送っている間(自分の受け手は数えない)。dispatchEvent は同期に届く。 */
  let forwarding = false;
  const swallow = (event: Event): void => { event.preventDefault(); event.stopImmediatePropagation(); };
  const forward = (target: EventTarget, events: readonly Event[]): void => {
    forwarding = true;
    try { for (const event of events) target.dispatchEvent(event); } finally { forwarding = false; }
  };
  const reset = (): void => { if (!tracker.active() && held === null) { gesture = null; first = null; } };

  const onDown = (raw: Event): void => {
    const input = touchInput(raw);
    if (input === null || forwarding) return;
    const answer = tracker.down(input);
    if (answer === 'first') {
      gesture = null;
      const settings = readSettings(), target = raw.target ?? surface;
      if (!handler.acceptsOneFinger(settings)) { first = { id: input.id, target }; return; }
      held = { id: input.id, target, settings, downX: input.x, downY: input.y, x: input.x, y: input.y, dragging: false };
      first = null;
      swallow(raw);
      return;
    }
    if (answer === 'second') {
      const settings = readSettings();
      if (handler.accepts(settings)) {
        gesture = settings;
        swallow(raw);
        // 持っている指は後ろへ渡していないので取り消さない。渡した指だけ取り消す。
        if (held === null && first !== null) forward(first.target, [touchEvent('pointercancel', first.id, input.x, input.y, 0)]);
        held = null;
        return;
      }
    }
    if (gesture !== null || held !== null) swallow(raw);
  };
  const onMove = (raw: Event): void => {
    const input = touchInput(raw);
    if (input === null || forwarding) return;
    const step = tracker.move(input);
    if (held !== null) {
      swallow(raw);
      if (input.id !== held.id) return;
      if (!held.dragging && Math.hypot(input.x - held.downX, input.y - held.downY) > RIGHT_DRAG_THRESHOLD_PX) held.dragging = true;
      if (!held.dragging) return;
      handler.drag(held.settings, input.x - held.x, input.y - held.y);
      held.x = input.x; held.y = input.y;
      return;
    }
    if (gesture === null || !tracker.active()) return;
    swallow(raw);
    if (step !== null) handler.step(gesture, step);
  };
  const onUp = (raw: Event): void => {
    const input = touchInput(raw);
    if (input === null || forwarding) return;
    const inGesture = gesture !== null && tracker.active();
    tracker.up(input.id);
    if (held !== null) {
      swallow(raw);
      if (input.id === held.id) {
        const finger = held;
        held = null;
        // 超えずに離した(軽く触れた): 押下と離しを、同じ宛先・同じ座標・同じ pointerId でこの順に 1 回ずつ送り直す。
        // 押下の既定の動き(焦点を移す)は、受け手が止めなかった時だけ真似る(作図の欄は押下を止めて欄に焦点を残す)。
        if (!finger.dragging && raw.type === 'pointerup') {
          const down = touchEvent('pointerdown', finger.id, finger.downX, finger.downY, 1);
          forward(finger.target, [down]);
          if (!down.defaultPrevented) handler.focus();
          forward(finger.target, [touchEvent('pointerup', finger.id, input.x, input.y, 0)]);
        }
      }
      reset();
      return;
    }
    // 2 本指の操作の指の離し・取り消しは後ろへ渡さない(残った指で作図を始めない)。
    if (inGesture) swallow(raw);
    reset();
  };

  const listeners = [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp]] as const;
  // 外す時も { capture: true } の形で渡す(真偽値の true は Node の EventTarget では捕捉の段として照らされない)。
  const capture = { capture: true } as const;
  for (const [type, listener] of listeners) surface.addEventListener(type, listener, capture);
  return () => { for (const [type, listener] of listeners) surface.removeEventListener(type, listener, capture); };
}
