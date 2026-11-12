/**
 * スケッチの操作で「押した場所がどの座標になるか」を決める責務(FR-107、FR-110、FR-302、FR-303、FR-328、FR-330)。
 *
 * 作図面の決め方、点の吸着 → 向きの吸着 → 作図面の上の点の順、次の要素の基準点、押した場所を欄の
 * 指定方法(絶対・相対・極)へ詰め替えることをここに置く。読むのはストアだけで、文書もストアも変えない。
 * 押したときとマウスを動かしたときで同じ順序になるよう、決め方はこの 1 か所にまとめる。
 */
import {
  baseWorkPlane,
  curveEnd,
  curveStart,
  DEFAULT_WORK_PLANE_ID,
  dotVec3,
  isFreeWorkPlaneId,
  lengthVec3,
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
  type Vec3,
  type WorkPlane,
} from '@pointercad/model';

import { freeClickPlane } from '../sketch/freeSketch.js';
import {
  DEFAULT_COORDINATE_BASE,
  isCoordinateStep,
  reduceNumericInput,
  type NumericInputState,
  type NumericInputStep,
  type NumericInputToolId,
} from '../sketch/numericInput.js';
import { resolveShapePoints } from '../sketch/shapeCommands.js';
import {
  chooseSnap,
  collectSnapCandidates,
  enabledTrackKinds,
  SNAP_RADIUS_PIXELS,
  type ProjectToScreen,
  type SnapCandidate,
} from '../sketch/snapMath.js';
import { chooseTrack, collectTrackCandidates, type TrackResult } from '../sketch/trackMath.js';
import { useAppStore } from '../store/useAppStore.js';
import { viewDirection, type OrbitState } from './cameraMath.js';
import type { ViewportScene } from './createViewportScene.js';
import { gridSpacing } from './gridMath.js';

type Pointer = readonly [number, number];

/** 基準点を引くだけの問い合わせに使う名前。失敗の理由は捨てるので画面には出ない。 */
const BASE_PROBE_ID = 'numericInput';

interface SketchCoordinateContext {
  readonly scene: ViewportScene;
  readonly project: ProjectToScreen;
  readonly getOrbit: () => OrbitState;
  /** 向きの吸着(案内線)を効かせる道具か。押した場所が座標そのものになる道具だけが真。 */
  readonly tracksDirection: (tool: NumericInputToolId) => boolean;
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

/**
 * 極座標の欄の値。`polarOffset`(planeMath.ts)の逆算で、角度は第1軸から第2軸へ向かう向きが正、
 * 仰角は作図面から法線の側へ向かう向きが正。
 */
function polarValues(offset: Vec3, plane: WorkPlane): readonly [number, number, number] {
  const alongU = dotVec3(offset, plane.axisU);
  const alongV = dotVec3(offset, plane.axisV);
  const alongNormal = dotVec3(offset, plane.normal);
  return [
    lengthVec3(offset),
    radiansToDegrees(Math.atan2(alongV, alongU)),
    radiansToDegrees(Math.atan2(alongNormal, Math.hypot(alongU, alongV))),
  ];
}

/** 1 つの canvas の座標の決め方。返す関数はどれも呼ばれた時点のストアを読む。 */
export function createSketchCoordinates(context: SketchCoordinateContext) {
  const { scene, project, getOrbit, tracksDirection } = context;

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
  function findSnap(pointer: Pointer, sketch?: ResolvedSketch): SnapCandidate | null {
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
  function pointAt(pointer: Pointer, snap: SnapCandidate | null): Vec3 | null {
    if (snap !== null) {
      return snap.position;
    }
    const plane = interactionPlane(useAppStore.getState().workPlaneId);
    return scene.screenToPlanePoint(pointer[0], pointer[1], plane);
  }

  /**
   * いま合っている向き(FR-110)。点の吸着(`snap`)が採れているときは**そちらが優先**
   * なので何も返さない(点は 1 点に決まるが向きは線なので、点を先に採る)。
   * 吸着そのものが切、または向きの種別が 1 つも効いていないときも返さない(FR-107 と揃える)。
   */
  function findTrack(pointer: Pointer, snap: SnapCandidate | null): TrackResult | null {
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
      視点が斜めだと、作図面上のポインタ点への垂直射影(光線を渡さないときの後退先)では
      画面上の最近点とずれ、案内線の印がポインタから遠くに決まってしまうため
      (`trackMath.ts` の `closestParameterToRay` の注釈)。
    */
    const ray = scene.pointerRay(pointer[0], pointer[1]);
    return chooseTrack(candidates, project, pointer, SNAP_RADIUS_PIXELS, onPlane, ray);
  }

  /**
   * 押した場所の座標(FR-107、FR-110)。点の吸着 → 向きの吸着 → 作図面の上の点、の順で決める。
   * 押したときとマウスを動かしたときで同じ順序になるよう、決め方はここ 1 か所に置く。
   */
  function pickedPointAt(pointer: Pointer): Vec3 | null {
    const snap = findSnap(pointer);
    if (snap !== null) {
      return snap.position;
    }
    const track = findTrack(pointer, null);
    return track === null ? pointAt(pointer, null) : track.position;
  }

  /**
   * 押した場所の基準になる点(FR-302、FR-303)。
   *
   * 線分の終点だけは自分の始点が基準で、それ以外は「直前の点」。
   * 決められなければ null を返し、呼び出し側が絶対座標へ切り替える。
   */
  function baseWorldPoint(step: NumericInputStep): Vec3 | null {
    const state = useAppStore.getState();
    const resolveContext: ResolveContext = {
      plane: interactionPlane(state.workPlaneId),
      points: state.resolvedSketch.points,
      previous: lastCreatedPoint(state.sketch, state.resolvedSketch),
      vertices: collectVertices(state.resolvedSketch),
    };
    if (step === 'lineEnd') {
      if (state.pendingStart === null) {
        return null;
      }
      const start = resolveCoordinate(state.pendingStart, resolveContext, BASE_PROBE_ID);
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
      const positions = resolveShapePoints(state.sketch, state.workPlaneId, placed, resolveContext.plane);
      const last = positions?.[positions.length - 1];
      if (last !== undefined) {
        return last;
      }
    }
    const base = resolvePointReference(DEFAULT_COORDINATE_BASE, resolveContext, BASE_PROBE_ID);
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
    const plane = interactionPlane(useAppStore.getState().workPlaneId);
    return reduceNumericInput(input, { type: 'setValues', values: polarValues(offset, plane) });
  }

  return { interactionPlane, findSnap, pointAt, findTrack, pickedPointAt, baseWorldPoint, fillClickedPoint };
}
