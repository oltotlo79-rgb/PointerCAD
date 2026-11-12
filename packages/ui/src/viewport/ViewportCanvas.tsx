import { currentReferenceRepairPreview } from '../solid/referenceRepairPreview.js';
import { referenceRepairPreviewChangesDisplay } from './viewportRepairPreview.js';
import { DraggableWindowTitle } from '../sketch/DraggableWindowTitle.js';
import { useCallback, useEffect, useRef, useState } from 'react';

import { evaluateExpression } from '@pointercad/expression';
import {
  createEmptySketchDocument,
  formatDisplayLength,
  parseDisplayInput,
  resolveSketch,
  toDisplayLength,
  type LengthUnit,
} from '@pointercad/model';

import { t } from '../i18n/t.js';
import { resolveCutPlane } from '../solid/cutCommands.js';
import { LENGTH_UNIT_LABEL_KEYS } from '../settings/settings.js';
import { CanvasRectificationField } from './canvasRectificationField.js';
import { activePartDocument } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import type { AppState } from '../store/appState.js';
import { isSheetFlatDisplayed } from '../sheetMetal/sheetCreationActions.js';
import { ViewCube } from '../viewcube/ViewCube.js';
import type { CameraControls } from './attachCameraControls.js';
import type { SketchTimingContext } from './sketchDragTiming.js';
import { MatePopover } from '../assembly/MatePopover.js';
import { HOME_ORBIT, type OrbitState } from './cameraMath.js';
import { createViewportScene } from './createViewportScene.js';
import { LOCAL_DISPLAY_GPU_MESH_BUDGET } from './solidMeshAdmission.js';
import { toThreePlane } from './sectionView.js';
import { QuadPaneLabels } from './QuadPaneLabels.js';
import { createViewportAssemblyInput } from './viewportCanvasAssemblyInput.js';
import { publishCaptureProducers } from './viewportCanvasCapture.js';
import { publishSceneDiagnostics, publishThumbnailReasons } from './viewportCanvasDiagnostics.js';
import { createViewportFrame } from './viewportCanvasFrame.js';
import { attachViewportInputs } from './viewportCanvasInputs.js';
import { mountViewportCanvas, retryRetiredViewports, type ViewportMount } from './viewportCanvasMount.js';
import { syncInitialScene, syncStoreChange, type ViewportStoreSync } from './viewportCanvasStoreSync.js';
import { attachUnderlayPointInput, createUnderlayImages } from './viewportCanvasUnderlay.js';

/** 部品文書を開いていない間と、板金の展開図を出している間に scene へ渡す空のスケッチ。 */
const EMPTY_PART_SKETCH = resolveSketch(createEmptySketchDocument());

/**
 * 断面表示を出せないときの理由(NFR-UX-5。「断られたら `message` を
 * 案内に」)。出せているときは `null`。文言は `sectionView.ts` と `planeSpec.ts` が持つ
 * 日本語をそのまま使い、ja.json に同じ文を二重に書かない。
 */
function sectionRefusalOf(
  section: ReturnType<typeof useAppStore.getState>['sectionView'],
): string | null {
  if (section === null) {
    return null;
  }
  const plane = resolveCutPlane(section.plane);
  if (plane === null) {
    return t('sectionView.planeUnavailable');
  }
  const outcome = toThreePlane(plane, section.offsetMm, section.flipped);
  return outcome.ok ? null : outcome.message;
}

/**
 * つまみの位置を欄に出すときの丸め(桁)。引いている最中は端数がいくらでも長くなるので、
 * 打ち直すときの出発点として読める長さに切る(内部の値は丸めない)。
 */
const SECTION_OFFSET_DIGITS = 3;

/** 断面表示のオフセット(内部は mm)を、表示の単位の読める文字にする(FR-811)。 */
function offsetFieldText(offsetMm: number, unit: LengthUnit): string {
  return String(Number(toDisplayLength(offsetMm, unit).toFixed(SECTION_OFFSET_DIGITS)));
}

