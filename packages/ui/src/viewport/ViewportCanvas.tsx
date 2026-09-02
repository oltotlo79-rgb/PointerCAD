import { useCallback, useEffect, useRef, useState } from 'react';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { ViewCube } from '../viewcube/ViewCube.js';
import { attachCameraControls, type CameraControls } from './attachCameraControls.js';
import { attachSketchInteraction } from './attachSketchInteraction.js';
import { HOME_ORBIT, type OrbitState } from './cameraMath.js';
import { createViewportScene } from './createViewportScene.js';

/**
 * 3D ビューポート(FR-101、FR-102、FR-104、FR-105、FR-106、FR-108、FR-310)。
 *
 * 視点の正本は `attachCameraControls` が持ち、画面状態(投影・表示スタイル・方眼・メッシュ・
 * スケッチ・ホバー・選択・作図面)は Zustand ストアから読む(rules/04-設計の規律.md)。
 * 描画は入力・状態変化・大きさの変化があったときだけ次の描画機会に1回行い、
 * 常時のループは回さない(NFR-PF-1)。
 *
 * 描いたことは `subscribeDraw` で購読者へ知らせる。ビューキューブは自前のループを持たず、
 * この通知に相乗りして同じ描画機会に1回だけ描く。
 */
export function ViewportCanvas(): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** ビューキューブが `getOrbit` / `setOrbit` を借りるための入口。 */
  const controlsRef = useRef<CameraControls | null>(null);
  /** ビューポートが描いたことを知りたい人たち(いまはビューキューブだけ)。 */
  const drawListenersRef = useRef(new Set<() => void>());
  /** 初回描画では `controlsRef` がまだ空なので、用意できてからビューキューブを出す。 */
  const [controlsReady, setControlsReady] = useState(false);

  const getOrbit = useCallback((): OrbitState => {
    return controlsRef.current?.getOrbit() ?? HOME_ORBIT;
  }, []);

  const setOrbit = useCallback((next: OrbitState): void => {
    controlsRef.current?.setOrbit(next);
  }, []);

  /** ビューポートが描き直したときに呼ばれる。戻り値を呼ぶと購読をやめる。 */
  const subscribeDraw = useCallback((listener: () => void): (() => void) => {
    const listeners = drawListenersRef.current;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }

    const scene = createViewportScene(canvas);
    const listeners = drawListenersRef.current;
    let frameId = 0;

    function draw(): void {
      frameId = 0;
      const { projection, displayStyle, showGrid } = useAppStore.getState();
      scene.render(controls.getOrbit(), projection, displayStyle, showGrid);
      // 本体を描いた後にだけ知らせる。視点はこの時点で確定している。
      for (const listener of listeners) {
        listener();
      }
    }

    /** 同じ描画機会に何度呼ばれても描画は1回にまとめる。 */
    function requestDraw(): void {
      if (frameId === 0) {
        frameId = globalThis.requestAnimationFrame(draw);
      }
    }

    const controls = attachCameraControls(canvas, requestDraw);
    controlsRef.current = controls;
    // 視点操作を先に結び、その後ろでスケッチの操作を結ぶ(中ボタン・Alt の取り合いを避ける)。
    const interaction = attachSketchInteraction(canvas, scene, () => controls.getOrbit().distance);
    setControlsReady(true);

    const observer = new ResizeObserver(() => {
      scene.resize(canvas.clientWidth, canvas.clientHeight);
      requestDraw();
    });
    observer.observe(canvas);

    scene.resize(canvas.clientWidth, canvas.clientHeight);
    const initial = useAppStore.getState();
    scene.setMesh(initial.mesh);
    scene.setSketch(initial.resolvedSketch, initial.sketchMesh);
    scene.setSketchHighlight(initial.hoveredElementId, initial.selection);
    scene.setWorkPlane(initial.workPlaneId);
    requestDraw();

    const unsubscribe = useAppStore.subscribe((next, previous) => {
      if (next.mesh !== previous.mesh) {
        scene.setMesh(next.mesh);
      }
      // スケッチの形と、カーネルが返した面(FR-105、FR-310)。
      if (
        next.resolvedSketch !== previous.resolvedSketch ||
        next.sketchMesh !== previous.sketchMesh
      ) {
        scene.setSketch(next.resolvedSketch, next.sketchMesh);
      }
      // ホバー・選択の強調(FR-106)。
      if (
        next.hoveredElementId !== previous.hoveredElementId ||
        next.selection !== previous.selection
      ) {
        scene.setSketchHighlight(next.hoveredElementId, next.selection);
      }
      // 作図面が変わったら矩形の向きを変える(§0.a-0.3)。
      if (next.workPlaneId !== previous.workPlaneId) {
        scene.setWorkPlane(next.workPlaneId);
      }
      // ホーム視点への復帰要求(FR-108)。数が増えたときだけ戻す。
      if (next.homeViewRequestCount !== previous.homeViewRequestCount) {
        controls.goHome();
      }
      // 「視点に合わせる」の要求(§0.a-0.3)。視点の正本はここにしか無いので、
      // 今の視点をストアへ渡し返して作図面を決めてもらう。
      if (next.matchWorkPlaneRequestCount !== previous.matchWorkPlaneRequestCount) {
        useAppStore.getState().matchWorkPlaneToView(controls.getOrbit());
      }
      requestDraw();
    });

    return () => {
      if (frameId !== 0) {
        globalThis.cancelAnimationFrame(frameId);
      }
      unsubscribe();
      observer.disconnect();
      interaction.detach();
      controls.detach();
      scene.dispose();
      controlsRef.current = null;
      setControlsReady(false);
    };
  }, []);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="pcad-viewport__canvas"
        tabIndex={0}
        aria-label={t('viewport.label')}
      />
      {controlsReady ? (
        <ViewCube getOrbit={getOrbit} setOrbit={setOrbit} subscribeDraw={subscribeDraw} />
      ) : null}
    </>
  );
}
