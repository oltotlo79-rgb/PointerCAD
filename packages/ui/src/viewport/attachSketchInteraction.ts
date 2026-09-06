/**
 * ビューポートの上でのホバー・選択・吸着・形の作り始めを結ぶ
 * (計画書 docs/plans/P1-式とスケッチ.md タスク21 手順4)。
 *
 * 対応要件: FR-106(ホバーとクリック選択)、FR-107(吸着)、FR-307(続けてかく)、FR-309(面)。
 *
 * 判定の中身(当たり判定・吸着候補・履歴の作り方)はすべて純関数に置いてあり、
 * ここは「DOM の出来事をストアの操作へ詰め替える」だけにする。視点操作
 * (attachCameraControls)とぶつからないよう、左ボタン以外と Alt 併用は何もしない。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addVec3,
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
  scaleVec3,
  subVec3,
  vertexKey,
  WORK_PLANES,
  worldToPlane,
  type ConstraintTarget,
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
  cancelConstraintTool,
  constraintContextOfStore,
  constraintResolveOptions,
  pickForConstraint,
} from '../sketch/constraintActions.js';
import {
  constraintMarkAt,
  constraintMarksOf,
  pickConstraintTarget,
  vertexAt,
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
  createNumericInput,
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
  type MeasureToolId,
  type NumericInputState,
  type NumericInputStep,
  type NumericInputToolId,
  type PickEditToolId,
  type ShapeToolId,
  type SketchToolId,
  type SolidToolId,
} from '../sketch/numericInput.js';
import {
  inferredConstraintPreview,
  sameInferredPreview,
} from '../sketch/inferredConstraints.js';
import { pickSketchElement } from '../sketch/pickMath.js';
import {
  projectionSourceOf,
  projectionTakesSubShape,
} from '../sketch/projectionCommands.js';
import { resolveShapePoints } from '../sketch/shapeCommands.js';
import {
  commitFace,
  commitSphereGridPoint,
  commitSubShapePoint,
  selectedSphereFeature,
  sphereGridSphereOf,
} from '../sketch/sketchCommands.js';
import { extendPreviewAt, sameEditPreview, trimPreviewAt } from '../sketch/trimPreview.js';
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
  closestParameterToRay,
  collectTrackCandidates,
  type TrackCandidate,
  type TrackResult,
} from '../sketch/trackMath.js';
import { resolveCutPlane } from '../solid/cutCommands.js';
import { pickSolidSubShape } from '../solid/pickSubShape.js';
import { filterPickCandidates, type SelectionFilter } from '../solid/selectionFilter.js';
import {
  subShapeElementId,
  subShapeRefOf,
  type SelectionKind,
  type SubShapeBody,
} from '../solid/subShapeSelection.js';
import { useAppStore, type SnapIndicator } from '../store/useAppStore.js';
import type { SolidBodyWithSubShapes } from './buildSolidGeometry.js';
import { viewDirection, type OrbitState } from './cameraMath.js';
import {
  commitDrag,
  dragRefusalMessageKey,
  dragTargetUv,
  draggableAt,
  isDraggable,
  solveWithDrag,
} from './dragSketch.js';
import type { ViewportScene } from './createViewportScene.js';
import { gridSpacing } from './gridMath.js';
import { snapToSphereGrid, type SphereGridPoint, type SphereGridSpec } from './buildSphereGrid.js';

const LEFT_BUTTON = 0;

/**
 * 断面表示のつまみ(FR-111、P6 タスク35、§0.42)を掴める画面上の半径(px)。
 *
 * 狙うのは**矢印の根もと**(= 切る平面の中心)。矢印の長さは四角の大きさから決まる
 * (`createSolidLayer.ts` が測る)ので画面側からは分からず、根もとの 1 点だけが
 * 呼び出し側と描画側で必ず一致する。部分形状の 6px より広くしてあるのは、つまみが
 * 立体の面に重なって出るぶん狙いにくいため(NFR-UX-7)。
 */
const SECTION_HANDLE_PICK_RADIUS_PIXELS = 18;

/**
 * 数値入力で位置を決める道具。選択と面はクリックだけで進む。
 * P4 タスク11 で新しい図形(円・2点+半径の円弧・矩形・正多角形・長穴・楕円・スプライン)も
 * ここへ入った。いずれも「押した場所が座標そのもの」になる道具なので、既存のかき込む
 * 4 道具とまったく同じ扱いにする(立体も部分形状も拾わない)。
 */
type DrawingToolId = Exclude<SketchToolId, 'select' | 'face'> | ShapeToolId;

/** 道具ごとの、最初に開く段階。新しい図形の最初の段は `SHAPE_TOOL_STEPS` が正本。 */
const FIRST_STEP: Readonly<Record<DrawingToolId, NumericInputStep>> = {
  point: 'point',
  line: 'lineStart',
  arc: 'arcCenter',
  pointArray: 'pointArrayBase',
  ...SHAPE_TOOL_STEPS,
};

/** 基準点を引くだけの問い合わせに使う名前。失敗の理由は捨てるので画面には出ない。 */
const BASE_PROBE_ID = 'numericInput';

/**
 * 数値を聞くソリッドの道具かどうか(P2 タスク19、P3 タスク24 で加工6種+ばねを追加、§2.11)。
 *
 * `SolidToolId` の全メンバーは `numericInput.ts` の `SOLID_TOOL_STEPS`(道具ごとの最初の段)の
 * キーと同じ集合になるようにその型で作ってあるので、そこから判定する。以前はここへ
 * `'extrude' | 'revolve' | 'sew'` の3つだけを書き出していたため、P3 で `SolidToolId` へ
 * 穴・ねじ穴・R面取り・C面取り・パターン・ばねが増えたときに追随できておらず、
 * これらの道具で pointerdown が誤って `openInputAt`(座標入力)へ流れる不具合があった。
 * 一覧をハードコードせず `SOLID_TOOL_STEPS` から引くことで、今後の道具追加にも追随する。
 */
export function isSolidTool(tool: NumericInputToolId): tool is SolidToolId {
  return tool in SOLID_TOOL_STEPS;
}

/**
 * ツールバーの「見た目」の一覧に並ぶ道具(FR-1101、FR-1102、FR-1106。P5 タスク11・32)。
 *
 * 外観と測るは、どちらも**立体を作らず「いま選んでいるものについて何かをする」**道具で、
 * 押し出しのような `SolidToolId` でも、トリムのような自前のクリックの意味を持つ道具でもない。
 * 一覧をここへ書き出さずに済ませたいが、`numericInput.ts` はこの 2 つを 1 メンバーの型
 * (`AppearanceToolId` / `MeasureToolId`)としてしか持っていないので、**網羅の `Record`** で
 * 表を作る。型が増えたらこの表が型検査で落ちるので、追随の漏れが機械で見つかる
 * (`numericInput.ts` の `CLICK_EDIT_TOOLS` / `PICK_EDIT_TOOLS` と同じ流儀)。
 */
