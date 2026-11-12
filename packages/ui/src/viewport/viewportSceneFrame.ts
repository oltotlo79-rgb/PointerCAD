import type * as THREE from 'three';
import type { DisplayStyle, ProjectionMode } from '../store/viewSlice.js';
import type { SketchGeometryBundle } from './buildSketchGeometry.js';
import type { OrbitState } from './cameraMath.js';
import type { ViewportScene } from './createViewportScene.js';
import { gridSpacing } from './gridMath.js';
import type { QuadCameraState } from './quadCamera.js';
import type { QuadRectangle, QuadViewId } from './quadLayout.js';
import type { ScenePointer } from './viewportScenePointer.js';
import type { SceneRenderer } from './viewportSceneRenderer.js';
import { logicalQuadPanes, placeKeyLight } from './viewportSceneRendering.js';
import { updateLabelScreenScale, type ViewportSceneLayers } from './viewportSceneResources.js';

/*
 * createViewportScene の 1 枚の描画(FR-101・FR-102・FR-104)。呼ばれた視点と見せ方を控え、各層を
 * 同期してから同じカメラで描く。4 区画は共通の方眼の間隔を 1 回だけ決めて区画ごとに描き、最後に
 * 入力を受ける区画のカメラへ戻す。視点そのものは持たない(視点の正本は attachCameraControls)。
 */

/**
 * 1 枚描くときの見せ方。視点はここでも持たず、呼び出しごとに渡されたものを控えるだけ
 * (視点の正本は `attachCameraControls`)。サムネイルは最後の 1 枚と
 * 同じ見せ方で描き直すため、この控えを使う。
 */
interface RenderSettings {
  readonly orbit: OrbitState;
  readonly projection: ProjectionMode;
  readonly displayStyle: DisplayStyle;
  readonly showGrid: boolean;
  /**
   * UI の拡大率(`DisplaySettings.uiScale`、90〜150)。名前の札(基準軸・座標系)の
   * 画面上の大きさをそろえるのに使う(`createReferenceLayer.ts`)。
   */
  readonly uiScale: number;
}

type FrameMethods = Pick<ViewportScene, 'render' | 'renderQuad' | 'setActivePane'>;

/** 描画の前に同期する、他の持ち主の表示。どれも同じ並びを渡し直したときは層を触らない。 */
interface SceneFrameDependencies {
  readonly canvas: HTMLCanvasElement;
  readonly scene: THREE.Scene;
  readonly output: Pick<SceneRenderer, 'renderer' | 'width' | 'height'>;
  readonly layers: ViewportSceneLayers;
  readonly grid: { spacing(): number; rebuild(spacing: number): void };
  readonly solid: { ensureCurrentOwner(): boolean; syncLayer(displayStyle: DisplayStyle, currentSolid: boolean): void };
  readonly assembly: { ensureCurrentOwner(): boolean; syncLayer(displayStyle: DisplayStyle): void };
  readonly overlays: { syncSolidOverlays(currentSolid: boolean): void };
  readonly sketchBundle: () => SketchGeometryBundle;
  readonly pointer: Pick<ScenePointer, 'configureCamera'>;
  readonly ensureRepairPreviewCurrent: () => void;
  readonly isDisposed: () => boolean;
}

