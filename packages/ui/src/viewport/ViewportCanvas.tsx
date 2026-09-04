import { useCallback, useEffect, useRef, useState } from 'react';

import { isFreeWorkPlaneId } from '@pointercad/model';

import { t } from '../i18n/t.js';
import { constructionFeatureIds } from '../sketch/featureSummary.js';
import { useAppStore } from '../store/useAppStore.js';
import { ViewCube } from '../viewcube/ViewCube.js';
import { attachCameraControls, type CameraControls } from './attachCameraControls.js';
import { attachSketchInteraction } from './attachSketchInteraction.js';
import { HOME_ORBIT, type OrbitState } from './cameraMath.js';
import { createViewportScene } from './createViewportScene.js';
import { readThemeColors } from './themeColors.js';

/**
 * 3D ビューポート(FR-101、FR-102、FR-104、FR-105、FR-106、FR-108、FR-310)。
 *
 * 視点の正本は `attachCameraControls` が持ち、画面状態(投影・表示スタイル・方眼・
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

    /**
     * 3D の色をテーマから読み直すべきか(FR-908)。ルート要素へ `data-theme` を書くのは
     * `applyDisplaySettings.ts` の見張りなので、**読むのは次の描画機会まで待つ**。
     * こうすると見張りが呼ばれる順に依らず、属性が効いた後の色を必ず読める。
     * 起動時も 1 回読む(保存されていたテーマで始まるため)。
     */
    let themeDirty = true;

    function draw(): void {
      frameId = 0;
      if (themeDirty) {
        themeDirty = false;
        scene.setThemeColors(readThemeColors());
      }
      const { projection, displayStyle, showGrid, displaySettings } = useAppStore.getState();
      scene.render(controls.getOrbit(), projection, displayStyle, showGrid, displaySettings.uiScale);
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

    // 保存のときに呼ばれるサムネイルの作り手を差し出す(§0.a-0.18、FR-801)。
    // 3D 表示部は後から読み込まれるので、それまでは口が空でサムネイルなしになる。
    useAppStore.getState().setCaptureThumbnail(() => scene.captureThumbnail());

    const controls = attachCameraControls(canvas, requestDraw);
    controlsRef.current = controls;
    // 視点操作を先に結び、その後ろでスケッチの操作を結ぶ(中ボタン・Alt の取り合いを避ける)。
    // 視点そのものを渡す。距離は方眼の刻みに、向きは 3D スケッチで押した場所に置く面に使う
    // (FR-330、P4 タスク14)。
    const interaction = attachSketchInteraction(canvas, scene, () => controls.getOrbit());
    setControlsReady(true);

    const observer = new ResizeObserver(() => {
      scene.resize(canvas.clientWidth, canvas.clientHeight);
      requestDraw();
    });
    observer.observe(canvas);

    scene.resize(canvas.clientWidth, canvas.clientHeight);
    const initial = useAppStore.getState();
    scene.setSketch(initial.resolvedSketch, initial.sketchMesh);
    scene.setSketchHighlight(initial.hoveredElementId, initial.selection);
    scene.setBodies(initial.bodies);
    scene.setBodyHighlight(initial.hoveredElementId, initial.selection);
    scene.setSubShapeHighlight(initial.hoveredElementId, initial.selection);
    scene.setWorkPlane(initial.workPlane);
    // 3D スケッチ(作図面なし、FR-330)では作図面の矩形を出さない(P4 タスク33)。
    scene.setWorkPlaneVisible(!isFreeWorkPlaneId(initial.workPlaneId));
    // 構築線(FR-320)は履歴を見ないと分からないので、文書から引いて渡す(P4 タスク33)。
    scene.setConstructionIds(constructionFeatureIds(initial.sketch));
    scene.setReferences(initial.resolvedReferences);
    scene.setEditPreview(initial.editPreview);
    scene.setTracking(initial.trackIndicator);
    requestDraw();

    const unsubscribe = useAppStore.subscribe((next, previous) => {
      // スケッチの形と、カーネルが返した面(FR-105、FR-310)。
      if (
        next.resolvedSketch !== previous.resolvedSketch ||
        next.sketchMesh !== previous.sketchMesh
      ) {
        scene.setSketch(next.resolvedSketch, next.sketchMesh);
      }
      // 立体(FR-105)。カーネルが返した三角形と稜線をボディごとに描く。
      if (next.bodies !== previous.bodies) {
        scene.setBodies(next.bodies);
      }
      // ホバー・選択の強調(FR-106)。スケッチの要素・ボディ・部分形状(面・辺・頂点)は
      // 同じ選択を共有していて、id の形でどれを強調するかが決まる(§0.a-0.8)。
      // 選択の種類(selectionKind)が変わると選択は空になる(useAppStore.setSelectionKind)が、
      // ホバーは残ることがあるので、種類の変化そのものも見て古い形の強調を残さない。
      if (
        next.hoveredElementId !== previous.hoveredElementId ||
        next.selection !== previous.selection ||
        next.selectionKind !== previous.selectionKind
      ) {
        scene.setSketchHighlight(next.hoveredElementId, next.selection);
        scene.setBodyHighlight(next.hoveredElementId, next.selection);
        scene.setSubShapeHighlight(next.hoveredElementId, next.selection);
      }
      // 作図面が変わったら矩形の向きを変える(§0.a-0.3)。任意の作業平面(FR-328)は
      // 文書が変わっても面の位置が動くので、解いた面そのものの変化を見る(タスク13)。
      if (next.workPlane !== previous.workPlane) {
        scene.setWorkPlane(next.workPlane);
      }
      if (next.workPlaneId !== previous.workPlaneId) {
        scene.setWorkPlaneVisible(!isFreeWorkPlaneId(next.workPlaneId));
      }
      // 構築線(FR-320)の入り切りは履歴の変化にだけ表れる(解決済みの曲線には出ない)。
      if (next.sketch !== previous.sketch) {
        scene.setConstructionIds(constructionFeatureIds(next.sketch));
      }
      // 基準ジオメトリ(FR-329)。文書から解いた控えが変わったときだけ出し直す。
      if (next.resolvedReferences !== previous.resolvedReferences) {
        scene.setReferences(next.resolvedReferences);
      }
      // トリム・延長の予告(FR-322、タスク22)。同じ区間なら
      // `attachSketchInteraction` 側が入れ直さないので、ここは変化だけを見ればよい。
      if (next.editPreview !== previous.editPreview) {
        scene.setEditPreview(next.editPreview);
      }
      // 向きの吸着の案内線(FR-110、P4b タスク16)。同じ線のままポインタが滑っている間は
      // `attachSketchInteraction` 側が入れ直さないので、ここは変化だけを見ればよい。
      if (next.trackIndicator !== previous.trackIndicator) {
        scene.setTracking(next.trackIndicator);
      }
      // 表示テーマが変わったら 3D の色も読み直す(FR-908。拡大率は 3D の色を変えない)。
      if (next.displaySettings.theme !== previous.displaySettings.theme) {
        themeDirty = true;
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
      // 片付けた場面をもう使えないので、サムネイルの作り手も取り下げる。
      useAppStore.getState().setCaptureThumbnail(null);
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
