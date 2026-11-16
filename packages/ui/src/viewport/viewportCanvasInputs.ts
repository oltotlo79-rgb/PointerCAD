import { attachPointerCommands } from '../commands/attachPointerCommands.js';
import { executeCommand } from '../commands/commandRegistry.js';
import { EMPTY_MOUSE_BUTTON_COMMANDS } from '../commands/pointerCommandGesture.js';
import { currentViewControls, viewZoomCenter } from '../settings/viewControlSettings.js';
import { activeAssemblyDocument } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachAssemblyInteraction } from './attachAssemblyInteraction.js';
import { attachCameraControls, type CameraControls, type ViewCenterResolver } from './attachCameraControls.js';
import { attachQuadInput } from './attachQuadInput.js';
import { attachSketchInteraction } from './attachSketchInteraction.js';
import { attachTouchCamera } from './attachTouchCamera.js';
import { HOME_ORBIT, viewDirection } from './cameraMath.js';
import type { ViewportScene } from './createViewportScene.js';
import { namedCameraFromOrbit, orbitFromNamedCamera, type ViewCameraController } from './namedCamera.js';
import { quadLayout } from './quadLayout.js';
import type { sketchDragTimingForE2E } from './sketchDragTiming.js';
import type { ViewportAssemblyInput } from './viewportCanvasAssemblyInput.js';
import type { ViewportLifetime } from './viewportLifetime.js';
import { fitOrbitToBounds, viewFitBounds } from './viewFit.js';
import { assemblySurfacePoint, boundsCenter, partSurfacePoint, rayPointAtTargetDepth } from './viewCenters.js';

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

/**
 * 回転の中心・拡大の中心の点(B-08d)。押した所の形の上の点は scene の当たりの面と光線の交点、選んだ物の中心は
 * 「選択に合わせる」と同じ外接箱の中心。形に当たらない所の拡大は、注視点の深さの面の上の点へ向ける。
 */
function createViewCenters(scene: Pick<ViewportScene, 'viewFitSource' | 'pointerRay' | 'pickFaceAt' | 'pickAssemblyFace'>,
  canvas: Pick<HTMLCanvasElement, 'getBoundingClientRect'>): ViewCenterResolver {
  const canvasPoint = (clientX: number, clientY: number): readonly [number, number] | null => {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const rect = canvas.getBoundingClientRect();
    return [clientX - rect.left, clientY - rect.top];
  };
  const assemblyMode = (): boolean => activeAssemblyDocument(useAppStore.getState()) !== null;
  const surface = (x: number, y: number) => {
    const ray = scene.pointerRay(x, y);
    if (ray === null) return { ray, point: null };
    if (assemblyMode()) {
      const hit = scene.pickAssemblyFace(x, y), source = scene.viewFitSource('assembly');
      return { ray, point: hit === null || source.kind !== 'assembly' ? null : assemblySurfacePoint(source.assembly, hit, ray) };
    }
    const hit = scene.pickFaceAt(x, y), source = scene.viewFitSource('part');
    return { ray, point: hit === null || source.kind !== 'part' ? null : partSurfacePoint(source.solid, hit, ray) };
  };
  return {
    orbitPivot: (center, clientX, clientY) => {
      if (center === 'selection') {
        const bounds = viewFitBounds(scene.viewFitSource(assemblyMode() ? 'assembly' : 'part'), 'selection', useAppStore.getState().selection);
        return bounds === null ? null : boundsCenter(bounds);
      }
      const at = canvasPoint(clientX, clientY);
      return at === null ? null : surface(at[0], at[1]).point;
    },
    zoomPoint: (clientX, clientY, current) => {
      const at = canvasPoint(clientX, clientY);
      if (at === null) return null;
      const { ray, point } = surface(at[0], at[1]);
      return point ?? (ray === null ? null : rayPointAtTargetDepth(ray, current.target, viewDirection(current)));
    },
  };
}

