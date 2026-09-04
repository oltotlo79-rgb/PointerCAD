/**
 * 拘束の変数の切り出しと自由度の数え方(FR-313、
 * 計画書 docs/plans/P4b-スケッチの仕上げ.md §2.2、タスク4)。
 *
 * ソルバーが動かしてよい数(変数)を、スケッチの解決結果から決め打ちの順で並べる。
 * **動かせるのは「作図面の上にある、数値リテラルで書かれた座標」と「数値リテラルの半径」だけ**
 * (§0.a-0.2)。式で書かれた座標を動かすと式を壊すか、式と値が食い違う(FR-202
 * 「式は文字列のまま保存され、元の式が再表示・再編集できる」)ので、式は定数として読む。
 *
 * 変数にしなかったものは理由つきで `frozen` に入れる。画面が「なぜこの点は動かないのか」を
 * 出せるようにするため(NFR-UX-7、タスク13)。
 *
 * ここは純関数だけを置く。乱数・時刻・`Map` の反復順に頼らず、同じ文書からは必ず同じ並びの
 * 変数を返す(決定性。§2.2「変数の並び順は履歴順 → start, end, center → u, v で決め打ち」)。
 */

import { isNumericLiteral, type ExpressionValue } from '@pointercad/expression';

import { curveEnd, curveStart, isFullCircle } from '../intersectionMath.js';
import {
  distanceToPlane,
  isFreeWorkPlaneId,
  worldToPlane,
  type WorkPlane,
} from '../planeMath.js';
import { vertexKey } from '../resolveCoordinate.js';
import type {
  CoordinateInput,
  ResolvedArc,
  ResolvedCurve,
  ResolvedEllipse,
  ResolvedPoint,
  ResolvedSegment,
  ResolvedSketch,
  ResolvedSpline,
  SketchDocument,
} from '../types.js';
import { SKETCH_TOLERANCE_MM, type Vec3 } from '../vec3.js';
import {
  constraintEquationCount,
  constraintTargets,
  sketchConstraints,
  type ConstraintTarget,
  type SketchConstraint,
} from './types.js';

/**
 * 変数の上限(§2.2)。超えたら解かずに断る(判定はタスク7。ここでは数え上げるだけ)。
 * 400 は点 200 個ぶんで、`JᵀJ` のガウス消去が 400³/3 ≒ 2.1×10⁷ 回になる大きさ。
 */
export const MAX_CONSTRAINT_VARIABLES = 400;

/** 半径の種類。円・円弧は 1 つ、楕円は長半径・短半径の 2 つを持つ(§2.2 の表)。 */
export type RadiusKind = 'radius' | 'major' | 'minor';

/** 変数にしなかった理由。 */
export type FrozenReason =
  /** 座標・半径が式で書かれている(§0.a-0.2)。 */
  | 'expression'
  /** 「固定」拘束が付いている。 */
  | 'fixed'
  /** 規則から導かれる(点列・複製・オフセット・投影の結果、円弧の端点、別の作図面の要素)。 */
  | 'derived';

/**
 * 1 つの変数。`pointKey` は `ResolvedPoint.id` / `vertexKey` と同じ規約
 * (点フィーチャーは `featureId`、n 番目の点は `featureId#n`、端点は `featureId:start` など)。
 */
export type ConstraintVariable =
  | { readonly kind: 'u' | 'v'; readonly pointKey: string }
  | {
      readonly kind: 'radius';
      readonly featureId: string;
      readonly radiusKind: RadiusKind;
    };

/**
 * 変数と定数を同じ鍵の空間で引けるようにする接尾辞。
 * 点は 1 つの鍵に (u, v) の 2 つの数がぶら下がるので、成分まで含めた鍵を作る。
 */
const RADIUS_SUFFIX: Readonly<Record<RadiusKind, string>> = {
  radius: '.r',
  major: '.rmajor',
  minor: '.rminor',
};

/** 点の成分の鍵(`line-1:start` の u なら `line-1:start.u`)。 */
export function pointComponentKey(pointKey: string, component: 'u' | 'v'): string {
  return `${pointKey}.${component}`;
}