/**
 * 断面表示のその場の数値入力(NFR-UX-2。「ドラッグで動かし、その場の数値入力でも打てる」)。
 *
 * ビューポートの上に浮かべる小さな欄で、つまみを引くのと同じ 1 つの値(法線方向の
 * オフセット、mm)を打ち込む。**式が打てる**(FR-201)ので、`10/3` や `√2*5` もそのまま
 * 通る。打っている途中の文字はここが持つ(rules/04: `useState` は表示専用の一時状態だけ)。
 */
function SectionOffsetField(): React.JSX.Element | null {
  const sectionView = useAppStore((state) => state.sectionView);
  const lengthUnit = useAppStore((state) => state.displaySettings.lengthUnit);
  const setSectionOffset = useAppStore((state) => state.setSectionOffset);
  const flipSectionView = useAppStore((state) => state.flipSectionView);
  const toggleSectionView = useAppStore((state) => state.toggleSectionView);
  /** 打ちかけの文字。null のあいだはストアの値(つまみで動いたぶんも)をそのまま出す。 */
  const [draft, setDraft] = useState<string | null>(null);

  if (sectionView === null) {
    return null;
  }
  const source = draft ?? offsetFieldText(sectionView.offsetMm, lengthUnit);
  // 表示が inch のときは打った式を `(…)in` で包む(規則の正本は model の `parseDisplayInput`)。
  const evaluated = evaluateExpression(parseDisplayInput(source, lengthUnit));
  const refusal = sectionRefusalOf(sectionView);
  return (
    /*
      その場に浮かぶ欄の見た目は**既存のその場入力(ポップアップ)と同じ作法**にそろえる。
      `.pcad-popover` は `position: absolute` と `z-index: 2` を持つのでビューポートの
      左上へ浮かび、canvas の上に出る。ステータスバーの入切と同じく、この機能のために
      appShell.css を 1 行も増やさない(区画も増やさない、rules/04)。
      `pcad-section-view` は**見た目を持たない目印**で、E2E がその場入力のポップアップと
      この欄を取り違えないようにするために添えてある。
    */
    <div className="pcad-popover pcad-section-view">
      <DraggableWindowTitle className="pcad-popover__title">{t('sectionView.title')}</DraggableWindowTitle>
      <label className="pcad-field">
        <span className="pcad-field__label">{t('sectionView.offset')}</span>
        <input title={t('controlGuide.section.offset')}
          className="pcad-field__input"
          type="text"
          inputMode="text"
          value={source}
          aria-label={t('sectionView.offset')}
          onChange={(event) => {
            const next = event.target.value;
            setDraft(next);
            const parsed = evaluateExpression(parseDisplayInput(next, lengthUnit));
            if (parsed.ok) {
              // 評価した値は必ず mm(単位の換算は式の側で済んでいる)。
              setSectionOffset(parsed.value.value);
            }
          }}
          onBlur={() => {
            // 欄を離れたら打ちかけを畳み、ストアの値(引いて動いたぶんも含む)へ戻す。
            setDraft(null);
          }}
        />
        <span className="pcad-field__unit">{t(LENGTH_UNIT_LABEL_KEYS[lengthUnit])}</span>
      </label>
      <span
        className={
          evaluated.ok && refusal === null
            ? 'pcad-field__message'
            : 'pcad-field__message pcad-field__message--error'
        }
      >
        {evaluated.ok
          ? (refusal ?? `= ${formatDisplayLength(evaluated.value.value, lengthUnit)}`)
          : evaluated.error.message}
      </span>
      <div className="pcad-popover__actions">
        <button
          type="button"
          className="pcad-button"
          title={t('sectionView.flipTooltip')}
          onClick={() => {
            flipSectionView();
          }}
        >
          {t('sectionView.flip')}
        </button>
        <button
          type="button"
          className="pcad-button"
          title={t('sectionView.closeTooltip')}
          onClick={() => {
            setDraft(null);
            toggleSectionView();
          }}
        >
          {t('sectionView.close')}
        </button>
      </div>
    </div>
  );
}

