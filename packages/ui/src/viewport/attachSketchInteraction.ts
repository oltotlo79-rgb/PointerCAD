import { createConfiguredNumericInput as createNumericInput } from '../settings/createConfiguredNumericInput.js';
/**
 * ビューポートの上でのホバー・選択・吸着・形の作り始めを
 * 結ぶ。
 *
 * 対応要件: FR-106(ホバーとクリック選択)、FR-107(吸着)、FR-307(続けてかく)、FR-309(面)。
 *
 * 判定の中身(当たり判定・吸着候補・履歴の作り方)はすべて純関数に置いてあり、
 * ここは「DOM の出来事をストアの操作へ詰め替える」だけにする。視点操作
 * (attachCameraControls)とぶつからないよう、左ボタン以外と Alt 併用は何もしない。
 *
 * 責務の分け方。どの系列も文書を変えるのは表の「確定」の欄の時点だけ:
 *
 * | 系列 | 置き場所 | 確定(文書・Undo を変える時点) | 取消(文書を変えずに終える) |
 * |---|---|---|---|
 * | 選択 | この関数の `handleSelectionInput`・`pickInto` | 文書は変えない(選択・注目点だけ) | Esc で選択を解く |
 * | 作図 | この関数の `handleDrawingInput`・`openInputAt` | 数値入力の確定(`commitToStore.ts`)。押下は欄を開くだけ | Esc で欄を閉じる |
 * | 引っぱり | `sketchDragSession.ts` | 動かした後の pointerup の `finish` の1回 | pointercancel・Esc・文書の差替え・破棄で `stop(false)` |
 * | 断面のつまみ | `sectionHandleDrag.ts` | 文書は変えない(表示のオフセットだけ) | pointerup・pointercancel・文書の差替え・破棄 |
 * | 一時表示 | `sketchInteractionIndicators.ts` | 文書は変えない(吸着の印・案内線・推定・予告) | 自分が出した物だけを消す |
 *
 * ポインタの捕捉とイベントの登録・解除・ストアの購読は `sketchInteractionResources.ts` が持つ。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  baseWorkPlane,
  curveEnd,
  curveStart,
  DEFAULT_WORK_PLANE_ID,
  FREE_WORK_PLANE_ID,
  dotVec3,
  isFreeWorkPlaneId,
  lengthVec3,
  nextFeatureId,
  ORIGIN,
  radiansToDegrees,
  resolveCoordinate,
  resolvePointReference,
  subVec3,
  vertexKey,
  WORK_PLANES,
  type ResolveContext,
  type ResolvedSketch,
  type SketchDocument,
  type SketchResolveOptions,
  type SubShapeRef,
  type Vec3,
  type WorkPlane,
} from '@pointercad/model';

import { applyProjectionCommit, applySketchCommit } from '../sketch/commitToStore.js';
import {
  pickForConstraint,
} from '../sketch/constraintActions.js';
import {
  constraintMarkAt,
  constraintMarksOf,
  pickConstraintTarget,
} from '../sketch/constraintPicking.js';
import {
  cornerNear,
  cornerPreview,
  type CornerHit,
  type CornerShape,
} from '../sketch/cornerCommands.js';
import { commitExtend, commitTrim } from '../sketch/editCommands.js';
import { freeClickPlane, picksSolidVertices } from '../sketch/freeSketch.js';
import {
  commitNumericInput,
  DEFAULT_COORDINATE_BASE,
  DEFAULT_SKETCH_CHAMFER_DISTANCE_MM,
  DEFAULT_SKETCH_FILLET_RADIUS_MM,
  EDIT_TOOL_STEPS,
  isClickEditTool,
  isCornerEditTool,
  isCoordinateStep,
  isPickEditTool,
  isReferenceCoordinateStep,
  isReferenceTool,
  nextNumericInput,
  reduceNumericInput,
  SHAPE_TOOL_STEPS,
  SOLID_TOOL_STEPS,
  type AppearanceToolId,
  type ClickEditToolId,
  type CornerEditToolId,
  type MathGeometryToolId,
  type MeasureToolId,
  type NumericInputState,
  type NumericInputStep,
  type NumericInputToolId,
  type PickEditToolId,
  type ShapeToolId,
  type SketchToolId,
  type SolidToolId,
} from '../sketch/numericInput.js';
import { inferredConstraintPreview } from '../sketch/inferredConstraints.js';
import { pickSketchElement, sketchForSelection } from '../sketch/pickMath.js';
import { pickConnectionPoint } from '../sketch/connectionSelection.js';
import {
  projectionSourceOf,
  projectionTakesSubShape,
} from '../sketch/projectionCommands.js';
import { resolveShapePoints } from '../sketch/shapeCommands.js';
import {
  commitSphereGridPoint,
  commitSubShapePoint,
  selectedSphereFeature,
  sphereGridSphereOf,
} from '../sketch/sketchCommands.js';
import { extendPreviewAt, trimPreviewAt } from '../sketch/trimPreview.js';
import {
  chooseSnap,
  collectSnapCandidates,
  enabledTrackKinds,
  SNAP_RADIUS_PIXELS,
  type ProjectToScreen,
  type SnapCandidate,
} from '../sketch/snapMath.js';
import {
  chooseTrack,
  collectTrackCandidates,
  type TrackResult,
} from '../sketch/trackMath.js';
import { pickSolidSubShape } from '../solid/pickSubShape.js';
import { filterPickCandidates, type SelectionFilter } from '../solid/selectionFilter.js';
import {
  subShapeElementId,
  subShapeRefOf,
  type SelectionKind,
  type SubShapeBody,
} from '../solid/subShapeSelection.js';
import { useAppStore } from '../store/useAppStore.js';
import { stagedPreviewOf } from './solidMeshAdmission.js';
import type { SolidBodyWithSubShapes } from './buildSolidGeometry.js';
import { viewDirection, type OrbitState } from './cameraMath.js';
import type { ViewportScene } from './createViewportScene.js';
import { gridSpacing } from './gridMath.js';
import type { SketchDragTiming } from './sketchDragTiming.js';
import { createSketchInteractionResources } from './sketchInteractionResources.js';
import { createSketchInteractionIndicators } from './sketchInteractionIndicators.js';
import { snapToSphereGrid, type SphereGridPoint, type SphereGridSpec } from './buildSphereGrid.js';


/**
 * 数値入力で位置を決める道具。選択と面はクリックだけで進む。
 * 図形の道具(円・2点+半径の円弧・矩形・正多角形・長穴・楕円・スプライン)も
 * ここへ入った。いずれも「押した場所が座標そのもの」になる道具なので、既存のかき込む
 * 4 道具とまったく同じ扱いにする(立体も部分形状も拾わない)。
 */
type DrawingToolId = Exclude<SketchToolId, 'select' | 'face'> | ShapeToolId | 'text';

/** 道具ごとの、最初に開く段階。新しい図形の最初の段は `SHAPE_TOOL_STEPS` が正本。 */
const FIRST_STEP: Readonly<Record<DrawingToolId, NumericInputStep>> = {
  point: 'point',
  text: 'point',
  line: 'lineStart',
  arc: 'arcCenter',
  pointArray: 'pointArrayBase',
  ...SHAPE_TOOL_STEPS,
};

/** 基準点を引くだけの問い合わせに使う名前。失敗の理由は捨てるので画面には出ない。 */
const BASE_PROBE_ID = 'numericInput';

/**
 * 数値を聞くソリッドの道具かどうか(加工6種+ばねを含む)。
 *
 * `SolidToolId` の全メンバーは `numericInput.ts` の `SOLID_TOOL_STEPS`(道具ごとの最初の段)の
 * キーと同じ集合になるようにその型で作ってあるので、そこから判定する。以前はここへ
 * `'extrude' | 'revolve' | 'sew'` の3つだけを書き出していたため、`SolidToolId` へ
 * 穴・ねじ穴・R面取り・C面取り・パターン・ばねが増えたときに追随できておらず、
 * これらの道具で pointerdown が誤って `openInputAt`(座標入力)へ流れる不具合があった。
 * 一覧をハードコードせず `SOLID_TOOL_STEPS` から引くことで、今後の道具追加にも追随する。
 */
