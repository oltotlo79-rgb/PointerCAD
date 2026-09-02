import { HOME_ORBIT, orbit, pan, zoom, type OrbitState } from './cameraMath.js';

/** 視点の正本。ビューキューブなど外側の部品もここを通してだけ視点を読み書きする。 */
export interface CameraControls {
  getOrbit(): OrbitState;
  /** ビューキューブなど、外から視点を差し替えるための入口。視点の正本はこの1箇所に置く。 */
  setOrbit(next: OrbitState): void;
  goHome(): void;
  detach(): void;
}

const LEFT_BUTTON = 0;
const MIDDLE_BUTTON = 1;

/**
 * ホイールの目盛りを画素相当へ揃える係数。
 * Firefox などは 1 目盛りを「行」「頁」で送ってくるため、そのままでは拡大縮小が効かない。
 */
const PIXELS_PER_WHEEL_LINE = 16;
const PIXELS_PER_WHEEL_PAGE = 100;

function wheelDeltaInPixels(event: WheelEvent): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * PIXELS_PER_WHEEL_LINE;
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * PIXELS_PER_WHEEL_PAGE;
  }
  return event.deltaY;
}

/**
 * ビューポートの視点操作を canvas へ結びつける(FR-101)。
 *
 * 操作の割当(要件§12 の Blender 互換ショートカットに対する P0 の決定):
 * - 視点回転: 中ボタンドラッグ / Alt + 左ボタンドラッグ
 * - 平行移動: Shift + 中ボタンドラッグ / Alt + Shift + 左ボタンドラッグ
 * - 拡大縮小: ホイール / タッチパッドの2本指スクロール / Ctrl + ホイール
 * - ホーム視点: Home キー(このビューポートに入力の焦点があるとき)
 *
 * Home キーを受けるため、呼び出し側は canvas を焦点の当たる要素にしておく(`tabIndex` を 0 以上にする)。
 * 視点が変わるたびに onChange を呼ぶ。実際の描画は呼び出し側が行う。
 */
export function attachCameraControls(
  canvas: HTMLCanvasElement,
  onChange: () => void,
): CameraControls {
  let state: OrbitState = HOME_ORBIT;
  let dragMode: 'orbit' | 'pan' | null = null;
  let lastX = 0;
  let lastY = 0;

  function beginDrag(event: PointerEvent): void {
    const isOrbitButton = event.button === MIDDLE_BUTTON && !event.shiftKey;
    const isPanButton = event.button === MIDDLE_BUTTON && event.shiftKey;
    const isAltOrbit = event.button === LEFT_BUTTON && event.altKey && !event.shiftKey;
    const isAltPan = event.button === LEFT_BUTTON && event.altKey && event.shiftKey;

    if (isOrbitButton || isAltOrbit) {
      dragMode = 'orbit';
    } else if (isPanButton || isAltPan) {
      dragMode = 'pan';
    } else {
      return;
    }

    lastX = event.clientX;
    lastY = event.clientY;
    // ビューポートの外へ出ても操作が続くようにする。
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    // 既定動作を止めると焦点が移らないので、Home キーのために自分で当てる。
    canvas.focus({ preventScroll: true });
  }

  function moveDrag(event: PointerEvent): void {
    if (dragMode === null) {
      return;
    }
    const deltaX = event.clientX - lastX;
    const deltaY = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;

    state =
      dragMode === 'orbit'
        ? orbit(state, deltaX, deltaY)
        : pan(state, deltaX, deltaY, canvas.clientHeight);
    onChange();
  }

  function endDrag(event: PointerEvent): void {
    if (dragMode === null) {
      return;
    }
    dragMode = null;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  }

  /** 捕捉が外部要因で外れたときも掴んだままにしない。 */
  function onLostPointerCapture(): void {
    dragMode = null;
  }

  function onWheel(event: WheelEvent): void {
    // Ctrl + ホイールでの頁全体の拡大や、タッチパッドの慣性スクロールを止める。
    event.preventDefault();
    state = zoom(state, wheelDeltaInPixels(event));
    onChange();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Home') {
      event.preventDefault();
      state = HOME_ORBIT;
      onChange();
    }
  }

  // 中ボタンのドラッグでブラウザの自動スクロールが始まらないようにする。
  function onMiddleButtonMouseDown(event: MouseEvent): void {
    if (event.button === MIDDLE_BUTTON) {
      event.preventDefault();
    }
  }

  function onAuxClick(event: MouseEvent): void {
    if (event.button === MIDDLE_BUTTON) {
      event.preventDefault();
    }
  }

  canvas.addEventListener('pointerdown', beginDrag);
  canvas.addEventListener('pointermove', moveDrag);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', onLostPointerCapture);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('mousedown', onMiddleButtonMouseDown);
  canvas.addEventListener('auxclick', onAuxClick);
  canvas.addEventListener('keydown', onKeyDown);

  return {
    getOrbit: () => state,
    setOrbit: (next) => {
      state = next;
      onChange();
    },
    goHome: () => {
      state = HOME_ORBIT;
      onChange();
    },
    detach: () => {
      canvas.removeEventListener('pointerdown', beginDrag);
      canvas.removeEventListener('pointermove', moveDrag);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('lostpointercapture', onLostPointerCapture);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onMiddleButtonMouseDown);
      canvas.removeEventListener('auxclick', onAuxClick);
      canvas.removeEventListener('keydown', onKeyDown);
    },
  };
}