/** 半径の鍵(円・円弧は `arc-1.r`、楕円は `ellipse-1.rmajor` / `.rminor`)。 */
export function radiusComponentKey(featureId: string, radiusKind: RadiusKind): string {
  return `${featureId}${RADIUS_SUFFIX[radiusKind]}`;
}

/** その変数の鍵。`VariableSet.index` と `constants` はこの鍵で引く。 */
export function variableComponentKey(variable: ConstraintVariable): string {
  return variable.kind === 'radius'
    ? radiusComponentKey(variable.featureId, variable.radiusKind)
    : pointComponentKey(variable.pointKey, variable.kind);
}

/** 点の鍵から、その点を作ったフィーチャーの id(`line-1:start` → `line-1`)。 */
export function featureIdOfPointKey(pointKey: string): string {
  const colon = pointKey.indexOf(':');
  const hash = pointKey.indexOf('#');
  if (colon < 0 && hash < 0) {
    return pointKey;
  }
  const separator = colon < 0 ? hash : hash < 0 ? colon : Math.min(colon, hash);
  return pointKey.slice(0, separator);
}

/**
 * 「円弧の端点は円周の上にある」という暗黙の式(|P − C| = r。統括の決定 2026-09-04)。
 *
 * 円弧の端点を変数にした代わりに、円弧 1 本につき 2 本(始点・終点)を必ず立てる。
 * 利用者が付けた拘束ではないので `SketchDocument.constraints` には現れず、
 * 自由度の数え上げ(`countDegreesOfFreedom`)と残差の組み立て(タスク5)がここを見る。
 * 半径の鍵は円弧なので必ず `radiusComponentKey(featureId, 'radius')`。
 */
export interface ImplicitCircleEquation {
  readonly featureId: string;
  /** 円周の上にある端点の鍵。 */
  readonly pointKey: string;
  /** 中心の点の鍵。 */
  readonly centerKey: string;
}

export interface VariableSet {
  /** 決め打ちの順(履歴順 → start / end / center → u, v)。ソルバーの列の順でもある。 */
  readonly variables: readonly ConstraintVariable[];
  /** 初期値(拘束を無視した解決から取る)。`variables` と同じ並び。 */
  readonly initial: readonly number[];
  /**
   * 変数の鍵 → 列の番号(`variables` / `initial` の添字)。残差の計算(タスク5)が
   * 「この点の u は何列目か」を引くための対応表。
   */
  readonly index: ReadonlyMap<string, number>;
  /** 変数にしなかった点/半径と、その理由。画面が「なぜ動かないか」を出すのに使う。 */
  readonly frozen: ReadonlyMap<string, FrozenReason>;
  /** 変数でない点/半径の作図面上の値(残差が定数として読む)。鍵は変数と同じ空間。 */
  readonly constants: ReadonlyMap<string, number>;
  /**
   * 同じ点を指す別名 → 正本の鍵。`spline-1:start` は `spline-1#0` と同じ点、
   * 点フィーチャーの `point-1:start` は `point-1` と同じ点。
   * 別名ごとに変数を作ると 1 つの点が 2 回動いてしまうので、正本へ寄せてから引く。
   */
  readonly aliases: ReadonlyMap<string, string>;
  /** 形が決まった要素のフィーチャー id。拘束の材料が在るかの判定に使う(FR-504)。 */
  readonly elementFeatureIds: ReadonlySet<string>;
  /**
   * 円弧の端点が円周の上にあるという暗黙の式。**変数を 1 つも含まない式は入れない**
   * (すべて定数の円弧に式を数えると、動かせないのに「拘束が多すぎる」と出てしまう)。
   */
  readonly implicit: readonly ImplicitCircleEquation[];
}

/** 座標が「数値リテラルだけで書かれた絶対座標」か(§0.a-0.2)。 */
function isLiteralCoordinate(input: CoordinateInput): boolean {
  return (
    input.mode === 'absolute' &&
    isNumericLiteral(input.x.source) &&
    isNumericLiteral(input.y.source) &&
    isNumericLiteral(input.z.source)
  );
}

