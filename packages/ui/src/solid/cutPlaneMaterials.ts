/**
 * 切断の「切る面の材料」を選択と入力から集め、押す前に確かめる(EX-04 W1、FR-432・FR-328)。
 *
 * 切る面の決め方は 5 通り(立体の面／3 点／点と法線／XYZ 軸に垂直な面／任意の作業平面)。
 * model の `PlaneSpec` はどの材料も表せるので、ここは**選択と入力を `PlaneSpec` の参照へ
 * 読み替えるだけ**にし、平面の解き方は model の `resolvePlaneSpec` をそのまま使う
 * (同じ規則を 2 か所に書かない。§0.a-0.56)。
 *
 * | 材料 | 選び方 | 切断に保存する参照 |
 * |---|---|---|
 * | 立体の頂点 | ビューポートで頂点を選ぶ | `{ kind: 'subShape', ref }`(指紋つき) |
 * | スケッチの点 | 編集中のスケッチの点・点列の 1 点を選ぶ | `{ kind: 'point', pointId }` |
 * | 座標の式 | 入力欄の「点の X / Y / Z」 | 補助の基準点を名指しする `{ kind: 'point', pointId }` |
 * | 軸と位置 | 決め方「X / Y / Z 軸に垂直な面」と欄「位置」 | 補助の基準点とワールドの軸(`pointAndAxis`) |
 * | 任意の作業平面 | モデルブラウザで作業平面を選ぶ | `{ kind: 'workPlane', planeId }` |
 * | 辺・面 | ビューポートで選ぶ | `SubShapeRef`(指紋つき) |
 *
 * 座標は写さず参照で持つ(FR-201/202)。座標の式の点は、作業平面の道具と同じく基準点として
 * 文書に残す(`referenceCommands.ts` の `appendCoordinatePoints`。部品文書の `PointReference` には
 * 「その場の座標」を入れる欄が無いため)。保存した参照は、参照先を後で直しても書き換えない
 * (解き直すのは model の再計算の役目)。
 */

