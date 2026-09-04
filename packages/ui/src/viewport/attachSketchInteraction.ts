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

import {
  baseWorkPlane,
  curveEnd,
  curveStart,
  DEFAULT_WORK_PLANE_ID,
  dotVec3,
  lengthVec3,
  radiansToDegrees,
  resolveCoordinate,
  resolvePointReference,
  subVec3,
  vertexKey,
  WORK_PLANES,
  type ResolveContext,
  type ResolvedSketch,
  type SketchDocument,
  type Vec3,
  type WorkPlane,
} from '@pointercad/model';

import {
  createNumericInput,
  DEFAULT_COORDINATE_BASE,
  isCoordinateStep,
  reduceNumericInput,
  SHAPE_TOOL_STEPS,
  SOLID_TOOL_STEPS,
  type NumericInputState,
  type NumericInputStep,
  type NumericInputToolId,
  type ShapeToolId,
  type SketchToolId,
  type SolidToolId,
} from '../sketch/numericInput.js';
import { pickSketchElement } from '../sketch/pickMath.js';
import { commitFace } from '../sketch/sketchCommands.js';
import {
  chooseSnap,
  collectSnapCandidates,
  SNAP_RADIUS_PIXELS,
  type ProjectToScreen,
  type SnapCandidate,
} from '../sketch/snapMath.js';
import { pickSolidSubShape } from '../solid/pickSubShape.js';
import {
  subShapeElementId,
  type SelectionKind,
  type SubShapeBody,
} from '../solid/subShapeSelection.js';
import { useAppStore, type SnapIndicator } from '../store/useAppStore.js';
import type { SolidBodyWithSubShapes } from './buildSolidGeometry.js';
import type { ViewportScene } from './createViewportScene.js';
import { gridSpacing } from './gridMath.js';

const LEFT_BUTTON = 0;

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
 * 立体そのものをクリックで選べる道具かどうか(FR-106、§0.a-0.6)。
 *
 * 選択のときと、立体の道具(押し出し・回転・縫合、ブーリアンの相手選び、パターン・ばねの
 * 対象選び)のときに効かせる。面の道具は面の境界を順にクリックする道具なので、立体を拾うと
 * 選ぶ順が壊れる。かき込む道具(点・線分・円弧・点列)は押した場所が座標そのものなので拾わない。
 */
