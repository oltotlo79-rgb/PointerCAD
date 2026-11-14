/**
 * スケッチ 1 回の解決が育てる記録(結果の配列・引く表・直前の点)と、その記録への書き込み方。
 *
 * `resolveSketch` は履歴を先頭から順にたどり、フィーチャーごとの解き方(作図面の上で形が決まる
 * 図形は `resolveSketch.ts`、ほかの要素や外の計算から来る曲線は `resolveSketchDerived.ts`)へ渡す。
 * どの解き方も結果をここの関数で書き込むので、「解決できたものだけが以後の参照先になる」こと
 * (FR-504)と、端点・直前の点(FR-302)の決め方は 1 か所にそろう。
 */

import { curveEnd, curveStart } from './intersectionMath.js';
import type { WorkPlane, WorkPlaneId } from './planeMath.js';
import { vertexKey, type ResolveContext } from './resolveCoordinate.js';
import type {
  PendingOffset,
  PendingProjection,
  ResolvedArc,
  ResolvedCurve,
  ResolvedEllipse,
  ResolvedFace,
  ResolvedPoint,
  ResolvedSegment,
  ResolvedSketch,
  ResolvedSpline,
  SketchError,
  SketchErrorCode,
} from './types.js';
import type { Vec3 } from './vec3.js';

/** 1 回の解決の記録。解決の間だけ使い、結果の配列と `curvesByFeature` は戻り値へそのまま渡す。 */
export interface SketchResolveState {
  readonly points: ResolvedPoint[];
  readonly segments: ResolvedSegment[];
  readonly arcs: ResolvedArc[];
  readonly ellipses: ResolvedEllipse[];
  readonly splines: ResolvedSpline[];
  readonly faces: ResolvedFace[];
  readonly errors: SketchError[];
  readonly pendingOffsets: PendingOffset[];
  readonly pendingProjections: PendingProjection[];
  /** 端点・中心の手掛かり(`ResolveContext.vertices`)。鍵は `vertexKey`。 */
  readonly vertices: Map<string, Vec3>;
  /** 1 フィーチャー = 1 曲線の結果(線分・円弧・楕円・スプライン)。 */
  readonly curveByFeature: Map<string, ResolvedCurve>;
  readonly pointsByFeature: Map<string, readonly ResolvedPoint[]>;
  /**
   * 矩形・正多角形・長穴のように「1 フィーチャーが複数の曲線を生む」結果。
   * 既存の線分・円弧(1 フィーチャー = 1 曲線)は単数の curveByFeature のまま残す
   * (既存の呼び出し側を壊さないため)。
   */
  readonly curvesByFeature: Map<string, readonly ResolvedCurve[]>;
  /**
   * 構築線(FR-320)の featureId。線・円弧・矩形・正多角形・長穴・楕円・スプラインが
   * `construction: true` を持つときにここへ足す。`resolveFace` が面の境界に選ばれていないか
   * ここを見て断る(解決済みの曲線(`ResolvedCurve`)自体には construction を持たせない
   * ため、featureId で引く)。
   */
  readonly constructionFeatureIds: Set<string>;
  /** 「直前の点」(FR-302)。点を作ったフィーチャーと線・円弧の終点で更新する。 */
  previous: Vec3 | null;
}

/** 外から渡された引き口に、渡されなかったときの既定を入れた形。1 回の解決の間は変わらない。 */
export interface SketchResolveLookups {
  readonly workPlane: (planeId: WorkPlaneId) => WorkPlane | null;
  readonly offsetCurves: (key: string) => readonly ResolvedCurve[] | null;
  readonly projectedCurves: (featureId: string) => readonly ResolvedCurve[] | null;
  /** 渡されなければ undefined を返す(関数の再計算が済んでいない扱い)。 */
  readonly functionCurves: (featureId: string) => readonly ResolvedCurve[] | null | undefined;
  readonly pointOverrides: ReadonlyMap<string, Vec3> | undefined;
  readonly overridePoint: (key: string, value: Vec3) => Vec3;
  readonly overrideRadius: (key: string, value: number) => number;
}

/** 作図面の上の 1 フィーチャーを解くときに渡すもの。 */
export interface SketchFeatureStep {
  /** 作図面。3D スケッチ(FR-330)では null。 */
  readonly plane: WorkPlane | null;
  /** そのフィーチャーの座標を解く手掛かり。`previous` はそのフィーチャーを解き始めた時の直前の点。 */
  readonly context: ResolveContext;
  readonly state: SketchResolveState;
  readonly lookups: SketchResolveLookups;
}

export function createSketchResolveState(): SketchResolveState {
  return {
    points: [],
    segments: [],
    arcs: [],
    ellipses: [],
    splines: [],
    faces: [],
    errors: [],
    pendingOffsets: [],
    pendingProjections: [],
    vertices: new Map<string, Vec3>(),
    curveByFeature: new Map<string, ResolvedCurve>(),
    pointsByFeature: new Map<string, readonly ResolvedPoint[]>(),
    curvesByFeature: new Map<string, readonly ResolvedCurve[]>(),
    constructionFeatureIds: new Set<string>(),
    previous: null,
  };
}