/** 組み立て中の 1 つの数(点の成分 2 つ、または半径 1 つ)。 */
interface Slot {
  readonly variable: ConstraintVariable;
  readonly value: number;
  /** 変数にしない理由。null なら変数の候補(「固定」拘束の判定はこの後)。 */
  readonly reason: FrozenReason | null;
  /** 理由を記録するときの鍵(点なら点の鍵、半径なら半径の鍵)。 */
  readonly frozenKey: string;
}

/** 組み立ての途中の状態。関数の間で持ち回る。 */
interface Builder {
  readonly plane: WorkPlane;
  readonly slots: Slot[];
  readonly aliases: Map<string, string>;
  readonly elementFeatureIds: Set<string>;
  /** フィーチャー id → そのフィーチャーが持つ点/半径の鍵(「固定」を要素ごと掛けるのに使う)。 */
  readonly keysByFeature: Map<string, string[]>;
}

/**
 * 作図面の上に無い点は (u, v) では表せないので定数として読む。「作図面の上」は
 * 作図面の id が一致し、かつ平面までの距離が許容誤差以内であることまで見る
 * (同じ作図面を指していても、Z を手で打って面から浮かせた点は動かせない)。
 */
function onPlaneReason(plane: WorkPlane, onPlane: boolean, world: Vec3): FrozenReason | null {
  return !onPlane || distanceToPlane(plane, world) > SKETCH_TOLERANCE_MM ? 'derived' : null;
}

/** 保存された座標を変数にしてよいか。 */
function coordinateReason(
  plane: WorkPlane,
  onPlane: boolean,
  world: Vec3,
  input: CoordinateInput | null,
): FrozenReason | null {
  if (input === null) {
    return 'derived';
  }
  if (onPlaneReason(plane, onPlane, world) !== null) {
    return 'derived';
  }
  if (input.mode !== 'absolute') {
    // 相対・極は基準が動けば追従する。独立した変数にすると二重定義になる(§2.2 の表)。
    return 'derived';
  }
  return isLiteralCoordinate(input) ? null : 'expression';
}

/** 半径を変数にしてよいか。 */
function radiusReason(
  onPlane: boolean,
  input: ExpressionValue | null,
): FrozenReason | null {
  if (input === null) {
    return 'derived';
  }
  if (!onPlane) {
    return 'derived';
  }
  return isNumericLiteral(input.source) ? null : 'expression';
}

function rememberKey(builder: Builder, featureId: string, key: string): void {
  const known = builder.keysByFeature.get(featureId);
  if (known === undefined) {
    builder.keysByFeature.set(featureId, [key]);
    return;
  }
  known.push(key);
}

/** 点を 1 つ積む(u, v の 2 つの数になる)。`reason` が null なら変数の候補。 */
function addPoint(
  builder: Builder,
  featureId: string,
  pointKey: string,
  world: Vec3,
  reason: FrozenReason | null,
): void {
  const [u, v] = worldToPlane(builder.plane, world);
  builder.slots.push({
    variable: { kind: 'u', pointKey },
    value: u,
    reason,
    frozenKey: pointKey,
  });
  builder.slots.push({
    variable: { kind: 'v', pointKey },
    value: v,
    reason,
    frozenKey: pointKey,
  });
  builder.elementFeatureIds.add(featureId);
  rememberKey(builder, featureId, pointKey);
}

/** 半径を 1 つ積む。 */
function addRadius(
  builder: Builder,
  featureId: string,
  radiusKind: RadiusKind,
  value: number,
  input: ExpressionValue | null,
  onPlane: boolean,
): void {
  const key = radiusComponentKey(featureId, radiusKind);
  builder.slots.push({
    variable: { kind: 'radius', featureId, radiusKind },
    value,
    reason: radiusReason(onPlane, input),
    frozenKey: key,
  });
  builder.elementFeatureIds.add(featureId);
  rememberKey(builder, featureId, key);
}

function addAlias(builder: Builder, alias: string, canonical: string): void {
  builder.aliases.set(alias, canonical);
}