/**
 * 下絵の 2 点の寸法合わせのその場入力(FR-332、NFR-UX-2)。
 *
 * 断面表示のつまみ(`SectionOffsetField`)とまったく同じ流儀で、ビューポートの上に浮かべる
 * (**区画は増やさない**、要件§7.1)。指す 2 点はビューポートを押して決め、ここでは
 * **欄 1 つ(2 点の実寸)**だけを受ける。**式が打てる**(FR-201)ので `10/3` や `√2*5` も通り、
 * 表示が inch のときは打った式を `(…)in` で包む(規則の正本は model の `parseDisplayInput`)。
 */
function CanvasScaleField(): React.JSX.Element | null {
  const canvasScale = useAppStore((state) => state.canvasScale);
  const canvasRectification = useAppStore((state) => state.canvasRectification);
  const canvasMessage = useAppStore((state) => state.canvasMessage);
  const document = useAppStore((state) => state.document);
  const lengthUnit = useAppStore((state) => state.displaySettings.lengthUnit);
  const applyCanvasScale = useAppStore((state) => state.applyCanvasScale);
  const cancelCanvasScale = useAppStore((state) => state.cancelCanvasScale);
  const setCanvasMessage = useAppStore((state) => state.setCanvasMessage);
  /** 打ちかけの文字(rules/04: `useState` は表示専用の一時状態だけ)。 */
  const [draft, setDraft] = useState('');

  if (canvasScale === null && (canvasMessage === null || canvasRectification !== null)) {
    return null;
  }
  const canvas =
    canvasScale === null
      ? undefined
      : document.canvases.find((item) => item.id === canvasScale.canvasId);
  const evaluated = evaluateExpression(parseDisplayInput(draft, lengthUnit));
  const points = canvasScale?.points ?? [];
  const ready = points.length >= 2;
  const typing = draft.trim() !== '';
  /**
   * 欄の下の 1 行。断り → 指す案内 → 打った式の下ごたえ、の順に出す。
   * 打ち始める前は空(空の式の断りを出しても読み手には何の役にも立たない)。
   */
  const messageText = ((): string => {
    if (canvasMessage !== null) {
      return canvasMessage;
    }
    if (!ready) {
      return points.length === 0 ? t('canvas.pickFirst') : t('canvas.pickSecond');
    }
    if (!typing) {
      return '';
    }
    return evaluated.ok
      ? `= ${formatDisplayLength(evaluated.value.value, lengthUnit)}`
      : evaluated.error.message;
  })();
  return (
    <div className="pcad-popover pcad-canvas-scale">
      {/* 受け付けられない画像を断るだけのときは、寸法合わせの見出しにしない。 */}
      <DraggableWindowTitle className="pcad-popover__title">
        {canvasScale === null ? t('toolbar.canvas.label') : t('canvas.title')}
      </DraggableWindowTitle>
      {ready ? (
        <label className="pcad-field">
          <span className="pcad-field__label">{t('canvas.realLength')}</span>
          <input title={t('controlGuide.canvas.realLength')}
            className="pcad-field__input"
            type="text"
            inputMode="text"
            value={draft}
            aria-label={t('canvas.realLength')}
            onChange={(event) => {
              setDraft(event.target.value);
              setCanvasMessage(null);
            }}
          />
          <span className="pcad-field__unit">{t(LENGTH_UNIT_LABEL_KEYS[lengthUnit])}</span>
        </label>
      ) : null}
      <span
        className={
          canvasMessage === null
            ? 'pcad-field__message'
            : 'pcad-field__message pcad-field__message--error'
        }
      >
        {/*
          断りの文言(2 点が同じ・実寸が 0 以下・受け付けない画像)は model が組み立てたものを
          そのまま出す(`ja.json` に同じ文を二重に書かない)。
        */}
        {messageText}
      </span>
      <div className="pcad-popover__actions">
        <button
          type="button"
          className="pcad-button"
          title={t('canvas.applyTooltip')}
          disabled={!ready || !typing || !evaluated.ok || canvas === undefined}
          onClick={() => {
            if (!evaluated.ok || canvas === undefined) {
              return;
            }
            // 画素の大きさは復号した画像が答える(文書には保存しない、rules/04)。
            const pixelSize = useAppStore.getState().canvasPixelSizes.get(canvas.imageId);
            if (pixelSize === undefined) {
              return;
            }
            if (applyCanvasScale(evaluated.value.value, pixelSize)) {
              setDraft('');
            }
          }}
        >
          {t('canvas.apply')}
        </button>
        <button
          type="button"
          className="pcad-button"
          title={t('canvas.cancelTooltip')}
          onClick={() => {
            setDraft('');
            cancelCanvasScale();
          }}
        >
          {t('canvas.cancel')}
        </button>
      </div>
    </div>
  );
}