export function createSceneFrame(deps: SceneFrameDependencies) {
  const { canvas, scene, output, layers, grid, solid, assembly, overlays, pointer } = deps;
  const { renderer } = output;
  /** 最後に描いたときの見せ方。サムネイルを撮るときに同じ絵を描き直すのに使う。 */
  let lastRender: RenderSettings | null = null;
  let lastQuad: QuadCameraState | null = null;
  let quadProjection: ProjectionMode = 'perspective';

  /** 各層の表示内容を同期する。renderer と camera の所有者はこの scene のまま。 */
  function updateVisibleLayers(settings: RenderSettings, rectangle: QuadRectangle, spacing: number): void {
    const currentSolid = solid.ensureCurrentOwner();
    assembly.ensureCurrentOwner();
    const { orbit, displayStyle, showGrid, uiScale } = settings;
    if (spacing !== grid.spacing()) {
      grid.rebuild(spacing);
    }
    layers.gridGroup.visible = showGrid;

    // 立体とスケッチは組み立て直したときだけ並びを差し替える(同じ結果なら表示の入切だけ)。
    solid.syncLayer(displayStyle, currentSolid);
    overlays.syncSolidOverlays(currentSolid);
    // 配置した部品(FR-605)。同じ一式を渡し直したときは並びを触らない(NFR-PF-1)。
    assembly.syncLayer(displayStyle);
    layers.sketchLayer.update(deps.sketchBundle(), displayStyle);
    updateLabelScreenScale(layers, orbit, rectangle.height, uiScale);
  }

  /** 1 枚描く。層の同期後、同じカメラで光源と renderer を更新する。 */
  function drawScene(settings: RenderSettings, rectangle: QuadRectangle, spacing: number): void {
    updateVisibleLayers(settings, rectangle, spacing);
    // Layer disposal callbacks may change the live owner before the renderer consumes it.
    solid.ensureCurrentOwner();
    assembly.ensureCurrentOwner();
    deps.ensureRepairPreviewCurrent();
    const { orbit, projection } = settings;
    placeKeyLight(layers.keyLight, orbit);
    // Each quad pane uses this camera with the same world-space solid origins.
    // Three multiplies the double-valued inverse camera and object matrices before
    // converting modelView to GPU floats; no world Float32 mesh is retranslated.
    const camera = pointer.configureCamera(orbit, projection, rectangle);
    renderer.render(scene, camera);
  }

  function quadPanes() {
    return logicalQuadPanes(renderer.getPixelRatio(), canvas.width, canvas.height, quadProjection);
  }

  /** 入力の最初に切り替える。描画待ちの間も選択は対象の区画のカメラを使う。 */
  function activatePane(id: QuadViewId): void {
    if (lastQuad === null) return;
    const pane = quadPanes().find((entry) => entry.id === id);
    if (pane === undefined) return;
    lastQuad = { ...lastQuad, active: id };
    pointer.configureCamera(lastQuad.orbits[id], pane.projection, pane.rectangle);
  }

  /** サムネイル・印刷も4区画を同じ同期描画で再現する。 */
  function redraw(): void {
    if (deps.isDisposed() || lastRender === null) return;
    if (lastQuad === null) {
      const width = output.width(), height = output.height();
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, width, height);
      drawScene(lastRender, { x: 0, y: 0, width, height }, gridSpacing(lastRender.orbit.distance));
      return;
    }
    // 共通格子を区画ごとに作り直さない。最大距離で1回だけ間隔を決める。
    const spacing = gridSpacing(Math.max(...Object.values(lastQuad.orbits).map((entry) => entry.distance)));
    renderer.setScissorTest(true);
    try {
      for (const pane of quadPanes()) {
        const box = pane.scissor;
        renderer.setViewport(box.x, box.y, box.width, box.height);
        renderer.setScissor(box.x, box.y, box.width, box.height);
        drawScene({ ...lastRender, orbit: lastQuad.orbits[pane.id], projection: pane.projection }, pane.rectangle, spacing);
      }
    } finally {
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, output.width(), output.height());
      activatePane(lastQuad.active);
    }
  }

  const methods: FrameMethods = {
    render(orbit, projection, displayStyle, showGrid, uiScale): void {
      lastQuad = null;
      lastRender = { orbit, projection, displayStyle, showGrid, uiScale };
      redraw();
    },

    renderQuad(state, projection, displayStyle, showGrid, uiScale): void {
      lastQuad = state;
      quadProjection = projection;
      lastRender = { orbit: state.orbits[state.active], projection, displayStyle, showGrid, uiScale };
      redraw();
    },

    setActivePane: activatePane,
  };

  return {
    methods,
    redraw,
    /** 最後に描いた表示スタイル。まだ 1 度も描いていなければ undefined。 */
    displayStyle: (): DisplayStyle | undefined => lastRender?.displayStyle,
    rendered: (): boolean => lastRender !== null,
  };
}