export function isSolidTool(tool: NumericInputToolId): tool is SolidToolId {
  return tool in SOLID_TOOL_STEPS;
}

/** Add/remove selection must not start a point drag. */
export function addsToSketchSelection(event: Pick<PointerEvent, 'shiftKey' | 'ctrlKey'>): boolean {
  return event.shiftKey || event.ctrlKey;
}

/**
 * ツールバーの「見た目」の一覧に並ぶ道具(FR-1101、FR-1102、FR-1106)。
 *
 * 外観と測るは、どちらも**立体を作らず「いま選んでいるものについて何かをする」**道具で、
 * 押し出しのような `SolidToolId` でも、トリムのような自前のクリックの意味を持つ道具でもない。
 * 一覧をここへ書き出さずに済ませたいが、`numericInput.ts` はこの 2 つを 1 メンバーの型
 * (`AppearanceToolId` / `MeasureToolId`)としてしか持っていないので、**網羅の `Record`** で
 * 表を作る。型が増えたらこの表が型検査で落ちるので、追随の漏れが機械で見つかる
 * (`numericInput.ts` の `CLICK_EDIT_TOOLS` / `PICK_EDIT_TOOLS` と同じ流儀)。
 *
 * **図形の測定値(`MathGeometryToolId`)も同じ性質**(立体を作らず、いま選んでいる
 * ものについて何かをする)なのでここへ入る（LOOK_TOOLS の型で道具の網羅を照合する）。
 */
const LOOK_TOOLS: Readonly<Record<AppearanceToolId | MeasureToolId | MathGeometryToolId, true>> = {
  appearance: true,
  measure: true,
  mathGeometry: true,
};

/** 「見た目」の一覧の道具(外観・測る・図形の測定値)かどうか。一覧は `LOOK_TOOLS` の 1 か所だけ。 */
export function isLookTool(
  tool: NumericInputToolId,
): tool is AppearanceToolId | MeasureToolId | MathGeometryToolId {
  return tool in LOOK_TOOLS;
}

/**
 * 立体そのものをクリックで選べる道具かどうか(FR-106)。
 *
 * 選択のときと、立体の道具(押し出し・回転・縫合、ブーリアンの相手選び、パターン・ばねの
 * 対象選び)のときに効かせる。面の道具は面の境界を順にクリックする道具なので、立体を拾うと
 * 選ぶ順が壊れる。かき込む道具(点・線分・円弧・点列)は押した場所が座標そのものなので拾わない。
 *
 * 断面(FR-325)も立体そのものを押して決める道具なので、ここへ入れる
 * (`isPickEditTool` の 2 つのうち、投影は面・辺を押すので `picksSubShapes` 側を通る)。
 *
 * **外観と測る(`isLookTool`)もここへ入れる。** どちらも立体そのものを
 * 選ぶ場面を持つ道具で、外観は「立体ごとに色を付ける」道(`subShapeSelection.ts` の
 * `selectionKindForTool` の注釈が『立体へ付けたいときは `4` キーで切り替える』と案内している)、
 * 測るは体積・質量特性・立体 2 つの隙間(FR-1101)がどれも立体を選ぶ。
 * この 2 つが増えたときにここへ足し忘れていたため、**その 2 つの道具の
 * あいだは立体をクリックしても選べず、ホバーの強調も出なかった**(2026-09-06 ヘッドレスで実測。
 * 「外観 → `4` → 箱を押す」で選択が空のまま)。
 *
 * **図形の測定値も測ると同じ理由でここへ入る**(`isLookTool` に足したので自動で
 * 拾う)。選んだ点・辺・面・立体から作れる量が決まる道具なので、立体・部分形状を
 * クリックで拾えないと何も測定値を作れない。
 */
export function picksBodies(tool: NumericInputToolId): boolean {
  return tool === 'select' || isSolidTool(tool) || isPickEditTool(tool) || isLookTool(tool);
}

/** 位置を数値で決める、かき込む道具かどうか(FIRST_STEP のキーと同じ集合)。 */
export function isDrawingTool(tool: NumericInputToolId): tool is DrawingToolId {
  return tool in FIRST_STEP;
}

/**
 * 部分形状(面・辺・頂点)をクリック・ホバーで拾う種類かどうか。
 * `picksBodies` の部分形状版。**選択の種類が `body` なら立体の道具・立体の経路(いまのまま)を使う**
 * ので、ここは `body` 以外のときだけ true になる。かき込む道具(点・線・円弧・点列)を
 * 使っているときは、選択の種類を手動で部分形状へ切り替えていても拾わない
 * (いまと同じ判断。押した場所が座標そのものになる道具なので、当たり判定を挟むと
 * 座標の入り口が曖昧になる)。
 */
export function picksSubShapes(kind: SelectionKind, tool: NumericInputToolId): boolean {
  return kind !== 'body' && !isDrawingTool(tool);
}

/**
 * 選択の種類が `body` でないとき、スケッチ要素の当たり判定を飛ばして部分形状だけを拾うべきか
 * (スケッチの面が先に当たる不具合の再発防止)。
 *
 * スケッチの面フィーチャーは「投影した輪郭の内側なら当たり」という当たり判定なので、
 * 押し出し済みの面(の輪郭の内側)を押すと、奥にある立体の面より手前のスケッチ面が
 * 先に当たってしまう。選ぶものの種類が面・辺・頂点(`body` 以外)のときは、そもそも
 * スケッチ要素は選ぶ対象ではないので、当たり判定そのものを試みない。
 * `body` のときは従来どおりスケッチ要素 → 吸着 → 立体の順を保つ。
 */
export function skipsSketchElements(kind: SelectionKind): boolean {
  return kind !== 'body';
}

/**
 * `state.bodies` を `pickSolidSubShape` が要る形へ詰め替える。面・辺・頂点の一覧は
 * model の `SolidBody` に必須の欄として届くが、
 * `?? []` は保険としてそのまま残す(押し出し等、一覧そのものが空のボディを空として扱う)。
 */
export function toSubShapeBodies(bodies: readonly SolidBodyWithSubShapes[]): readonly SubShapeBody[] {
  return bodies.map((body) => ({
    ...body,
    faces: body.faces ?? [],
    edges: body.edges ?? [],
    vertices: body.vertices ?? [],
  }));
}

export interface SketchInteraction {
  detach(): void;
}

/**
 * 解決済みの形から端点・中心の一覧を作る。次に作る要素の基準点を引くのに使う。
 * 点列は同じ featureId の先頭が start、末尾が end(resolveSketch と同じ約束)。
 */
function collectVertices(resolved: ResolvedSketch): Map<string, Vec3> {
  const vertices = new Map<string, Vec3>();
  for (const point of resolved.points) {
    const start = vertexKey(point.featureId, 'start');
    if (!vertices.has(start)) {
      vertices.set(start, point.position);
    }
    vertices.set(vertexKey(point.featureId, 'end'), point.position);
  }
  for (const segment of resolved.segments) {
    vertices.set(vertexKey(segment.featureId, 'start'), segment.from);
    vertices.set(vertexKey(segment.featureId, 'end'), segment.to);
  }
  for (const arc of resolved.arcs) {
    vertices.set(vertexKey(arc.featureId, 'center'), arc.center);
    vertices.set(vertexKey(arc.featureId, 'start'), curveStart(arc));
    vertices.set(vertexKey(arc.featureId, 'end'), curveEnd(arc));
  }
  return vertices;
}

