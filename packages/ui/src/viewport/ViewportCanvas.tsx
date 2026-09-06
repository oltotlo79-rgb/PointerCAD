import { useCallback, useEffect, useRef, useState } from 'react';

import { evaluateExpression } from '@pointercad/expression';
import {
  addVec3,
  appearanceOf,
  checkCanvasImage,
  formatDisplayLength,
  isFreeWorkPlaneId,
  parseDisplayInput,
  resolveAssembly,
  scaleVec3,
  toDisplayLength,
  worldToPlane,
  type LengthUnit,
  type SolidBody,
} from '@pointercad/model';

import { buildAppearanceInput } from '../appearance/appearanceCommands.js';
import { t } from '../i18n/t.js';
import {
  cutPlaneSpecFor,
  cutPreviewDiagonal,
  cutTargetOf,
  DEFAULT_CUT_TILT,
  resolveCutPlane,
  type CutContext,
} from '../solid/cutCommands.js';
import { LENGTH_UNIT_LABEL_KEYS } from '../settings/settings.js';
import { subShapeBodiesOf } from '../solid/subShapeSelection.js';
import { constrainedFeatureIdsOfStore } from '../sketch/constraintActions.js';
import { constraintMarksOf } from '../sketch/constraintPicking.js';
import { decodeCanvasImage, type DecodedCanvasImage } from '../file/canvasFile.js';
import { constructionFeatureIds } from '../sketch/featureSummary.js';
import { resolveWorkPlaneOf } from '../sketch/referenceCommands.js';
import { canvasPlacementOf, type CanvasDraw } from './canvasLayer.js';
import {
  buildAssemblyGeometry,
  EMPTY_ASSEMBLY_GEOMETRY,
  type AssemblyGeometryBundle,
} from './createAssemblyLayer.js';
import { sphereGridSphereOf, sphereGridTargetSphere } from '../sketch/sketchCommands.js';
import { activeAssemblyDocument } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { ViewCube } from '../viewcube/ViewCube.js';
import { attachCameraControls, type CameraControls } from './attachCameraControls.js';
import { attachSketchInteraction } from './attachSketchInteraction.js';
import { HOME_ORBIT, type OrbitState } from './cameraMath.js';
import { createViewportScene, type SectionViewRender } from './createViewportScene.js';
import type { CutPreview, PrintabilityHighlight } from './createSolidLayer.js';
import type { SphereGridSpec } from './buildSphereGrid.js';
import { toThreePlane } from './sectionView.js';
import { readThemeColors } from './themeColors.js';

/** 切断の予告を組み立てる材料。ストアから読むものだけを並べる。 */
interface CutPreviewSource {
  readonly numericInput: ReturnType<typeof useAppStore.getState>['numericInput'];
  readonly document: ReturnType<typeof useAppStore.getState>['document'];
  readonly bodies: ReturnType<typeof useAppStore.getState>['bodies'];
  readonly selection: readonly string[];
}

/**
 * 切断面の予告(FR-432、P5 タスク27e、§0.a-0.61)をストアの状態から組み立てる。
 *
 * **出す条件**は「切断の道具の段が開いていて、切る立体が決まっていること」。段を閉じれば
 * (確定でも取消でも)`numericInput` が null になるので、そのまま消える。
 * 平面が解けない(スケッチの点を材料にした等)ときと、対象の大きさが測れないときも null。
 */
function cutPreviewOf(source: CutPreviewSource): CutPreview | null {
  const input = source.numericInput;
  if (input === null || input.toolId !== 'cut') {
    return null;
  }
  const context: CutContext = {
    document: source.document,
    bodies: subShapeBodiesOf(source.bodies),
    selection: source.selection,
  };
  const target = cutTargetOf(context);
  if (target === null) {
    return null;
  }
  const planeKind = input.choices.find((choice) => choice.key === 'cutPlaneKind')?.value;
  const tiltField = input.fields.find((field) => field.key === 'cutTilt');
  const tilt =
    tiltField === undefined
      ? DEFAULT_CUT_TILT
      : { source: tiltField.source, value: Number(tiltField.source), display: tiltField.source };
  const spec = cutPlaneSpecFor(
    context,
    planeKind,
    Number.isFinite(tilt.value) ? tilt : DEFAULT_CUT_TILT,
  );
  if (spec === null) {
    return null;
  }
  const plane = resolveCutPlane(spec);
  const diagonal = cutPreviewDiagonal(context, target);
  if (plane === null || diagonal <= 0) {
    return null;
  }
  // 残す側は「反対側を残す」のつまみで決まる(§0.a-0.57)。
  const keepOpposite =
    input.toggles.find((toggle) => toggle.key === 'cutKeepOpposite')?.value === true;
  return { plane, diagonal, keep: keepOpposite ? 'negative' : 'positive' };
}