/** コンポーネントの状態のうち、装着の初期化が使うもの。 */
interface ViewportCanvasView {
  /** ビューキューブが `getOrbit` / `setOrbit` を借りるための入口。 */
  readonly controlsRef: { current: CameraControls | null };
  /** ビューポートが描いたことを知りたい人たち(いまはビューキューブだけ)。 */
  readonly drawListeners: ReadonlySet<() => void>;
  readonly setControlsReady: (ready: boolean) => void;
}

/**
 * 1 回の装着の初期化。scene と各持ち主(診断の口・組立の入力の準備・描画の予約・下絵・保存の作り手・入力・
 * ストアの受け渡し)を、片付けの台帳へ決まった順(=片付けの順)で登録しながら作って結ぶ。
 * スケッチの形の差し替え(setObservedSketch)と参照修復の予告(syncRepairPreview)はここに置く。どちらも待ちの
 * 後に文書を差し替えない(scene への表示の受け渡しと描き直しの予約だけ)。
 */
function initializeViewport(mount: ViewportMount, view: ViewportCanvasView): void {
  const { canvas, lifetime, isAlive, sketchTiming } = mount;
  publishThumbnailReasons(lifetime, mount.thumbnailReasons);
  const scene = createViewportScene(canvas, { readSolidMeshState: () => useAppStore.getState(),
    gpuMeshBudget: LOCAL_DISPLAY_GPU_MESH_BUDGET, observation: mount.observation, viewportOwnerId: mount.viewportOwnerId });
  mount.setSceneReservation(() => scene.meshReservation());
  lifetime.register('viewport scene', () => {
    scene.dispose();
    const reading = scene.meshReservation();
    if (reading.viewportCleanupStatus === 'pending' || reading.assemblyCleanupStatus === 'pending') {
      throw new Error('Viewport resources remain pending');
    }
  });
  const assemblyInput = createViewportAssemblyInput({ scene, isAlive, requestDraw: () => { frame.requestDraw(); } });
  const diagnostics = publishSceneDiagnostics({ lifetime, scene, isAlive, viewportOwnerId: mount.viewportOwnerId,
    observation: mount.observation, assemblyInput, readRetiredViewports: mount.readRetiredViewports });

  // 全setSketch入口を通し、成功した実resolved参照だけを記録する。
  function sketchTimingContext(): SketchTimingContext {
    const state = useAppStore.getState();
    return { canvas, document: state.document, documentVersion: state.documentVersion,
      owner: state.sketchDrag, resolved: state.dragResolved ?? state.resolvedSketch,
      hidden: !isAlive() || activePartDocument(state) === null || isSheetFlatDisplayed(state) };
  }
  function setObservedSketch(state: AppState, hidden: boolean): void {
    const resolved = hidden ? EMPTY_PART_SKETCH : state.dragResolved ?? state.resolvedSketch;
    if (sketchTiming === undefined) scene.setSketch(resolved, hidden ? null : state.sketchMesh);
    else sketchTiming.setSketch(resolved, () => { scene.setSketch(resolved, hidden ? null : state.sketchMesh); }, sketchTimingContext);
  }
  const frame = createViewportFrame({ scene, lifetime, isAlive, sketchTiming, sketchTimingContext,
    assemblyReady: assemblyInput.assemblyReady, orbit: () => inputs.controls.getOrbit(), stats: diagnostics.stats,
    listeners: view.drawListeners });
  const images = createUnderlayImages({ scene, lifetime, isAlive, requestDraw: frame.requestDraw,
    disposeViewport: mount.disposeViewport });
  attachUnderlayPointInput(canvas, scene, lifetime, isAlive);
  const capture = publishCaptureProducers({ scene, lifetime, isAlive, assemblyInput, thumbnailReasons: mount.thumbnailReasons });
  const inputs = attachViewportInputs({ canvas, scene, lifetime, isAlive, requestDraw: frame.requestDraw, assemblyInput,
    sketchTiming, controlsRef: view.controlsRef, setControlsReady: view.setControlsReady });

  function syncRepairPreview(state: AppState): void {
    const update = scene.setReferenceRepairPreview(currentReferenceRepairPreview(state));
    if (isAlive() && referenceRepairPreviewChangesDisplay(update)) frame.requestDraw();
    void update.then(() => {
      if (isAlive() && referenceRepairPreviewChangesDisplay(update)) frame.requestDraw();
    }, () => {
      // A provider/cleanup rejection leaves the preview unavailable; no document or history is changed.
      if (isAlive()) frame.requestDraw();
    });
  }

  const sync: ViewportStoreSync = { canvas, scene, isAlive, sketchTiming, publishSketch: setObservedSketch, syncRepairPreview,
    showCutPreview: diagnostics.showCutPreview, assemblyInput, invalidateThumbnailPublication: capture.invalidatePublication,
    syncCanvasImages: () => { images.sync(); }, requestDraw: frame.requestDraw, markThemeDirty: frame.markThemeDirty,
    cancelAssemblyDrag: inputs.cancelAssemblyDrag, controls: inputs.controls };
  syncInitialScene(sync);
  const unsubscribe = useAppStore.subscribe((next, previous) => { syncStoreChange(sync, next, previous); });
  lifetime.register('store subscription', unsubscribe);
}

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
  const quadActive = useAppStore((state) => state.quadCamera?.active ?? null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** ビューキューブが `getOrbit` / `setOrbit` を借りるための入口。 */
  const controlsRef = useRef<CameraControls | null>(null);
  /** ビューポートが描いたことを知りたい人たち(いまはビューキューブだけ)。 */
  const drawListenersRef = useRef(new Set<() => void>());
  /** 初回描画では `controlsRef` がまだ空なので、用意できてからビューキューブを出す。 */
  const [controlsReady, setControlsReady] = useState(false);
  const [cleanupWaiting, setCleanupWaiting] = useState(false);
  const [mountFailure, setMountFailure] = useState<Error | null>(null);

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

  // 装着の寿命(片付けの順番待ち・失敗の巻き戻し・外した後の片付けの返し直し)は viewportCanvasMount.ts が持つ。
  useEffect(() => mountViewportCanvas({ canvasRef, setCleanupWaiting, setMountFailure,
    initialize: (mount) => {
      initializeViewport(mount, { controlsRef, drawListeners: drawListenersRef.current, setControlsReady });
    } }), []);

  if (mountFailure !== null) throw mountFailure;

  return (
    <>
      <canvas
        ref={canvasRef}
        className="pcad-viewport__canvas"
        tabIndex={0}
        aria-label={t('viewport.label')}
      />
      {cleanupWaiting ? <div className="pcad-viewport__overlay" role="status">
        <div className="pcad-card pcad-viewport__failure">
          <p>{t('viewport.cleanupPending')}</p>
          <p>{t('viewport.failedAdvice')}</p>
          <button className="pcad-button" type="button" title={t('controlGuide.button.viewportRetry')}
            onClick={() => { retryRetiredViewports(); }}>{t('viewport.retry')}</button>
        </div>
      </div> : null}
      {/*
        断面表示のその場の数値入力(FR-111、NFR-UX-2)。**区画は増やさない**——
        ビューポートの中に浮かべ、断面表示を入れているあいだだけ出す。
      */}
      <SectionOffsetField />
      <QuadPaneLabels />
      {/*
        下絵の 2 点の寸法合わせ(FR-332、NFR-UX-2)。合わせている間だけ出る。
        断面表示の欄と同じく**区画は増やさない**。
      */}
      <CanvasScaleField />
      <CanvasRectificationField />
      <MatePopover />
      {controlsReady && (quadActive === null || quadActive === 'isometric') ? (
        <ViewCube getOrbit={getOrbit} setOrbit={setOrbit} subscribeDraw={subscribeDraw} />
      ) : null}
    </>
  );
}
