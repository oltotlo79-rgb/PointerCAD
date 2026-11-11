import { readCameraControlSettings, type CameraControlSettings } from '../settings/cameraControlSettings.js';
import { cameraDragAction, cameraWheelMatches } from './cameraControlBindings.js';
import { HOME_ORBIT, orbit, pan, zoom, type OrbitState } from './cameraMath.js';
import { exceedsRightDragThreshold } from './rightPointerGesture.js';

/** 視点の正本。ビューキューブなど外側の部品もここを通してだけ視点を読み書きする。 */
export interface CameraControls {
  getOrbit(): OrbitState;
  /** 開始時の操作を保持する。ドラッグ途中でAltを離しても作図へ切り替えない。 */
  isDragging(): boolean;
  /** ビューキューブなど、外から視点を差し替えるための入口。視点の正本はこの1箇所に置く。 */
  setOrbit(next: OrbitState): void;
  goHome(): void;
  detach(): void;
}

/** 分割表示の間だけ差し替える視点。解除後は元の単一視点へ戻る。 */
export interface CameraControlOverride {
  getOrbit(): OrbitState | null;
  setOrbit(next: OrbitState): void;
  goHome(): void;
  viewportHeight(): number;
  canOrbit(): boolean;
}

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
 * 設定された最大2枠を完全一致の修飾キーで解決する。初期値:
 * - 視点回転: 中ボタンドラッグ / Alt + 左ボタンドラッグ
 * - 平行移動: 右ボタンドラッグ / Shift + 中ボタンドラッグ
 * - 拡大縮小: 修飾なしホイール / Ctrl + ホイール
 * - ホーム視点: Home キー(このビューポートに入力の焦点があるとき)
 *
 * Home キーを受けるため、呼び出し側は canvas を焦点の当たる要素にしておく(`tabIndex` を 0 以上にする)。
 * 視点が変わるたびに onChange を呼ぶ。実際の描画は呼び出し側が行う。
 */
export function attachCameraControls(
  canvas: HTMLCanvasElement,
  onChange: () => void,
  onInteractionChange: (active: boolean) => void = () => {},
  override?: CameraControlOverride,
  readSettings: () => CameraControlSettings = () => readCameraControlSettings(undefined),
): CameraControls {
  let state: OrbitState = HOME_ORBIT;
  let dragMode: 'orbit' | 'pan' | 'zoom' | null = null;
  let dragPointer: number | null = null;
  let rightStart: { readonly x: number; readonly y: number } | null = null;
  let rightPanning = false;
  let dragButtons = 0;
  let dragSettings = readSettings();
  let lastX = 0;
  let lastY = 0;
  const view = canvas.ownerDocument?.defaultView;

  const getOrbit = (): OrbitState => override?.getOrbit() ?? state;
  const setOrbit = (next: OrbitState): void => {
    if (override?.getOrbit() != null) override.setOrbit(next);
    else state = next;
    onChange();
  };
  const goHome = (): void => {
    if (override?.getOrbit() != null) override.goHome();
    else state = HOME_ORBIT;
    onChange();
  };

  function beginDrag(event: PointerEvent): void {
    if (dragMode !== null) return;
    const settings = readSettings();
    const action = cameraDragAction(settings, event);
    if (action === null) return;
    if (action === 'orbit' && override?.getOrbit() != null && !override.canOrbit()) return;
    dragMode = action;
    dragButtons = event.buttons;
    dragSettings = settings;
    const isRightPan = event.button === 2;

    lastX = event.clientX;
    lastY = event.clientY;
    dragPointer = event.pointerId;
    rightStart = isRightPan ? { x: lastX, y: lastY } : null;
    rightPanning = false;
    // ビューポートの外へ出ても操作が続くようにする。
    canvas.setPointerCapture(event.pointerId);
    onInteractionChange(true);
    event.preventDefault();
    // Right clicks also belong to the radial release/drag observer on this canvas.
    if (event.button === 2) event.stopPropagation();
    else event.stopImmediatePropagation();
    // 既定動作を止めると焦点が移らないので、Home キーのために自分で当てる。
    canvas.focus({ preventScroll: true });
  }

  function moveDrag(event: PointerEvent): void {
    if (dragMode === null || event.pointerId !== dragPointer) return;
    if (event.buttons !== dragButtons) { cancelDrag(); return; }
    updateDrag(event);
  }

  function updateDrag(event: PointerEvent): void {
    if (rightStart !== null && !rightPanning) {
      if (!exceedsRightDragThreshold(rightStart, event)) return;
      rightPanning = true;
      // Include the initial six pixels so the grabbed point stays under the pointer.
    }
    const deltaX = event.clientX - lastX;
    const deltaY = event.clientY - lastY;
    if (deltaX === 0 && deltaY === 0) return;
    lastX = event.clientX;
    lastY = event.clientY;

    const current = getOrbit();
    setOrbit(
      dragMode === 'orbit'
        ? orbit(current, deltaX, deltaY)
        : dragMode === 'pan'
          ? pan(current, deltaX, deltaY, override?.getOrbit() != null ? override.viewportHeight() : canvas.clientHeight)
          : zoom(current, deltaY * dragSettings.dragSensitivity * (dragSettings.invertDrag ? -1 : 1)),
    );
  }

  function endDrag(event: PointerEvent): void {
    if (dragMode === null || event.pointerId !== dragPointer) return;
    if (rightStart !== null && event.type === 'pointerup') {
      if (event.button !== 2) return;
      if (event.buttons === 0) updateDrag(event);
    }
    cancelDrag();
  }

  function cancelDrag(): void {
    if (dragMode === null) return;
    const pointer = dragPointer;
    dragMode = null;
    dragPointer = null;
    rightStart = null;
    rightPanning = false;
    onInteractionChange(false);
    if (pointer !== null && canvas.hasPointerCapture(pointer)) {
      canvas.releasePointerCapture(pointer);
    }
  }

  /** 捕捉が外部要因で外れたときも掴んだままにしない。 */
  function onLostPointerCapture(event: PointerEvent): void {
    if (event.pointerId === dragPointer) cancelDrag();
  }

  function onWheel(event: WheelEvent): void {
    if (dragMode !== null) return;
    const settings = readSettings();
    if (!cameraWheelMatches(settings, event)) return;
    // Ctrl + ホイールでの頁全体の拡大や、タッチパッドの慣性スクロールを止める。
    event.preventDefault();
    const delta = wheelDeltaInPixels(event) * settings.wheelSensitivity * (settings.invertWheel ? -1 : 1);
    if (!Number.isFinite(delta) || delta === 0) return;
    setOrbit(zoom(getOrbit(), delta));
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Home') {
      event.preventDefault();
      goHome();
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
  view?.addEventListener('blur', cancelDrag);

  return {
    getOrbit,
    isDragging: () => dragMode !== null,
    setOrbit,
    goHome,
    detach: () => {
      cancelDrag();
      canvas.removeEventListener('pointerdown', beginDrag);
      canvas.removeEventListener('pointermove', moveDrag);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('lostpointercapture', onLostPointerCapture);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onMiddleButtonMouseDown);
      canvas.removeEventListener('auxclick', onAuxClick);
      canvas.removeEventListener('keydown', onKeyDown);
      view?.removeEventListener('blur', cancelDrag);
    },
  };
}