/**
 * 「規則から導かれる」フィーチャー(点列・複製・オフセット・投影・断面・矩形・正多角形・長穴)の
 * 点と端点を定数として積む。n 番目だけを動かすと、もとの規則(基準+間隔+個数など)と
 * 食い違うので変数にしない(タスク4 の落とし穴)。
 */
function addDerivedGroup(
  builder: Builder,
  featureId: string,
  points: readonly ResolvedPoint[] | undefined,
  curves: readonly ResolvedCurve[] | undefined,
): void {
  if (points !== undefined && points.length > 0) {
    for (const point of points) {
      addPoint(builder, featureId, point.id, point.position, 'derived');
    }
    addAlias(builder, vertexKey(featureId, 'start'), points[0].id);
    addAlias(builder, vertexKey(featureId, 'end'), points[points.length - 1].id);
    return;
  }
  if (curves === undefined || curves.length === 0) {
    return;
  }
  addPoint(builder, featureId, vertexKey(featureId, 'start'), curveStart(curves[0]), 'derived');
  addPoint(
    builder,
    featureId,
    vertexKey(featureId, 'end'),
    curveEnd(curves[curves.length - 1]),
    'derived',
  );
}

/**
 * 拘束の変数を切り出す(§2.2)。`resolved` は拘束を無視した解決の結果で、初期値の出どころ。
 *
 * `plane` はこのスケッチの作図面。**この平面を指しているフィーチャーの座標だけ**が変数になる
 * (3D スケッチ・別の作図面の要素は定数。§0.a-0.3)。
 */
