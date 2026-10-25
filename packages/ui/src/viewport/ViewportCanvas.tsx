import { cameraDragAction } from './cameraControlBindings.js';
import { readCameraControlSettings } from '../settings/cameraControlSettings.js';
import { currentReferenceRepairPreview } from '../solid/referenceRepairPreview.js';
import { DraggableWindowTitle } from '../sketch/DraggableWindowTitle.js';
import { useCallback, useEffect, useRef, useState } from 'react';

import { evaluateExpression } from '@pointercad/expression';
import {
  addVec3,
  appearanceOf,
  createEmptySketchDocument,
  formatDisplayLength,
  isFreeWorkPlaneId,
  parseDisplayInput,
  resolveSketch,
  scaleVec3,
  solveCanvasHomography,
  toDisplayLength,
  worldToPlane,
  type LengthUnit,
} from '@pointercad/model';

import { buildAppearanceInput } from '../appearance/appearanceCommands.js';
import { t } from '../i18n/t.js';
import { resolveCutPlane } from '../solid/cutCommands.js';
import { cutPlanePreviewOf } from '../solid/cutPlanePreview.js';
import { LENGTH_UNIT_LABEL_KEYS } from '../settings/settings.js';
import { printabilityMatchesDisplayMeshes } from '../solid/printabilityColors.js';
import { solidAnalysisLayersOf } from '../solidAnalysis/solidModalViewport.js';
import { subShapeBodiesOf } from '../solid/subShapeSelection.js';
import { constrainedFeatureIdsOfStore } from '../sketch/constraintActions.js';
import { constraintMarksOf } from '../sketch/constraintPicking.js';
import type { DecodedCanvasImage } from '../file/canvasFile.js';
import { createCanvasImageCache } from './createCanvasImageCache.js';
import { createViewportMeshObservation, type ViewportMeshObservationSnapshot } from './viewportMeshObservation.js';
import { constructionFeatureIds } from '../sketch/featureSummary.js';
import { resolveWorkPlaneOf } from '../sketch/referenceCommands.js';
import { canvasPixelPointOf, canvasPlacementOf, type CanvasDraw } from './canvasLayer.js';
import { CanvasRectificationField } from './canvasRectificationField.js';
import {
  buildAssemblyGeometry,
  EMPTY_ASSEMBLY_GEOMETRY,
  flattenAssemblyGeometry,
  type AssemblyGeometryBundle,
} from './createAssemblyLayer.js';
import { sphereGridSphereOf, sphereGridTargetSphere } from '../sketch/sketchCommands.js';
import { activeAssemblyDocument, activePartDocument } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { currentMathGeometry } from '../math/mathGeometryResults.js';
import type { AppState } from '../store/appState.js';
import { currentAssemblyMeshAdmission, currentAssemblyMeshPublication, type AssemblyMeshOwnership } from './assemblyMeshAdmission.js';
import { isSheetFlatDisplayed } from '../sheetMetal/sheetCreationActions.js';
import { ViewCube } from '../viewcube/ViewCube.js';
import { attachCameraControls, type CameraControls } from './attachCameraControls.js';
import { attachSketchInteraction } from './attachSketchInteraction.js';
import { attachAssemblyInteraction, type AssemblyMateInputObservation } from './attachAssemblyInteraction.js';
import { MatePopover } from '../assembly/MatePopover.js';
import { componentDragPlacements } from '../assembly/dragComponentActions.js';
import { shownOccurrencePlacements } from '../store/assemblyOccurrenceDriveSlice.js';
import { assemblyTargetId } from '../assembly/mateCommands.js';
import { HOME_ORBIT, viewDirection, type OrbitState } from './cameraMath.js';
import { createViewportScene, ViewportSceneInitializationFailure, type SectionViewRender, type ViewportMeshReservation } from './createViewportScene.js';
import { LOCAL_DISPLAY_GPU_MESH_BUDGET, solidBodiesForAdmission, solidMeshOwnershipChanged } from './solidMeshAdmission.js';
import type { CutPreview, PrintabilityHighlight } from './createSolidLayer.js';
import type { SphereGridSpec } from './buildSphereGrid.js';
import { toThreePlane } from './sectionView.js';
import { readThemeColors } from './themeColors.js';
import { namedCameraFromOrbit, orbitFromNamedCamera, type ViewCameraController } from './namedCamera.js';
import { attachQuadInput } from './attachQuadInput.js';
import { quadLayout } from './quadLayout.js';
import { createThumbnailCaptureReasonJournal, observeThumbnailCaptureReasons } from '../file/thumbnail.js';
import { QuadPaneLabels } from './QuadPaneLabels.js';
import { createViewportLifetime, createViewportCleanupQueue, type PendingViewportReading } from './viewportLifetime.js';

/** E2Eだけが読む、実際に完了したビューポート描画の統計。製品の状態には含めない。 */
interface ViewportRenderStats {
  readonly completedRenders: number;
  readonly lastCompletedAtMs: number;
  readonly totalSceneRenderMs: number;
  readonly totalDrawListenerMs: number;
  readonly cleanupStatus: 'active' | 'complete' | 'pending';
}

declare global {
  interface Window {
    /** 検査専用。`scene.render` が正常に戻った回数と最後の完了時刻を読む。 */
    pcadViewportRenderStats?: () => ViewportRenderStats;
    pcadViewportAssemblyOwner?: () => Readonly<Record<string, unknown>> | null;
    pcadViewportFramedBodies?: () => readonly string[];
    pcadThumbnailCaptureReasons?: () => ReturnType<ReturnType<typeof createThumbnailCaptureReasonJournal>['snapshot']>;
    /** 検査専用の表示コピー/属性予約会計。driverのGPU actualではない。 */
    pcadViewportMemoryStats?: () => ViewportMeshReservation | null;
    pcadViewportMeshObservation?: () => ViewportMeshObservationSnapshot;
    /** 検査専用。scene へ渡した最後の切断の予告(EX-04 W2 の画面検査が予告の面を読む)。 */
    pcadViewportCutPreview?: () => CutPreview | null;
    pcadViewportRetiredCleanups?: () => { readonly pendingCount: number; readonly ownerCount: number;
      readonly waitingCount: number; readonly scheduled: boolean; readonly sharedGpuPoolReservedBytes: number;
      readonly owners: readonly PendingViewportReading[] };
  }
}

/** 切断の予告を組み立てる材料。ストアから読むものだけを並べる。 */
const EMPTY_PART_SKETCH = resolveSketch(createEmptySketchDocument());
let nextViewportOwner = 0;
const retiredViewports = createViewportCleanupQueue((retry, delayMs) => {
  const timer = globalThis.setTimeout(retry, delayMs);
  return () => { globalThis.clearTimeout(timer); };
});
const readRetiredViewports = () => ({ pendingCount: retiredViewports.pendingCount,
  ownerCount: retiredViewports.ownerCount, waitingCount: retiredViewports.waitingCount,
  scheduled: retiredViewports.scheduled, sharedGpuPoolReservedBytes: LOCAL_DISPLAY_GPU_MESH_BUDGET.reservedBytes(),
  owners: retiredViewports.snapshot() });