/**
 * ビューの断面表示(FR-111、P6 タスク35、§2.12)を、ストアの札から描く材料へ開く。
 *
 * **カーネルへは行かない。** 切断の予告(`resolveCutPlane`)と同じく指紋だけで平面を解き、
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
      <span className="pcad-popover__title">{t('sectionView.title')}</span>
      <label className="pcad-field">
        <span className="pcad-field__label">{t('sectionView.offset')}</span>
        <input
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
): readonly CanvasDraw[] {
  return document.canvases.flatMap((canvas) => {
    const image = decoded.get(canvas.imageId);
    if (!canvas.visible || image === undefined) {
      return [];
    }
    return [
      {
        id: canvas.id,
        image,
        // 任意の作業平面(FR-328)にも貼れる。解けない id は既定の XY へ落ちる。
        plane: resolveWorkPlaneOf(document, canvas.plane),
        placement: canvasPlacementOf(canvas),
        opacity: canvas.opacity.value,
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
  const canvasMessage = useAppStore((state) => state.canvasMessage);
  const document = useAppStore((state) => state.document);
  const lengthUnit = useAppStore((state) => state.displaySettings.lengthUnit);
  const applyCanvasScale = useAppStore((state) => state.applyCanvasScale);
  const cancelCanvasScale = useAppStore((state) => state.cancelCanvasScale);
  const setCanvasMessage = useAppStore((state) => state.setCanvasMessage);
  /** 打ちかけの文字(rules/04: `useState` は表示専用の一時状態だけ)。 */
  const [draft, setDraft] = useState('');

  if (canvasScale === null && canvasMessage === null) {
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
      <span className="pcad-popover__title">
        {canvasScale === null ? t('toolbar.canvas.label') : t('canvas.title')}
      </span>
      {ready ? (
        <label className="pcad-field">
          <span className="pcad-field__label">{t('canvas.realLength')}</span>
          <input
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
 * 部品の鍵 → その部品を 1 回だけ再計算した形。**まだストアに置き場が無い。**
 *
 * 部品ごとの再計算(鍵ごとに 1 回の `recomputePart`)はカーネル(Worker)への往復なので、
 * 見張りの置き場はストア側(`store/attachKernel.ts` の `attachPartRecompute` と同じ形)で、
 * それを足すのは**アセンブリへ部品を置く操作を作るタスク11**である(このタスクが触るのは
 * 計画書のタスク10 の欄にある viewport の 3 ファイルだけ)。ここではその表を**空**のまま
 * 渡し、形が入った時点で絵が出るようにしてある。
 *
 * **抱き込んだ部品の一式(`PartLibrary`)も同じ事情**で、まだストアに欄が無い。下の
 * `resolveAssembly` はそれを渡さずに呼ぶので、配置は正しく解けるが「どの部品か」
 * (`partKeys`)は空になり、結局まだ 1 つも描かれない。**2 つはタスク11 で一緒に入る。**
 */
const NO_ASSEMBLY_BODIES: ReadonlyMap<string, readonly SolidBody[]> = new Map<
  string,
  readonly SolidBody[]
>();

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
  const resolved = resolveAssembly(assembly);
  return buildAssemblyGeometry({
    components: assembly.components,
    placements: resolved.placements,
    partKeys: resolved.partKeys,
    bodies: NO_ASSEMBLY_BODIES,
    hoveredComponentId: state.hoveredElementId,
    selectedComponentIds: state.selection,
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

    /*
      下絵の画像(FR-332、P6 タスク39)。**復号した画像を覚えているのはここ**で、
      three.js のテクスチャは層(`canvasLayer.ts`)が作って捨てる(持ち主を分ける)。
      文書ではなく**画面**の寿命で持つが、文書から消えた画像はその場で閉じ、画面を
      閉じるときに残りを全部閉じるので、rules/06 10.17 のような溜め込みは起きない。
    */
    const decodedCanvases = new Map<string, DecodedCanvasImage>();
    /** いま復号を頼んでいる画像。同じ画像を二重に復号しない。 */
    const decodingCanvases = new Set<string>();
    /** 画面を閉じた後に復号が返ってきたら、画像を閉じて捨てるための札。 */
    let detached = false;

    /** いまの文書と復号済みの画像から、下絵を描き直す。 */
    function pushCanvases(): void {
      scene.setCanvases(canvasDrawsOf(useAppStore.getState().document, decodedCanvases));
      requestDraw();
    }

    /**
     * 下絵の画像を必要なだけ復号し、描き直す。**再計算は起こさない**(§2.14)。
     * 復号は非同期なので、済んだものから順に画面へ出る(読み込み中でも操作は止まらない)。
     */
    function syncCanvases(): void {
      const state = useAppStore.getState();
      const alive = new Set(state.document.canvases.map((canvas) => canvas.imageId));
      for (const [imageId, image] of decodedCanvases) {
        if (!alive.has(imageId)) {
          // 消した下絵の画像は記憶を返す(`ImageBitmap` は閉じないと残る)。
          image.close?.();
          decodedCanvases.delete(imageId);
        }
      }
      for (const canvas of state.document.canvases) {
        const bytes = state.canvases.get(canvas.imageId);
        if (
          bytes === undefined ||
          decodedCanvases.has(canvas.imageId) ||
          decodingCanvases.has(canvas.imageId)
        ) {
          continue;
        }
        // 受け付けの判定(PNG / JPEG・8MB)と断りの文言は model が持つ(§2.8)。
        const checked = checkCanvasImage(bytes);
        if (!checked.ok) {
          useAppStore.getState().setCanvasMessage(checked.message);
          continue;
        }
        const imageId = canvas.imageId;
        decodingCanvases.add(imageId);
        decodeCanvasImage(bytes, checked.format).then(
          (image) => {
            decodingCanvases.delete(imageId);
            if (detached) {
              image.close?.();
              return;
            }
            decodedCanvases.set(imageId, image);
            // 画素の大きさは 2 点の寸法合わせ(§2.14)が使うのでストアへ控える。
            useAppStore.getState().setCanvasPixelSize(imageId, {
              width: image.width,
              height: image.height,
            });
            pushCanvases();
          },
          () => {
            // 壊れた画像。**止めずに**その 1 枚だけ出さない(FR-504、NFR-RE-1)。
            decodingCanvases.delete(imageId);
          },
        );
      }
      pushCanvases();
    }

    /**
     * 2 点の寸法合わせ(§2.14)のあいだだけ、押した場所を作図面の点として拾う。
     *
     * **スケッチの操作より先に登録する**(下の `attachSketchInteraction` より前)。同じ
     * canvas の同じ段階では登録した順に呼ばれるので、先に登録して
     * `stopImmediatePropagation()` を呼べば、寸法合わせの最中に線を引き始めてしまうことがない。
     */
    const onCanvasScalePointerDown = (event: PointerEvent): void => {
      const state = useAppStore.getState();
      const scaling = state.canvasScale;
      if (scaling === null) {
        return;
      }
      const target = state.document.canvases.find((item) => item.id === scaling.canvasId);
      if (target === undefined) {
        return;
      }
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
      state.addCanvasScalePoint(worldToPlane(plane, world));
    };
    canvas.addEventListener('pointerdown', onCanvasScalePointerDown);

    // 保存のときに呼ばれるサムネイルの作り手を差し出す(§0.a-0.18、FR-801)。
    // 3D 表示部は後から読み込まれるので、それまでは口が空でサムネイルなしになる。
    useAppStore.getState().setCaptureThumbnail(() => scene.captureThumbnail());
    // 印刷のときに呼ばれる 1 コマの作り手も同じように差し出す(FR-810、P6 タスク33)。
    // 用意できるまでは口が空で、印刷は「印刷する絵を作れませんでした。」で断られる。
    useAppStore.getState().setCapturePrintFrame(() => scene.capturePrintFrame());

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
    // 引っぱっている最中(FR-313、P4b タスク14)は仮の形を描く。文書どおりの形
    // (`resolvedSketch`)は当たり判定・プロパティ・吸着がそのまま読み続ける。
    scene.setSketch(initial.dragResolved ?? initial.resolvedSketch, initial.sketchMesh);
    scene.setSketchHighlight(initial.hoveredElementId, initial.selection);
    scene.setBodies(initial.bodies);
    // 配置した部品(FR-605、P7 タスク10)。アセンブリを開いていないあいだは空のまま。
    scene.setAssembly(assemblyBundleOf(initial));
    // 外観の割り当て(FR-1106〜1109)。文書の割り当てと、カーネルが選び直した面の対応から
    // 組み立てる(P5 タスク10)。割り当てが 1 つも無ければ既定の外観 1 色になる。
    scene.setAppearance(
      buildAppearanceInput(appearanceOf(initial.document), initial.appearanceMatches),
    );
    scene.setBodyHighlight(initial.hoveredElementId, initial.selection);
    scene.setSubShapeHighlight(initial.hoveredElementId, initial.selection);
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
    scene.setCutPreview(cutPreviewOf(initial));
    // 球面の案内線(FR-431、P5 タスク21)。球を選んでいる間(または「いつも出す」)だけ出る。
    scene.setSphereGrid(sphereGridSpecOf(initial));
    // ビューの断面表示(FR-111、P6 タスク35)。入れているあいだだけ平面を配る。
    scene.setSectionView(sectionViewRenderOf(initial.sectionView));
    // 3D プリントの点検の色(FR-815、P6 タスク46)。点検を出しているあいだだけ塗る。
    scene.setPrintability(printabilityHighlightOf(initial));
    // 下絵(FR-332、P6 タスク39)。復号が済んだものから順に貼られる。
    syncCanvases();
    requestDraw();

    const unsubscribe = useAppStore.subscribe((next, previous) => {
      // スケッチの形と、カーネルが返した面(FR-105、FR-310)。
      if (
        next.resolvedSketch !== previous.resolvedSketch ||
        next.sketchMesh !== previous.sketchMesh ||
        // 引っぱっている最中の仮の形(FR-313、タスク14)。1 コマに 1 回だけ差し替わる。
        next.dragResolved !== previous.dragResolved
      ) {
        scene.setSketch(next.dragResolved ?? next.resolvedSketch, next.sketchMesh);
      }
      // 立体(FR-105)。カーネルが返した三角形と稜線をボディごとに描く。
      if (next.bodies !== previous.bodies) {
        scene.setBodies(next.bodies);
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
        next.hoveredElementId !== previous.hoveredElementId ||
        next.selection !== previous.selection
      ) {
        scene.setAssembly(assemblyBundleOf(next));
      }
      /*
        切断面の予告(FR-432、タスク27e)。**材料が変わったときだけ**組み立て直す
        (NFR-PF-1。同じ内容を渡し直すと層は並びを触らないが、ここで毎回作り直すと
        参照が変わってしまい、その約束が効かなくなる)。
      */
      if (
        next.numericInput !== previous.numericInput ||
        next.selection !== previous.selection ||
        next.bodies !== previous.bodies ||
        next.document !== previous.document
      ) {
        scene.setCutPreview(cutPreviewOf(next));
      }
      /*
        球面の案内線(FR-431、タスク21)。**材料が変わったときだけ**組み立て直す。
        中心と半径は文書と解決結果から、出すか出さないかは選択と設定から決まるので、
        その 5 つのどれかが変わったときに作り直せばよい。中身が同じなら `setSphereGrid` が
        線分の組み立てそのものを省く(NFR-PF-1)。
      */
      if (
        next.document !== previous.document ||
        next.resolvedSketch !== previous.resolvedSketch ||
        next.selection !== previous.selection ||
        next.sphereGridStep !== previous.sphereGridStep ||
        next.sphereGridAlwaysVisible !== previous.sphereGridAlwaysVisible
      ) {
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
      /*
        3D プリントの点検の色(FR-815、タスク46)。**結果が入れ替わったときだけ**渡し直す。
        塗る相手(`printabilityOffsets`)は結果と必ず一緒に入れ替わる(ストアの決め)ので、
        結果の入れ替わりだけを見ればよい。**再計算は 1 回も走らない**(§0.53)。
      */
      if (next.printability !== previous.printability) {
        scene.setPrintability(printabilityHighlightOf(next));
      }
      /*
        下絵(FR-332、タスク39)。**文書か画像の表が変わったときだけ**貼り直す。
        入切・移動・不透明度は文書の変化として届くが、**再計算は 1 回も走らない**
        (`affectsShape` が下絵を見ないので `isComputing` も立たない。§2.14)。
      */
      if (next.document !== previous.document || next.canvases !== previous.canvases) {
        syncCanvases();
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
      canvas.removeEventListener('pointerdown', onCanvasScalePointerDown);
      // 下絵の画像の記憶を返す(テクスチャは `scene.dispose()` が捨てる。P5 §4)。
      detached = true;
      for (const image of decodedCanvases.values()) {
        image.close?.();
      }
      decodedCanvases.clear();
      // 片付けた場面をもう使えないので、サムネイルと印刷の作り手も取り下げる。
      useAppStore.getState().setCaptureThumbnail(null);
      useAppStore.getState().setCapturePrintFrame(null);
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
      {/*
        断面表示のその場の数値入力(FR-111、NFR-UX-2)。**区画は増やさない**——
        ビューポートの中に浮かべ、断面表示を入れているあいだだけ出す。
      */}
      <SectionOffsetField />
      {/*
        下絵の 2 点の寸法合わせ(FR-332、NFR-UX-2)。合わせている間だけ出る。
        断面表示の欄と同じく**区画は増やさない**。
      */}
      <CanvasScaleField />
      {controlsReady ? (
        <ViewCube getOrbit={getOrbit} setOrbit={setOrbit} subscribeDraw={subscribeDraw} />
      ) : null}
    </>
  );
}