export function collectVariables(
  document: SketchDocument,
  resolved: ResolvedSketch,
  plane: WorkPlane,
): VariableSet {
  const builder: Builder = {
    plane,
    slots: [],
    aliases: new Map<string, string>(),
    elementFeatureIds: new Set<string>(),
    keysByFeature: new Map<string, string[]>(),
  };

  const pointsById = new Map<string, ResolvedPoint>();
  const pointsByFeature = new Map<string, ResolvedPoint[]>();
  for (const point of resolved.points) {
    pointsById.set(point.id, point);
    const group = pointsByFeature.get(point.featureId);
    if (group === undefined) {
      pointsByFeature.set(point.featureId, [point]);
    } else {
      group.push(point);
    }
  }
  const segmentByFeature = new Map<string, ResolvedSegment>();
  for (const segment of resolved.segments) {
    segmentByFeature.set(segment.featureId, segment);
  }
  const arcByFeature = new Map<string, ResolvedArc>();
  for (const arc of resolved.arcs) {
    arcByFeature.set(arc.featureId, arc);
  }
  const ellipseByFeature = new Map<string, ResolvedEllipse>();
  for (const ellipse of resolved.ellipses) {
    ellipseByFeature.set(ellipse.featureId, ellipse);
  }
  const splineByFeature = new Map<string, ResolvedSpline>();
  for (const spline of resolved.splines) {
    splineByFeature.set(spline.featureId, spline);
  }
  /** 円弧の端点の暗黙の式。変数が決まってから、定数だけの式を落とす。 */
  const implicit: ImplicitCircleEquation[] = [];

  for (const feature of document.features) {
    const onPlane = !isFreeWorkPlaneId(feature.planeId) && feature.planeId === plane.id;
    const id = feature.id;
    switch (feature.kind) {
      case 'point': {
        const point = pointsById.get(id);
        if (point === undefined) {
          break;
        }
        addPoint(
          builder,
          id,
          id,
          point.position,
          coordinateReason(plane, onPlane, point.position, feature.at),
        );
        // 解決は点フィーチャーの端点も登録する(`resolveSketch.ts`)。同じ点なので別名にする。
        addAlias(builder, vertexKey(id, 'start'), id);
        addAlias(builder, vertexKey(id, 'end'), id);
        break;
      }
      case 'line': {
        const segment = segmentByFeature.get(id);
        if (segment === undefined) {
          break;
        }
        addPoint(
          builder,
          id,
          vertexKey(id, 'start'),
          segment.from,
          coordinateReason(plane, onPlane, segment.from, feature.from),
        );
        addPoint(
          builder,
          id,
          vertexKey(id, 'end'),
          segment.to,
          coordinateReason(plane, onPlane, segment.to, feature.to),
        );
        break;
      }
      case 'arc': {
        const arc = arcByFeature.get(id);
        if (arc === undefined) {
          break;
        }
        const start = curveStart(arc);
        const end = curveEnd(arc);
        addPoint(
          builder,
          id,
          vertexKey(id, 'center'),
          arc.center,
          coordinateReason(plane, onPlane, arc.center, feature.center),
        );
        addRadius(builder, id, 'radius', arc.radius, feature.radius, onPlane);
        // **円弧の端点は変数にする**(統括の決定 2026-09-04。§0.a-0.6「角度は座標から導く」の
        // 趣旨どおり)。角度を変数にすると端点座標と二重定義になるので、代わりに端点そのものを
        // 動かし、「端点が円周の上にある」暗黙の式 2 本(|P − C| = r)で円弧の形を保つ。
        // 書き戻し(タスク8)では、動いた端点から開始角・終了角を逆算する。
        // 全周の円は端点を持たない(始点と終点が同じ点)ので、変数にせず定数のままにする。
        const fullCircle = isFullCircle(arc);
        const endpointReason = (world: Vec3): FrozenReason | null =>
          fullCircle ? 'derived' : onPlaneReason(plane, onPlane, world);
        addPoint(builder, id, vertexKey(id, 'start'), start, endpointReason(start));
        addPoint(builder, id, vertexKey(id, 'end'), end, endpointReason(end));
        if (!fullCircle) {
          implicit.push(
            { featureId: id, pointKey: vertexKey(id, 'start'), centerKey: vertexKey(id, 'center') },
            { featureId: id, pointKey: vertexKey(id, 'end'), centerKey: vertexKey(id, 'center') },
          );
        }
        break;
      }
      case 'ellipse': {
        const ellipse = ellipseByFeature.get(id);
        if (ellipse === undefined) {
          break;
        }
        addPoint(
          builder,
          id,
          vertexKey(id, 'center'),
          ellipse.center,
          coordinateReason(plane, onPlane, ellipse.center, feature.center),
        );
        addRadius(builder, id, 'major', ellipse.majorRadius, feature.majorRadius, onPlane);
        addRadius(builder, id, 'minor', ellipse.minorRadius, feature.minorRadius, onPlane);
        // 楕円の端点は円弧と違い定数のまま(統括の決定 2026-09-04)。端点から角度を逆算するには
        // 長軸の傾きも要るが、傾きは変数にしない(§0.a-0.6)ので端点だけでは形が決まらない。
        // 楕円に端点の拘束を付ける場面も少ないため、扱いを増やさない。
        addPoint(builder, id, vertexKey(id, 'start'), curveStart(ellipse), 'derived');
        addPoint(builder, id, vertexKey(id, 'end'), curveEnd(ellipse), 'derived');
        break;
      }
      case 'spline': {
        const spline = splineByFeature.get(id);
        if (spline === undefined) {
          break;
        }
        spline.points.forEach((position, n) => {
          addPoint(
            builder,
            id,
            `${id}#${n}`,
            position,
            coordinateReason(plane, onPlane, position, feature.points[n] ?? null),
          );
        });
        addAlias(builder, vertexKey(id, 'start'), `${id}#0`);
        addAlias(builder, vertexKey(id, 'end'), `${id}#${spline.points.length - 1}`);
        break;
      }
      case 'face': {
        // 面は点も曲線も生まないので、拘束の材料にはならない。
        break;
      }
      case 'polygon': {
        const curves = resolved.curvesByFeature.get(id);
        addDerivedGroup(builder, id, pointsByFeature.get(id), curves);
        if (curves !== undefined && curves.length > 0) {
          // 正多角形の中心は、解決した頂点(各辺の始点)の平均で厳密に求まる。
          // 解決結果には中心が残らないので、同心拘束の相手にできるようここで作る。
          const starts = curves.map(curveStart);
          const center: Vec3 = [
            starts.reduce((total, point) => total + point[0], 0) / starts.length,
            starts.reduce((total, point) => total + point[1], 0) / starts.length,
            starts.reduce((total, point) => total + point[2], 0) / starts.length,
          ];
          addPoint(builder, id, vertexKey(id, 'center'), center, 'derived');
        }
        break;
      }
      case 'pointArray':
      case 'rectangle':
      case 'slot':
      case 'offset':
      case 'copy':
      case 'projectedCurve':
      case 'planeSection': {
        addDerivedGroup(builder, id, pointsByFeature.get(id), resolved.curvesByFeature.get(id));
        break;
      }
    }
  }

  // 「固定」拘束は式を足さず、指された点/半径を変数から外す(§2.2 の表)。
  const fixedKeys = collectFixedKeys(builder, document);

  const variables: ConstraintVariable[] = [];
  const initial: number[] = [];
  const index = new Map<string, number>();
  const frozen = new Map<string, FrozenReason>();
  const constants = new Map<string, number>();
  for (const slot of builder.slots) {
    const key = variableComponentKey(slot.variable);
    const reason = slot.reason ?? (fixedKeys.has(slot.frozenKey) ? 'fixed' : null);
    if (reason === null) {
      index.set(key, variables.length);
      variables.push(slot.variable);
      initial.push(slot.value);
      continue;
    }
    frozen.set(slot.frozenKey, reason);
    constants.set(key, slot.value);
  }

  // 端点も中心も半径もすべて定数の円弧(固定した円弧、別の作図面の円弧)は、
  // 暗黙の式が動かせる数を 1 つも含まないので数えない。
  const effectiveImplicit = implicit.filter(
    (equation) =>
      index.has(pointComponentKey(equation.pointKey, 'u')) ||
      index.has(pointComponentKey(equation.centerKey, 'u')) ||
      index.has(radiusComponentKey(equation.featureId, 'radius')),
  );

  return {
    variables,
    initial,
    index,
    frozen,
    constants,
    aliases: builder.aliases,
    elementFeatureIds: builder.elementFeatureIds,
    implicit: effectiveImplicit,
  };
}