/**
 * 検査専用の口 `window.pcadViewportCutPreview`(EX-04 W2)を出している、生きているビューポートの読み取り。
 * 付けた順に積み、いちばん後に付けたものを公開する。外したら 1 つ前のものへ、最後の 1 つを外したら
 * 最初に付ける前の値へ戻す(取り付けと取り外しが対になる)。製品の経路からは読まない。
 */
const cutPreviewReaders: (() => CutPreview | null)[] = [];
let cutPreviewReaderBeforeAttach: (() => CutPreview | null) | undefined;

/** 読み取りを口へ付け、外す関数を返す(ビューポートの lifetime に登録する)。 */
function attachCutPreviewReader(read: () => CutPreview | null): () => void {
  if (cutPreviewReaders.length === 0) {
    cutPreviewReaderBeforeAttach = window.pcadViewportCutPreview;
  }
  cutPreviewReaders.push(read);
  window.pcadViewportCutPreview = read;
  return () => {
    const index = cutPreviewReaders.indexOf(read);
    if (index === -1) {
      return;
    }
    cutPreviewReaders.splice(index, 1);
    const restored = cutPreviewReaders.at(-1) ?? cutPreviewReaderBeforeAttach;
    if (restored === undefined) {
      delete window.pcadViewportCutPreview;
    } else {
      window.pcadViewportCutPreview = restored;
    }
  };
}

interface CutPreviewSource {
  readonly numericInput: ReturnType<typeof useAppStore.getState>['numericInput'];
  readonly document: ReturnType<typeof useAppStore.getState>['document'];
  readonly bodies: ReturnType<typeof useAppStore.getState>['bodies'];
  readonly selection: readonly string[];
  readonly parameterAnalysis: ReturnType<typeof useAppStore.getState>['parameterAnalysis'];
  readonly displaySettings: ReturnType<typeof useAppStore.getState>['displaySettings'];
}

/**
 * 切断面の予告(FR-432、P5 タスク27e、§0.a-0.61)をストアの状態から組み立てる。
 *
 * **出す条件**は「切断の道具の段が開いていて、切る立体が決まっていて、いま決定すれば切れること」。
 * 段を閉じれば(確定でも取消でも)`numericInput` が null になるので、そのまま消える。
 * 面は確定と同じ式の評価・材料の解決で解く(`cutPlanePreviewOf`、EX-04 W2)。式の評価の文脈は
 * 決定(`NumericInputPopover` の Enter)と同じ、パラメータの解析と表示の単位。
 */
function cutPreviewOf(source: CutPreviewSource): CutPreview | null {
  return cutPlanePreviewOf({
    numericInput: source.numericInput,
    document: source.document,
    bodies: subShapeBodiesOf(source.bodies),
    selection: source.selection,
    evaluation: { ...source.parameterAnalysis, lengthUnit: source.displaySettings.lengthUnit },
  });
}

/**
 * ビューの断面表示(FR-111、P6 タスク35、§2.12)を、ストアの札から描く材料へ開く。
 *
 * **カーネルへは行かない。** `resolveCutPlane`(指紋と基準の面だけで解く)で平面を解き、
 * `toThreePlane`(タスク34)で three.js に渡す素の数へ写す。**形は 1 つも変えない。**
 *
 * つまみの四角は**オフセットを載せた後の位置**へ置く(平面そのものを動かして見せる)。
 * 平面が解けない・オフセットが数でないときは `null` を返し、断りの文は
 * `sectionRefusalOf` が同じ道筋でもう一度求める(断りを 2 通りに分けない)。
 */
function sectionViewRenderOf(
  section: ReturnType<typeof useAppStore.getState>['sectionView'],
): SectionViewRender | null {
  if (section === null) {
    return null;
  }
  const plane = resolveCutPlane(section.plane);
  if (plane === null) {
    return null;
  }
  const outcome = toThreePlane(plane, section.offsetMm, section.flipped);
  if (!outcome.ok) {
    return null;
  }
  return {
    plane: outcome.plane,
    handle: {
      plane: {
        ...plane,
        origin: addVec3(plane.origin, scaleVec3(plane.normal, section.offsetMm)),
      },
      keep: section.flipped ? 'negative' : 'positive',
    },
  };
}

/**
 * 3D プリントの点検の色(FR-815、P6 §0.53、タスク46)。点検していなければ `null`。
 *
 * **結果と塗る相手はストアで必ず一緒に入れ替わる**ので、ここでは片方が欠けている状態を
 * 「点検していない」として扱う(欠けたまま塗ると、色の行き先が決まらない)。
 */
function printabilityHighlightOf(
  state: ReturnType<typeof useAppStore.getState>,
): PrintabilityHighlight | null {
  if (state.printability === null || state.printabilityOffsets === null) {
    return null;
  }
  if (!printabilityMatchesDisplayMeshes(state.printability, state.bodies)) {
    return null;
  }
  return { report: state.printability, triangleOffsets: state.printabilityOffsets };
}

/**
 * 断面表示を出せないときの理由(NFR-UX-5、タスク34 の申し送り「断られたら `message` を
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
 * 断面表示のその場の数値入力(NFR-UX-2、§0.42「ドラッグで動かし、その場の数値入力でも打てる」)。
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
      この欄を取り違えないようにするために添えてある(タスク44)。
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
 * 下絵(FR-332、P6 タスク39)の描く材料を、文書と復号した画像から組み立てる。
 *
 * **出さないもの**を 3 つここで外す: ①入切で切ってあるもの(`visible` が偽)、
 * ②画像をまだ復号できていないもの(読み込んだ直後の一瞬と、壊れた画像)、
 * ③文書にバイト列が無いもの。層(`canvasLayer.ts`)は渡された分だけを描く。
 */
function canvasDrawsOf(
  document: ReturnType<typeof useAppStore.getState>['document'],
  decoded: ReadonlyMap<string, DecodedCanvasImage>,
  rectifyingCanvasId: string | null,
): readonly CanvasDraw[] {
  return document.canvases.flatMap((canvas) => {
    const image = decoded.get(canvas.imageId);
    if (!canvas.visible || image === undefined) {
      return [];
    }
    const rectification = canvas.id === rectifyingCanvasId ? undefined : canvas.rectification;
    const solved = rectification === undefined ? null : solveCanvasHomography(rectification.sourceQuad);
    if (solved !== null && !solved.ok) return [];
    const homography = solved?.ok === true ? solved.homography : undefined;
    return [
      {
        id: canvas.id,
        image,
        // 任意の作業平面(FR-328)にも貼れる。解けない id は既定の XY へ落ちる。
        plane: resolveWorkPlaneOf(document, canvas.plane),
        placement: canvasPlacementOf(canvas),
        opacity: canvas.opacity.value,
        ...(homography === undefined ? {} : { homography }),
      },
    ];
  });
}

