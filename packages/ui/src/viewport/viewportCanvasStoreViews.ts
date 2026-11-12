import { addVec3, scaleVec3, solveCanvasHomography } from '@pointercad/model';
import type { DecodedCanvasImage } from '../file/canvasFile.js';
import { componentDragPlacements } from '../assembly/dragComponentActions.js';
import { assemblyTargetId } from '../assembly/mateCommands.js';
import { currentMathGeometry } from '../math/mathGeometryResults.js';
import { resolveCutPlane } from '../solid/cutCommands.js';
import { cutPlanePreviewOf } from '../solid/cutPlanePreview.js';
import { printabilityMatchesDisplayMeshes } from '../solid/printabilityColors.js';
import { subShapeBodiesOf } from '../solid/subShapeSelection.js';
import { resolveWorkPlaneOf } from '../sketch/referenceCommands.js';
import { sphereGridSphereOf, sphereGridTargetSphere } from '../sketch/sketchCommands.js';
import type { AppState } from '../store/appState.js';
import { shownOccurrencePlacements } from '../store/assemblyOccurrenceDriveSlice.js';
import { activeAssemblyDocument } from '../store/documentKind.js';
import type { useAppStore } from '../store/useAppStore.js';
import type { SphereGridSpec } from './buildSphereGrid.js';
import { canvasPlacementOf, type CanvasDraw } from './canvasLayer.js';
import {
  buildAssemblyGeometry,
  EMPTY_ASSEMBLY_GEOMETRY,
  flattenAssemblyGeometry,
  type AssemblyGeometryBundle,
} from './createAssemblyLayer.js';
import type { CutPreview, PrintabilityHighlight } from './createSolidLayer.js';
import type { SectionViewRender } from './createViewportScene.js';
import { toThreePlane } from './sectionView.js';

/*
 * ViewportCanvas が scene へ渡す表示の材料を、ストアの状態から組み立てる純関数(切断の予告・断面表示・
 * 3D プリントの点検の色・球面の案内線・配置した部品・下絵)。形は 1 つも変えず、カーネルへも行かない。
 * 起動時の受け渡しとストアの変化の受け渡し(viewportCanvasStoreSync.ts)が同じ関数を使う。
 */

/** 切断の予告を組み立てる材料。ストアから読むものだけを並べる。 */
interface CutPreviewSource {
  readonly numericInput: ReturnType<typeof useAppStore.getState>['numericInput'];
  readonly document: ReturnType<typeof useAppStore.getState>['document'];
  readonly bodies: ReturnType<typeof useAppStore.getState>['bodies'];
  readonly selection: readonly string[];
  readonly parameterAnalysis: ReturnType<typeof useAppStore.getState>['parameterAnalysis'];
  readonly displaySettings: ReturnType<typeof useAppStore.getState>['displaySettings'];
}

/**
 * 切断面の予告(FR-432)をストアの状態から組み立てる。
 *
 * **出す条件**は「切断の道具の段が開いていて、切る立体が決まっていて、いま決定すれば切れること」。
 * 段を閉じれば(確定でも取消でも)`numericInput` が null になるので、そのまま消える。
 * 面は確定と同じ式の評価・材料の解決で解く(`cutPlanePreviewOf`)。式の評価の文脈は
 * 決定(`NumericInputPopover` の Enter)と同じ、パラメータの解析と表示の単位。
 */
export function cutPreviewOf(source: CutPreviewSource): CutPreview | null {
  return cutPlanePreviewOf({
    numericInput: source.numericInput,
    document: source.document,
    bodies: subShapeBodiesOf(source.bodies),
    selection: source.selection,
    evaluation: { ...source.parameterAnalysis, lengthUnit: source.displaySettings.lengthUnit },
  });
}

/**
 * ビューの断面表示(FR-111)を、ストアの札から描く材料へ開く。
 *
 * **カーネルへは行かない。** `resolveCutPlane`(指紋と基準の面だけで解く)で平面を解き、
 * `toThreePlane`で three.js に渡す素の数へ写す。**形は 1 つも変えない。**
 *
 * つまみの四角は**オフセットを載せた後の位置**へ置く(平面そのものを動かして見せる)。
 * 平面が解けない・オフセットが数でないときは `null` を返し、断りの文は
 * `sectionRefusalOf` が同じ道筋でもう一度求める(断りを 2 通りに分けない)。
 */
export function sectionViewRenderOf(
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
 * 3D プリントの点検の色(FR-815)。点検していなければ `null`。
 *
 * **結果と塗る相手はストアで必ず一緒に入れ替わる**ので、ここでは片方が欠けている状態を
 * 「点検していない」として扱う(欠けたまま塗ると、色の行き先が決まらない)。
 */
export function printabilityHighlightOf(
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
 * 下絵(FR-332)の描く材料を、文書と復号した画像から組み立てる。
 *
 * **出さないもの**を 3 つここで外す: ①入切で切ってあるもの(`visible` が偽)、
 * ②画像をまだ復号できていないもの(読み込んだ直後の一瞬と、壊れた画像)、
 * ③文書にバイト列が無いもの。層(`canvasLayer.ts`)は渡された分だけを描く。
 */
export function canvasDrawsOf(
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

/** 球面の案内線を組み立てる材料。ストアから読むものだけを並べる。 */
interface SphereGridSource {
  readonly document: ReturnType<typeof useAppStore.getState>['document'];
  readonly resolvedSketch: ReturnType<typeof useAppStore.getState>['resolvedSketch'];
  readonly selection: readonly string[];
  readonly sphereGridStep: ReturnType<typeof useAppStore.getState>['sphereGridStep'];
  readonly sphereGridAlwaysVisible: boolean;
}

/** The subscription and its unit tests share this decision. */
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
 * 球面の案内線(球面グリッド、FR-431)をストアの状態から組み立てる。
 *
 * **出す条件**は「球を選んでいること、または『いつも出す』が入で球が 1 つでもあること」。
 * 球が 1 つも無い文書では null になり、線分を 1 本も組み立てない(費用ゼロ)。
 * 中心を求められない置き方(立体の頂点に置いた球)でも null になる
 * (`sphereGridSphereOf` の注釈。緯度・経度を打って点を作る道はそのまま使える)。
 */
export function sphereGridSpecOf(source: SphereGridSource): SphereGridSpec | null {
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
 * 配置した部品(FR-605、FR-606)をストアの状態から組み立てる。
 *
 * **アセンブリを開いていないあいだは空**(部品の画面では入れ物も形も 1 つも作らない)。
 * 開いているあいだは `resolveAssembly`(model の純関数)が返す**インスタンスごとの配置**と
 * **部品の鍵**をそのまま使う——鍵の作り方も配置の合成も model の 1 か所が正本で、
 * 画面側で作り直さない。
 *
 * ホバー・選択は部品の立体と同じ欄(`hoveredElementId` / `selection`)に乗る。部品の id は
 * `component-<n>` でフィーチャーの id とは形が違うので、取り違えは起きない。
 */
export function assemblyBundleOf(
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