import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import {
  affectsShape,
  baseWorkPlane,
  resolvePlaneSpec,
  resolveSketch,
  subShapeFromFingerprint,
  WORLD_AXIS_DIRECTIONS,
  type PlaneErrorKey,
  type PlaneOutcome,
  type PlaneResolveContext,
  type PlaneSpec,
  type PointReference,
  type PartDocument,
  type ResolvedReferences,
  type ResolvedSketch,
  type SketchDocument,
  type SketchFeature,
  type SubShapeRef,
  type Vec3,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';
import { featureIdOf } from '../sketch/featureSummary.js';
import {
  appendCoordinatePoints,
  resolveReferencesOf,
  resolveWorkPlaneOf,
} from '../sketch/referenceCommands.js';

import type { CutContext } from './cutCommands.js';
import { parseSubShapeId, selectedSubShapeRefs, subShapeRefOf } from './subShapeSelection.js';

/** 選択から拾った切る面の材料(どれも選んだ順)。 */
export interface CutMaterials {
  /** 立体の頂点とスケッチの点。 */
  readonly points: readonly PointReference[];
  readonly edges: readonly SubShapeRef[];
  readonly faces: readonly SubShapeRef[];
  /** 選んだ作業平面(部品文書の `referencePlane`)の id。 */
  readonly workPlaneIds: readonly string[];
}

export type CutMaterialsOutcome =
  | { readonly ok: true; readonly materials: CutMaterials }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/** 座標や軸の位置から置いた補助の点。文書は点を積んだ後のもの。 */
export type PlacedCutPoint =
  | { readonly ok: true; readonly document: PartDocument; readonly point: PointReference }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/** 切る面に垂直な軸(決め方「X / Y / Z 軸に垂直な面」)。 */
export type CutAxis = 'x' | 'y' | 'z';

/** スケッチの点の種類(点そのもの・点列の 1 点)。 */
const SKETCH_POINT_KINDS: ReadonlySet<SketchFeature['kind']> = new Set(['point', 'pointArray']);

/**
 * 選択から切る面の材料を拾う。
 *
 * 頂点・辺・面は `subShapeSelection.ts` の参照の作り方をそのまま使い、引けないものは
 * 黙って飛ばす(`selectedSubShapeRefs` と同じ方針)。スケッチの点は**編集中のスケッチの点**
 * だけを拾い(ビューポートとモデルブラウザが選ばせるのは編集中のスケッチの要素だけ。
 * `sketchRefs.ts`)、点として使えないときは理由を返す。
 */
export function collectCutMaterials(context: CutContext): CutMaterialsOutcome {
  const points: PointReference[] = [];
  const workPlaneIds: string[] = [];
  const seen = new Set<string>();
  for (const elementId of context.selection) {
    if (seen.has(elementId)) {
      continue;
    }
    seen.add(elementId);
    const parsed = parseSubShapeId(elementId);
    if (parsed !== null) {
      const ref = parsed.kind === 'vertex' ? subShapeRefOf(context.bodies, elementId) : null;
      if (ref !== null) {
        points.push({ kind: 'subShape', ref });
      }
      continue;
    }
    if (isWorkPlaneId(context.document, elementId)) {
      workPlaneIds.push(elementId);
      continue;
    }
    const sketchPoint = sketchPointMaterial(context, elementId);
    if (sketchPoint === null) {
      continue;
    }
    if (!sketchPoint.ok) {
      return sketchPoint;
    }
    points.push(sketchPoint.point);
  }
  return {
    ok: true,
    materials: {
      points,
      edges: selectedSubShapeRefs(context.bodies, context.selection, 'edge'),
      faces: selectedSubShapeRefs(context.bodies, context.selection, 'face'),
      workPlaneIds,
    },
  };
}

/** その id が部品文書の作業平面(FR-328 の任意の作業平面)か。 */
function isWorkPlaneId(document: PartDocument, elementId: string): boolean {
  return document.references.some(
    (feature) => feature.id === elementId && feature.kind === 'referencePlane',
  );
}

type SketchPointMaterial =
  | { readonly ok: true; readonly point: PointReference }
  | { readonly ok: false; readonly reasonKey: MessageKey };

/**
 * 選択の要素 id が編集中のスケッチの点なら、切る面の点の参照にする。点でなければ null。
 *
 * 点そのもの(`point-3`)と点列の 1 点(`point-1#3`)だけを点とみなす。点列の行(全体)や
 * 線・面は 1 つの点ではないので拾わない。
 *
 * model は `{ kind: 'point' }` を**文書の並び順で最初に見つかったスケッチ**の点として解く
 * (`resolveReferences.ts`)。編集中のスケッチより前のスケッチに同じ名前の点があると、
 * 選んだ点と別の点で切ってしまうので断る(rules/06 §10.381 の同名 id の取り違え)。
 */
function sketchPointMaterial(context: CutContext, elementId: string): SketchPointMaterial | null {
  const { document } = context;
  const activeIndex = document.sketches.findIndex((sketch) => sketch.id === document.activeSketchId);
  const active = document.sketches[activeIndex];
  if (active === undefined) {
    return null;
  }
  const featureId = featureIdOf(elementId);
  const feature = active.features.find((candidate) => candidate.id === featureId);
  const single = feature?.kind === 'point' && elementId === featureId;
  const member = feature?.kind === 'pointArray' && elementId !== featureId;
  if (!single && !member) {
    return null;
  }
  const shadowed = document.sketches.slice(0, activeIndex).some((sketch) =>
    sketch.features.some((other) => other.id === featureId && SKETCH_POINT_KINDS.has(other.kind)));
  if (shadowed) {
    return { ok: false, reasonKey: 'cutError.sketchPointOtherSketch' };
  }
  const resolved = resolvedSketchOf(context, active);
  const found = resolved.points.find((point) => point.id === elementId);
  if (found === undefined || !found.position.every(Number.isFinite)
    || resolved.errors.some((error) => error.featureId === featureId)) {
    return { ok: false, reasonKey: 'cutError.sketchPointUnresolved' };
  }
  return { ok: true, point: { kind: 'point', pointId: elementId } };
}

/**
 * スケッチ 1 本の解決結果。文書と対になったいまの再計算の結果(拘束を解いた位置)があれば
 * それを使い、無ければその場で解く(`cutCommands.ts` の `profileCutGeometry` と同じ選び方)。
 */
function resolvedSketchOf(context: CutContext, sketch: SketchDocument): ResolvedSketch {
  const snapshot = context.resolvedSketches;
  const current = snapshot !== undefined && snapshot.document.id === context.document.id
    && !affectsShape(snapshot.document, context.document);
  const remembered = current
    ? snapshot.sketches.find((entry) => entry.sketchId === sketch.id)?.resolved
    : undefined;
  return remembered ?? resolveSketch(sketch, {
    workPlane: (planeId) => resolveWorkPlaneOf(context.document, planeId),
  });
}

/* ------------------------------------------------------------------ *
 * 座標の式・軸の位置から補助の点を置く
 * ------------------------------------------------------------------ */

/**
 * 座標の式(「点の X / Y / Z」)を補助の基準点として積む。
 * 値が数になっていなければ断る(式が評価できない、NFR-UX-5)。
 */
export function placeCoordinatePoint(
  document: PartDocument,
  x: ExpressionValue | undefined,
  y: ExpressionValue | undefined,
  z: ExpressionValue | undefined,
): PlacedCutPoint {
  if (x === undefined || y === undefined || z === undefined) {
    return { ok: false, reasonKey: 'shapeError.noCutPlane' };
  }
  return placePoint(document, x, y, z);
}

/**
 * 軸に垂直な面の位置(「位置」の欄)を、その軸の上の補助の基準点として積む。
 * 例: X 軸・位置 `10*2` なら (10*2, 0, 0)。面の法線は軸の向き(+X / +Y / +Z)になる。
 */
export function placeAxisPoint(
  document: PartDocument,
  axis: CutAxis,
  position: ExpressionValue | undefined,
): PlacedCutPoint {
  if (position === undefined) {
    return { ok: false, reasonKey: 'shapeError.noCutPlane' };
  }
  const zero = expressionValueFromNumber(0);
  return placePoint(
    document,
    axis === 'x' ? position : zero,
    axis === 'y' ? position : zero,
    axis === 'z' ? position : zero,
  );
}

/** 座標の 3 つの式を補助の基準点として積む。どれかが数でなければ積まずに断る。 */
function placePoint(
  document: PartDocument,
  x: ExpressionValue,
  y: ExpressionValue,
  z: ExpressionValue,
): PlacedCutPoint {
  if (![x.value, y.value, z.value].every(Number.isFinite)) {
    return { ok: false, reasonKey: 'cutError.expressionInvalid' };
  }
  const placed = appendCoordinatePoints(document, [{ mode: 'absolute', x, y, z }]);
  const point = placed.points[0];
  return point === undefined
    ? { ok: false, reasonKey: 'shapeError.noCutPlane' }
    : { ok: true, document: placed.document, point };
}

/* ------------------------------------------------------------------ *
 * 押す前の確かめ(NFR-UX-5)
 * ------------------------------------------------------------------ */

/**
 * model の平面の断り(`PlaneErrorKey`)を切断の文言へ写す。断りの判定そのものは model の
 * `resolvePlaneSpec` が行う(同じ規則を UI に書かない)。向きが定まらない(`degenerate`)のは、
 * 切断の決め方では「辺を含む面」で点が辺の延長線の上にあるときだけに起きる。
 */
const PLANE_ERROR_KEYS: Readonly<Record<PlaneErrorKey, MessageKey>> = {
  missingPoint: 'cutError.pointMissing',
  missingSubShape: 'shapeError.noCutPlane',
  missingAxis: 'shapeError.noCutPlane',
  missingPlane: 'cutError.workPlaneMissing',
  collinear: 'cutError.collinear',
  notStraightEdge: 'cutError.notStraightEdge',
  notFlatFace: 'cutError.curvedFace',
  invalidValue: 'cutError.expressionInvalid',
  degenerate: 'cutError.pointOnEdgeLine',
};

/**
 * 切る面がいまの材料で決まるかを、model の `resolvePlaneSpec` で**押す前に**確かめる。
 * 決まれば null。
 *
 * 頂点・辺・面は選んだ瞬間の指紋の位置・向き(予告も同じ手掛かり。`resolveCutPlaneOf`)、スケッチの点は
 * スケッチの解決結果、基準点と作業平面は部品文書の基準ジオメトリの解決結果から引く。
 * 画面で解けない材料(関数の上の点・基準軸など、この入口が作らないもの)を含むときは、
 * 押す前には断らず再計算に任せる。
 */
export function cutPlaneMaterialRejection(context: CutContext, plane: PlaneSpec): MessageKey | null {
  if (!isCheckable(plane)) {
    return null;
  }
  const outcome = resolveCutPlaneOf(context, plane);
  return outcome.ok ? null : PLANE_ERROR_KEYS[outcome.reason];
}

/**
 * 切る面を、押す前の確かめ(`cutPlaneMaterialRejection`)と同じ手掛かりで解く(EX-04 W2)。
 * 切断の予告(`cutPlanePreview.ts`)はこれで面を解くので、予告と確定前の確かめが同じ材料の解決になる。
 * 確定した切断は model の `resolvePart` が同じ `resolvePlaneSpec` で解く。
 */
export function resolveCutPlaneOf(context: CutContext, plane: PlaneSpec): PlaneOutcome {
  return resolvePlaneSpec(plane, uiPlaneContext(context));
}

/** この画面で位置を確かめられる点か(この入口が作る参照の種類だけ)。 */
function isCheckablePoint(point: PointReference): boolean {
  return point.kind === 'subShape' || point.kind === 'point' || point.kind === 'origin';
}

function isCheckable(plane: PlaneSpec): boolean {
  switch (plane.kind) {
    case 'threePoints':
      return [plane.p1, plane.p2, plane.p3].every(isCheckablePoint);
    case 'pointAndEdge':
    case 'pointAndParallelFace':
      return isCheckablePoint(plane.point);
    case 'pointAndAxis':
      return isCheckablePoint(plane.point) && plane.axis.kind === 'world';
    case 'face':
    case 'workPlane':
      return true;
    case 'tilted':
      return false;
  }
}

/** 画面の側で平面を解く手掛かり。基準ジオメトリは要るときに 1 回だけ解く。 */
function uiPlaneContext(context: CutContext): PlaneResolveContext {
  let references: ResolvedReferences | null = null;
  const referencesOf = (): ResolvedReferences => {
    references ??= resolveReferencesOf(context.document);
    return references;
  };
  return {
    point: (reference) => {
      switch (reference.kind) {
        case 'subShape':
          return subShapeFromFingerprint(reference.ref).position;
        case 'origin':
          return [0, 0, 0];
        case 'point':
          return context.document.references.some((feature) => feature.id === reference.pointId)
            ? referencesOf().points.find((point) => point.featureId === reference.pointId)?.position ?? null
            : sketchPointPosition(context, reference.pointId);
        default:
          return null;
      }
    },
    axis: (spec) =>
      spec.kind === 'world' ? { origin: [0, 0, 0], direction: WORLD_AXIS_DIRECTIONS[spec.axis] } : null,
    workPlane: (planeId) => {
      const base = baseWorkPlane(planeId);
      if (base !== null) {
        return { origin: base.origin, axisU: base.axisU, axisV: base.axisV, normal: base.normal };
      }
      return referencesOf().planes.find((plane) => plane.featureId === planeId)?.plane ?? null;
    },
  };
}

/**
 * スケッチの点の位置を、model と同じ規則(文書の並び順で最初に見つかったスケッチ)で引く。
 * 見つからなければ null。
 */
function sketchPointPosition(context: CutContext, pointId: string): Vec3 | null {
  for (const sketch of context.document.sketches) {
    const found = resolvedSketchOf(context, sketch).points.find((point) => point.id === pointId);
    if (found !== undefined) {
      return found.position;
    }
  }
  return null;
}
