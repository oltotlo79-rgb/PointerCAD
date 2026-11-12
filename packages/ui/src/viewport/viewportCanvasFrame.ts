import { useAppStore } from '../store/useAppStore.js';
import type { OrbitState } from './cameraMath.js';
import type { ViewportScene } from './createViewportScene.js';
import type { sketchDragTimingForE2E, SketchTimingContext } from './sketchDragTiming.js';
import { readThemeColors } from './themeColors.js';
import type { ViewportRenderStatsRecorder } from './viewportCanvasDiagnostics.js';
import type { ViewportLifetime } from './viewportLifetime.js';

/*
 * ViewportCanvas の描画の予約(NFR-PF-1)。入力・状態の変化・大きさの変化があった時だけ次の描画機会に 1 回描き、
 * 常時のループは回さない。描いた後にだけ購読者(ビューキューブ)へ知らせ、同じ描画機会に相乗りさせる。
 * テーマの色は、ルート要素の data-theme が効いた後の次の描画機会に読み直す。
 */

/** 描画が借りるもの。視点の正本(attachCameraControls)は描画の持ち主より後に作るので、描く時に読む。 */
interface ViewportFrameDependencies {
  readonly scene: ViewportScene;
  readonly lifetime: ViewportLifetime;
  readonly isAlive: () => boolean;
  readonly sketchTiming: ReturnType<typeof sketchDragTimingForE2E>;
  readonly sketchTimingContext: () => SketchTimingContext;
  readonly assemblyReady: () => boolean;
  readonly orbit: () => OrbitState;
  readonly stats: ViewportRenderStatsRecorder;
  /** ビューポートが描いたことを知りたい人たち(いまはビューキューブだけ)。 */
  readonly listeners: ReadonlySet<() => void>;
}

export function createViewportFrame(deps: ViewportFrameDependencies) {
  const { scene, sketchTiming, stats, listeners } = deps;
  let frameId = 0;
  /**
   * 3D の色をテーマから読み直すべきか(FR-908)。ルート要素へ `data-theme` を書くのは
   * `applyDisplaySettings.ts` の見張りなので、**読むのは次の描画機会まで待つ**。
   * こうすると見張りが呼ばれる順に依らず、属性が効いた後の色を必ず読める。
   * 起動時も 1 回読む(保存されていたテーマで始まるため)。
   */
  let themeDirty = true;

  function draw(): void {
    frameId = 0;
    if (!deps.isAlive()) return;
    if (themeDirty) {
      themeDirty = false;
      scene.setThemeColors(readThemeColors());
    }
    if (!deps.assemblyReady()) return;
    const { projection, displayStyle, showGrid, displaySettings, quadCamera } = useAppStore.getState();
    const renderStartedAt = globalThis.performance.now();
    const renderCurrent = (): void => {
      if (quadCamera === null) scene.render(deps.orbit(), projection, displayStyle, showGrid, displaySettings.uiScale);
      else scene.renderQuad(quadCamera, projection, displayStyle, showGrid, displaySettings.uiScale);
    };
    if (sketchTiming === undefined) renderCurrent();
    else sketchTiming.render(renderCurrent, deps.sketchTimingContext);
    // `scene.render` が例外なく戻った実描画だけを、1回につきちょうど1つ数える。
    const completedAt = stats.renderCompleted(renderStartedAt);
    // 本体を描いた後にだけ知らせる。視点はこの時点で確定している。
    for (const listener of listeners) {
      listener();
    }
    stats.listenersCompleted(completedAt);
  }

  /** 同じ描画機会に何度呼ばれても描画は1回にまとめる。 */
  function requestDraw(): void {
    if (deps.isAlive() && frameId === 0) {
      frameId = globalThis.requestAnimationFrame(draw);
    }
  }

  deps.lifetime.register('animation frame', () => {
    if (frameId !== 0) globalThis.cancelAnimationFrame(frameId);
    frameId = 0;
  });

  return {
    requestDraw,
    /** 表示テーマが変わった。3D の色は次の描画機会に読み直す(拡大率は 3D の色を変えない)。 */
    markThemeDirty: (): void => { themeDirty = true; },
  };
}
