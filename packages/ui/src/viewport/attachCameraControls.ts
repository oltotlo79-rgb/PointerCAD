import {
  DEFAULT_VIEW_CONTROLS, viewOrbitCenter, viewZoomCenter, type ViewAction, type ViewControlOptions, type ViewControlSettings,
} from '../settings/viewControlSettings.js';
import {
  dragZoomDelta, KEY_PAN_PIXELS, keyOrbitPixels, keyZoomDelta, scaledOrbitDelta, scaledPanDelta, viewDragAction, viewKeyMove,
  viewWheelAction, wheelDragEquivalent, wheelZoomDelta,
} from './cameraControlBindings.js';
import { HOME_ORBIT, orbit, orbitAround, pan, zoom, zoomToward, type OrbitState } from './cameraMath.js';
import { exceedsRightDragThreshold } from './rightPointerGesture.js';
import { createViewHistory } from './viewHistory.js';

/** 視点の正本。ビューキューブなど外側の部品もここを通してだけ視点を読み書きする。 */
export interface CameraControls {
  getOrbit(): OrbitState;
  /** 開始時の操作を保持する。ドラッグ途中でAltを離しても作図へ切り替えない。 */
  isDragging(): boolean;
  /** ビューキューブなど、外から視点を差し替えるための入口。視点の正本はこの1箇所に置く。 */
  setOrbit(next: OrbitState): void;
  goHome(): void;
  /** 直前の視点へ戻る(B-08c)。戻れる視点が無い時と 4 分割の表示の間は何もせず false。 */
  previousView(): boolean;
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

/**
 * 回転の中心・拡大の中心の点を決める口(B-08d)。画面の座標は clientX/clientY(キーの時は NaN)。決まらなければ null
 * (今までどおり注視点の周りに回し、注視点へ寄せる)。
 */
export interface ViewCenterResolver {
  orbitPivot(center: 'pointer' | 'selection', clientX: number, clientY: number): readonly [number, number, number] | null;
  zoomPoint(clientX: number, clientY: number, current: OrbitState): readonly [number, number, number] | null;
}

const MIDDLE_BUTTON = 1;

/**
 * ドラッグ(またはホイールのドラッグ相当の移動)の 1 回分を視点へ当てる。速さと向きは設定に従う。
 * 拡大縮小は縦の移動だけを使う。
 */
function movedOrbit(current: OrbitState, action: ViewAction, options: ViewControlOptions,
  delta: readonly [number, number], viewportHeight: () => number, center: readonly [number, number, number] | null = null): OrbitState {
  if (action === 'orbit') {
    const [deltaX, deltaY] = scaledOrbitDelta(options, delta[0], delta[1]);
    return center === null ? orbit(current, deltaX, deltaY) : orbitAround(current, deltaX, deltaY, center);
  }
  if (action === 'pan') {
    const [deltaX, deltaY] = scaledPanDelta(options, delta[0], delta[1]);
    return pan(current, deltaX, deltaY, viewportHeight());
  }
  const deltaZoom = dragZoomDelta(options, delta[1]);
  return center === null ? zoom(current, deltaZoom) : zoomToward(current, deltaZoom, center);
}

/**
 * ビューポートの視点操作を canvas へ結びつける(FR-101)。
 *
 * 設定された割当(1 操作に最大4つ。ドラッグとホイール)を完全一致の修飾キーで解決する。初期値:
 * - 視点回転: 中ボタンドラッグ / Alt + 左ボタンドラッグ
 * - 平行移動: 右ボタンドラッグ / Shift + 中ボタンドラッグ
 * - 拡大縮小: 修飾なしホイール / Ctrl + ホイール
 * ホイール(タッチパッドの 2 本指スクロール)を回転・平行移動へ割り当てた時は、ページを送る向きに動かす。
 * ホーム視点はここではキーを受けない。命令「ホーム視点」(toolbar.view.home。既定は Home キーで、利用者が別のキーへ
 * 変えられる)が全体のキーの入口から届き、ストアの要求(viewportCanvasStoreSync.ts)から goHome を呼ぶ。
 *
 * スケッチと組立のキー(Esc・Enter など)を canvas で受けるため、呼び出し側は canvas を焦点の当たる要素にしておく
 * (`tabIndex` を 0 以上にする)。
 * 視点が変わるたびに onChange を呼ぶ。実際の描画は呼び出し側が行う。
 */
export function attachCameraControls(
  canvas: HTMLCanvasElement,
  onChange: () => void,
  onInteractionChange: (active: boolean) => void = () => {},
  override?: CameraControlOverride,
  readSettings: () => ViewControlSettings = () => DEFAULT_VIEW_CONTROLS,
  centers?: ViewCenterResolver,
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
  /** このドラッグの回転・拡大の中心(押した時に 1 回決める)。null は注視点。 */
  let dragCenter: readonly [number, number, number] | null = null;
  const view = canvas.ownerDocument?.defaultView;

  // 単一の視点の履歴(4 分割の区画の視点は積まない)。
  const history = createViewHistory(() => globalThis.performance.now());
  const getOrbit = (): OrbitState => override?.getOrbit() ?? state;
  const setOrbit = (next: OrbitState): void => {
    if (override?.getOrbit() != null) override.setOrbit(next);
    else { history.beforeChange(state); state = next; }
    onChange();
  };
  const goHome = (): void => {
    if (override?.getOrbit() != null) override.goHome();
    else { history.beforeChange(state); state = HOME_ORBIT; }
    onChange();
  };
  const previousView = (): boolean => {
    const previous = override?.getOrbit() != null ? null : history.takePrevious(state);
    if (previous === null) return false;
    state = previous;
    onChange();
    return true;
  };
  const viewportHeight = (): number => override?.getOrbit() != null ? override.viewportHeight() : canvas.clientHeight;
  /** 回転・拡大の中心の点(B-08d)。設定が注視点・平行移動・4 分割の区画・決まらない時は null。 */
  const centerFor = (action: ViewAction, options: ViewControlOptions, clientX: number, clientY: number): readonly [number, number, number] | null => {
    if (centers === undefined || override?.getOrbit() != null || action === 'pan') return null;
    if (action === 'zoom') return viewZoomCenter(options) === 'pointer' ? centers.zoomPoint(clientX, clientY, getOrbit()) : null;
    const kind = viewOrbitCenter(options);
    return kind === 'target' ? null : centers.orbitPivot(kind, clientX, clientY);
  };

  function beginDrag(event: PointerEvent): void {
    if (dragMode !== null) return;
    const settings = readSettings();
    const action = viewDragAction(settings, event);
    if (action === null) return;
    if (action === 'orbit' && override?.getOrbit() != null && !override.canOrbit()) return;
    dragMode = action;
    dragCenter = centerFor(action, settings.options, event.clientX, event.clientY);
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
    // 既定動作を止めると焦点が移らないので、ビューポートのキー(Esc・Enter など)のために自分で当てる。
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

    if (dragMode === null) return;
    setOrbit(movedOrbit(getOrbit(), dragMode, dragSettings.options, [deltaX, deltaY], viewportHeight, dragCenter));
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
    dragCenter = null;
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
    const action = viewWheelAction(settings, event);
    if (action === null) return;
    // Ctrl + ホイールでの頁全体の拡大や、タッチパッドの慣性スクロールを止める。
    event.preventDefault();
    if (action === 'zoom') {
      const delta = wheelZoomDelta(settings.options, event);
      if (!Number.isFinite(delta) || delta === 0) return;
      const point = centerFor('zoom', settings.options, event.clientX, event.clientY);
      setOrbit(point === null ? zoom(getOrbit(), delta) : zoomToward(getOrbit(), delta, point));
      return;
    }
    // 4 分割の正投影の区画は回さない(ドラッグの回転と同じ扱い)。
    if (action === 'orbit' && override?.getOrbit() != null && !override.canOrbit()) return;
    const delta = wheelDragEquivalent(event);
    if (!delta.every(value => Number.isFinite(value)) || delta.every(value => value === 0)) return;
    setOrbit(movedOrbit(getOrbit(), action, settings.options, delta, viewportHeight, centerFor(action, settings.options, event.clientX, event.clientY)));
  }

  /** キーの割当(B-08): 押している間(キーの繰り返し)ずつ回す・動かす・拡大縮小する。割当の無いキーは触らない。 */
  function onKeyDown(event: KeyboardEvent): void {
    if (dragMode !== null || event.isComposing) return;
    const settings = readSettings(), move = viewKeyMove(settings, event);
    if (move === null) return;
    if (move.action === 'orbit' && override?.getOrbit() != null && !override.canOrbit()) return;
    // 命令のキーと重ならないよう窓で断っているが、ブラウザーの画面送り(矢印)と全体のキーの入口へは渡さない。
    // 同じ canvas の後ろの受け手(組立の 1〜4・スケッチ)へも渡さない(NumLock のテンキーの数字は文字の数字としても届く)。
    event.preventDefault();
    event.stopImmediatePropagation();
    // キーには押した所が無いので、中心は「選んだもの」だけが効く(カーソルの下は注視点のまま)。
    const center = centerFor(move.action, settings.options, Number.NaN, Number.NaN);
    if (move.action === 'zoom') {
      const delta = keyZoomDelta(settings.options, move.direction[1]);
      setOrbit(center === null ? zoom(getOrbit(), delta) : zoomToward(getOrbit(), delta, center));
      return;
    }
    const step = move.action === 'orbit' ? keyOrbitPixels(settings.options) : KEY_PAN_PIXELS;
    setOrbit(movedOrbit(getOrbit(), move.action, settings.options, [move.direction[0] * step, move.direction[1] * step], viewportHeight, center));
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
    previousView,
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