/** 「固定」拘束が指している点/半径の鍵。要素まるごとを指したときはその要素の全部を固定する。 */
function collectFixedKeys(builder: Builder, document: SketchDocument): ReadonlySet<string> {
  const fixed = new Set<string>();
  for (const constraint of sketchConstraints(document)) {
    if (constraint.kind !== 'fix') {
      continue;
    }
    const target = constraint.target;
    if (target.kind === 'curve') {
      for (const key of builder.keysByFeature.get(target.element.featureId) ?? []) {
        fixed.add(key);
      }
      continue;
    }
    const raw =
      target.kind === 'point' ? target.pointId : vertexKey(target.featureId, target.vertex);
    fixed.add(builder.aliases.get(raw) ?? raw);
  }
  return fixed;
}

/** その点の鍵が解決済みのスケッチに在るか。 */
function hasPoint(variableSet: VariableSet, pointKey: string): boolean {
  const key = pointComponentKey(pointKey, 'u');
  return variableSet.index.has(key) || variableSet.constants.has(key);
}

/** 別名を正本の鍵へ寄せる。在る点でなければ null。 */
export function canonicalPointKey(variableSet: VariableSet, pointKey: string): string | null {
  const canonical = variableSet.aliases.get(pointKey) ?? pointKey;
  return hasPoint(variableSet, canonical) ? canonical : null;
}

/** 拘束の指し先を点の鍵にする。曲線を指しているときと、在らない点のときは null。 */
export function constraintPointKey(
  variableSet: VariableSet,
  target: ConstraintTarget,
): string | null {
  if (target.kind === 'curve') {
    return null;
  }
  const raw = target.kind === 'point' ? target.pointId : vertexKey(target.featureId, target.vertex);
  return canonicalPointKey(variableSet, raw);
}

