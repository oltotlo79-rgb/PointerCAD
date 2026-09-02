import { useEffect, useRef } from 'react';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { attachCameraControls, type CameraControls } from './attachCameraControls.js';
import { createViewportScene } from './createViewportScene.js';

/**
 * 3D ビューポート(FR-101、FR-102、FR-104、FR-105、FR-108)。
 *
 * 視点の正本は `attachCameraControls` が持ち、画面状態(投影・表示スタイル・方眼・メッシュ)は
 * Zustand ストアから読む(rules/04-設計の規律.md)。描画は入力・状態変化・大きさの変化があった
 * ときだけ次の描画機会に1回行い、常時のループは回さない(NFR-PF-1)。
 */
export function ViewportCanvas(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** タスク13 のビューキューブが `getOrbit` / `setOrbit` を借りるための入口。 */
  const controlsRef = useRef<CameraControls | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }

    const scene = createViewportScene(canvas);
    let frameId = 0;

    function draw(): void {
      frameId = 0;
      const { projection, displayStyle, showGrid } = useAppStore.getState();
      scene.render(controls.getOrbit(), projection, displayStyle, showGrid);
    }

    /** 同じ描画機会に何度呼ばれても描画は1回にまとめる。 */
    function requestDraw(): void {
      if (frameId === 0) {
        frameId = globalThis.requestAnimationFrame(draw);
      }
    }

    const controls = attachCameraControls(canvas, requestDraw);
    controlsRef.current = controls;

    const observer = new ResizeObserver(() => {
      scene.resize(canvas.clientWidth, canvas.clientHeight);
      requestDraw();
    });
    observer.observe(canvas);

    scene.resize(canvas.clientWidth, canvas.clientHeight);
    scene.setMesh(useAppStore.getState().mesh);
    requestDraw();

    const unsubscribe = useAppStore.subscribe((next, previous) => {
      if (next.mesh !== previous.mesh) {
        scene.setMesh(next.mesh);
      }
      // ホーム視点への復帰要求(FR-108)。数が増えたときだけ戻す。
      if (next.homeViewRequestCount !== previous.homeViewRequestCount) {
        controls.goHome();
      }
      requestDraw();
    });

    return () => {
      if (frameId !== 0) {
        globalThis.cancelAnimationFrame(frameId);
      }
      unsubscribe();
      observer.disconnect();
      controls.detach();
      scene.dispose();
      controlsRef.current = null;
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="pcad-viewport__canvas"
      tabIndex={0}
      aria-label={t('viewport.label')}
    />
  );
}