const LOOK_TOOLS: Readonly<Record<AppearanceToolId | MeasureToolId, true>> = {
  appearance: true,
  measure: true,
};

/** 「見た目」の一覧の道具(外観・測る)かどうか。一覧は `LOOK_TOOLS` の 1 か所だけ。 */
export function isLookTool(
  tool: NumericInputToolId,
): tool is AppearanceToolId | MeasureToolId {
  return tool in LOOK_TOOLS;
}

/**
 * 立体そのものをクリックで選べる道具かどうか(FR-106、§0.a-0.6)。
 *
 * 選択のときと、立体の道具(押し出し・回転・縫合、ブーリアンの相手選び、パターン・ばねの
 * 対象選び)のときに効かせる。面の道具は面の境界を順にクリックする道具なので、立体を拾うと
 * 選ぶ順が壊れる。かき込む道具(点・線分・円弧・点列)は押した場所が座標そのものなので拾わない。
 *
 * 断面(FR-325、タスク27)も立体そのものを押して決める道具なので、ここへ入れる
 * (`isPickEditTool` の 2 つのうち、投影は面・辺を押すので `picksSubShapes` 側を通る)。
 *
 * **外観と測る(`isLookTool`)もここへ入れる(P5 仕上げ (j))。** どちらも立体そのものを
 * 選ぶ場面を持つ道具で、外観は「立体ごとに色を付ける」道(`subShapeSelection.ts` の
 * `selectionKindForTool` の注釈が『立体へ付けたいときは `4` キーで切り替える』と案内している)、
 * 測るは体積・質量特性・立体 2 つの隙間(FR-1101、§0.a-0.69)がどれも立体を選ぶ。
 * P5 タスク11・32 でこの 2 つが増えたときにここへ足し忘れていたため、**その 2 つの道具の
 * あいだは立体をクリックしても選べず、ホバーの強調も出なかった**(2026-09-06 ヘッドレスで実測。
 * 「外観 → `4` → 箱を押す」で選択が空のまま)。
 */
export function picksBodies(tool: NumericInputToolId): boolean {
  return tool === 'select' || isSolidTool(tool) || isPickEditTool(tool) || isLookTool(tool);
}

/** 位置を数値で決める、かき込む道具かどうか(FIRST_STEP のキーと同じ集合)。 */
export function isDrawingTool(tool: NumericInputToolId): tool is DrawingToolId {
  return tool in FIRST_STEP;
}

/**
 * 部分形状(面・辺・頂点)をクリック・ホバーで拾う種類かどうか(§0.a-0.6、§2.3.2)。
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
 * (§2.3.2、タスク30 不具合(c))。
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
 * model の `SolidBody` にタスク17(橋渡しの拡張)で必須の欄として届くようになったが、
 * `?? []` は保険としてそのまま残す(押し出し等、一覧そのものが空のボディを空として扱う)。
 */
