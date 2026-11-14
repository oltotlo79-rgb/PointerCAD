import { currentViewControls } from '../settings/viewControlSettings.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachAssemblyInteraction } from './attachAssemblyInteraction.js';
import { attachCameraControls, type CameraControls } from './attachCameraControls.js';
import { attachQuadInput } from './attachQuadInput.js';
import { attachSketchInteraction } from './attachSketchInteraction.js';
import { HOME_ORBIT, viewDirection } from './cameraMath.js';
import type { ViewportScene } from './createViewportScene.js';
import { namedCameraFromOrbit, orbitFromNamedCamera, type ViewCameraController } from './namedCamera.js';
import { quadLayout } from './quadLayout.js';
import type { sketchDragTimingForE2E } from './sketchDragTiming.js';
import type { ViewportAssemblyInput } from './viewportCanvasAssemblyInput.js';
import type { ViewportLifetime } from './viewportLifetime.js';

/*
 * ViewportCanvas の入力の結線(FR-102・FR-108・FR-106・FR-605)。4 区画の切り替え・視点の操作・名前付きの視点・
 * 合致と部品の入力・スケッチの操作・大きさの見張りを、この順で canvas へ結ぶ(同じ canvas の同じ段階では
 * 登録した順に呼ばれるので、視点の操作を先に、スケッチの操作を後に結んで中ボタン・Alt の取り合いを避ける)。
 * 視点の操作の間と大きさの変化では、部品のドラッグを取り消してから描き直す。
 */

/** 入力が借りるもの。controlsRef と表示の切り替えはコンポーネントの状態。 */
interface ViewportInputDependencies {
  readonly canvas: HTMLCanvasElement;
  readonly scene: ViewportScene;
  readonly lifetime: ViewportLifetime;
  readonly isAlive: () => boolean;
  readonly requestDraw: () => void;
  readonly assemblyInput: Pick<ViewportAssemblyInput, 'prepareMateInput' | 'observeMateInput' | 'prepareHoverInput'>;
  readonly sketchTiming: ReturnType<typeof sketchDragTimingForE2E>;
  /** ビューキューブが `getOrbit` / `setOrbit` を借りるための入口。 */
  readonly controlsRef: { current: CameraControls | null };
  readonly setControlsReady: (ready: boolean) => void;
}

/** 名前付きの視点の取り込みと戻し(視点の正本はここにしか無いので、今の視点から写す)。 */
function createViewCameraController(controls: CameraControls, isAlive: () => boolean): ViewCameraController {
  return {
    capture: () => {
      if (!isAlive()) return namedCameraFromOrbit(HOME_ORBIT, useAppStore.getState().projection);
      const { quadCamera, projection } = useAppStore.getState();
      return namedCameraFromOrbit(controls.getOrbit(), quadCamera === null || quadCamera.active === 'isometric' ? projection : 'orthographic');
    },
    restore: (camera) => {
      if (!isAlive()) return false;
      const orbit = orbitFromNamedCamera(camera);
      if (orbit === null) return false;
      useAppStore.getState().setQuadViewEnabled(false);
      useAppStore.getState().setProjection(camera.projection);
      controls.setOrbit(orbit);
      return true;
    },
  };
}

export function attachViewportInputs(deps: ViewportInputDependencies) {
  const { canvas, scene, lifetime, isAlive, requestDraw, assemblyInput } = deps;
  let assemblyInteraction: ReturnType<typeof attachAssemblyInteraction> | null = null;
  const detachQuadInput = attachQuadInput(canvas, () => useAppStore.getState().quadCamera !== null, (pane) => {
    if (!isAlive()) return;
    useAppStore.getState().setQuadActivePane(pane);
    scene.setActivePane(pane);
  });
  lifetime.register('quad input', detachQuadInput);
  const controls = attachCameraControls(canvas, () => {
    if (!isAlive()) return;
    assemblyInteraction?.cancelDrag();
    requestDraw();
  }, (active) => {
    if (!isAlive()) return;
    scene.setInteractiveRendering(active);
    // 離したときは通常解像度の静止画を必ず1枚描く。開始時も最初の入力を待たず切り替える。
    requestDraw();
  }, {
    getOrbit: () => {
      const state = useAppStore.getState().quadCamera;
      return state === null ? null : state.orbits[state.active];
    },
    setOrbit: (next) => useAppStore.getState().setQuadOrbit(next),
    goHome: () => useAppStore.getState().resetQuadOrbit(),
    canOrbit: () => useAppStore.getState().quadCamera?.active === 'isometric',
    viewportHeight: () => {
      const pane = quadLayout(canvas.width, canvas.height).find((entry) => entry.id === useAppStore.getState().quadCamera?.active);
      return Math.max(1, (pane?.rectangle.height ?? canvas.height) * canvas.clientHeight / Math.max(1, canvas.height));
    },
  }, () => currentViewControls(useAppStore.getState().displaySettings));
  lifetime.register('camera ref', () => { if (deps.controlsRef.current === controls) deps.controlsRef.current = null; });
  lifetime.register('camera input', () => { controls.detach(); });
  deps.controlsRef.current = controls;
  const viewCameraController = createViewCameraController(controls, isAlive);
  lifetime.register('camera producer', () => {
    if (useAppStore.getState().viewCameraController === viewCameraController) useAppStore.getState().setViewCameraController(null);
  });
  useAppStore.getState().setViewCameraController(viewCameraController);
  // 視点操作を先に結び、その後ろでスケッチの操作を結ぶ(中ボタン・Alt の取り合いを避ける)。
  // 視点そのものを渡す。距離は方眼の刻みに、向きは 3D スケッチで押した場所に置く面に使う
  // (FR-330)。
  // 合致の選択を先に受け、処理した左クリックは部品用の作図操作へ流さない。
  assemblyInteraction = attachAssemblyInteraction(canvas, scene, {
    viewDirection: () => viewDirection(controls.getOrbit()),
    prepareMateInput: assemblyInput.prepareMateInput,
    observeMateInput: assemblyInput.observeMateInput, prepareHoverInput: assemblyInput.prepareHoverInput,
  });
  lifetime.register('assembly input', () => { assemblyInteraction?.detach(); });
  const interaction = attachSketchInteraction(canvas, scene, () => controls.getOrbit(), () => controls.isDragging(), deps.sketchTiming);
  lifetime.register('sketch input', () => { interaction.detach(); });
  lifetime.register('view controls', () => { deps.setControlsReady(false); });
  deps.setControlsReady(true);

  const observer = new ResizeObserver(() => {
    if (!isAlive()) return;
    assemblyInteraction?.cancelDrag();
    scene.resize(canvas.clientWidth, canvas.clientHeight);
    requestDraw();
  });
  lifetime.register('resize observation', () => { observer.disconnect(); });
  observer.observe(canvas);

  return {
    controls,
    /** 投影の切り替えなど、視点が変わる操作の前に部品のドラッグを取り消す。 */
    cancelAssemblyDrag: (): void => { assemblyInteraction?.cancelDrag(); },
  };
}
