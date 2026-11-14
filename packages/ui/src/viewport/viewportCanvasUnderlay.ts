import { worldToPlane } from '@pointercad/model';
import { currentViewControls } from '../settings/viewControlSettings.js';
import { resolveWorkPlaneOf } from '../sketch/referenceCommands.js';
import { activePartDocument } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { viewDragAction } from './cameraControlBindings.js';
import { canvasPixelPointOf, canvasPlacementOf } from './canvasLayer.js';
import { createCanvasImageCache } from './createCanvasImageCache.js';
import type { ViewportScene } from './createViewportScene.js';
import { canvasDrawsOf } from './viewportCanvasStoreViews.js';
import type { ViewportLifetime } from './viewportLifetime.js';

/*
 * ViewportCanvas の下絵(FR-332)。文書の下絵の画像を復号して scene へ貼り(復号した画像はこの装着が持ち、
 * 片付けで返す)、2 点の寸法合わせ・4 点の補正の間だけ、押した場所を作図面の点として拾う。
 */

/** 下絵の画像の控えが借りるもの。 */
interface UnderlayImageDependencies {
  readonly scene: Pick<ViewportScene, 'setCanvases'>;
  readonly lifetime: ViewportLifetime;
  readonly isAlive: () => boolean;
  readonly requestDraw: () => void;
  /** 装着を外した後に復号の片付けが済んだ時、残りの片付けをもう 1 度試す。 */
  readonly disposeViewport: () => void;
}

/** 復号した下絵の控えを作り、片付けを登録する。文書か画像の表が変わった時に `sync` で貼り直す。 */
export function createUnderlayImages(deps: UnderlayImageDependencies) {
  const { scene, isAlive } = deps;
  const canvasImageCache = createCanvasImageCache({
    readSource: () => {
      const state = useAppStore.getState();
      return { documentId: state.activeDocumentId,
        canvases: activePartDocument(state)?.canvases ?? [], images: state.canvases, retries: state.canvasImageRetries };
    },
    publish: (images) => {
      if (!isAlive()) return;
      const state = useAppStore.getState();
      const part = activePartDocument(state);
      scene.setCanvases(part === null ? [] : canvasDrawsOf(part, images, state.canvasRectification?.canvasId ?? null));
      deps.requestDraw();
    },
    setLoad: (id, owner, load) => { useAppStore.getState().setCanvasImageLoad(id, owner, load); },
    reportInvalid: (message) => { if (isAlive()) useAppStore.getState().setCanvasMessage(message); },
    onCleanupSettled: () => { if (!isAlive()) deps.disposeViewport(); },
  });
  deps.lifetime.register('decoded canvas images', () => {
    canvasImageCache.dispose();
    if (canvasImageCache.cleanupPending()) throw new Error('Image resources remain pending cleanup');
  });
  return canvasImageCache;
}

/**
 * 2 点の寸法合わせのあいだだけ、押した場所を作図面の点として拾う。
 *
 * **スケッチの操作より先に登録する**(`attachSketchInteraction` より前)。同じ
 * canvas の同じ段階では登録した順に呼ばれるので、先に登録して
 * `stopImmediatePropagation()` を呼べば、寸法合わせの最中に線を引き始めてしまうことがない。
 */
export function attachUnderlayPointInput(canvas: HTMLCanvasElement, scene: Pick<ViewportScene, 'screenToPlanePoint'>,
  lifetime: ViewportLifetime, isAlive: () => boolean): void {
  const onCanvasScalePointerDown = (event: PointerEvent): void => {
    if (!isAlive()) return;
    const state = useAppStore.getState();
    const picking = state.canvasRectification;
    const scaling = state.canvasScale;
    if (scaling === null && picking === null) {
      return;
    }
    const target = state.document.canvases.find((item) => item.id === (picking?.canvasId ?? scaling?.canvasId));
    if (target === undefined) {
      return;
    }
    if (viewDragAction(currentViewControls(state.displaySettings), event) !== null) return;
    if (event.button !== 0) {
      // 中ボタン・右ボタンは視点操作へそのまま通す(合わせている間も回せる)。
      return;
    }
    event.stopImmediatePropagation();
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const plane = resolveWorkPlaneOf(state.document, target.plane);
    const world = scene.screenToPlanePoint(
      event.clientX - rect.left,
      event.clientY - rect.top,
      plane,
    );
    if (world === null) {
      // 作図面を真横から見ている(視線と平行)。点は決まらないので何もしない。
      return;
    }
    const planePoint = worldToPlane(plane, world);
    if (picking !== null) {
      const pixel = canvasPixelPointOf(canvasPlacementOf(target), picking.size, planePoint);
      state.addCanvasRectificationPoint([pixel[0] / picking.size.width, pixel[1] / picking.size.height]);
    } else {
      state.addCanvasScalePoint(planePoint);
    }
  };
  lifetime.register('canvas pointer input', () => { canvas.removeEventListener('pointerdown', onCanvasScalePointerDown); });
  canvas.addEventListener('pointerdown', onCanvasScalePointerDown);
}