export function sketchError(featureId: string, code: SketchErrorCode, message: string): SketchError {
  return { featureId, code, message };
}

/**
 * 3D スケッチ(作図面なし、FR-330)では作れない図形を断る。
 *
 * 3D スケッチで作れるのは点・線分・円弧・スプライン・面の 5 つ(要件 FR-330)。
 * 矩形・正多角形・長穴・楕円・点列は「作図面の中の並び」で形が決まる図形なので、
 * 平面が無いと形自体が定まらない。作図面を選び直せば作れるので、そう伝える。
 */
export function needsWorkPlane(featureId: string, label: string): SketchError {
  return sketchError(
    featureId,
    'missingBase',
    `3D スケッチでは${label}を作れません。作図面を選んでから作ってください。`,
  );
}

/** 構築線(FR-320)なら印を付ける。面の境界に選ばれたときに断るため。 */
export function markConstruction(
  state: SketchResolveState,
  featureId: string,
  construction: boolean,
): void {
  if (construction) {
    state.constructionFeatureIds.add(featureId);
  }
}

/**
 * 点を作ったフィーチャー(点・点列・点の複製)の結果を記録する。
 * 最初の点を始点、最後の点を終点と「直前の点」にする。
 */
export function recordPoints(
  state: SketchResolveState,
  featureId: string,
  created: readonly ResolvedPoint[],
): void {
  state.points.push(...created);
  state.pointsByFeature.set(featureId, created);
  const last = created[created.length - 1];
  state.vertices.set(vertexKey(featureId, 'start'), created[0].position);
  state.vertices.set(vertexKey(featureId, 'end'), last.position);
  state.previous = last.position;
}

/**
 * 1 フィーチャー = 1 曲線の結果(線分・円弧・楕円・スプライン)を記録する。
 * 曲線の始点・終点を端点の手掛かりにし、終点を「直前の点」にする(FR-307 の連続描画)。
 */
export function recordCurve(
  state: SketchResolveState,
  featureId: string,
  construction: boolean,
  curve: ResolvedCurve,
): void {
  pushCurvesByKind(state, [curve]);
  state.curveByFeature.set(featureId, curve);
  markConstruction(state, featureId, construction);
  state.vertices.set(vertexKey(featureId, 'start'), curveStart(curve));
  state.vertices.set(vertexKey(featureId, 'end'), curveEnd(curve));
  state.previous = curveEnd(curve);
}

/**
 * 1 フィーチャーが複数の曲線を生む結果(矩形・正多角形・長穴・オフセット・複製・関数・投影)を
 * 記録する。先頭の曲線の始点を始点、末尾の曲線の終点を終点と「直前の点」にする。
 */
export function recordCurveGroup(
  state: SketchResolveState,
  featureId: string,
  construction: boolean,
  curves: readonly ResolvedCurve[],
): void {
  pushCurvesByKind(state, curves);
  state.curvesByFeature.set(featureId, curves);
  markConstruction(state, featureId, construction);
  const first = curves[0];
  const last = curves[curves.length - 1];
  state.vertices.set(vertexKey(featureId, 'start'), curveStart(first));
  state.vertices.set(vertexKey(featureId, 'end'), curveEnd(last));
  state.previous = curveEnd(last);
}

/**
 * 解決済みの曲線を種類ごとの配列へ積む。矩形などの複数曲線フィーチャーも単体の線分・円弧と
 * 同じ配列に並ぶので、UI 側(pickMath.ts 等)は `sketch.segments` / `sketch.arcs` の走査を
 * そのまま使える。オフセットの結果は線分・円弧しか返らない(`makeOffsetWire.ts`)が、
 * 型の上では 4 種すべて来うるので全部を受ける。
 */
function pushCurvesByKind(state: SketchResolveState, curves: readonly ResolvedCurve[]): void {
  for (const curve of curves) {
    switch (curve.kind) {
      case 'segment':
        state.segments.push(curve);
        break;
      case 'arc':
        state.arcs.push(curve);
        break;
      case 'ellipse':
        state.ellipses.push(curve);
        break;
      case 'spline':
        state.splines.push(curve);
        break;
    }
  }
}

/** 記録から解決の結果を組み立てる。配列と `curvesByFeature` は記録の物をそのまま渡す。 */
export function sketchResultOf(state: SketchResolveState): ResolvedSketch {
  return {
    points: state.points,
    segments: state.segments,
    arcs: state.arcs,
    ellipses: state.ellipses,
    splines: state.splines,
    faces: state.faces,
    errors: state.errors,
    pendingOffsets: state.pendingOffsets,
    pendingProjections: state.pendingProjections,
    curvesByFeature: state.curvesByFeature,
  };
}