/** 曲線の両端の点の鍵(平行・直角・水平などの残差が読む)。片方でも無ければ null。 */
export function curveEndpointKeys(
  variableSet: VariableSet,
  featureId: string,
): readonly [string, string] | null {
  const start = canonicalPointKey(variableSet, vertexKey(featureId, 'start'));
  const end = canonicalPointKey(variableSet, vertexKey(featureId, 'end'));
  return start === null || end === null ? null : [start, end];
}

/** 1 つの数を読む。変数なら現在値 x から、そうでなければ定数から。 */
function valueOf(
  variableSet: VariableSet,
  x: readonly number[],
  key: string,
): number | null {
  const column = variableSet.index.get(key);
  if (column !== undefined) {
    return x[column];
  }
  const constant = variableSet.constants.get(key);
  return constant ?? null;
}

/** その点の作図面上の位置 (u, v)。在らない点なら null。 */
export function pointValueAt(
  variableSet: VariableSet,
  x: readonly number[],
  pointKey: string,
): readonly [number, number] | null {
  const canonical = variableSet.aliases.get(pointKey) ?? pointKey;
  const u = valueOf(variableSet, x, pointComponentKey(canonical, 'u'));
  const v = valueOf(variableSet, x, pointComponentKey(canonical, 'v'));
  return u === null || v === null ? null : [u, v];
}

/** その半径の値。在らなければ null。 */
export function radiusValueAt(
  variableSet: VariableSet,
  x: readonly number[],
  featureId: string,
  radiusKind: RadiusKind,
): number | null {
  return valueOf(variableSet, x, radiusComponentKey(featureId, radiusKind));
}

/** 自由度の数え上げ(FR-313 の「足りない拘束の数を示し」)。 */
export interface DegreesOfFreedomCount {
  /** 動かせる数の個数。 */
  readonly variables: number;
  /** 式の本数の合計(利用者が付けた拘束+円弧の暗黙の式)。 */
  readonly equations: number;
  /** そのうち円弧の暗黙の式(端点が円周の上にある)の本数。 */
  readonly implicit: number;
  /** あと何か所決まっていないか(0 以上。帯に出す N)。 */
  readonly remaining: number;
  /** 式が変数より多い分(0 以上)。拘束の付けすぎの目安。 */
  readonly excess: number;
  /** 指していた要素が無くなった拘束の id(式を数えない。FR-504)。 */
  readonly dangling: readonly string[];
}

/** その指し先の材料がそろっているか。 */
function hasMaterial(variableSet: VariableSet, target: ConstraintTarget): boolean {
  if (target.kind === 'curve') {
    return variableSet.elementFeatureIds.has(target.element.featureId);
  }
  return constraintPointKey(variableSet, target) !== null;
}

/**
 * 自由度を数える(§2.2)。**変数の数 −(有効な拘束の式+円弧の暗黙の式)の数**の素朴な数え方で、
 * 拘束どうしが同じことを言っている(線形従属)かどうかは見ない。重なりまで見た正確な
 * 自由度はヤコビアンの階数から出す(タスク7 の `diagnoseConstraints`)。
 *
 * 足りないぶん(`remaining`)と足しすぎのぶん(`excess`)は別々に数え、負の数にしない。
 * 「あと −2 か所決まっていません」は利用者に意味が通らないため。
 */
export function countDegreesOfFreedom(
  variableSet: VariableSet,
  constraints: readonly SketchConstraint[],
): DegreesOfFreedomCount {
  const dangling: string[] = [];
  // 円弧の端点を変数にした代わりに立つ式(統括の決定 2026-09-04)。利用者の拘束が
  // 1 つも無くても、円弧 1 本は「端点が円周の上にある」2 本のぶんだけ自由度が減る。
  const implicit = variableSet.implicit.length;
  let equations = implicit;
  for (const constraint of constraints) {
    const ready = constraintTargets(constraint).every((target) => hasMaterial(variableSet, target));
    if (!ready) {
      dangling.push(constraint.id);
      continue;
    }
    equations += constraintEquationCount(constraint);
  }
  const variables = variableSet.variables.length;
  return {
    variables,
    equations,
    implicit,
    remaining: Math.max(0, variables - equations),
    excess: Math.max(0, equations - variables),
    dangling,
  };
}