/**
 * 名前付きの視点の取り込みと戻し(視点の正本はここにしか無いので、今の視点から写す)。直前の視点と、全体を表示・
 * 選択に合わせる(B-08c)もここから行う。収める形は scene の描画の一式から、今の画面(組立か部品か)の物を使う。
 */
function createViewCameraController(controls: CameraControls, isAlive: () => boolean,
  scene: Pick<ViewportScene, 'viewFitSource'>, canvas: Pick<HTMLCanvasElement, 'clientWidth' | 'clientHeight'>): ViewCameraController {
  return {
    previous: () => isAlive() && controls.previousView(),
    fit: (scope, selection) => {
      if (!isAlive()) return false;
      const source = scene.viewFitSource(activeAssemblyDocument(useAppStore.getState()) === null ? 'part' : 'assembly');
      const bounds = viewFitBounds(source, scope, selection);
      const fitted = bounds === null ? null
        : fitOrbitToBounds(controls.getOrbit(), bounds, canvas.clientWidth / Math.max(1, canvas.clientHeight));
      if (fitted === null) return false;
      controls.setOrbit(fitted);
      return true;
    },
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

/** 4 分割の時の、選んでいる区画の高さ(CSS 画素。平行移動の換算に使う)。 */
function quadPaneHeight(canvas: HTMLCanvasElement): number {
  const pane = quadLayout(canvas.width, canvas.height).find((entry) => entry.id === useAppStore.getState().quadCamera?.active);
  return Math.max(1, (pane?.rectangle.height ?? canvas.height) * canvas.clientHeight / Math.max(1, canvas.height));
}

/**
 * タッチ画面の指(B-08g・B-08h)。割り当てた時だけ視点を動かす。捕捉の段で受け、視点の操作の間の指の入力は後ろ(作図・選択)へ
 * 渡さない。4 分割の時は選んでいる区画の視点を動かし、正投影の区画は回さない。つまむ拡大の中心は拡大の中心の設定に従う。
 */
function attachViewportTouch(canvas: HTMLCanvasElement, controls: CameraControls, centers: ViewCenterResolver): () => void {
  const settings = () => currentViewControls(useAppStore.getState().displaySettings);
  return attachTouchCamera(canvas, {
    getOrbit: () => controls.getOrbit(),
    setOrbit: (next) => { controls.setOrbit(next); },
    viewportHeight: () => useAppStore.getState().quadCamera === null ? canvas.clientHeight : quadPaneHeight(canvas),
    canOrbit: () => {
      const quad = useAppStore.getState().quadCamera;
      return quad === null || quad.active === 'isometric';
    },
    zoomPoint: (clientX, clientY, current) => useAppStore.getState().quadCamera === null
      && viewZoomCenter(settings().options) === 'pointer' ? centers.zoomPoint(clientX, clientY, current) : null,
    focus: () => { canvas.focus({ preventScroll: true }); },
  }, settings);
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
  const centers = createViewCenters(scene, canvas);
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
    viewportHeight: () => quadPaneHeight(canvas),
  }, () => currentViewControls(useAppStore.getState().displaySettings), centers);
  lifetime.register('camera ref', () => { if (deps.controlsRef.current === controls) deps.controlsRef.current = null; });
  lifetime.register('camera input', () => { controls.detach(); });
  lifetime.register('touch camera', attachViewportTouch(canvas, controls, centers));
  // マウスの戻る・進む・中ボタンのダブルクリックの命令(B-08e)。割り当てた入力だけを受ける。
  const detachPointerCommands = attachPointerCommands(canvas,
    () => useAppStore.getState().displaySettings.mouseButtonCommands ?? EMPTY_MOUSE_BUTTON_COMMANDS, (id) => { if (isAlive()) executeCommand(id); });
  lifetime.register('pointer commands', detachPointerCommands);
  deps.controlsRef.current = controls;
  const viewCameraController = createViewCameraController(controls, isAlive, scene, canvas);
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