export function toSubShapeBodies(bodies: readonly SolidBodyWithSubShapes[]): readonly SubShapeBody[] {
  return bodies.map((body) => ({
    featureId: body.featureId,
    mesh: { edgePositions: body.mesh.edgePositions },
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

/** 印を出し直す必要があるかどうか。同じ場所なら書き換えず、無駄な再描画を起こさない。 */
function sameIndicator(a: SnapIndicator | null, b: SnapIndicator | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.kind === b.kind &&
    a.elementId === b.elementId &&
    a.screen[0] === b.screen[0] &&
    a.screen[1] === b.screen[1]
  );
}

/** 案内線 1 本ぶんが同じか。線そのもの(通る点と向き)だけを見る。 */
function sameTrackLine(a: TrackCandidate, b: TrackCandidate): boolean {
  return (
    a.kind === b.kind &&
    a.sourceFeatureId === b.sourceFeatureId &&
    a.angleDegrees === b.angleDegrees &&
    a.origin.every((value, index) => value === b.origin[index]) &&
    a.direction.every((value, index) => value === b.direction[index])
  );
}

/**
 * 案内線を引き直す必要があるかどうか(FR-110、NFR-PF-1)。
 *
 * **線の上をポインタが滑っている間は同じ線**なので、位置ではなく線そのものを比べる。
 * 位置で比べると 1 回動かすたびにストアが書き換わり、案内線を毎フレーム引き直すことになる。
 */
function sameTrack(
  a: readonly TrackCandidate[] | null,
  b: readonly TrackCandidate[] | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.length === b.length && a.every((line, index) => sameTrackLine(line, b[index]));
}

export function attachSketchInteraction(
  canvas: HTMLCanvasElement,
  scene: ViewportScene,
  getOrbit: () => OrbitState,
): SketchInteraction {
  // メソッドをそのまま値として渡さない(@typescript-eslint/unbound-method)。
  const project: ProjectToScreen = (point) => scene.worldToScreen(point);

  function pointerPosition(event: PointerEvent): readonly [number, number] {
    const bounds = canvas.getBoundingClientRect();
    return [event.clientX - bounds.left, event.clientY - bounds.top];
  }

  /**
   * 操作に使う作図面。任意の作業平面(FR-328)は部品文書を見ないと決まらないので、
   * **解くのはストアの `workPlane`**(文書か作図面が変わるたびに 1 度だけ解く、タスク13)。
   * ここではそれを読むだけにして、同じ計算を押すたびにやり直さない(NFR-PF-1)。
   * 引数の id は「いま読んだ状態と食い違っていないか」を確かめるためだけに使う。
   *
   * 3D スケッチ(FR-330、タスク14)には作図面が無いので、代わりに**直前に置いた点を通り
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

  /**
   * 吸着の印と向きの案内線をまとめて消す(FR-107、FR-110)。乗せているだけの道具
   * (トリム・延長・角の丸め・部分形状を拾う種類)と、ポインタが画面から出たときに呼ぶ。
   */
  function clearSnapIndicators(): void {
    const state = useAppStore.getState();
    if (state.snapIndicator !== null) {
      state.setSnapIndicator(null);
    }
    if (state.trackIndicator !== null) {
      state.setTrackIndicator(null);
    }
    // 拘束の推定の予告も一緒に消す(FR-333、P6 タスク41)。線を引いていない道具では
    // 予告する相手がいないので、印だけが残るのを防ぐ。
    clearInferredConstraints();
  }

  /** 推定した拘束の予告を消す(FR-333)。既に無ければ書き込まない(NFR-PF-1)。 */
  function clearInferredConstraints(): void {
    const state = useAppStore.getState();
    if (state.inferredConstraints !== null) {
      state.setInferredConstraints(null);
    }
  }

  /** いま吸い付いている候補。吸着が切なら null(FR-107)。 */
  function findSnap(pointer: readonly [number, number]): SnapCandidate | null {
    const state = useAppStore.getState();
    if (!state.snapEnabled) {
      return null;
    }
    const plane = interactionPlane(state.workPlaneId);
    const onPlane = scene.screenToPlanePoint(pointer[0], pointer[1], plane);
    const candidates = collectSnapCandidates(
      state.resolvedSketch,
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
   * なので何も返さない(§0.13。点は 1 点に決まるが向きは線なので、点を先に採る)。
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
      候補の直線上でどこが「吸い付く点」かは、ポインタの光線に最も近い点で決める
      (P4b 仕上げ (a))。視点が斜めだと、作図面上のポインタ点への垂直射影(光線を渡さない
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
   * 拾った 1 件を選択フィルタ(FR-112、P6 タスク36)に通す。切ってある種類なら null。
   *
   * **押して選ぶのも、乗せて強調するのも同じこの道を通る**(`pickInto` と `onPointerMove` の
   * どちらも下の `pickBodyAt` / `pickSubShapeAt` を呼ぶ)ので、「押せば選べるのに色は
   * 出ない」という食い違いは起きない。絞り込みそのものは Node で検査できる純関数
   * (`solid/selectionFilter.ts` の `filterPickCandidates`)に置いてある。
   *
   * **限界(申し送り)**: 選択の種類が `edge` のときは頂点が辺に勝つ(§0.a-0.27)ので、
   * 頂点だけを切ってあると「頂点の上に乗った瞬間だけ辺も拾えない」。頂点を外して辺を
   * 拾い直すには `pickSolidSubShape` に辺だけの道が要る(タスク37・44 へ申し送り)。
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
   * (小さいものを先に取る、P1 §2.8)。
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
   * 押した場所にある立体の部分形状(面・辺・頂点)の要素 id(§2.3.2)。選択の種類が `body` の
   * ときや、部分形状を拾わない道具(かき込む道具、§2.3.2)のときは呼ばない前提で null を返す。
   *
   * 面は光線(`pickFaceAt`)、辺・頂点は画面座標(`pickSolidSubShape`。頂点が辺に勝つ、
   * §0.a-0.27 の裏側も含む)。**吸着(スケッチの点への吸い付き)はここでは使わない**
   * (§2.3.2 の順序表。吸着は作図の補助で、既にある立体の部分形状を拾う場面とは関係が薄い)。
   */
  function pickSubShapeAt(pointer: readonly [number, number]): string | null {
    const state = useAppStore.getState();
    const { selectionKind, bodies, activeTool } = state;
    if (selectionKind === 'body' || bodies.length === 0 || !picksSubShapes(selectionKind, activeTool)) {
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

  /* ---------------------------------------------------------------- *
   * 断面表示のつまみ(FR-111、P6 タスク35、§0.42)
   * ---------------------------------------------------------------- */

  /**
   * つまみを引いている最中の控え。掴んでいなければ null。
   *
   * 平面は**掴んだ瞬間のもの**を覚える(引いている間に文書が変わっても、掴んだ軸の上を
   * まっすぐ動く)。`delta` は掴んだ瞬間のずれで、これを足すことでつまみが指の下へ
   * 飛ばない(スケッチの引っぱりと同じ考え方)。
   */
  let sectionDrag: {
    /** オフセット 0 のときの平面の原点(ここを起点に法線方向へ測る)。 */
    readonly origin: Vec3;
    /** 単位法線。オフセットが増える向き。 */
    readonly normal: Vec3;
    /** 掴んだ瞬間の「今のオフセット − 光線から求めた値」。 */
    readonly delta: number;
  } | null = null;

  /**
   * つまみを掴めたか(FR-111)。断面表示を出していない・平面が解けない・矢印の根もとから
   * 遠いときは掴まず、押下は従来どおり下の枝(選択など)へ流れる。
   */
  function beginSectionDragAt(pointer: readonly [number, number]): boolean {
    const state = useAppStore.getState();
    const section = state.sectionView;
    if (section === null) {
      return false;
    }
    const plane = resolveCutPlane(section.plane);
    if (plane === null) {
      return false;
    }
    // つまみは「オフセットを載せた後」の位置に出ている(ViewportCanvas と同じ式)。
    const handleOrigin = addVec3(plane.origin, scaleVec3(plane.normal, section.offsetMm));
    const screen = project(handleOrigin);
    if (screen === null) {
      return false;
    }
    const distance = Math.hypot(screen[0] - pointer[0], screen[1] - pointer[1]);
    if (distance > SECTION_HANDLE_PICK_RADIUS_PIXELS) {
      return false;
    }
    const ray = scene.pointerRay(pointer[0], pointer[1]);
    const grabbed =
      ray === null
        ? null
        : closestParameterToRay({ origin: plane.origin, direction: plane.normal }, ray);
    sectionDrag = {
      origin: plane.origin,
      normal: plane.normal,
      // 光線が取れない(まだ一度も描いていない)ときはずれ 0 で始める。
      delta: grabbed === null ? 0 : section.offsetMm - grabbed,
    };
    return true;
  }

  /**
   * 引いている間、法線の軸の上でポインタにいちばん近い位置をオフセットにする(§0.42)。
   *
   * 軸への写し方は案内線と同じ `closestParameterToRay`(P4b 仕上げ (a))。法線が単位なので
   * 求まる係数がそのまま mm になる。視線と法線がほぼ平行(真上から見て真下へ切っている)
   * ときは係数が定まらないので、**その間は動かさない**(暴れさせない、NFR-UX-7)。
   */
  function updateSectionDrag(pointer: readonly [number, number]): void {
    if (sectionDrag === null) {
      return;
    }
    const ray = scene.pointerRay(pointer[0], pointer[1]);
    if (ray === null) {
      return;
    }
    const parameter = closestParameterToRay(
      { origin: sectionDrag.origin, direction: sectionDrag.normal },
      ray,
    );
    if (parameter === null) {
      return;
    }
    useAppStore.getState().setSectionOffset(parameter + sectionDrag.delta);
  }

  /**
   * 3D スケッチ(FR-330、タスク14)で、押した場所にある立体の頂点。
   *
   * 作図面のあるスケッチでは、かき込む道具は立体も部分形状も拾わない(押した場所が座標
   * そのものになる道具なので、当たり判定を挟むと座標の入り口が曖昧になる)。3D スケッチだけは
   * **立体の頂点を押すことが座標の入り口そのもの**なので、点・線分・円弧・スプラインの
   * 道具のときに限って頂点を拾う(`picksSolidVertices`)。辺・面は拾わない(点にできるのは
   * 頂点だけ。辺の中点・面の中心を点にするのは基準点の道具の役目、FR-329)。
   */
  function pickFreeVertexAt(pointer: readonly [number, number]): string | null {
    const state = useAppStore.getState();
    if (!picksSolidVertices(state.workPlaneId, state.activeTool) || state.bodies.length === 0) {
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
   * 球面上の点(FR-431、計画書タスク21・22)
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
   * ポインタの下にある案内線の交点(FR-431、§0.a-0.22)。無ければ null。
   *
   * **候補を全部回さない。** 光線と球の交点を解いて緯度・経度へ直し、間隔で丸めるだけなので、
   * 費用は交点の数(5° で 2,522 個)に依らず一定になる(`buildSphereGrid.ts` の
   * `nearestSphereGridPoint`)。P1 の当たり判定(`pickMath.ts`)のように候補を毎回
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
   * 案内線の交点に吸い付いた緯度・経度を、開いている段の欄へ入れる(タスク22 手順2)。
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
   * トリム・延長(FR-322、計画書タスク22、§0.a-0.26 の利用者の決定)
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
    const picked = pickSketchElement(state.resolvedSketch, project, pointer);
    if (picked === null || picked.kind !== 'curve') {
      return null;
    }
    const at = pointAt(pointer, null);
    return at === null ? null : { elementId: picked.elementId, at };
  }

  /**
   * トリム・延長のときのマウスの動き。乗っている区間(トリムなら消える区間、
   * 延長なら伸びる区間)を予告として出す(§0.a-0.26、NFR-UX-5)。
   * 断られる場面では何も強調しない。理由はクリックしたときに帯へ出る。
   */
  function updateEditPreview(tool: ClickEditToolId, pointer: readonly [number, number]): void {
    const state = useAppStore.getState();
    const target = editTargetAt(pointer);
    const nextHovered = target === null ? null : target.elementId;
    if (nextHovered !== state.hoveredElementId) {
      state.setHovered(nextHovered);
    }
    clearSnapIndicators();
    const outcome =
      target === null
        ? null
        : tool === 'trim'
          ? trimPreviewAt(state.resolvedSketch, target.elementId, target.at)
          : extendPreviewAt(state.resolvedSketch, target.elementId, target.at);
    const preview = outcome !== null && outcome.ok ? outcome.preview : null;
    if (!sameEditPreview(state.editPreview, preview)) {
      state.setEditPreview(preview);
    }
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
   * 続けて何か所でも消せる・伸ばせる(§0.a-0.26)。
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
    state.setEditPreview(null);
    state.setSketch(outcome.document);
  }

  /* ---------------------------------------------------------------- *
   * 投影・断面(FR-325、計画書タスク27)
   * ---------------------------------------------------------------- */

  /**
   * 投影・断面のクリック(FR-325)。押した瞬間に決まり、**1 クリック = Undo 1 回**。
   * 道具は選んだまま残るので、続けて何枚でも投影できる(トリム・延長と同じ、§0.a-0.26)。
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
   * 角の丸め・面取り(FR-323、計画書タスク23)
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
    clearSnapIndicators();
    const preview = hit === null ? null : cornerPreview(hit, cornerPlane(), cornerShapeOf(tool));
    if (!sameEditPreview(state.editPreview, preview)) {
      state.setEditPreview(preview);
    }
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
   * 線を引いている最中の拘束の自動推定(FR-333、P6 タスク41、§0.a-0.50)。
   * `pointermove` ごとに 1 回だけ呼ぶ。
   *
   * 予告するのは**始点を置いて終点を探している線**だけ(確定は「線を引き終えた瞬間」なので、
   * その 1 つ手前の段がここに当たる)。他の道具・他の段では相手が決まらないので予告しない。
   *
   * 終点は**押したときとまったく同じ決め方**(吸着 → 向きの吸着 → 作図面の上の点)にする
   * ため、`onPointerMove` が既に求めた候補をそのまま受け取る(同じ計算を 2 度しない、
   * NFR-PF-1)。近くの要素の絞り込みと判定は `inferredConstraints.ts` / model の純関数。
   *
   * `suspended` は Shift(§0.a-0.50「押している間は推定を止める」)。
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
      clearInferredConstraints();
      return;
    }
    const fromWorld = baseWorldPoint('lineEnd');
    const toWorld = snap?.position ?? track?.position ?? pointAt(pointer, null);
    if (fromWorld === null || toWorld === null) {
      clearInferredConstraints();
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
    if (!sameInferredPreview(state.inferredConstraints, next)) {
      state.setInferredConstraints(next);
    }
  }

  function onPointerMove(event: PointerEvent): void {
    const state = useAppStore.getState();
    const pointer = pointerPosition(event);

    if (sectionDrag !== null) {
      // 断面表示のつまみを引いている最中(FR-111)。掴む相手はもう決まっているので、
      // ホバーも当たり判定も吸着も通さず、切る位置だけを動かす。
      updateSectionDrag(pointer);
      return;
    }

    if (state.sketchDrag !== null) {
      /*
        引っぱっている最中(FR-313、タスク14)。ホバーも当たり判定も要らない
        (掴む相手はもう決まっている)ので、解き直しだけをコマごとに予約する。
      */
      scheduleDragSolve(pointer);
      return;
    }

    if (isCornerEditTool(state.activeTool)) {
      // 角の丸め・面取り(FR-323)。乗せた角に「丸めたあとの形」を薄く出すだけの道具なので、
      // 吸着も立体の当たり判定も通さない(トリム・延長と同じ扱い)。
      updateCornerPreview(state.activeTool, pointer);
      return;
    }

    if (isClickEditTool(state.activeTool)) {
      // トリム・延長は「乗せた区間を強調 → 押して消す/伸ばす」だけの道具なので、
      // 吸着も立体の当たり判定も通さない(§0.a-0.26)。
      updateEditPreview(state.activeTool, pointer);
      return;
    }

    if (skipsSketchElements(state.selectionKind)) {
      /*
        部分形状(面・辺・頂点)を拾う種類のときは、スケッチ要素の当たり判定を飛ばして
        部分形状だけを拾う(スケッチの面が立体の面より先に当たるのを防ぐ、§2.3.2、
        タスク30 不具合(c))。吸着も使わない。
      */
      const nextHovered = pickSubShapeAt(pointer);
      if (nextHovered !== state.hoveredElementId) {
        state.setHovered(nextHovered);
      }
      clearSnapIndicators();
      return;
    }

    if (state.activeTool === 'sphereGridPoint') {
      /*
        球面上の点(FR-431、タスク21・22)。案内線の交点に吸い付いた緯度・経度を段の欄へ
        入れ、押せば点になることを見せる(NFR-UX-5)。スケッチの要素の吸着も向きの吸着も
        通さない——狙っているのは球の上の交点だけなので、他の候補を混ぜると交点から
        引き離される。乗せている球そのものは強調して「どの球の上か」を示す。
      */
      updateSphereGridInput(pointer);
      const nextHovered = pickBodyAt(pointer);
      if (nextHovered !== state.hoveredElementId) {
        state.setHovered(nextHovered);
      }
      clearSnapIndicators();
      return;
    }

    const snap = findSnap(pointer);
    // 点に吸い付いていないときだけ向きを見る(§0.13 の優先順位)。
    const track = findTrack(pointer, snap);

    // 当たり判定(6 画素)から外れていても、吸着(12 画素)が拾った要素は強調して
    // 「どこへ吸い付くのか」を見せる(FR-106、FR-107)。
    // スケッチにも吸着にも当たらなかったときだけ、3D スケッチの頂点(タスク14)、
    // 続いて奥にある立体を拾う。頂点は既存の強調(setSubShapeHighlight)でそのまま光る。
    const picked = pickSketchElement(state.resolvedSketch, project, pointer);
    const nextHovered =
      picked !== null
        ? picked.elementId
        : (snap?.elementId ?? pickFreeVertexAt(pointer) ?? pickBodyAt(pointer));
    if (nextHovered !== state.hoveredElementId) {
      state.setHovered(nextHovered);
    }

    /*
      印は点の吸着と向きの吸着で同じものを使う(利用者から見れば「ここに置かれる」の印は
      1 種類。`SnapKind` に向きの 4 種を足してあるので、そのまま種別として渡せる)。
      案内線そのものは別に持つ(`trackIndicator`)。
    */
    const indicatorSource = snap ?? track?.candidates[0] ?? null;
    const indicatorPosition = snap?.position ?? track?.position ?? null;
    const nextIndicator: SnapIndicator | null =
      indicatorSource === null || indicatorPosition === null
        ? null
        : {
            // 画面の外へ出るほど傾いた面でも印を見失わないよう、写せなければ指の位置に置く。
            screen: project(indicatorPosition) ?? pointer,
            kind: indicatorSource.kind,
            // 向きの候補は「どの要素から来たか」だけを持つ(極は要素を持たないので null)。
            elementId: 'elementId' in indicatorSource
              ? indicatorSource.elementId
              : indicatorSource.sourceFeatureId,
          };
    if (!sameIndicator(state.snapIndicator, nextIndicator)) {
      state.setSnapIndicator(nextIndicator);
    }
    const nextTrack = track === null ? null : track.candidates;
    if (!sameTrack(state.trackIndicator, nextTrack)) {
      state.setTrackIndicator(nextTrack);
    }

    // 拘束の自動推定の予告(FR-333、タスク41)。Shift を押している間は止める(§0.a-0.50)。
    updateInferredConstraints(pointer, event.shiftKey, snap, track);
  }

  /** 離したら引っぱりを確定する(FR-313、タスク14)。掴んでいなければ何もしない。 */
  function onPointerUp(event: PointerEvent): void {
    if (sectionDrag !== null) {
      // 断面表示のつまみを離した(FR-111)。切る位置はもうストアに入っているので、
      // 掴んでいた控えを落とすだけ。文書は 1 バイトも変わっていない。
      sectionDrag = null;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      return;
    }
    if (useAppStore.getState().sketchDrag === null) {
      return;
    }
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    finishDrag();
  }

  function onPointerLeave(): void {
    const state = useAppStore.getState();
    if (sectionDrag !== null) {
      // つまみを引いている最中はポインタを捕まえてあるので、画面の外へ出ても続ける。
      return;
    }
    if (state.sketchDrag !== null) {
      // 引っぱっている最中は、ポインタを捕まえてあるので画面の外へ出ても続ける。
      return;
    }
    if (state.hoveredElementId !== null) {
      state.setHovered(null);
    }
    clearSnapIndicators();
    // 画面から出たら「ここが消える」の赤も消す(タスク22)。
    if (state.editPreview !== null) {
      state.setEditPreview(null);
    }
  }

  /**
   * 選択の道具・面の道具・立体の道具・部分形状(面・辺・頂点)を選ぶ加工の道具。押した順が
   * 面の境界の順になり、立体を 2 つ選ぶ順が和・差・積の「もと」と「組み合わせる方」になる
   * (FR-106、FR-309、§0.a-0.6)。何も無いところを押したら選択を解く(足すときは解かない)。
   */
  function pickInto(pointer: readonly [number, number], accumulate: boolean): void {
    const state = useAppStore.getState();
    let elementId: string | null;
    if (skipsSketchElements(state.selectionKind)) {
      /*
        部分形状(面・辺・頂点)を拾う種類のときは、スケッチ要素の当たり判定を飛ばして
        部分形状だけを拾う(スケッチの面が立体の面より先に当たるのを防ぐ、§2.3.2、
        タスク30 不具合(c))。
      */
      elementId = pickSubShapeAt(pointer);
    } else {
      // 選択の種類が body のときは従来の順序(要素 → 吸着 → 立体、P1・P2 のまま)。
      const picked = pickSketchElement(state.resolvedSketch, project, pointer);
      elementId = picked !== null ? picked.elementId : pickBodyAt(pointer);
    }
    if (elementId === null) {
      if (!accumulate) {
        state.setSelection([]);
        state.setPickAnchor(null);
      }
      return;
    }
    // 選んだ場所を覚えておき、立体の道具のその場入力をその近くへ出す(NFR-UX-2)。
    state.setPickAnchor(pointer);
    if (accumulate) {
      state.toggleSelection(elementId);
    } else {
      state.setSelection([elementId]);
    }
  }

  /**
   * 拘束の道具でビューポートを押したとき(FR-313、P4b タスク13)。
   *
   * 拘束の道具は**トリム・延長と同じ流儀**(道具を選んでから要素を順に押す。統括の決定
   * 2026-09-05)。押した相手は `constraintPicking.ts` が決め、**端点・中心を先に見る**ので
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
   * **描画・当たり判定・選択の 3 つをそろえる**(P4 タスク12 の失敗の再発防止)ため、
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

  /* ---------------------------------------------------------------- *
   * 引っぱって形を変える(FR-313、計画書タスク14)
   * ---------------------------------------------------------------- */

  /**
   * 引っぱっている間の作図面。**押した瞬間に 1 度だけ決めて、離すまで変えない。**
   * 面の決め方は model(`solveSketch.ts` の `sketchWorkPlane`)と同じ 1 か所
   * (`constraintContextOfStore`)から取るので、規約が 2 通りに割れない。
   */
  let dragPlane: WorkPlane | null = null;
  /** 引っぱりの解き直しを 1 コマ 1 回にまとめる(NFR-PF-1)。0 なら予約が無い。 */
  let dragFrameId = 0;
  /** そのコマで最後に届いたポインタの位置。動かすたびに解かず、最後の 1 つだけ解く。 */
  let dragPointer: readonly [number, number] | null = null;
  /** 最後に解けた座標(離したときに文書へ書き戻すもと)。 */
  let dragSolution: ReadonlyMap<string, Vec3> | null = null;
  /**
   * 掴んだ場所に重なっていた拘束の印(タスク13)。**動かさずに離したら、その印を選ぶ。**
   *
   * 距離拘束の印は指し先の点そのものの上に出る(`constraintSummary.ts` の `anchorsOf`)ので、
   * 印を先に見ると端点をいつまでも掴めない。逆に掴みを先にすると印を押せない。
   * どちらかを捨てずに済むよう、**押した時点では掴み、離した時点で「動いたか」で決める**
   * (動いた = 引っぱり、動いていない = 印を押した)。
   */
  let dragMarkId: string | null = null;

  /** 引っぱっている面の上での、ポインタの (u, v)。面から外れていれば null。 */
  function dragPointerUv(pointer: readonly [number, number]): readonly [number, number] | null {
    if (dragPlane === null) {
      return null;
    }
    const world = scene.screenToPlanePoint(pointer[0], pointer[1], dragPlane);
    return world === null ? null : worldToPlane(dragPlane, world);
  }

  /**
   * 引っぱっている間の点の吸着(FR-107)。**案内線(向きの吸着)は出さない**
   * (統括の決定 2026-09-05。引いている線が無いので極や延長線の起点が決まらず、
   * 画面を賑やかにするだけになる)。
   *
   * **引っぱっている要素そのものから来た候補は外す。** 線分の終点を引くときに自分の始点へ
   * 吸い付くと、長さ 0 の線分ができてしまう(P4 タスク14 の失敗と同じ壊れ方)。
   */
  function dragSnapAt(
    pointer: readonly [number, number],
    featureId: string,
  ): SnapCandidate | null {
    const state = useAppStore.getState();
    if (!state.snapEnabled || dragPlane === null) {
      return null;
    }
    const onPlane = scene.screenToPlanePoint(pointer[0], pointer[1], dragPlane);
    const candidates = collectSnapCandidates(
      state.resolvedSketch,
      dragPlane,
      gridSpacing(getOrbit().distance),
      onPlane,
    ).filter((candidate) => candidate.featureId !== featureId);
    return chooseSnap(candidates, project, pointer, SNAP_RADIUS_PIXELS, new Set(state.snapKinds));
  }

  /** 引っぱりを片付ける。予約したコマも捨てる。 */
  function stopDrag(keepShape: boolean): void {
    if (dragFrameId !== 0) {
      globalThis.cancelAnimationFrame(dragFrameId);
      dragFrameId = 0;
    }
    dragPointer = null;
    dragPlane = null;
    dragSolution = null;
    dragMarkId = null;
    useAppStore.getState().endSketchDrag(keepShape);
    clearSnapIndicators();
  }

  /**
   * 1 コマぶんの解き直し。**文書は変えず**、解いた形を表示専用の控えへ置く
   * (`dragResolved`)。拘束が 0 個のスケッチでは model が連立を解かずに点を置くだけなので、
   * 拘束を使わない文書の手触りは落ちない(§2.2)。
   */
  function solveDragAt(pointer: readonly [number, number]): void {
    const state = useAppStore.getState();
    const drag = state.sketchDrag;
    if (drag === null) {
      return;
    }
    const snap = dragSnapAt(pointer, drag.featureId);
    const pointerUv = dragPointerUv(pointer);
    const target =
      snap !== null && dragPlane !== null
        ? worldToPlane(dragPlane, snap.position)
        : pointerUv === null
          ? null
          : dragTargetUv(drag, pointerUv);
    if (target === null) {
      return;
    }
    // 吸い付いている先の印だけを出す(案内線は出さない)。
    const nextIndicator: SnapIndicator | null =
      snap === null
        ? null
        : { screen: project(snap.position) ?? pointer, kind: snap.kind, elementId: snap.elementId };
    if (!sameIndicator(state.snapIndicator, nextIndicator)) {
      state.setSnapIndicator(nextIndicator);
    }
    const solved = solveWithDrag(state.sketch, drag, target, constraintResolveOptions(state));
    dragSolution = solved.solution;
    useAppStore.getState().setDragResolved(solved.resolved);
  }

  /** 動かすたびではなく、コマごとに最後の位置だけを解く(§2.9 の落とし穴)。 */
  function scheduleDragSolve(pointer: readonly [number, number]): void {
    dragPointer = pointer;
    if (dragFrameId !== 0) {
      return;
    }
    dragFrameId = globalThis.requestAnimationFrame(() => {
      dragFrameId = 0;
      const at = dragPointer;
      dragPointer = null;
      if (at !== null) {
        solveDragAt(at);
      }
    });
  }

  /**
   * 押した場所の点を掴む(FR-313)。掴めたら true。
   *
   * 掴む相手は**端点・中心(12 画素)と点フィーチャー**で、判定は拘束の道具と同じ
   * `constraintPicking.ts` の 1 か所を使う(同じ「点を狙う」判定を 2 つ作らない)。
   * 引っぱれない点(式・固定・導かれる点)は掴まず、理由を帯へ出してから通常の選択へ落とす
   * (押したのに何も起きない、を作らない。P4 タスク12 の失敗)。
   */
  function beginDragAt(pointer: readonly [number, number]): boolean {
    const state = useAppStore.getState();
    const context = constraintContextOfStore(state);
    const vertex = vertexAt(state.resolvedSketch, project, pointer);
    const picked = vertex === null ? pickSketchElement(state.resolvedSketch, project, pointer) : null;
    if (vertex === null && (picked === null || picked.kind !== 'point')) {
      // 点でも端点でもない(線の途中・面・何も無いところ)。掴まない。
      return false;
    }
    if (context.variableSet === null || context.plane === null) {
      // 3D スケッチ(作図面が無い)。理由を出して掴まない(§0.a-0.3)。
      state.setDragRefusal(dragRefusalMessageKey('freeSketch'));
      return false;
    }
    dragPlane = context.plane;
    const grabWorld = scene.screenToPlanePoint(pointer[0], pointer[1], context.plane);
    if (grabWorld === null) {
      dragPlane = null;
      return false;
    }
    const target: ConstraintTarget =
      vertex !== null
        ? { kind: 'vertex', featureId: vertex.featureId, vertex: vertex.vertex }
        : { kind: 'point', pointId: picked?.elementId ?? '' };
    const outcome = draggableAt(
      state.sketch,
      context.variableSet,
      target,
      worldToPlane(context.plane, grabWorld),
    );
    if (outcome === null) {
      dragPlane = null;
      return false;
    }
    if (!isDraggable(outcome)) {
      dragPlane = null;
      state.setDragRefusal(dragRefusalMessageKey(outcome.reason));
      return false;
    }
    state.beginSketchDrag(outcome);
    // 同じところに拘束の印が重なっていたら覚えておく(動かさずに離したらそちらを選ぶ)。
    dragMarkId = constraintMarkAt(constraintMarksOf(state.constraintSummaries), project, pointer);
    // 掴んだ要素は選択にも入れて 3D で光らせる(何を掴んだかが見えるように、NFR-UX-7)。
    state.setSelection([outcome.featureId]);
    state.setPickAnchor(pointer);
    return true;
  }

  /**
   * 離したときの確定(§0.a-0.4)。**引っぱった点の座標だけ**を書き換えて取り消し 1 段。
   * 1 度も動かしていなければ(掴んだだけ)文書は変えない。
   */
  function finishDrag(): void {
    const state = useAppStore.getState();
    const drag = state.sketchDrag;
    if (drag === null) {
      return;
    }
    if (state.dragResolved === null) {
      // 掴んだだけで動かしていない。押しただけで履歴が伸びないようにする。
      const markId = dragMarkId;
      stopDrag(false);
      if (markId !== null) {
        // 印の上を押して離しただけ = 印を押したということ(タスク13 の「押したら選ばれる」)。
        useAppStore.getState().setSelectedConstraint(markId);
      }
      return;
    }
    const solution = dragSolution;
    if (solution === null) {
      stopDrag(false);
      return;
    }
    /*
      書き戻しは**保存されている指定方法のまま**行う(統括の決定 2026-09-05、案 A。
      P4b タスク22b)。相対・極の基準の位置は「引っぱった後の形」(`dragResolved`)から
      読み、角度の基準は掴んだときの作図面(`dragPlane`)を使う。
    */
    const next = commitDrag(state.sketch, drag, solution, state.dragResolved, dragPlane);
    // 離した形は次の再計算が届くまで残す(元の形へ一瞬戻ってちらつかないように)。
    stopDrag(true);
    if (next !== state.sketch) {
      useAppStore.getState().setSketch(next);
    }
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
      P4 の新しい図形(矩形の対角・長穴の 2 つ目の中心・2 点+半径の円弧の 2 点目・
      スプラインの 2 点目以降)は、**まだ履歴に無い「いま置いた点」**が基準になる
      (タスク12)。置いた点の並びをそのまま解けば、確定したフィーチャーを resolveSketch が
      解くときと同じ位置になるので、押した場所が欄へ正しいずれとして入る。
    */
    const placed = state.shapeDraft.points;
    if (placed.length > 0) {
      // 任意の作業平面(FR-328)の上の点も解けるよう、解いた面も渡す(タスク13 の申し送り)。
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
    state.openNumericInput(filled, pointer);
  }

  /**
   * 3D スケッチで立体の頂点を押したときに、点を 1 つ作る(FR-330、計画書タスク14)。
   *
   * **点の道具**は押した瞬間に確定する(その場数値入力は開かない。計画書タスク14 の
   * 「もう 1 つの点の作り方」)。**線分・円弧・スプライン**の道具では、いま聞いている
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

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== LEFT_BUTTON || event.altKey) {
      return;
    }
    const state = useAppStore.getState();
    if (state.commandLineFocused) {
      /*
        コマンドラインの欄(FR-208、P4b タスク18)に焦点があるあいだの押下は、
        **欄から出るための押下**として当たり判定を飛ばす。ここで下の各枝へ流すと、
        どの枝も `event.preventDefault()` で既定の動作を止めて開いている欄から焦点を
        奪わないようにしている(NFR-UX-2)ため、押しても焦点がコマンドラインに残ったままになり、
        続けて打った文字が 3D の表示ではなくコマンドラインへ入り続けてしまう。
        ここで何もせずに返せば、既定の動作で canvas が焦点を受け取り、欄の焦点が外れる。
      */
      return;
    }
    const pointer = pointerPosition(event);
    const tool = state.activeTool;

    if (state.activeConstraintKind !== null) {
      /*
        拘束の道具(FR-313、タスク13)。押した要素・端点を順に受け取り、必要な数がそろったら
        拘束が付く。焦点は canvas に残して、続けて何か所でも押せて Esc で終われるようにする
        (トリム・延長と同じ、NFR-UX-7)。
      */
      event.preventDefault();
      pickConstraintAt(pointer);
      return;
    }

    if (beginSectionDragAt(pointer)) {
      /*
        断面表示のつまみ(FR-111、§0.42)。**道具に関わらず掴める**——断面表示は「いま何を
        しているか」と無関係に中を見るための表示で、切る位置を直すのに道具を選び直させる
        のは筋が悪い(NFR-UX-1)。掴めるのは矢印の根もとの 18px だけなので、ほかの操作を
        奪わない(掴めなければそのまま下の枝へ落ちる)。

        ポインタを捕まえて、canvas の外へ出ても離すまで追い続ける(引っぱりと同じ)。
      */
      canvas.setPointerCapture(event.pointerId);
      return;
    }

    if (
      tool === 'select' &&
      !event.shiftKey &&
      !skipsSketchElements(state.selectionKind) &&
      beginDragAt(pointer)
    ) {
      /*
        点・端点・中心を掴んで引っぱる(FR-313、タスク14)。順は §0.a 追記 5 の
        「①拘束の道具 → ②印の当たり判定 → ③従来」を守りつつ、**掴めるときだけ②より先**に
        置く。理由: 距離拘束の印は指し先の点そのものの上に出る(`constraintSummary.ts` の
        `anchorsOf`)ので、印を必ず先に見ると端点をいつまでも掴めない。掴んでおいて
        **動かさずに離したら印を選ぶ**(`finishDrag`)ので、印の「押したら選ばれる」も
        そのまま生きている。掴めなかったときは下の②へ落ちる。

        Shift を押しているときは「選択に足す」操作なので掴まない。選ぶものの種類が
        立体の面・辺・頂点のときは、そもそもスケッチ要素を拾わない(§2.3.2)。

        ポインタを捕まえて、canvas の外へ出ても離すまで追い続ける。既定の動作は止めない
        (canvas に焦点が移り、Esc が効くようにする)。
      */
      canvas.setPointerCapture(event.pointerId);
      return;
    }

    if (tool === 'select' && pickConstraintMark(pointer)) {
      // 拘束の印を押した。要素の選択は変えずに、その拘束を一覧で選ぶだけにする。
      return;
    }

    if (tool === 'select' || tool === 'face') {
      // 面の道具では 1 つずつ足していく。選択の道具は Shift を押したときだけ足す。
      // 選択の種類(selectionKind)がどうであっても、この2つの道具の振る舞いは変えない
      // (P1・P2 のまま。手動で部分形状の種類へ切り替えていても面の境界の順が壊れないように、
      // この判定を選択の種類より先に置く)。
      pickInto(pointer, tool === 'face' || event.shiftKey);
      return;
    }

    if (isClickEditTool(tool)) {
      /*
        トリム・延長(FR-322、§0.a-0.26 の利用者の決定)。押した瞬間に決まる道具なので、
        選択もその場入力も挟まない。焦点は canvas に残して、続けて何か所でも押せて
        Esc で終われるようにする(NFR-UX-7)。
      */
      event.preventDefault();
      commitEditClick(tool, pointer);
      return;
    }

    if (isPickEditTool(tool)) {
      /*
        投影・断面(FR-325、タスク27)。押した立体の面・辺・立体そのものがそのまま
        取り込む相手になる。選択もその場入力も挟まず、押した瞬間に決まる。この判定を
        下の「部分形状を選ぶ道具」より先に置くのは、そちらへ流れると選ぶだけで
        終わってしまうため。
      */
      event.preventDefault();
      commitProjectionClick(tool, pointer);
      return;
    }

    if (isCornerEditTool(tool)) {
      /*
        角の丸め・面取り(FR-323、タスク23)。押した角の 2 本を選んで、その場で半径/距離を
        聞く。確定したあとも道具は残るので、続けて別の角を押せる(Esc で終わる)。
      */
      event.preventDefault();
      openCornerInput(tool, pointer);
      return;
    }

    if (isReferenceTool(tool)) {
      /*
        基準ジオメトリの道具(FR-328、FR-329、タスク13)。座標を聞いている段では押した場所を
        欄へ入れ(NFR-UX-1)、決め方の段では辺・面・頂点を選ぶ(選択の種類は道具を選んだ
        ときに `selectionKindForTool` が切り替えている)。開いている欄から焦点は奪わない。
      */
      event.preventDefault();
      const opened = state.numericInput;
      if (opened !== null && opened.toolId === tool && isReferenceCoordinateStep(opened.step)) {
        const world = pickedPointAt(pointer);
        if (world !== null) {
          state.openNumericInput(fillClickedPoint(opened, world), pointer);
          return;
        }
      }
      pickInto(pointer, event.shiftKey);
      return;
    }

    if (tool === 'sphereGridPoint') {
      /*
        球面上の点(FR-431、タスク22)。案内線の交点を押したらその場で点ができ、
        交点から外れたところを押したときは**球を選び直す**ふつうの選択になる
        (どの球の上に置くかを押し直せる)。開いている欄から焦点は奪わない。
      */
      event.preventDefault();
      if (!commitSphereGridClick(pointer)) {
        pickInto(pointer, event.shiftKey);
      }
      return;
    }

    if (picksBodies(tool) || picksSubShapes(state.selectionKind, tool)) {
      // 立体の道具(押し出し・回転・縫合、パターン・ばねの対象選び)と、部分形状(面・辺・頂点)を
      // 選ぶ加工の道具(穴・ねじ穴・R 面取り・C 面取り)では、入力欄を開いたまま対象を選び直せる。
      // 焦点は欄に残してそのまま Enter で決められるようにする(NFR-UX-2)。Shift で相手を足す
      // (§0.a-0.6)。
      //
      // 見るのを `isSolidTool` から `picksBodies` へ広げてある(P5 仕上げ (j))。外観・測るは
      // `SolidToolId` ではないので、選ぶものが「立体」のときこの枝に入れず、**押しても何も
      // 起きなかった**(下の「押した場所が座標にならない道具」で黙って返っていた)。
      // 選択・投影・断面は上の枝で先に返るので、条件を広げてもそれらの振る舞いは変わらない。
      event.preventDefault();
      pickInto(pointer, event.shiftKey);
      return;
    }

    // 既定の動作(canvas へ焦点を移す)を止めて、開いている欄から焦点を奪わない。
    // 押した場所の座標が欄へ入った直後に、そのまま Enter で決められるようにする(NFR-UX-2)。
    event.preventDefault();

    if (isFreeWorkPlaneId(state.workPlaneId) && isDrawingTool(tool)) {
      /*
        3D スケッチ(FR-330、タスク14)。立体の頂点を押したらその頂点を参照する点にし
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
      // 押した場所が座標にならない道具(オフセットのように既にある要素を選ぶ道具、
      // タスク21・22)は、ここでは何もしない。段の開き方はその道具の受け持ち。
      return;
    }
    openInputAt(tool, pointer);
  }

  /** 面を張る(FR-309)。断られたら理由を帯に出し、履歴は変えない(FR-504、NFR-UX-5)。 */
  function commitSelectedFace(): void {
    const state = useAppStore.getState();
    const outcome = commitFace(
      state.sketch,
      state.resolvedSketch,
      state.workPlaneId,
      state.selection,
    );
    if (!outcome.ok) {
      // 計算そのものの失敗とは分けて持つ。帯は「面を作れませんでした:」で出す(FR-504)。
      state.setFaceError(outcome.reasonKey);
      return;
    }
    state.setFaceError(null);
    state.setSketch(outcome.document);
    state.setSelection([]);
  }

  /**
   * canvas に焦点があるときだけ来る(ViewportCanvas の tabIndex={0})。
   * ポップアップの欄に焦点があるときは来ないので、そちらの Enter / Esc とぶつからない
   * (docs/報告記録.md 2026-09-02 15:42 の「Home キーは canvas に焦点があるときだけ」と同じ考え)。
   */
  function onKeyDown(event: KeyboardEvent): void {
    const state = useAppStore.getState();
    if (event.key === 'Shift') {
      /*
        拘束の自動推定の一時停止(FR-333、§0.a-0.50)。押した瞬間に予告を消す
        (マウスを動かすまで印が残っていると「止まっていない」と見える)。離したときは
        次にマウスを動かした時点で戻る——予告はもともとマウスの動きに付く表示なので、
        キーを離しただけで印が湧いて出るほうが不自然だから。**他のキーの処理は続ける**
        ので、ここでは返さない(Shift 併用の操作を横取りしない)。
      */
      clearInferredConstraints();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (state.sketchDrag !== null) {
        /*
          引っぱりの取り消し(FR-313、タスク14、NFR-UX-3)。文書は 1 度も変えていないので、
          仮の形を捨てるだけで押す前の形へ戻る。選択も取りかけも巻き込まないよう、
          ここで返して他の Esc の後始末はしない。
        */
        stopDrag(false);
        return;
      }
      state.setSelection([]);
      state.setPendingStart(null);
      state.closeNumericInput();
      if (state.activeConstraintKind !== null) {
        // 拘束の道具(FR-313、タスク13)も Esc で終わる(トリム・延長と同じ)。
        cancelConstraintTool();
        return;
      }
      // 拘束の印を選んでいたら解く(選択を解くのと同じ Esc の一手で、NFR-UX-1)。
      if (state.selectedConstraintId !== null) {
        state.setSelectedConstraint(null);
      }
      if (
        isClickEditTool(state.activeTool) ||
        isCornerEditTool(state.activeTool) ||
        isPickEditTool(state.activeTool)
      ) {
        // トリム・延長(§0.a-0.26)、角の丸め・面取り(FR-323)、投影・断面(FR-325)は
        // Esc で終わり、選択の道具へ戻る。予告は `setActiveTool` が落とす。
        state.setActiveTool('select');
      }
      return;
    }
    if (event.key === 'Enter' && state.activeTool === 'face') {
      event.preventDefault();
      commitSelectedFace();
    }
  }

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerdown', onPointerDown);
  // 引っぱりの確定(FR-313、タスク14)。取り消し(pointercancel)も同じ後始末にする。
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('keydown', onKeyDown);

  /*
   * ビューポートへ焦点を戻す要求(ツールバーで面や選択を選んだ直後)。canvas を持っているのは
   * ここだけなので、要求の数が増えたら焦点を移す。これで Enter がそのまま効く(NFR-UX-4)。
   */
  const unsubscribe = useAppStore.subscribe((next, previous) => {
    if (next.focusViewportRequestCount !== previous.focusViewportRequestCount) {
      canvas.focus();
    }
  });

  return {
    detach(): void {
      unsubscribe();
      // 引っぱっている途中で外されても、予約したコマを残さない(タスク14)。
      if (dragFrameId !== 0) {
        globalThis.cancelAnimationFrame(dragFrameId);
        dragFrameId = 0;
      }
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('keydown', onKeyDown);
    },
  };
}