/**
 * 下絵の 2 点の寸法合わせのその場入力(FR-332、NFR-UX-2、§0.a-0.46、§2.14)。
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

/** 球面の案内線を組み立てる材料。ストアから読むものだけを並べる。 */
interface SphereGridSource {
  readonly document: ReturnType<typeof useAppStore.getState>['document'];
  readonly resolvedSketch: ReturnType<typeof useAppStore.getState>['resolvedSketch'];
  readonly selection: readonly string[];
  readonly sphereGridStep: ReturnType<typeof useAppStore.getState>['sphereGridStep'];
  readonly sphereGridAlwaysVisible: boolean;
}

/** The subscription and its unit tests share this decision (GR-20c A6). */
export function sphereGridNeedsUpdate(next: AppState, previous: AppState): boolean {
  return next.document !== previous.document
    || next.resolvedSketch !== previous.resolvedSketch
    || next.selection !== previous.selection
    || next.sphereGridStep !== previous.sphereGridStep
    || next.sphereGridAlwaysVisible !== previous.sphereGridAlwaysVisible
    || next.requestedGeneration !== previous.requestedGeneration
    || next.completedGeneration !== previous.completedGeneration
    || next.timelineIndex !== previous.timelineIndex
    || next.isComputing !== previous.isComputing
    || next.recomputeCancelled !== previous.recomputeCancelled
    || next.lastOutcome !== previous.lastOutcome
    || next.parameterAnalysis !== previous.parameterAnalysis
    || currentMathGeometry(next) !== currentMathGeometry(previous);
}

/**
 * 球面の案内線(球面グリッド、FR-431、P5 タスク21、§0.a-0.21)をストアの状態から組み立てる。
 *
 * **出す条件**は「球を選んでいること、または『いつも出す』が入で球が 1 つでもあること」。
 * 球が 1 つも無い文書では null になり、線分を 1 本も組み立てない(費用ゼロ)。
 * 中心を求められない置き方(立体の頂点に置いた球)でも null になる
 * (`sphereGridSphereOf` の注釈。緯度・経度を打って点を作る道はそのまま使える)。
 */
function sphereGridSpecOf(source: SphereGridSource): SphereGridSpec | null {
  const feature = sphereGridTargetSphere(
    source.document,
    source.selection,
    source.sphereGridAlwaysVisible,
  );
  if (feature === null) {
    return null;
  }
  const sphere = sphereGridSphereOf(feature, source.resolvedSketch);
  if (sphere === null) {
    return null;
  }
  return {
    center: sphere.center,
    radius: sphere.radius,
    stepDegrees: source.sphereGridStep.value,
  };
}

/**
 * 配置した部品(FR-605、FR-606、P7 タスク10)をストアの状態から組み立てる。
 *
 * **アセンブリを開いていないあいだは空**(部品の画面では入れ物も形も 1 つも作らない)。
 * 開いているあいだは `resolveAssembly`(model の純関数)が返す**インスタンスごとの配置**と
 * **部品の鍵**をそのまま使う——鍵の作り方も配置の合成も model の 1 か所が正本で、
 * 画面側で作り直さない(§0.a-0.4、§2.4)。
 *
 * ホバー・選択は部品の立体と同じ欄(`hoveredElementId` / `selection`)に乗る。部品の id は
 * `component-<n>` でフィーチャーの id とは形が違うので、取り違えは起きない(§0.a-0.8)。
 */