/**
 * 「直前の点」(FR-302)。履歴の末尾へ次の要素を足すときの基準になる。
 * 履歴を後ろからたどり、点を作った要素・線分・円弧のうち解決できている最初のものの
 * 終わりを採る。面は点を作らないので飛ばす(resolveSketch の previous と同じ決め方)。
 */
function lastCreatedPoint(document: SketchDocument, resolved: ResolvedSketch): Vec3 | null {
  for (let index = document.features.length - 1; index >= 0; index -= 1) {
    const feature = document.features[index];
    if (feature.kind === 'face') {
      continue;
    }
    if (feature.kind === 'line') {
      const segment = resolved.segments.find((candidate) => candidate.featureId === feature.id);
      if (segment !== undefined) {
        return segment.to;
      }
      continue;
    }
    if (feature.kind === 'arc') {
      const arc = resolved.arcs.find((candidate) => candidate.featureId === feature.id);
      if (arc !== undefined) {
        return curveEnd(arc);
      }
      continue;
    }
    const group = resolved.points.filter((candidate) => candidate.featureId === feature.id);
    const last = group[group.length - 1];
    if (last !== undefined) {
      return last.position;
    }
  }
  return null;
}

export function attachSketchInteraction(
  canvas: HTMLCanvasElement,
  scene: ViewportScene,
  getOrbit: () => OrbitState,
  isCameraDragging: () => boolean,
  timing?: SketchDragTiming,
): SketchInteraction {
  // メソッドをそのまま値として渡さない(@typescript-eslint/unbound-method)。
  const project: ProjectToScreen = (point) => scene.worldToScreen(point);
  // 一時表示は store で共有する。古い canvas は自分が最後に公開した参照だけを消す。
  const indicators = createSketchInteractionIndicators();
  const resources = createSketchInteractionResources({ canvas, scene, project, getOrbit, isCameraDragging, timing, indicators,
    addsToSketchSelection, skipsSketchElements, tracksDirection, findSnap, findTrack, pickBodyAt, pickSubShapeAt,
    pickFreeVertexAt, updateCornerPreview, updateEditPreview, updateSphereGridInput, updateInferredConstraints,
    pickConstraintAt, handleSelectionInput, handleDrawingInput });


  /**
   * 操作に使う作図面。任意の作業平面(FR-328)は部品文書を見ないと決まらないので、
   * **解くのはストアの `workPlane`**(文書か作図面が変わるたびに 1 度だけ解く)。
   * ここではそれを読むだけにして、同じ計算を押すたびにやり直さない(NFR-PF-1)。
   * 引数の id は「いま読んだ状態と食い違っていないか」を確かめるためだけに使う。
   *
   * 3D スケッチ(FR-330)には作図面が無いので、代わりに**直前に置いた点を通り
   * 画面に正対する面**を毎回作る(`freeSketch.ts` の `freeClickPlane`。理由はそちらの注釈)。
   * カメラが動けば向きが変わる面なので、ストアには置かず押すたびに作る。
   */
  function interactionPlane(planeId: string): WorkPlane {
    const state = useAppStore.getState();
    if (isFreeWorkPlaneId(planeId)) {
      const base = lastCreatedPoint(state.sketch, state.resolvedSketch) ?? ORIGIN;
      return freeClickPlane(base, viewDirection(getOrbit()));
    }
    if (state.workPlane.id === planeId) {
      return state.workPlane;
    }
    return baseWorkPlane(planeId) ?? WORK_PLANES[DEFAULT_WORK_PLANE_ID];
  }

  /** いま吸い付いている候補。吸着が切なら null(FR-107)。 */
  function findSnap(pointer: readonly [number, number], sketch?: ResolvedSketch): SnapCandidate | null {
    const state = useAppStore.getState();
    if (!state.snapEnabled) {
      return null;
    }
    const plane = interactionPlane(state.workPlaneId);
    const onPlane = scene.screenToPlanePoint(pointer[0], pointer[1], plane);
    const candidates = collectSnapCandidates(
      sketch ?? state.resolvedSketch,
      plane,
      gridSpacing(getOrbit().distance),
      onPlane,
    );
    return chooseSnap(candidates, project, pointer, SNAP_RADIUS_PIXELS, new Set(state.snapKinds));
  }

  /** 押した先のワールド座標。吸い付いていればその点、無ければ作図面の上の点。 */
  function pointAt(pointer: readonly [number, number], snap: SnapCandidate | null): Vec3 | null {
    if (snap !== null) {
      return snap.position;
    }
    const plane = interactionPlane(useAppStore.getState().workPlaneId);
    return scene.screenToPlanePoint(pointer[0], pointer[1], plane);
  }

  /**
   * 向きの吸着(FR-110)を効かせる道具かどうか。
   *
   * 押した場所がそのまま座標になる道具(かき込む道具・基準ジオメトリの道具)のときだけ
   * 案内線を出す。選択やトリムのように場所が座標にならない道具では、案内線は画面を
   * 賑やかにするだけで何の役にも立たないため(NFR-UX-1)。
   */
  function tracksDirection(tool: NumericInputToolId): boolean {
    return isDrawingTool(tool) || isReferenceTool(tool);
  }

  /**
   * いま合っている向き(FR-110)。点の吸着(`snap`)が採れているときは**そちらが優先**
   * なので何も返さない(点は 1 点に決まるが向きは線なので、点を先に採る)。
   * 吸着そのものが切、または向きの種別が 1 つも効いていないときも返さない(FR-107 と揃える)。
   */
  function findTrack(
    pointer: readonly [number, number],
    snap: SnapCandidate | null,
  ): TrackResult | null {
    const state = useAppStore.getState();
    if (snap !== null || !state.snapEnabled || !tracksDirection(state.activeTool)) {
      return null;
    }
    const kinds = enabledTrackKinds(new Set(state.snapKinds));
    if (kinds.size === 0) {
      return null;
    }
    const plane = interactionPlane(state.workPlaneId);
    const onPlane = scene.screenToPlanePoint(pointer[0], pointer[1], plane);
    if (onPlane === null) {
      return null;
    }
    /*
      極(角度)と平行線の起点は「直前に置いた点」。いま座標を聞いている段があるなら、
      その段の基準(線分の終点なら自分の始点、新しい図形なら直前に置いた点)がそれに当たる
      ので `baseWorldPoint` をそのまま使う(同じ決め方を 2 か所に書かない)。段が開いて
      いないときは履歴の末尾の点(`lastCreatedPoint`)。
    */
    const opened = state.numericInput;
    const origin =
      opened !== null && isCoordinateStep(opened.step)
        ? baseWorldPoint(opened.step)
        : lastCreatedPoint(state.sketch, state.resolvedSketch);
    const candidates = collectTrackCandidates(
      state.resolvedSketch,
      plane,
      origin,
      onPlane,
      state.displaySettings.trackAngleStep,
      kinds,
    );
    /*
      候補の直線上でどこが「吸い付く点」かは、ポインタの光線に最も近い点で決める。
      視点が斜めだと、作図面上のポインタ点への垂直射影(光線を渡さない
      ときの後退先)では画面上の最近点とずれ、案内線の印がポインタから遠くに決まってしまう
      実測があったための修正(`trackMath.ts` の `closestParameterToRay` の注釈)。
    */
    const ray = scene.pointerRay(pointer[0], pointer[1]);
    return chooseTrack(candidates, project, pointer, SNAP_RADIUS_PIXELS, onPlane, ray);
  }

  /**
   * 押した場所の座標(FR-107、FR-110)。点の吸着 → 向きの吸着 → 作図面の上の点、の順で決める。
   * 押したときとマウスを動かしたときで同じ順序になるよう、決め方はここ 1 か所に置く。
   */
  function pickedPointAt(pointer: readonly [number, number]): Vec3 | null {
    const snap = findSnap(pointer);
    if (snap !== null) {
      return snap.position;
    }
    const track = findTrack(pointer, null);
    return track === null ? pointAt(pointer, null) : track.position;
  }

  /**
   * 拾った 1 件を選択フィルタ(FR-112)に通す。切ってある種類なら null。
   *
   * **押して選ぶのも、乗せて強調するのも同じこの道を通る**(`pickInto` と `onPointerMove` の
   * どちらも下の `pickBodyAt` / `pickSubShapeAt` を呼ぶ)ので、「押せば選べるのに色は
   * 出ない」という食い違いは起きない。絞り込みそのものは Node で検査できる純関数
   * (`solid/selectionFilter.ts` の `filterPickCandidates`)に置いてある。
   *
   * **限界(申し送り)**: 選択の種類が `edge` のときは頂点が辺に勝つので、
   * 頂点だけを切ってあると「頂点の上に乗った瞬間だけ辺も拾えない」。頂点を外して辺を
   * 拾い直すには `pickSolidSubShape` に辺だけの道が要る(残りの課題)。
   */
  function throughSelectionFilter(
    picked: { readonly elementId: string; readonly kind: SelectionKind } | null,
    filter: SelectionFilter,
  ): string | null {
    if (picked === null) {
      return null;
    }
    const [kept] = filterPickCandidates([picked], filter);
    return kept === undefined ? null : kept.elementId;
  }

  /**
   * 押した場所にある立体の id(FR-106)。立体が 1 つも無いときは光線を飛ばさない。
   * スケッチの要素のほうが細くて狙いにくいので、**必ず要素を先に**当ててから呼ぶ
   * (小さいものを先に取る)。
   *
   * 選択フィルタ(FR-112)で「立体」を切ってあるときは光線そのものを飛ばさない。
   */
  function pickBodyAt(pointer: readonly [number, number]): string | null {
    const state = useAppStore.getState();
    if (
      state.bodies.length === 0 ||
      !picksBodies(state.activeTool) ||
      !state.displaySettings.selectionFilter.body
    ) {
      return null;
    }
    return scene.pickBody(pointer[0], pointer[1]);
  }

  /**
   * 押した場所にある立体の部分形状(面・辺・頂点)の要素 id。選択の種類が `body` の
   * ときや、部分形状を拾わない道具(かき込む道具)のときは呼ばない前提で null を返す。
   *
   * 面は光線(`pickFaceAt`)、辺・頂点は画面座標(`pickSolidSubShape`。頂点が辺に勝つ、
   * 裏側も含む)。**吸着(スケッチの点への吸い付き)はここでは使わない**
   * (吸着は作図の補助で、既にある立体の部分形状を拾う場面とは関係が薄い)。
   */
  function pickSubShapeAt(pointer: readonly [number, number]): string | null {
    const state = useAppStore.getState();
    const { selectionKind, bodies, activeTool } = state;
    if (selectionKind === 'body' || bodies.length === 0 || !picksSubShapes(selectionKind, activeTool)) {
      return null;
    }
    // 押し出しの仮の形を描いている間は、画面に見えていない確定済みの辺・頂点を拾わない
    // (面は描いている層を当てるので、場面の側が仮の形を当てないようにしてある)。
    if (stagedPreviewOf(state) !== null) {
      return null;
    }
    const filter = state.displaySettings.selectionFilter;
    if (selectionKind === 'face') {
      // 面を切ってあるときは光線そのものを飛ばさない(FR-112)。
      if (!filter.face) {
        return null;
      }
      const hit = scene.pickFaceAt(pointer[0], pointer[1]);
      return hit === null ? null : subShapeElementId(hit.featureId, 'face', hit.faceIndex);
    }
    // ここまで来たら edge か vertex(pickSolidSubShape が要る SubShapeKind、頂点 > 辺の順)。
    const picked = pickSolidSubShape(toSubShapeBodies(bodies), project, pointer, selectionKind);
    return throughSelectionFilter(picked, filter);
  }

  /**
   * 3D スケッチ(FR-330)で、押した場所にある立体の頂点。
   *
   * 作図面のあるスケッチでは、かき込む道具は立体も部分形状も拾わない(押した場所が座標
   * そのものになる道具なので、当たり判定を挟むと座標の入り口が曖昧になる)。3D スケッチだけは
   * **立体の頂点を押すことが座標の入り口そのもの**なので、点・線分・円弧・スプラインの
   * 道具のときに限って頂点を拾う(`picksSolidVertices`)。辺・面は拾わない(点にできるのは
   * 頂点だけ。辺の中点・面の中心を点にするのは基準点の道具の役目、FR-329)。
   */
  function pickFreeVertexAt(pointer: readonly [number, number]): string | null {
    const state = useAppStore.getState();
    if (!picksSolidVertices(state.workPlaneId, state.activeTool) || state.bodies.length === 0
      || stagedPreviewOf(state) !== null) {
      return null;
    }
    // 選択フィルタ(FR-112)で頂点を切ってあるときは、3D スケッチでも頂点を拾わない。
    const picked = pickSolidSubShape(toSubShapeBodies(state.bodies), project, pointer, 'vertex');
    return throughSelectionFilter(picked, state.displaySettings.selectionFilter);
  }

  /** 押した頂点から、文書へ保存する参照(選んだ瞬間の指紋つき)を作る。 */
  function freeVertexRefAt(pointer: readonly [number, number]): SubShapeRef | null {
    const elementId = pickFreeVertexAt(pointer);
    if (elementId === null) {
      return null;
    }
    return subShapeRefOf(toSubShapeBodies(useAppStore.getState().bodies), elementId);
  }

  /* ---------------------------------------------------------------- *
   * 球面上の点(FR-431)
   * ---------------------------------------------------------------- */

  /**
   * いま吸着の相手にする球と間隔(FR-431)。相手がいなければ null。
   *
   * 相手は**選んでいる球だけ**にする(「いつも出す」で見えているだけの球は相手にしない。
   * どの球の上に点を置くかは利用者が選んだもので決める、`sphereGridTargetSphere` の注釈)。
   * 吸着そのものが切(FR-107)のときも相手にしない。
   */
  function sphereGridTarget(): { readonly spec: SphereGridSpec; readonly sphereFeatureId: string } | null {
    const state = useAppStore.getState();
    if (state.activeTool !== 'sphereGridPoint' || !state.snapEnabled) {
      return null;
    }
    const feature = selectedSphereFeature(state.document, state.selection);
    if (feature === null) {
      return null;
    }
    const sphere = sphereGridSphereOf(feature, state.resolvedSketch);
    if (sphere === null) {
      return null;
    }
    return {
      sphereFeatureId: sphere.featureId,
      spec: {
        center: sphere.center,
        radius: sphere.radius,
        stepDegrees: state.sphereGridStep.value,
      },
    };
  }

  /**
   * ポインタの下にある案内線の交点(FR-431)。無ければ null。
   *
   * **候補を全部回さない。** 光線と球の交点を解いて緯度・経度へ直し、間隔で丸めるだけなので、
   * 費用は交点の数(5° で 2,522 個)に依らず一定になる(`buildSphereGrid.ts` の
   * `nearestSphereGridPoint`)。スケッチの当たり判定(`pickMath.ts`)のように候補を毎回
   * 画面へ写していたら `pointermove` ごとに 2,522 回の変換になり、NFR-PF-1 を割る。
   * 画面座標で 12 画素まで、の判定だけは `snapToSphereGrid` が 1 点ぶん行う。
   */
  function sphereGridPointAtPointer(
    pointer: readonly [number, number],
  ): { readonly point: SphereGridPoint; readonly sphereFeatureId: string } | null {
    const target = sphereGridTarget();
    if (target === null) {
      return null;
    }
    const ray = scene.pointerRay(pointer[0], pointer[1]);
    if (ray === null) {
      return null;
    }
    const point = snapToSphereGrid(target.spec, ray, project, pointer);
    return point === null ? null : { point, sphereFeatureId: target.sphereFeatureId };
  }

  /**
   * 案内線の交点に吸い付いた緯度・経度を、開いている段の欄へ入れる。
   *
   * **値が変わったときだけ**ストアへ書く。ポインタが同じ升の中を滑っている間は丸めた
   * 緯度・経度が変わらないので、`pointermove` のたびに書き直すことはない(NFR-PF-1)。
   */
  function updateSphereGridInput(pointer: readonly [number, number]): void {
    const state = useAppStore.getState();
    const opened = state.numericInput;
    if (opened === null || opened.toolId !== 'sphereGridPoint') {
      return;
    }
    const found = sphereGridPointAtPointer(pointer);
    if (found === null) {
      return;
    }
    const latitude = expressionValueFromNumber(found.point.latitude).source;
    const longitude = expressionValueFromNumber(found.point.longitude).source;
    if (opened.fields[0]?.source === latitude && opened.fields[1]?.source === longitude) {
      return;
    }
    state.updateNumericInput(
      reduceNumericInput(opened, {
        type: 'setValues',
        values: [found.point.latitude, found.point.longitude],
      }),
    );
  }

  /**
   * 案内線の交点を押して球面上の点を 1 つ作る(FR-431)。作れたら true。
   *
   * 交点に吸い付いていないときは false を返し、呼び出し側はふつうの選択(球を選び直す)へ
   * 落とす。**押した瞬間に決まる**(立体の頂点を押して点を作る `commitVertexPoint` と同じ)
   * ので、道具も選択もそのまま残り、続けて何点でも取れる。
   *
   * 作る中身は緯度・経度を打つ経路(`solidCommands.ts`)と同じ `commitSphereGridPoint`
   * なので、どちらから作っても文書はまったく同じ形になる(NFR-UX-1)。
   */
  function commitSphereGridClick(pointer: readonly [number, number]): boolean {
    const found = sphereGridPointAtPointer(pointer);
    if (found === null) {
      return false;
    }
    const state = useAppStore.getState();
    state.setSolidError(null);
    state.setSketch(
      commitSphereGridPoint(
        state.sketch,
        // 球面上の点は 3D スケッチの点(FR-330)。作図面の上には乗らない。
        FREE_WORK_PLANE_ID,
        found.sphereFeatureId,
        expressionValueFromNumber(found.point.latitude),
        expressionValueFromNumber(found.point.longitude),
      ),
    );
    return true;
  }

  /* ---------------------------------------------------------------- *
   * トリム・延長(FR-322、利用者の決定)
   * ---------------------------------------------------------------- */

  /**
   * トリム・延長で押した「曲線と、その上の場所」。曲線に当たっていなければ null。
   *
   * 点や面ではなく**曲線に当たったときだけ**対象にする(切る・伸ばす相手は線・円弧だけ)。
   * 場所は作図面の上の点で、吸着は使わない(吸着は端点・中点へ引き寄せるので、
   * 「いま指している区間」がずれてしまう。狙っているのは点ではなく区間)。
   */
  function editTargetAt(
    pointer: readonly [number, number],
  ): { readonly elementId: string; readonly at: Vec3 } | null {
    const state = useAppStore.getState();
    const picked = pickSketchElement(
      sketchForSelection(state.resolvedSketch, state.displaySettings.selectionFilter), project, pointer,
    );
    if (picked === null || picked.kind !== 'curve') {
      return null;
    }
    const at = pointAt(pointer, null);
    return at === null ? null : { elementId: picked.elementId, at };
  }

  /**
   * トリム・延長のときのマウスの動き。乗っている区間(トリムなら消える区間、
   * 延長なら伸びる区間)を予告として出す(NFR-UX-5)。
   * 断られる場面では何も強調しない。理由はクリックしたときに帯へ出る。
   */
  function updateEditPreview(tool: ClickEditToolId, pointer: readonly [number, number]): void {
    const state = useAppStore.getState();
    const target = editTargetAt(pointer);
    const nextHovered = target === null ? null : target.elementId;
    if (nextHovered !== state.hoveredElementId) {
      state.setHovered(nextHovered);
    }
    indicators.clearSnapIndicators();
    const outcome =
      target === null
        ? null
        : tool === 'trim'
          ? trimPreviewAt(state.resolvedSketch, target.elementId, target.at)
          : extendPreviewAt(state.resolvedSketch, target.elementId, target.at);
    indicators.showEdit(outcome !== null && outcome.ok ? outcome.preview : null);
  }

  /**
   * 作図面の引き方。model の `trimCurve` / `extendCurve` は中で文書を解き直すので、
   * 任意の作業平面(FR-328)も引けるように、いま解いてある面を渡す(`shapeCommands.ts` の
   * `resolveShapePoints` と同じ渡し方)。3D スケッチ(`'free'`)は model 側が
   * 「作図面が無い」ものとして扱うので、ここへは来ない。
   */
  function editResolveOptions(): SketchResolveOptions {
    const state = useAppStore.getState();
    return {
      workPlane: (planeId) =>
        planeId === state.workPlaneId ? state.workPlane : baseWorkPlane(planeId),
    };
  }

  /**
   * トリム・延長のクリック(FR-322)。押した瞬間に決まり、**1 クリック = Undo 1 回**
   * (`setSketch` が文書を 1 段だけ積む、FR-505)。道具は選んだままなので、
   * 続けて何か所でも消せる・伸ばせる。
   *
   * 断りは model の 6 種をそのまま帯へ出す(`editCommands.ts` が文言キーへ移し替える)。
   * 文書は変わらないので、失敗しても線は消えない(FR-504、NFR-UX-5)。
   */
  function commitEditClick(tool: ClickEditToolId, pointer: readonly [number, number]): void {
    const state = useAppStore.getState();
    const target = editTargetAt(pointer);
    if (target === null) {
      state.setEditError('trim.error.missingElement');
      return;
    }
    const options = editResolveOptions();
    const outcome =
      tool === 'trim'
        ? commitTrim(state.sketch, target.elementId, target.at, options)
        : commitExtend(state.sketch, target.elementId, target.at, options);
    if (!outcome.ok) {
      state.setEditError(outcome.reasonKey);
      return;
    }
    // 形が変わるので、いま出している予告は用済み(次にマウスが動いたら出し直す)。
    indicators.hideEdit();
    state.setSketch(outcome.document);
  }

  /* ---------------------------------------------------------------- *
   * 投影・断面(FR-325)
   * ---------------------------------------------------------------- */

  /**
   * 投影・断面のクリック(FR-325)。押した瞬間に決まり、**1 クリック = Undo 1 回**。
   * 道具は選んだまま残るので、続けて何枚でも投影できる(トリム・延長と同じ)。
   *
   * 拾う相手は道具で分かれる。投影は立体の面・辺(選ぶ種類は `selectionKindForTool` が
   * 面へ切り替えてあり、`2` キーで辺へ替えられる)、断面は立体そのもの。何にも当たって
   * いなければ「何を押せばよいか」を帯へ出すだけで、履歴は変えない(FR-504、NFR-UX-5)。
   */
  function commitProjectionClick(tool: PickEditToolId, pointer: readonly [number, number]): void {
    const state = useAppStore.getState();
    const elementId = projectionTakesSubShape(tool)
      ? pickSubShapeAt(pointer)
      : pickBodyAt(pointer);
    const source =
      elementId === null
        ? null
        : projectionSourceOf(tool, toSubShapeBodies(state.bodies), elementId);
    applyProjectionCommit(tool, source === null ? [] : [source]);
  }

  /* ---------------------------------------------------------------- *
   * 角の丸め・面取り(FR-323)
   * ---------------------------------------------------------------- */

  /**
   * 角を拾う輪の大きさ(画素)。当たり判定(6 画素)や吸着(12 画素)より広くしてある。
   * 狙っているのは線そのものではなく「2 本が交わる 1 点」で、細い線と違って多少ずれても
   * 迷う相手がいないため(近い角が 2 つあるときは近いほうを採る、`cornerNear`)。
   */
  const CORNER_PICK_RADIUS_PIXELS = 20;

  /**
   * 画素で決めた輪を、世界の長さ(mm)へ直す。拡大率を変えても「画面上で同じ広さ」に
   * 見えるようにするため(近い/遠いで拾いやすさが変わらない)。
   * 作図面の上で真横へ `CORNER_PICK_RADIUS_PIXELS` だけ動いた点との距離で測る。
   */
  function cornerRadiusInWorld(
    pointer: readonly [number, number],
    plane: WorkPlane,
    at: Vec3,
  ): number {
    const offset = scene.screenToPlanePoint(
      pointer[0] + CORNER_PICK_RADIUS_PIXELS,
      pointer[1],
      plane,
    );
    return offset === null ? CORNER_PICK_RADIUS_PIXELS : lengthVec3(subVec3(offset, at));
  }

  /** 角の丸め・面取りで、いま指している角。指していなければ null。 */
  function cornerTargetAt(pointer: readonly [number, number]): CornerHit | null {
    const state = useAppStore.getState();
    const plane = interactionPlane(state.workPlaneId);
    const at = scene.screenToPlanePoint(pointer[0], pointer[1], plane);
    if (at === null) {
      return null;
    }
    return cornerNear(
      state.sketch,
      state.resolvedSketch,
      at,
      cornerRadiusInWorld(pointer, plane, at),
    );
  }

  /** 予告に使う作図面。3D スケッチ(FR-330)は角そのものから面を作るので null を渡す。 */
  function cornerPlane(): WorkPlane | null {
    const state = useAppStore.getState();
    return isFreeWorkPlaneId(state.workPlaneId) ? null : state.workPlane;
  }

  /** いま欄に入っている値、まだ開いていなければ既定値で予告する形(NFR-UX-4)。 */
  function cornerShapeOf(tool: CornerEditToolId): CornerShape {
    return tool === 'sketchFillet'
      ? { kind: 'fillet', radius: DEFAULT_SKETCH_FILLET_RADIUS_MM }
      : {
          kind: 'chamfer',
          distance1: DEFAULT_SKETCH_CHAMFER_DISTANCE_MM,
          distance2: DEFAULT_SKETCH_CHAMFER_DISTANCE_MM,
        };
  }

  /**
   * 角の丸め・面取りのときのマウスの動き(FR-323、NFR-UX-5)。乗せた角に、丸めた形/
   * 面取りした形を薄く予告する。角に乗っていなければ何も強調しない。
   */
  function updateCornerPreview(tool: CornerEditToolId, pointer: readonly [number, number]): void {
    const state = useAppStore.getState();
    const hit = cornerTargetAt(pointer);
    // 角を作っている 1 本目を強調して、どの角を指しているかを分かりやすくする。
    const nextHovered = hit === null ? null : hit.firstElementId;
    if (nextHovered !== state.hoveredElementId) {
      state.setHovered(nextHovered);
    }
    indicators.clearSnapIndicators();
    indicators.showEdit(hit === null ? null : cornerPreview(hit, cornerPlane(), cornerShapeOf(tool)));
  }

  /**
   * 角の丸め・面取りのクリック(FR-323)。指した角の 2 本をそのまま選択に入れ、半径/距離を
   * 聞く欄をその場に開く(NFR-UX-2)。**確定が読むのは選択の 2 本**なので、「2 本を選んで
   * から道具を押す」道(`Toolbar.tsx`)と 1 本の経路に合流する(NFR-UX-1)。
   */
  function openCornerInput(tool: CornerEditToolId, pointer: readonly [number, number]): void {
    const state = useAppStore.getState();
    const hit = cornerTargetAt(pointer);
    if (hit === null) {
      state.setEditError('corner.error.noCornerHere');
      return;
    }
    state.setSelection([hit.firstElementId, hit.secondElementId]);
    state.setPickAnchor(pointer);
    state.openNumericInput(createNumericInput(tool, EDIT_TOOL_STEPS[tool]), pointer);
  }

  /**
   * 線を引いている最中の拘束の自動推定(FR-333)。
   * `pointermove` ごとに 1 回だけ呼ぶ。
   *
   * 予告するのは**始点を置いて終点を探している線**だけ(確定は「線を引き終えた瞬間」なので、
   * その 1 つ手前の段がここに当たる)。他の道具・他の段では相手が決まらないので予告しない。
   *
   * 終点は**押したときとまったく同じ決め方**(吸着 → 向きの吸着 → 作図面の上の点)にする
   * ため、`onPointerMove` が既に求めた候補をそのまま受け取る(同じ計算を 2 度しない、
   * NFR-PF-1)。近くの要素の絞り込みと判定は `inferredConstraints.ts` / model の純関数。
   *
   * `suspended` は Shift(「押している間は推定を止める」)。
   */
  function updateInferredConstraints(
    pointer: readonly [number, number],
    suspended: boolean,
    snap: SnapCandidate | null,
    track: TrackResult | null,
  ): void {
    const state = useAppStore.getState();
    const opened = state.numericInput;
    if (opened === null || opened.step !== 'lineEnd' || state.pendingStart === null) {
      indicators.clearInferredConstraints();
      return;
    }
    const fromWorld = baseWorldPoint('lineEnd');
    const toWorld = snap?.position ?? track?.position ?? pointAt(pointer, null);
    if (fromWorld === null || toWorld === null) {
      indicators.clearInferredConstraints();
      return;
    }
    const next = inferredConstraintPreview({
      resolved: state.resolvedSketch,
      document: state.sketch,
      plane: interactionPlane(state.workPlaneId),
      // 確定したときに付く id を先に読む(`commitSketchInput` の `lineEnd` と同じ関数)。
      // 予告と確定で同じ id を使うので、印が指した線と拘束が付く線が食い違わない。
      draftFeatureId: nextFeatureId(state.sketch, 'line'),
      fromWorld,
      toWorld,
      project,
      enabled: state.displaySettings.inferConstraints,
      suspended,
    });
    indicators.showInferred(next);
  }



  /**
   * 選択の道具・面の道具・立体の道具・部分形状(面・辺・頂点)を選ぶ加工の道具。押した順が
   * 面の境界の順になり、立体を 2 つ選ぶ順が和・差・積の「もと」と「組み合わせる方」になる
   * (FR-106、FR-309)。何も無いところを押したら選択を解く(足すときは解かない)。
   */
  function pickInto(pointer: readonly [number, number], accumulate: boolean): void {
    const state = useAppStore.getState();
    let elementId: string | null;
    if (skipsSketchElements(state.selectionKind)) {
      /*
        部分形状(面・辺・頂点)を拾う種類のときは、スケッチ要素の当たり判定を飛ばして
        部分形状だけを拾う(スケッチの面が
        立体の面より先に当たるのを防ぐ)。
      */
      if (state.selectionKind === 'vertex' && state.activeTool === 'select') {
        const picked = pickConnectionPoint(state, project, pointer);
        if (picked?.kind === 'ambiguous') { state.setEditError('sketch.connect.ambiguous'); return; }
        elementId = picked?.elementId ?? null;
      } else elementId = pickSubShapeAt(pointer);
    } else {
      // 選択の種類が body のときは従来の順序(要素 → 吸着 → 立体)。
      const picked = pickSketchElement(
        sketchForSelection(state.resolvedSketch, state.displaySettings.selectionFilter), project, pointer,
      );
      elementId = picked !== null ? picked.elementId : pickBodyAt(pointer);
    }
    if (elementId === null) {
      // 押し出しの仮の形を描いている間は、何も拾わない押下(仮の形の上・何も無い所)で
      // 確定に要る選択(輪郭の面・相手)を消さない。選び直しは要素を押す、やめるは Esc。
      if (!accumulate && stagedPreviewOf(state) === null) {
        state.setSelection([]);
        state.setPickAnchor(null);
      }
      return;
    }
    // 選んだ場所を覚えておき、立体の道具のその場入力をその近くへ出す(NFR-UX-2)。
    state.setPickAnchor(pointer);
    if (accumulate) {
      state.toggleSelection(elementId, { kind: 'pick' });
    } else {
      state.setSelection([elementId], { kind: 'pick' });
    }
  }

  /**
   * 拘束の道具でビューポートを押したとき(FR-313)。
   *
   * 拘束の道具は**トリム・延長と同じ流儀**(道具を選んでから要素を
   * 順に押す)。押した相手は `constraintPicking.ts` が決め、**端点・中心を先に見る**ので
   * 「線分の端どうしを一致させる」が成立する(`pickMath.ts` は端点を個別に拾えない)。
   * 積み方と確定は `constraintActions.ts` の 1 か所に置き、ここは押した場所を渡すだけにする。
   */
  function pickConstraintAt(pointer: readonly [number, number]): void {
    const state = useAppStore.getState();
    const pick = pickConstraintTarget(state.resolvedSketch, project, pointer);
    if (pick === null) {
      // 何も無いところを押したら、押した相手をいったん捨てる(選び直せる、NFR-UX-3)。
      state.setConstraintTargets([]);
      state.setSelection([]);
      return;
    }
    // 数値を聞く拘束のその場入力を、押したところの近くへ出す(NFR-UX-2)。
    state.setPickAnchor(pointer);
    pickForConstraint(pick, pointer);
  }

  /**
   * 拘束の印を押したら、その拘束を一覧で選ぶ(FR-106 と同じ「押したら選ばれる」)。
   * 印に当たらなければ false を返し、呼び出し側はふつうの当たり判定へ進む。
   * **描画・当たり判定・選択の 3 つをそろえる**ため、
   * 見るのは 3D へ渡したものと同じ `constraintSummaries` 1 つだけ。
   */
  function pickConstraintMark(pointer: readonly [number, number]): boolean {
    const state = useAppStore.getState();
    if (state.constraintSummaries.length === 0) {
      return false;
    }
    const constraintId = constraintMarkAt(
      constraintMarksOf(state.constraintSummaries),
      project,
      pointer,
    );
    if (constraintId === null) {
      return false;
    }
    state.setSelectedConstraint(constraintId);
    return true;
  }


  /**
   * 押した場所の基準になる点(FR-302、FR-303)。
   *
   * 線分の終点だけは自分の始点が基準で、それ以外は「直前の点」。
   * 決められなければ null を返し、呼び出し側が絶対座標へ切り替える。
   */
  function baseWorldPoint(step: NumericInputStep): Vec3 | null {
    const state = useAppStore.getState();
    const context: ResolveContext = {
      plane: interactionPlane(state.workPlaneId),
      points: state.resolvedSketch.points,
      previous: lastCreatedPoint(state.sketch, state.resolvedSketch),
      vertices: collectVertices(state.resolvedSketch),
    };
    if (step === 'lineEnd') {
      if (state.pendingStart === null) {
        return null;
      }
      const start = resolveCoordinate(state.pendingStart, context, BASE_PROBE_ID);
      return start.ok ? start.value : null;
    }
    /*
      図形の道具(矩形の対角・長穴の 2 つ目の中心・2 点+半径の円弧の 2 点目・
      スプラインの 2 点目以降)は、**まだ履歴に無い「いま置いた点」**が基準になる。
      置いた点の並びをそのまま解けば、確定したフィーチャーを resolveSketch が
      解くときと同じ位置になるので、押した場所が欄へ正しいずれとして入る。
    */
    const placed = state.shapeDraft.points;
    if (placed.length > 0) {
      // 任意の作業平面(FR-328)の上の点も解けるよう、解いた面も渡す。
      const positions = resolveShapePoints(
        state.sketch,
        state.workPlaneId,
        placed,
        context.plane,
      );
      const last = positions?.[positions.length - 1];
      if (last !== undefined) {
        return last;
      }
    }
    const base = resolvePointReference(DEFAULT_COORDINATE_BASE, context, BASE_PROBE_ID);
    return base.ok ? base.value : null;
  }

  /**
   * 押した場所を、いま選ばれている指定方法の欄へ入れる(FR-107、NFR-UX-1)。
   *
   * 絶対ならその座標、相対なら基準からのずれ、極なら距離と作図面内の角度・仰角に直す。
   * 基準の点が決まらないときは絶対へ切り替えてから入れる。押した場所が欄に入らないまま
   * ポップアップが開くと、何を押したのか分からなくなるため。
   */
  function fillClickedPoint(input: NumericInputState, world: Vec3): NumericInputState {
    if (input.mode === 'absolute') {
      return reduceNumericInput(input, { type: 'setValues', values: world });
    }
    const base = baseWorldPoint(input.step);
    if (base === null) {
      const absolute = reduceNumericInput(input, { type: 'setMode', mode: 'absolute' });
      return reduceNumericInput(absolute, { type: 'setValues', values: world });
    }
    const offset = subVec3(world, base);
    if (input.mode === 'relative') {
      return reduceNumericInput(input, { type: 'setValues', values: offset });
    }
    // 極座標は polarOffset(planeMath.ts)の逆算。角度は第1軸から第2軸へ向かう向きが正。
    const plane = interactionPlane(useAppStore.getState().workPlaneId);
    const alongU = dotVec3(offset, plane.axisU);
    const alongV = dotVec3(offset, plane.axisV);
    const alongNormal = dotVec3(offset, plane.normal);
    return reduceNumericInput(input, {
      type: 'setValues',
      values: [
        lengthVec3(offset),
        radiansToDegrees(Math.atan2(alongV, alongU)),
        radiansToDegrees(Math.atan2(alongNormal, Math.hypot(alongU, alongV))),
      ],
    });
  }

  /** 位置を数値で決める道具。押した場所を欄の既定値にして入力を開く(NFR-UX-1)。 */
  function openInputAt(tool: DrawingToolId, pointer: readonly [number, number]): void {
    const state = useAppStore.getState();
    const opened = state.numericInput;
    // 開いていないときは、前の取りかけ(Esc で捨てた始点など)を持ち越さず最初から始める。
    if (opened === null || opened.toolId !== tool) {
      if (state.pendingStart !== null) {
        state.setPendingStart(null);
      }
    }
    const current =
      opened !== null && opened.toolId === tool ? opened : createNumericInput(tool, FIRST_STEP[tool]);

    // 円弧の半径や点列の個数は座標ではないので、位置だけを動かす。
    const world = isCoordinateStep(current.step) ? pickedPointAt(pointer) : null;
    const filled = world === null ? current : fillClickedPoint(current, world);
    if (tool === 'text' && world === null) return;
    state.openNumericInput(tool === 'text' && world !== null ? { ...filled, textOrigin: world } : filled, pointer);
  }

  /**
   * 3D スケッチで立体の頂点を押したときに、点を 1 つ作る(FR-330)。
   *
   * **点の道具**は押した瞬間に確定する(その場数値入力は開かない。
   * 点を作るもう 1 つの方法)。**線分・円弧・スプライン**の道具では、いま聞いている
   * 座標の段の答えとして頂点を渡す。段の進み方(始点 → 終点、点を積み上げる)は
   * `commitNumericInput` / `nextNumericInput` に任せるので、数値を打ったときとまったく
   * 同じ道筋になる(NFR-UX-1)。
   *
   * どちらの経路でも保存するのは「頂点の参照+ずれ 0」(`subShapeCoordinate`)なので、
   * あとから立体を変えても点はその頂点に付いて動く。
   */
  function commitVertexPoint(ref: SubShapeRef, pointer: readonly [number, number]): void {
    const state = useAppStore.getState();
    if (state.activeTool === 'point') {
      state.setShapeError(null);
      state.setSketch(commitSubShapePoint(state.sketch, state.workPlaneId, ref));
      return;
    }
    const opened = state.numericInput;
    if (opened === null || !isCoordinateStep(opened.step)) {
      // 線分・円弧・スプラインで座標を聞いていないとき(半径や決め方の段)は、
      // 頂点を押しても入れる先が無いので何もしない(壊れた形を黙って作らない)。
      return;
    }
    // 相対のずれ 0 として、基準に頂点の参照を渡す。欄の値は 0 に揃える
    // (指定方法を切り替えると値は既定へ戻る約束なので、切り替えてから 0 を入れる)。
    const relative = reduceNumericInput(
      reduceNumericInput(opened, { type: 'setMode', mode: 'relative' }),
      { type: 'setValues', values: [0, 0, 0] },
    );
    const transition = commitNumericInput(relative, { base: { kind: 'subShape', ref } });
    if (transition.kind !== 'committed') {
      return;
    }
    applySketchCommit(transition.commit, transition.state);
    const next = nextNumericInput(transition.state, useAppStore.getState().chaining);
    if (next === null) {
      useAppStore.getState().closeNumericInput();
      return;
    }
    useAppStore.getState().openNumericInput(next, pointer);
  }


  /** 文書を変えない選択と、押した瞬間に処理する編集道具の入口。 */
  function handleSelectionInput(event: PointerEvent, pointer: readonly [number, number],
    state: ReturnType<typeof useAppStore.getState>, tool: NumericInputToolId): boolean {
    if (tool === 'select' && pickConstraintMark(pointer)) {
      // 拘束の印を押した。要素の選択は変えずに、その拘束を一覧で選ぶだけにする。
      return true;
    }

    if (tool === 'select' || tool === 'face') {
      // 面の道具では 1 つずつ足す。選択の道具は Shift/Ctrl で追加・解除する。
      // 選択の種類(selectionKind)がどうであっても、この2つの道具の振る舞いは変えない
      // (手動で部分形状の種類へ切り替えていても面の境界の順が壊れないように、
      // この判定を選択の種類より先に置く)。
      pickInto(pointer, tool === 'face' || addsToSketchSelection(event));
      return true;
    }

    if (isClickEditTool(tool)) {
      /*
        トリム・延長(FR-322、利用者の決定)。押した瞬間に決まる道具なので、
        選択もその場入力も挟まない。焦点は canvas に残して、続けて何か所でも押せて
        Esc で終われるようにする(NFR-UX-7)。
      */
      event.preventDefault();
      commitEditClick(tool, pointer);
      return true;
    }

    if (isPickEditTool(tool)) {
      /*
        投影・断面(FR-325)。押した立体の面・辺・立体そのものがそのまま
        取り込む相手になる。選択もその場入力も挟まず、押した瞬間に決まる。この判定を
        下の「部分形状を選ぶ道具」より先に置くのは、そちらへ流れると選ぶだけで
        終わってしまうため。
      */
      event.preventDefault();
      commitProjectionClick(tool, pointer);
      return true;
    }

    if (isCornerEditTool(tool)) {
      /*
        角の丸め・面取り(FR-323)。押した角の 2 本を選んで、その場で半径/距離を
        聞く。確定したあとも道具は残るので、続けて別の角を押せる(Esc で終わる)。
      */
      event.preventDefault();
      openCornerInput(tool, pointer);
      return true;
    }

    if (isReferenceTool(tool)) {
      /*
        基準ジオメトリの道具(FR-328、FR-329)。座標を聞いている段では押した場所を
        欄へ入れ(NFR-UX-1)、決め方の段では辺・面・頂点を選ぶ(選択の種類は道具を選んだ
        ときに `selectionKindForTool` が切り替えている)。開いている欄から焦点は奪わない。
      */
      event.preventDefault();
      const opened = state.numericInput;
      if (opened !== null && opened.toolId === tool && isReferenceCoordinateStep(opened.step)) {
        const world = pickedPointAt(pointer);
        if (world !== null) {
          state.openNumericInput(fillClickedPoint(opened, world), pointer);
          return true;
        }
      }
      pickInto(pointer, addsToSketchSelection(event));
      return true;
    }

    if (tool === 'sphereGridPoint') {
      /*
        球面上の点(FR-431)。案内線の交点を押したらその場で点ができ、
        交点から外れたところを押したときは**球を選び直す**ふつうの選択になる
        (どの球の上に置くかを押し直せる)。開いている欄から焦点は奪わない。
      */
      event.preventDefault();
      if (!commitSphereGridClick(pointer)) {
        pickInto(pointer, addsToSketchSelection(event));
      }
      return true;
    }

    if (picksBodies(tool) || picksSubShapes(state.selectionKind, tool)) {
      // 立体の道具(押し出し・回転・縫合、パターン・ばねの対象選び)と、部分形状(面・辺・頂点)を
      // 選ぶ加工の道具(穴・ねじ穴・R 面取り・C 面取り)では、入力欄を開いたまま対象を選び直せる。
      // 焦点は欄に残してそのまま Enter で決められるようにする(NFR-UX-2)。Shift で相手を足す
      // (穴・ばね等と同じ)。
      //
      // 見るのを `isSolidTool` から `picksBodies` へ広げてある。外観・測るは
      // `SolidToolId` ではないので、選ぶものが「立体」のときこの枝に入れず、**押しても何も
      // 起きなかった**(下の「押した場所が座標にならない道具」で黙って返っていた)。
      // 選択・投影・断面は上の枝で先に返るので、条件を広げてもそれらの振る舞いは変わらない。
      event.preventDefault();
      pickInto(pointer, addsToSketchSelection(event));
      return true;
    }

    return false;
  }

  /** 座標を受け取る作図道具だけを、選択/dragの後へ流す。 */
  function handleDrawingInput(event: PointerEvent, pointer: readonly [number, number],
    state: ReturnType<typeof useAppStore.getState>, tool: NumericInputToolId): void {
    // 既定の動作(canvas へ焦点を移す)を止めて、開いている欄から焦点を奪わない。
    // 押した場所の座標が欄へ入った直後に、そのまま Enter で決められるようにする(NFR-UX-2)。
    event.preventDefault();

    if (isFreeWorkPlaneId(state.workPlaneId) && isDrawingTool(tool)) {
      /*
        3D スケッチ(FR-330)。立体の頂点を押したらその頂点を参照する点にし
        (押した場所そのものより頂点を優先する。狙って押しているのは頂点のほう)、
        頂点でないところを押したときは、押した場所を「直前の点を通り画面に正対する面」の
        上の点として欄へ入れる(面の作り方と理由は `freeSketch.ts` の `freeClickPlane`)。
        その面は、続けて決まる円弧の向き(`freeOrientation`)にも使うので覚えておく。
      */
      const ref = freeVertexRefAt(pointer);
      if (ref !== null) {
        commitVertexPoint(ref, pointer);
        return;
      }
      state.setFreeSketchPlane(interactionPlane(state.workPlaneId));
      openInputAt(tool, pointer);
      return;
    }

    if (!isDrawingTool(tool)) {
      // 押した場所が座標にならない道具(オフセットのように既にある要素を選ぶ道具)は、
      // ここでは何もしない。段の開き方はその道具の受け持ち。
      return;
    }
    openInputAt(tool, pointer);
  }




  return resources.attach();
}