function picksBodies(tool: NumericInputToolId): boolean {
  return tool === 'select' || isSolidTool(tool);
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

export function attachSketchInteraction(
  canvas: HTMLCanvasElement,
  scene: ViewportScene,
  getCameraDistance: () => number,
): SketchInteraction {
  // メソッドをそのまま値として渡さない(@typescript-eslint/unbound-method)。
  const project: ProjectToScreen = (point) => scene.worldToScreen(point);

  function pointerPosition(event: PointerEvent): readonly [number, number] {
    const bounds = canvas.getBoundingClientRect();
    return [event.clientX - bounds.left, event.clientY - bounds.top];
  }

  /**
   * 操作に使う作図面。任意の作業平面(FR-328)は部品文書を見ないと決まらないので、
   * ここでは基準の 3 面だけを引き、それ以外は既定の XY に落とす
   * (任意平面の上で描く操作の配線はタスク13・33)。
   */
  function interactionPlane(planeId: string): WorkPlane {
    return baseWorkPlane(planeId) ?? WORK_PLANES[DEFAULT_WORK_PLANE_ID];
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
      gridSpacing(getCameraDistance()),
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
   * 押した場所にある立体の id(FR-106)。立体が 1 つも無いときは光線を飛ばさない。
   * スケッチの要素のほうが細くて狙いにくいので、**必ず要素を先に**当ててから呼ぶ
   * (小さいものを先に取る、P1 §2.8)。
   */
  function pickBodyAt(pointer: readonly [number, number]): string | null {
    const state = useAppStore.getState();
    if (state.bodies.length === 0 || !picksBodies(state.activeTool)) {
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
    if (selectionKind === 'face') {
      const hit = scene.pickFaceAt(pointer[0], pointer[1]);
      return hit === null ? null : subShapeElementId(hit.featureId, 'face', hit.faceIndex);
    }
    // ここまで来たら edge か vertex(pickSolidSubShape が要る SubShapeKind、頂点 > 辺の順)。
    const picked = pickSolidSubShape(toSubShapeBodies(bodies), project, pointer, selectionKind);
    return picked === null ? null : picked.elementId;
  }

  function onPointerMove(event: PointerEvent): void {
    const state = useAppStore.getState();
    const pointer = pointerPosition(event);

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
      if (state.snapIndicator !== null) {
        state.setSnapIndicator(null);
      }
      return;
    }

    const snap = findSnap(pointer);

    // 当たり判定(6 画素)から外れていても、吸着(12 画素)が拾った要素は強調して
    // 「どこへ吸い付くのか」を見せる(FR-106、FR-107)。
    // スケッチにも吸着にも当たらなかったときだけ、奥にある立体を拾う。
    const picked = pickSketchElement(state.resolvedSketch, project, pointer);
    const nextHovered =
      picked !== null ? picked.elementId : (snap?.elementId ?? pickBodyAt(pointer));
    if (nextHovered !== state.hoveredElementId) {
      state.setHovered(nextHovered);
    }

    const nextIndicator: SnapIndicator | null =
      snap === null
        ? null
        : {
            // 画面の外へ出るほど傾いた面でも印を見失わないよう、写せなければ指の位置に置く。
            screen: project(snap.position) ?? pointer,
            kind: snap.kind,
            elementId: snap.elementId,
          };
    if (!sameIndicator(state.snapIndicator, nextIndicator)) {
      state.setSnapIndicator(nextIndicator);
    }
  }

  function onPointerLeave(): void {
    const state = useAppStore.getState();
    if (state.hoveredElementId !== null) {
      state.setHovered(null);
    }
    if (state.snapIndicator !== null) {
      state.setSnapIndicator(null);
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
    const world = isCoordinateStep(current.step) ? pointAt(pointer, findSnap(pointer)) : null;
    const filled = world === null ? current : fillClickedPoint(current, world);
    state.openNumericInput(filled, pointer);
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== LEFT_BUTTON || event.altKey) {
      return;
    }
    const state = useAppStore.getState();
    const pointer = pointerPosition(event);
    const tool = state.activeTool;

    if (tool === 'select' || tool === 'face') {
      // 面の道具では 1 つずつ足していく。選択の道具は Shift を押したときだけ足す。
      // 選択の種類(selectionKind)がどうであっても、この2つの道具の振る舞いは変えない
      // (P1・P2 のまま。手動で部分形状の種類へ切り替えていても面の境界の順が壊れないように、
      // この判定を選択の種類より先に置く)。
      pickInto(pointer, tool === 'face' || event.shiftKey);
      return;
    }

    if (isSolidTool(tool) || picksSubShapes(state.selectionKind, tool)) {
      // 立体の道具(押し出し・回転・縫合、パターン・ばねの対象選び)と、部分形状(面・辺・頂点)を
      // 選ぶ加工の道具(穴・ねじ穴・R 面取り・C 面取り)では、入力欄を開いたまま対象を選び直せる。
      // 焦点は欄に残してそのまま Enter で決められるようにする(NFR-UX-2)。Shift で相手を足す
      // (§0.a-0.6)。
      event.preventDefault();
      pickInto(pointer, event.shiftKey);
      return;
    }

    // 既定の動作(canvas へ焦点を移す)を止めて、開いている欄から焦点を奪わない。
    // 押した場所の座標が欄へ入った直後に、そのまま Enter で決められるようにする(NFR-UX-2)。
    event.preventDefault();
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
    if (event.key === 'Escape') {
      event.preventDefault();
      state.setSelection([]);
      state.setPendingStart(null);
      state.closeNumericInput();
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
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('keydown', onKeyDown);
    },
  };
}