function assemblyBundleOf(
  state: ReturnType<typeof useAppStore.getState>,
): AssemblyGeometryBundle {
  const assembly = activeAssemblyDocument(state);
  if (assembly === null) {
    return EMPTY_ASSEMBLY_GEOMETRY;
  }
  const view = state.assemblyView;
  // History changes retain the previous view until attachAssembly publishes its new request.
  // Only publication identity is checked here; current receipt/accounting still belongs to Scene admission.
  if (view === null || view.sourceDocument !== assembly
    || state.requestedGeneration !== state.completedGeneration || state.recomputeCancelled
    || (view.meshOwnership !== undefined && !view.meshOwnership.publicationCurrent())) {
    return EMPTY_ASSEMBLY_GEOMETRY;
  }
  const resolved = view.resolved;
  const flattened = flattenAssemblyGeometry(
    assembly,
    resolved,
    componentDragPlacements(state)
      ?? (state.assemblyMotionSourceDocument === assembly ? state.assemblyMotionPlacements : null)
      ?? resolved.placements,
    shownOccurrencePlacements(state),
  );
  const selectedRoots = new Set([
    ...state.selection,
    ...(state.assemblyMateDraft?.targets.filter((target) => target.kind === 'origin').map((target) => target.componentId) ?? []),
  ]);
  const selectedComponentIds = flattened.components
    .filter((component) => [...selectedRoots].some((id) => component.id === id || component.id.startsWith(`${id}/`)))
    .map((component) => component.id);
  return buildAssemblyGeometry({
    ...flattened,
    bodies: view.bodies,
    appearances: view.appearances,
    hoveredComponentId: state.hoveredElementId,
    selectedComponentIds,
    selectedTargetIds: state.assemblyMateDraft?.targets.map(assemblyTargetId) ?? state.selection,
    hoveredTargetId: state.hoveredElementId,
  });
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const mountedCanvas = canvas;
    const viewportOwnerId = `viewport-${++nextViewportOwner}`;
    let mountEnded = false;
    let disposeMounted: (() => void) | null = null;
    const lifetime = createViewportLifetime();
    const observation = createViewportMeshObservation(viewportOwnerId);
    let alive = true;
    const thumbnailReasons = createThumbnailCaptureReasonJournal();
    const readThumbnailReasons = () => thumbnailReasons.snapshot();
    let frameId = 0;
    let readSceneReservation: (() => ViewportMeshReservation) | null = null;
    function disposeViewport(): void {
      alive = false;
      lifetime.dispose();
      if (lifetime.pendingCount === 0) {
        observation.close(viewportOwnerId);
        retiredViewports.returned(viewportOwnerId);
        if (retiredViewports.ownerCount === 0 && retiredViewports.waitingCount === 0
          && window.pcadViewportRetiredCleanups === readRetiredViewports) delete window.pcadViewportRetiredCleanups;
      } else {
        retiredViewports.retain(viewportOwnerId, {
          retry: () => { disposeViewport(); return lifetime.pendingCount === 0; },
          read: () => {
            const reading = readSceneReservation?.();
            return { viewportOwnerId, pendingCount: lifetime.pendingCount, errors: lifetime.errors,
              hostDisplayCopyBytes: reading?.displayCopyBytes ?? null, hostGpuAttributeBytes: reading?.gpuMeshBytes ?? null,
              unknown: [...(reading?.uncovered ?? ['viewportInitializationResources']), 'viewportBindings', 'nativeMemory', 'driverGpuActual'],
              observationActive: observation.snapshot().active };
          },
        });
      }
    }
    function initializeViewport(): void {
    if (mountEnded || canvasRef.current !== mountedCanvas) { retiredViewports.returned(viewportOwnerId); return; }
    const canvas = mountedCanvas;
    setCleanupWaiting(false);
    lifetime.register('thumbnail reason observer', observeThumbnailCaptureReasons(thumbnailReasons.record));
    window.pcadThumbnailCaptureReasons = readThumbnailReasons;
    lifetime.register('thumbnail reason getter', () => {
      if (window.pcadThumbnailCaptureReasons === readThumbnailReasons) delete window.pcadThumbnailCaptureReasons;
    });
    const scene = createViewportScene(canvas, { readSolidMeshState: () => useAppStore.getState(),
      gpuMeshBudget: LOCAL_DISPLAY_GPU_MESH_BUDGET, observation, viewportOwnerId });
    readSceneReservation = () => scene.meshReservation();
    lifetime.register('viewport scene', () => {
          scene.dispose();
          const reading = scene.meshReservation();
          if (reading.viewportCleanupStatus === 'pending' || reading.assemblyCleanupStatus === 'pending') {
            throw new Error('Viewport resources remain pending');
          }
        });
    const pendingAssemblyRefresh = new WeakMap<AssemblyMeshOwnership, Promise<boolean>>();
    const refusedAssemblyRefresh = new WeakSet<AssemblyMeshOwnership>();
    function assemblyReady(): boolean {
      const state = useAppStore.getState(), owner = state.assemblyView?.meshOwnership;
      if (activeAssemblyDocument(state) === null || owner === undefined) return true;
      const bundle = assemblyBundleOf(state);
      try {
        if (currentAssemblyMeshAdmission({ bundle, ownership: owner, state }, state)) return true;
        if (!currentAssemblyMeshPublication(owner, state) || owner.receipt.status !== 'known'
          || owner.backingInspection.status !== 'known' || owner.refreshOwnership === undefined
          || refusedAssemblyRefresh.has(owner) || pendingAssemblyRefresh.has(owner)) return false;
      } catch { refusedAssemblyRefresh.add(owner); return false; }
      const refresh = owner.refreshOwnership;
      if (refresh === undefined) return false;
      const pending = Promise.resolve().then(() => {
        if (!alive || !currentAssemblyMeshPublication(owner, useAppStore.getState())) return null;
        return refresh(owner);
      }).then(fresh => {
        if (!alive || fresh === null || fresh === owner) return false;
        const current = useAppStore.getState();
        if (current.assemblyView?.meshOwnership !== fresh || fresh.document !== owner.document
          || fresh.library !== owner.library || fresh.activeDocumentId !== owner.activeDocumentId
          || fresh.documentVersion !== owner.documentVersion || fresh.generation !== owner.generation
          || fresh.cancelRequestCount !== owner.cancelRequestCount || fresh.timelineIndex !== owner.timelineIndex
          || fresh.outcome !== owner.outcome || fresh.bodies !== owner.bodies || fresh.sources !== owner.sources
          || !currentAssemblyMeshPublication(fresh, current)) return false;
        const freshBundle = assemblyBundleOf(current);
        if (!currentAssemblyMeshAdmission({ bundle: freshBundle, ownership: fresh, state: current }, current)) return false;
        scene.setAssembly(freshBundle);
        requestDraw();
        return true;
      }).catch(() => false) // Fail closed; never reoffer the rejected owner.
        .finally(() => {
          refusedAssemblyRefresh.add(owner);
          if (pendingAssemblyRefresh.get(owner) === pending) pendingAssemblyRefresh.delete(owner);
        });
      pendingAssemblyRefresh.set(owner, pending);
      return false;
    }
    const listeners = drawListenersRef.current;
    let completedRenders = 0;
    let lastCompletedAtMs = 0;
    let totalSceneRenderMs = 0;
    let totalDrawListenerMs = 0;
    const readRenderStats = (): ViewportRenderStats => ({
      completedRenders,
      lastCompletedAtMs,
      totalSceneRenderMs,
      totalDrawListenerMs,
      cleanupStatus: alive ? 'active' : lifetime.pendingCount === 0 ? 'complete' : 'pending',
    });
    // StrictModeや将来の複数mountでは、最後に載った生きている口だけを公開する。
    lifetime.register('render observation', () => {
          if (window.pcadViewportRenderStats === readRenderStats) delete window.pcadViewportRenderStats;
        });
    window.pcadViewportRenderStats = readRenderStats;
    const readFramedBodies = (): readonly string[] => alive ? scene.fullyFramedBodyIds() : [];
    lifetime.register('frame observation', () => {
          if (window.pcadViewportFramedBodies === readFramedBodies) delete window.pcadViewportFramedBodies;
        });
    window.pcadViewportFramedBodies = readFramedBodies;
    const readMemoryStats = (): ViewportMeshReservation | null => alive ? scene.meshReservation() : null;
    lifetime.register('memory observation', () => {
          if (window.pcadViewportMemoryStats === readMemoryStats) delete window.pcadViewportMemoryStats;
        });
    window.pcadViewportMemoryStats = readMemoryStats;
    // 切断の予告は、scene へ渡した最後の値だけを検査専用の口から読めるようにする(製品の状態には含めない)。
    let lastCutPreview: CutPreview | null = null;
    const showCutPreview = (preview: CutPreview | null): void => {
      lastCutPreview = preview;
      scene.setCutPreview(preview);
    };
    const readCutPreview = (): CutPreview | null => alive ? lastCutPreview : null;
    lifetime.register('cut preview observation', attachCutPreviewReader(readCutPreview));
    // Diagnostic metadata only. Weak identity tags never retain documents or bodies.
    const ownerIdentities = new WeakMap<object, number>();
    let nextOwnerIdentity = 0;
    const identityOf = (value: object | null): number | null => {
      if (value === null) return null;
      const previous = ownerIdentities.get(value);
      if (previous !== undefined) return previous;
      const identity = ++nextOwnerIdentity;
      ownerIdentities.set(value, identity);
      return identity;
    };
    const readOwnerCheck = (read: () => boolean): { readonly value: boolean | null; readonly error: string | null } => {
      try { return { value: read(), error: null }; }
      catch (error) { return { value: null, error: String(error) }; }
    };
    // Same publication lifetime as the existing owner getter; no per-frame observation.
    const mateInputs: Readonly<AssemblyMateInputObservation>[] = [];
    const observeMateInput = (input: AssemblyMateInputObservation): void => {
      if (!alive) return;
      Object.freeze(input.clientPoint);
      if (input.canvasPoint !== undefined) Object.freeze(input.canvasPoint);
      if (input.scene !== undefined) Object.freeze(input.scene);
      if (input.hit !== undefined && input.hit !== null) Object.freeze(input.hit);
      mateInputs.push(Object.freeze(input));
      if (mateInputs.length > 2) mateInputs.shift();
    };
    const readAssemblyOwner = (): Readonly<Record<string, unknown>> | null => {
      if (!alive) return null;
      const state = useAppStore.getState(), view = state.assemblyView, owner = view?.meshOwnership;
      return { viewportOwnerId, mateInputs: [...mateInputs], activeDocumentId: state.activeDocumentId,
        documentVersion: state.documentVersion, requestedGeneration: state.requestedGeneration,
        completedGeneration: state.completedGeneration, cancelRequestCount: state.cancelRequestCount,
        recomputeCancelled: state.recomputeCancelled, lastOutcome: state.lastOutcome, timelineIndex: state.timelineIndex,
        assemblyIdentity: identityOf(state.assembly), drawingIdentity: identityOf(state.drawing),
        assemblyLibraryIdentity: identityOf(state.assemblyLibrary), assemblyViewIdentity: identityOf(view),
        sourceDocumentIdentity: identityOf(view?.sourceDocument ?? null),
        sourceBodiesIdentity: identityOf(view?.bodies ?? null), ownershipIdentity: identityOf(owner ?? null),
        ownership: owner === undefined ? null : {
          documentIdentity: identityOf(owner.document), libraryIdentity: identityOf(owner.library),
          activeDocumentId: owner.activeDocumentId, documentVersion: owner.documentVersion,
          generation: owner.generation, outcome: owner.outcome, timelineIndex: owner.timelineIndex,
          cancelRequestCount: owner.cancelRequestCount, bodiesIdentity: identityOf(owner.bodies),
          receiptStatus: owner.receipt.status, backingInspectionStatus: owner.backingInspection.status,
          publicationCurrent: readOwnerCheck(() => owner.publicationCurrent()), receiptCurrent: readOwnerCheck(() => owner.receiptCurrent()),
          backingInspectionCurrent: readOwnerCheck(() => owner.backingInspectionCurrent()),
        } };
    };
    lifetime.register('assembly ownership observation', () => {
      mateInputs.length = 0;
      if (window.pcadViewportAssemblyOwner === readAssemblyOwner) delete window.pcadViewportAssemblyOwner;
    });
    window.pcadViewportAssemblyOwner = readAssemblyOwner;
    const readMeshObservation = (): ViewportMeshObservationSnapshot => observation.snapshot();
    lifetime.register('mesh observation getter', () => {
          if (window.pcadViewportMeshObservation === readMeshObservation) delete window.pcadViewportMeshObservation;
        });
    window.pcadViewportMeshObservation = readMeshObservation;
    window.pcadViewportRetiredCleanups = readRetiredViewports;

    /**
     * 3D の色をテーマから読み直すべきか(FR-908)。ルート要素へ `data-theme` を書くのは
     * `applyDisplaySettings.ts` の見張りなので、**読むのは次の描画機会まで待つ**。
     * こうすると見張りが呼ばれる順に依らず、属性が効いた後の色を必ず読める。
     * 起動時も 1 回読む(保存されていたテーマで始まるため)。
     */
    let themeDirty = true;

    function draw(): void {
      frameId = 0;
      if (!alive) return;
      if (themeDirty) {
        themeDirty = false;
        scene.setThemeColors(readThemeColors());
      }
      if (!assemblyReady()) return;
      const { projection, displayStyle, showGrid, displaySettings, quadCamera } = useAppStore.getState();
      const renderStartedAt = globalThis.performance.now();
      if (quadCamera === null) scene.render(controls.getOrbit(), projection, displayStyle, showGrid, displaySettings.uiScale);
      else scene.renderQuad(quadCamera, projection, displayStyle, showGrid, displaySettings.uiScale);
      // `scene.render` が例外なく戻った実描画だけを、1回につきちょうど1つ数える。
      completedRenders += 1;
      lastCompletedAtMs = globalThis.performance.now();
      totalSceneRenderMs += lastCompletedAtMs - renderStartedAt;
      // 本体を描いた後にだけ知らせる。視点はこの時点で確定している。
      for (const listener of listeners) {
        listener();
      }
      totalDrawListenerMs += globalThis.performance.now() - lastCompletedAtMs;
    }

    /** 同じ描画機会に何度呼ばれても描画は1回にまとめる。 */
    function requestDraw(): void {
      if (alive && frameId === 0) {
        frameId = globalThis.requestAnimationFrame(draw);
      }
    }

    lifetime.register('animation frame', () => {
          if (frameId !== 0) globalThis.cancelAnimationFrame(frameId);
          frameId = 0;
        });
    const canvasImageCache = createCanvasImageCache({
      readSource: () => {
        const state = useAppStore.getState();
        return { documentId: state.activeDocumentId,
          canvases: activePartDocument(state)?.canvases ?? [], images: state.canvases, retries: state.canvasImageRetries };
      },
      publish: (images) => {
        if (!alive) return;
        const state = useAppStore.getState();
        const part = activePartDocument(state);
        scene.setCanvases(part === null ? [] : canvasDrawsOf(part, images, state.canvasRectification?.canvasId ?? null));
        requestDraw();
      },
      setLoad: (id, owner, load) => { useAppStore.getState().setCanvasImageLoad(id, owner, load); },
      reportInvalid: (message) => { if (alive) useAppStore.getState().setCanvasMessage(message); },
      onCleanupSettled: () => { if (!alive) disposeViewport(); },
    });
    lifetime.register('decoded canvas images', () => {
          canvasImageCache.dispose();
          if (canvasImageCache.cleanupPending()) throw new Error('Image resources remain pending cleanup');
        });

    /**
     * 2 点の寸法合わせ(§2.14)のあいだだけ、押した場所を作図面の点として拾う。
     *
     * **スケッチの操作より先に登録する**(下の `attachSketchInteraction` より前)。同じ
     * canvas の同じ段階では登録した順に呼ばれるので、先に登録して
     * `stopImmediatePropagation()` を呼べば、寸法合わせの最中に線を引き始めてしまうことがない。
     */
    const onCanvasScalePointerDown = (event: PointerEvent): void => {
      if (!alive) return;
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
      if (cameraDragAction(readCameraControlSettings(state.displaySettings.cameraControls), event) !== null) return;
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
    lifetime.register('canvas pointer input', () => { mountedCanvas.removeEventListener('pointerdown', onCanvasScalePointerDown); });
    canvas.addEventListener('pointerdown', onCanvasScalePointerDown);

    // 保存のときに呼ばれるサムネイルの作り手を差し出す(§0.a-0.18、FR-801)。
    // 3D 表示部は後から読み込まれるので、それまでは口が空でサムネイルなしになる。
    const captureThumbnail = (): Uint8Array | null => {
      if (!alive) { thumbnailReasons.record('consumer:not-alive'); return null; }
      if (!assemblyReady()) { thumbnailReasons.record('consumer:admission'); return null; }
      thumbnailReasons.record('consumer:admitted');
      return scene.captureThumbnail(undefined, thumbnailReasons.record);
    };
    lifetime.register('thumbnail producer', () => {
          if (useAppStore.getState().captureThumbnail === captureThumbnail) useAppStore.getState().setCaptureThumbnail(null);
        });
    useAppStore.getState().setCaptureThumbnail(captureThumbnail);
    // 印刷のときに呼ばれる 1 コマの作り手も同じように差し出す(FR-810、P6 タスク33)。
    // 用意できるまでは口が空で、印刷は「印刷する絵を作れませんでした。」で断られる。
    const capturePrintFrame = (): string | null => alive && assemblyReady() ? scene.capturePrintFrame() : null;
    lifetime.register('print producer', () => {
          if (useAppStore.getState().capturePrintFrame === capturePrintFrame) useAppStore.getState().setCapturePrintFrame(null);
        });
    useAppStore.getState().setCapturePrintFrame(capturePrintFrame);

    let assemblyInteraction: ReturnType<typeof attachAssemblyInteraction> | null = null;
    const detachQuadInput = attachQuadInput(canvas, () => useAppStore.getState().quadCamera !== null, (pane) => {
      if (!alive) return;
      useAppStore.getState().setQuadActivePane(pane);
      scene.setActivePane(pane);
    });
    lifetime.register('quad input', detachQuadInput);
    const controls = attachCameraControls(canvas, () => {
      if (!alive) return;
      assemblyInteraction?.cancelDrag();
      requestDraw();
    }, (active) => {
      if (!alive) return;
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
    }, () => readCameraControlSettings(useAppStore.getState().displaySettings.cameraControls));
    lifetime.register('camera ref', () => { if (controlsRef.current === controls) controlsRef.current = null; });
    lifetime.register('camera input', () => { controls.detach(); });
    controlsRef.current = controls;
    const viewCameraController: ViewCameraController = {
      capture: () => {
        if (!alive) return namedCameraFromOrbit(HOME_ORBIT, useAppStore.getState().projection);
        const { quadCamera, projection } = useAppStore.getState();
        return namedCameraFromOrbit(controls.getOrbit(), quadCamera === null || quadCamera.active === 'isometric' ? projection : 'orthographic');
      },
      restore: (camera) => {
        if (!alive) return false;
        const orbit = orbitFromNamedCamera(camera);
        if (orbit === null) return false;
        useAppStore.getState().setQuadViewEnabled(false);
        useAppStore.getState().setProjection(camera.projection);
        controls.setOrbit(orbit);
        return true;
      },
    };
    lifetime.register('camera producer', () => {
          if (useAppStore.getState().viewCameraController === viewCameraController) useAppStore.getState().setViewCameraController(null);
        });
    useAppStore.getState().setViewCameraController(viewCameraController);
    // 視点操作を先に結び、その後ろでスケッチの操作を結ぶ(中ボタン・Alt の取り合いを避ける)。
    // 視点そのものを渡す。距離は方眼の刻みに、向きは 3D スケッチで押した場所に置く面に使う
    // (FR-330、P4 タスク14)。
    // 合致の選択を先に受け、処理した左クリックは部品用の作図操作へ流さない。
    assemblyInteraction = attachAssemblyInteraction(canvas, scene, {
      viewDirection: () => viewDirection(controls.getOrbit()),
      prepareMateInput: () => {
        const owner = useAppStore.getState().assemblyView?.meshOwnership;
        if (assemblyReady()) return null;
        return (owner === undefined ? undefined : pendingAssemblyRefresh.get(owner)) ?? Promise.resolve(false);
      },
      observeMateInput,
    });
    lifetime.register('assembly input', () => { assemblyInteraction?.detach(); });
    const interaction = attachSketchInteraction(canvas, scene, () => controls.getOrbit(), () => controls.isDragging());
    lifetime.register('sketch input', () => { interaction.detach(); });
    lifetime.register('view controls', () => { setControlsReady(false); });
    setControlsReady(true);

    const observer = new ResizeObserver(() => {
      if (!alive) return;
      assemblyInteraction?.cancelDrag();
      scene.resize(canvas.clientWidth, canvas.clientHeight);
      requestDraw();
    });
    lifetime.register('resize observation', () => { observer.disconnect(); });
    observer.observe(canvas);

    function syncRepairPreview(state: AppState): void {
      void scene.setReferenceRepairPreview(currentReferenceRepairPreview(state)).then(() => {
        if (alive) requestDraw();
      }, () => {
        // A provider/cleanup rejection leaves the preview unavailable; no document or history is changed.
        if (alive) requestDraw();
      });
    }

    function syncInitialScene(): void {
      scene.resize(mountedCanvas.clientWidth, mountedCanvas.clientHeight);
      const initial = useAppStore.getState();
      // 引っぱっている最中(FR-313、P4b タスク14)は仮の形を描く。文書どおりの形
      // (`resolvedSketch`)は当たり判定・プロパティ・吸着がそのまま読み続ける。
      const initialSketchHidden = activePartDocument(initial) === null || isSheetFlatDisplayed(initial);
      scene.setSketch(initialSketchHidden ? EMPTY_PART_SKETCH : initial.dragResolved ?? initial.resolvedSketch,
        initialSketchHidden ? null : initial.sketchMesh);
      scene.setSketchHighlight(initial.hoveredElementId, initial.selection);
      scene.setBodies(solidBodiesForAdmission(initial));
      // 配置した部品(FR-605、P7 タスク10)。アセンブリを開いていないあいだは空のまま。
      if (assemblyReady()) scene.setAssembly(assemblyBundleOf(useAppStore.getState()));
      scene.setInterference(initial.assemblyInterferenceResult, initial.assemblyInterferenceSelectedKey);
      // 外観の割り当て(FR-1106〜1109)。文書の割り当てと、カーネルが選び直した面の対応から
      // 組み立てる(P5 タスク10)。割り当てが 1 つも無ければ既定の外観 1 色になる。
      scene.setAppearance(
        buildAppearanceInput(appearanceOf(initial.document), initial.appearanceMatches),
      );
      scene.setBodyHighlight(initial.hoveredElementId, initial.selection);
      scene.setSubShapeHighlight(initial.hoveredElementId, initial.selection);
      syncRepairPreview(initial);
      scene.setWorkPlane(initial.workPlane);
      // 3D スケッチ(作図面なし、FR-330)では作図面の矩形を出さない(P4 タスク33)。
      scene.setWorkPlaneVisible(!isFreeWorkPlaneId(initial.workPlaneId));
      // 構築線(FR-320)は履歴を見ないと分からないので、文書から引いて渡す(P4 タスク33)。
      scene.setConstructionIds(constructionFeatureIds(initial.sketch));
      // 完全に決まった要素(FR-313、利用者の決定②、P4b タスク22b)。判定は純関数 1 か所。
      scene.setConstrainedFeatureIds(constrainedFeatureIdsOfStore(initial));
      scene.setReferences(initial.resolvedReferences);
      scene.setEditPreview(initial.editPreview);
      scene.setTracking(initial.trackIndicator);
      // 拘束の印(FR-313、P4b タスク13)。一覧の行(`constraintSummaries`)を印へ開く。
      scene.setConstraintMarks(constraintMarksOf(initial.constraintSummaries));
      scene.setSelectedConstraint(initial.selectedConstraintId);
      // 推定した拘束の予告(FR-333、P6 タスク41)。線を引いている最中だけ出る。
      scene.setInferredConstraintMarks(initial.inferredConstraints?.marks ?? null);
      // 測定の結果(FR-1102、P5 タスク31)。線・弧・端の丸・値の札を出す。
      scene.setMeasurement(initial.measurement);
      // 切断面の予告(FR-432、P5 タスク27e)。切断の段が開いている間だけ出る。
      showCutPreview(cutPreviewOf(initial));
      // 球面の案内線(FR-431、P5 タスク21)。球を選んでいる間(または「いつも出す」)だけ出る。
      scene.setSphereGrid(sphereGridSpecOf(initial));
      // ビューの断面表示(FR-111、P6 タスク35)。入れているあいだだけ平面を配る。
      scene.setSectionView(sectionViewRenderOf(initial.sectionView));
      // 3D プリントの点検の色(FR-815、P6 タスク46)。点検を出しているあいだだけ塗る。
      scene.setPrintability(printabilityHighlightOf(initial));
      // 立体解析の場(完了した現在の結果だけ)。結果が無ければ何も描かない。
      { const layers = solidAnalysisLayersOf(initial); scene.setAnalysisField(layers.field); scene.setAnalysisMode(layers.mode); }
      // 下絵(FR-332、P6 タスク39)。復号が済んだものから順に貼られる。
      canvasImageCache.sync();
      requestDraw();
    }
    syncInitialScene();

    function syncStoreChange(next: AppState, previous: AppState): void {
      if (!alive) return;
      syncRepairPreview(next);
      // スケッチの形と、カーネルが返した面(FR-105、FR-310)。
      if (
        next.resolvedSketch !== previous.resolvedSketch ||
        next.sketchMesh !== previous.sketchMesh ||
        // 引っぱっている最中の仮の形(FR-313、タスク14)。1 コマに 1 回だけ差し替わる。
        next.dragResolved !== previous.dragResolved || next.assembly !== previous.assembly ||
        isSheetFlatDisplayed(next) !== isSheetFlatDisplayed(previous)
      ) {
        const sketchHidden = activePartDocument(next) === null || isSheetFlatDisplayed(next);
        scene.setSketch(sketchHidden ? EMPTY_PART_SKETCH : next.dragResolved ?? next.resolvedSketch, sketchHidden ? null : next.sketchMesh);
      }
      // 立体(FR-105)。カーネルが返した三角形と稜線をボディごとに描く。
      if (solidMeshOwnershipChanged(next, previous)) {
        scene.setBodies(solidBodiesForAdmission(next));
      }
      // 外観(FR-1106〜1109)。**割り当ての表そのものが変わったときだけ**組み立て直す。
      // 文書が変わるたびに作り直すと、スケッチを 1 本引いただけで材質の入れ替えが起きる
      // (`appearanceOf` は割り当てが変わらなければ同じ表を返す。P5 §2.3)。
      if (
        appearanceOf(next.document) !== appearanceOf(previous.document) ||
        next.appearanceMatches !== previous.appearanceMatches
      ) {
        scene.setAppearance(buildAppearanceInput(appearanceOf(next.document), next.appearanceMatches));
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
      /*
        配置した部品(FR-605、タスク10)。**アセンブリ文書か強調が変わったときだけ**
        仕分け直す(NFR-PF-1。同じ一式を渡し直すと層は並びを触らないが、ここで毎回
        作り直すと参照が変わってその約束が効かなくなる)。
      */
      if (
        next.assembly !== previous.assembly ||
        next.assemblyView !== previous.assemblyView ||
        next.requestedGeneration !== previous.requestedGeneration ||
        next.completedGeneration !== previous.completedGeneration ||
        next.recomputeCancelled !== previous.recomputeCancelled ||
        next.assemblyDragOverlay !== previous.assemblyDragOverlay ||
        next.assemblyMotionPlacements !== previous.assemblyMotionPlacements ||
        next.assemblyOccurrenceDrives !== previous.assemblyOccurrenceDrives ||
        next.assemblyMotionSourceDocument !== previous.assemblyMotionSourceDocument ||
        next.assemblyMateDraft !== previous.assemblyMateDraft ||
        next.hoveredElementId !== previous.hoveredElementId ||
        next.selection !== previous.selection
      ) {
        if (assemblyReady()) scene.setAssembly(assemblyBundleOf(useAppStore.getState()));
      }
      if (next.assemblyInterferenceResult !== previous.assemblyInterferenceResult
        || next.assemblyInterferenceSelectedKey !== previous.assemblyInterferenceSelectedKey) {
        scene.setInterference(next.assemblyInterferenceResult, next.assemblyInterferenceSelectedKey);
      }
      /*
        切断面の予告(FR-432、タスク27e)。**材料が変わったときだけ**組み立て直す
        (NFR-PF-1。同じ内容を渡し直すと層は並びを触らないが、ここで毎回作り直すと
        参照が変わってしまい、その約束が効かなくなる)。式は確定と同じく変数表と表示の単位で
        読むので、パラメータの解析・表示の単位が変わったときも組み立て直す(EX-04 W2)。
      */
      if (
        next.numericInput !== previous.numericInput ||
        next.selection !== previous.selection ||
        next.bodies !== previous.bodies ||
        next.document !== previous.document ||
        next.parameterAnalysis !== previous.parameterAnalysis ||
        next.displaySettings.lengthUnit !== previous.displaySettings.lengthUnit
      ) {
        showCutPreview(cutPreviewOf(next));
      }
      /*
        球面の案内線(FR-431、タスク21)。**材料が変わったときだけ**組み立て直す。
        文書・選択・設定に加え、図形由来の係数の現在値が使えるかも通知する。
        世代・履歴位置・計算状態だけの変更でも古い線を消し、現在値へ戻ったら描き直す。
        中身が同じなら `setSphereGrid` が線分の組み立てそのものを省く(NFR-PF-1)。
      */
      if (sphereGridNeedsUpdate(next, previous)) {
        scene.setSphereGrid(sphereGridSpecOf(next));
      }
      /*
        ビューの断面表示(FR-111、タスク35)。**札が変わったときだけ**平面を作り直す。
        つまみの四角の広さはボディから測るが、その測り直しは層の側(`syncDraws`)が
        形の差し替えと同じ機会に行うので、ここではボディの変化を見る必要が無い。
      */
      if (next.sectionView !== previous.sectionView) {
        scene.setSectionView(sectionViewRenderOf(next.sectionView));
      }
      // 立体解析の場。失敗・取消・古い結果・文書の差し替えでは結果が消えるので、場も消える。
      if (next.solidAnalysisSession !== previous.solidAnalysisSession || next.solidModal !== previous.solidModal
        || next.solidBuckling !== previous.solidBuckling
        || next.document !== previous.document || next.completedGeneration !== previous.completedGeneration) {
        const layers = solidAnalysisLayersOf(next);
        scene.setAnalysisField(layers.field); scene.setAnalysisMode(layers.mode);
        requestDraw();
      }
      /*
        3D プリントの点検の色(FR-815、タスク46)。**結果が入れ替わったときだけ**渡し直す。
        塗る相手(`printabilityOffsets`)は結果と必ず一緒に入れ替わる(ストアの決め)ので、
        結果の入れ替わりだけを見ればよい。**再計算は 1 回も走らない**(§0.53)。
      */
      if (next.printability !== previous.printability || next.bodies !== previous.bodies) {
        const highlight = printabilityHighlightOf(next);
        scene.setPrintability(highlight);
        if (
          highlight === null &&
          next.printability !== null &&
          next.printabilityOffsets !== null
        ) {
          next.invalidatePrintability();
        }
      }
      /*
        下絵(FR-332、タスク39)。**文書か画像の表が変わったときだけ**貼り直す。
        入切・移動・不透明度は文書の変化として届くが、**再計算は 1 回も走らない**
        (`affectsShape` が下絵を見ないので `isComputing` も立たない。§2.14)。
      */
      if (next.document !== previous.document || next.canvases !== previous.canvases
        || next.canvasRectification !== previous.canvasRectification
        || next.canvasImageRetries !== previous.canvasImageRetries
        || next.assembly !== previous.assembly || next.drawing !== previous.drawing
        || next.activeDocumentId !== previous.activeDocumentId) {
        canvasImageCache.sync();
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
      /*
        完全に決まった要素の色分け(FR-313、利用者の決定②、P4b タスク22b)。
        判定の材料は履歴・解決結果・拘束の診断・作図面の 4 つなので、そのどれかが
        変わったときだけ数え直す(解決はし直さない、NFR-PF-1)。
      */
      if (
        next.sketch !== previous.sketch ||
        next.resolvedSketch !== previous.resolvedSketch ||
        next.constraintDiagnosis !== previous.constraintDiagnosis ||
        next.workPlaneId !== previous.workPlaneId ||
        next.workPlane !== previous.workPlane
      ) {
        scene.setConstrainedFeatureIds(constrainedFeatureIdsOfStore(next));
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
      // 拘束の印(FR-313、タスク13)。一覧・当たり判定と同じ 1 つ(`constraintSummaries`)を
      // 見るので、ここでは控えが差し替わったときだけ開き直せばよい。
      if (next.constraintSummaries !== previous.constraintSummaries) {
        scene.setConstraintMarks(constraintMarksOf(next.constraintSummaries));
      }
      if (next.selectedConstraintId !== previous.selectedConstraintId) {
        scene.setSelectedConstraint(next.selectedConstraintId);
      }
      /*
        推定した拘束の予告(FR-333、タスク41)。控えが差し替わったときだけ出し直す。
        `attachSketchInteraction.ts` は中身が変わらないコマでは書き直さない
        (`sameInferredPreview`)ので、ここが毎コマ動くことはない(NFR-PF-1)。
      */
      if (next.inferredConstraints !== previous.inferredConstraints) {
        scene.setInferredConstraintMarks(next.inferredConstraints?.marks ?? null);
      }
      // 測定の結果(FR-1102、タスク31)。控えが差し替わったときだけ出し直す。測るのも
      // 消すのもストア側の仕事なので、ここは変化を見て渡すだけ(NFR-PF-1)。
      if (next.measurement !== previous.measurement) {
        scene.setMeasurement(next.measurement);
      }
      // 表示テーマが変わったら 3D の色も読み直す(FR-908。拡大率は 3D の色を変えない)。
      if (next.displaySettings.theme !== previous.displaySettings.theme) {
        themeDirty = true;
      }
      // ホーム視点への復帰要求(FR-108)。数が増えたときだけ戻す。
      if (next.projection !== previous.projection) {
        assemblyInteraction?.cancelDrag();
      }
      if (next.homeViewRequestCount !== previous.homeViewRequestCount) {
        controls.goHome();
      }
      // 「視点に合わせる」の要求(§0.a-0.3)。視点の正本はここにしか無いので、
      // 今の視点をストアへ渡し返して作図面を決めてもらう。
      if (next.matchWorkPlaneRequestCount !== previous.matchWorkPlaneRequestCount) {
        useAppStore.getState().matchWorkPlaneToView(controls.getOrbit());
      }
      requestDraw();
    }
    const unsubscribe = useAppStore.subscribe(syncStoreChange);
    lifetime.register('store subscription', unsubscribe);

    disposeMounted = disposeViewport;
    }
    setCleanupWaiting(retiredViewports.pendingCount !== 0 || retiredViewports.ownerCount >= 16);
    window.pcadViewportRetiredCleanups = readRetiredViewports;
    const cancelWaiting = retiredViewports.whenAvailable(viewportOwnerId, () => {
      try { initializeViewport(); }
      catch (error) {
        if (error instanceof ViewportSceneInitializationFailure) {
          lifetime.register('scene initialization rollback', () => {
            error.cleanup.dispose();
            if (error.cleanup.pendingCount !== 0) throw new Error('Scene initialization cleanup remains pending');
          });
        }
        disposeMounted = disposeViewport;
        disposeViewport();
        if (!mountEnded) setMountFailure(error instanceof Error ? error : new Error('Viewport initialization failed'));
      }
    });
    return () => { mountEnded = true; cancelWaiting(); disposeMounted?.(); };
  }, []);

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
            onClick={() => { retiredViewports.retryNow(); }}>{t('viewport.retry')}</button>
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
