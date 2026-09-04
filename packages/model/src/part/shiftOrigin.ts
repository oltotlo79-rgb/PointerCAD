/**
 * 原点の再設定(FR-331、計画書 docs/plans/P4-スケッチ拡張.md §0.a-0.25・タスク35 ②③)。
 *
 * 選んだ点が (0,0,0) になるよう、部品文書の中の**絶対座標を式のまま**平行移動する。
 * 文書 → 新しい文書の純関数で、履歴に段は増えない(呼び出し側が 1 回の履歴操作として
 * 積めば Undo 1 回で戻る、§0.a-0.25 の利用者の決定)。
 *
 * 利用者の要件は「同じ空間のすべての点・線・面・立体がシフト量ぶんずれる」ことなので、
 * **模型は剛体として平行移動する**。基準の 3 面の上に描いたスケッチも、シフトに法線方向の
 * 成分があれば作図面ごと動かす(基準面からオフセットした作業平面を 1 枚作って付け替える。
 * 統括の差し戻し 2026-09-04 ③)。こうすると、そのスケッチから作った立体も一緒に動く。
 *
 * **書き換えるもの**
 *   - 各スケッチの絶対座標と、ワールド原点を基準にした相対・極座標(`sketch/shiftCoordinate.ts`)
 *   - 基準の 3 面の上のスケッチの作図面(法線方向へ動くときだけ、オフセット平面へ付け替える)
 *   - 基準点(FR-329)のうち座標の式で定義したもの(`definition.kind === 'coordinate'`)
 *   - 基準の 3 面からのオフセットで定義した作業平面(FR-328)の `offset`
 *
 * **書き換えないもの**(いずれも「別の要素に対して定まっている」ので参照先が動けば追従する)
 *   - 原点以外の点を基準にした相対座標・極座標、点の参照(直前の点・スケッチの点・端点・頂点)
 *   - 3 点・面・辺などから定義した任意の作業平面の上に描いたスケッチの座標
 *   - 3 点や面から定義した平面そのもの、基準軸、基準座標系(いずれも点・軸の参照だけを持つ)
 *   - 立体の面から離した作業平面の `offset`(面が模型と一緒に動くため)
 *   - ソリッドの履歴(押し出し・回転・穴・ばね・パターンなど)。座標の式を直接持つ欄が
 *     1 つも無く、位置はすべてスケッチの点・面・辺・頂点への参照で決まる(`part/types.ts`)。
 *   - 半径・距離・角度などの寸法(原点の位置と無関係、FR-331)
 */

import {
  addExpression,
  expressionValueFromNumber,
  type ExpressionValue,
} from '@pointercad/expression';

import type { PlaneSpec } from '../geometry/planeSpec.js';
import {
  baseWorkPlane,
  isFreeWorkPlaneId,
  WORK_PLANES,
  type WorkPlane,
  type WorkPlaneId,
} from '../sketch/planeMath.js';
import {
  normalShiftAxis,
  originShiftFromPosition,
  planeShiftAxes,
  shiftCoordinateInput,
  shiftExpression,
  shiftSketchDocument,
  worldShiftAxes,
  type AxisShift,
  type FeatureShiftPlan,
  type OriginShift,
} from '../sketch/shiftCoordinate.js';
import type { CoordinateInput, PointReference, SketchDocument } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import {
  findReference,
  findSketch,
  nextReferenceId,
  nextReferenceName,
} from './createPartDocument.js';
import type { PartDocument, ReferenceFeature, ReferencePlaneFeature } from './types.js';

export type { OriginShift } from '../sketch/shiftCoordinate.js';
export { originShiftFromPosition };

/** 作業平面の連なりをたどる深さの上限(指定が輪になっていても止まる)。 */
const MAX_PLANE_DEPTH = 32;

/**
 * 「基準面からのオフセット」だけでできた作業平面の連なりをたどり、行き着いた基準面を返す。
 *
 * この形の平面は `shiftPlaneSpec` がオフセットを直すので**模型と一緒に法線方向へ動く**。
 * したがって、その上のスケッチの座標も世界の 3 成分ぶん動かしてよい(そうしないと平面だけが
 * 動いて図が置き去りになる)。3 点・面・辺から定義した平面は定義元が動くので null を返す。
 */
function baseOfWorkPlaneChain(
  document: PartDocument,
  planeId: WorkPlaneId,
  depth = 0,
): WorkPlane | null {
  if (depth > MAX_PLANE_DEPTH) {
    return null;
  }
  const base = baseWorkPlane(planeId);
  if (base !== null) {
    return base;
  }
  const feature = findReference(document, planeId);
  if (feature === undefined || feature.kind !== 'referencePlane') {
    return null;
  }
  return feature.plane.kind === 'workPlane'
    ? baseOfWorkPlaneChain(document, feature.plane.planeId, depth + 1)
    : null;
}

/** その平行移動が法線方向にも動かすか(動かすなら作図面ごと動かす必要がある)。 */
function movesAlongNormal(axis: AxisShift | null): boolean {
  return axis !== null && axis.kind !== 'keep' && axis.amount.value !== 0;
}

/**
 * 作図面の id から、その上のフィーチャーの動かし方を決める。
 *
 * - 3D スケッチ: 世界の 3 成分をそのまま動かす(作図面が無い)。
 * - 基準の 3 面: 法線方向の成分が 0 なら面内の 2 軸へ写したぶんだけ動かし、作図面はそのまま。
 *   0 でなければ世界の 3 成分を動かし、`ensurePlane` が作る「基準面からオフセットした作業平面」
 *   へ付け替える(統括の差し戻し ③)。
 * - 基準面からのオフセットで定義した作業平面: 平面のオフセットを直すので、世界の 3 成分を動かす。
 * - それ以外の任意の作業平面: 定義元が動くので何も書き換えない(null)。
 */
function planForPlane(
  document: PartDocument,
  planeId: WorkPlaneId,
  shift: OriginShift,
  ensurePlane: (base: WorkPlane) => string,
): FeatureShiftPlan | null {
  if (isFreeWorkPlaneId(planeId)) {
    return { shift: { axes: worldShiftAxes(shift), plane: null } };
  }
  const base = baseWorkPlane(planeId);
  if (base !== null) {
    const normal = normalShiftAxis(shift, base);
    if (!movesAlongNormal(normal)) {
      // 法線方向へは動かないので作図面はそのまま。面内へ写したぶん(= 世界のシフト)を動かす。
      const axes = planeShiftAxes(shift, base);
      return axes === null ? null : { shift: { axes, plane: base } };
    }
    return {
      shift: { axes: worldShiftAxes(shift), plane: base },
      planeId: ensurePlane(base),
    };
  }
  const chained = baseOfWorkPlaneChain(document, planeId);
  return chained === null
    ? null
    : { shift: { axes: worldShiftAxes(shift), plane: chained } };
}

/**
 * 基準面からのオフセットで定義した作業平面(FR-328)のオフセットを直す。
 *
 * 平面の位置は「基準面の原点 + 法線 × オフセット」(`geometry/planeSpec.ts` の
 * `offsetPlane`)なので、模型が `-shift` だけ動けばオフセットは法線方向の成分ぶん減る。
 */
function shiftPlaneSpec(spec: PlaneSpec, shift: OriginShift): PlaneSpec {
  if (spec.kind !== 'workPlane') {
    // 3 点・点+辺・点+軸・点+面・面・傾けた平面は、点や面の参照だけで位置が決まる。
    return spec;
  }
  const plane = baseWorkPlane(spec.planeId);
  if (plane === null) {
    // 他の作業平面からのオフセットは、その平面自身が動くのでオフセットが保たれる。
    return spec;
  }
  const axis = normalShiftAxis(shift, plane);
  return axis === null ? spec : { ...spec, offset: shiftExpression(spec.offset, axis) };
}

function shiftReferenceFeature(feature: ReferenceFeature, shift: OriginShift): ReferenceFeature {
  switch (feature.kind) {
    case 'referencePlane': {
      const plane = shiftPlaneSpec(feature.plane, shift);
      // 直す必要が無い平面は元のまま返す(下流が「変わった」と見なさないように)。
      return plane === feature.plane ? feature : { ...feature, plane };
    }
    case 'referencePoint':
      return feature.definition.kind === 'coordinate'
        ? {
            ...feature,
            definition: {
              kind: 'coordinate',
              // 部品文書には作図面が無いので、世界の 3 成分をそのまま動かす。
              at: shiftCoordinateInput(feature.definition.at, {
                axes: worldShiftAxes(shift),
                // 部品文書の極座標の基準は XY 面(`resolveReferences.ts` と同じ約束)。
                plane: WORK_PLANES.xy,
              }),
            },
          }
        : feature;
    case 'referenceAxis':
    case 'referenceCoordinateSystem':
      // 軸も座標系も点・軸の参照だけで決まる(座標の式を直接持たない)。
      return feature;
  }
}

/**
 * 選んだ点が原点になるよう、部品文書の絶対座標を式のまま平行移動する(FR-331)。
 *
 * `shift` は「選んだ点の世界座標」を式で表したもの。新しい式は `元の式 − シフトの式` で、
 * 厳密に計算できるところだけ簡約される(`@pointercad/expression` の `subtractExpression`)。
 */
export function shiftOrigin(document: PartDocument, shift: OriginShift): PartDocument {
  // 基準面ごとに 1 枚だけ作って使い回す(同じ基準面・同じシフトなら平面は 1 枚でよい)。
  const created: ReferencePlaneFeature[] = [];
  const byBase = new Map<string, string>();
  const ensurePlane = (base: WorkPlane): string => {
    const known = byBase.get(base.id);
    if (known !== undefined) {
      return known;
    }
    const plane = createOffsetPlane(document, created, base, shift);
    created.push(plane);
    byBase.set(base.id, plane.id);
    return plane.id;
  };

  const sketches = document.sketches.map((sketch) =>
    shiftSketchDocument(sketch, (planeId) => planForPlane(document, planeId, shift, ensurePlane)),
  );
  const references = document.references.map((feature) => shiftReferenceFeature(feature, shift));
  // 新しい作業平面は最後に足す(基準面しか参照しないので、順序の制約に触れない)。
  return { ...document, sketches, references: [...references, ...created] };
}

/**
 * 基準面の上のスケッチを載せ替えるための作業平面を作る(FR-328 の「基準平面のオフセット」)。
 *
 * オフセットは「原点から法線方向のシフト成分ぶん戻したところ」= `0 − シフトの法線成分`。
 * 符号は法線の向きに従う(XZ 面の法線は −Y なので Y のシフトはそのままオフセットになる)。
 * 画面には出さない(利用者が自分で作った平面ではないため)。参照はできる。
 */
function createOffsetPlane(
  document: PartDocument,
  created: readonly ReferencePlaneFeature[],
  base: WorkPlane,
  shift: OriginShift,
): ReferencePlaneFeature {
  const numbering: PartDocument = {
    ...document,
    references: [...document.references, ...created],
  };
  const axis = normalShiftAxis(shift, base);
  const zero = expressionValueFromNumber(0);
  return {
    id: nextReferenceId(numbering, 'referencePlane'),
    name: nextReferenceName(numbering, 'referencePlane'),
    visible: false,
    kind: 'referencePlane',
    plane: {
      kind: 'workPlane',
      planeId: base.id,
      offset: axis === null ? zero : shiftExpression(zero, axis),
    },
  };
}

// ---------------------------------------------------------------------------
// 選んだ点からシフト量を作る(タスク35 ③)
// ---------------------------------------------------------------------------

/**
 * 原点にしたい点の指し方(ui のコマンド(35b)がここへ詰め替える)。
 *
 * 式を持つ点(スケッチの点・基準点・座標の式)は**式のまま**シフト量にする。立体の頂点の
 * ように式を持たない点は、解決済みの座標を `position` で渡す(FR-331 の備考)。
 */
export type OriginTarget =
  /** スケッチの点フィーチャー(`kind: 'point'`)。 */
  | { readonly kind: 'sketchPoint'; readonly sketchId: string; readonly featureId: string }
  /** 基準点フィーチャー(FR-329)。座標の式で定義したものだけが式のまま使える。 */
  | { readonly kind: 'referencePoint'; readonly featureId: string }
  /** 座標の式を直接指定する。相対・極の基準をたどるためにスケッチの id を添えられる。 */
  | {
      readonly kind: 'coordinate';
      readonly at: CoordinateInput;
      readonly sketchId?: string;
    }
  /** 立体の頂点など、式を持たない点。解決済みの倍精度の座標をそのまま使う。 */
  | { readonly kind: 'position'; readonly position: Vec3 };

/** 相対座標の連なりをたどる深さの上限。参照が輪になっていても止まるようにする。 */
const MAX_BASE_DEPTH = 32;

/** 原点(0,0,0)を式で表したもの。相対座標の基準が原点のときの土台になる。 */
function zeroShift(): OriginShift {
  const zero = expressionValueFromNumber(0);
  return { x: zero, y: zero, z: zero };
}

function addShift(
  base: OriginShift,
  dx: ExpressionValue,
  dy: ExpressionValue,
  dz: ExpressionValue,
): OriginShift {
  return {
    x: addExpression(base.x, dx),
    y: addExpression(base.y, dy),
    z: addExpression(base.z, dz),
  };
}

/**
 * 相対座標の基準を式で表す。式へ直せない基準(直前の点・要素の端点・立体の頂点)は null で、
 * 呼び出し側は解決済みの座標(`OriginTarget` の `position`)へ後退する。
 */
function shiftFromPointReference(
  reference: PointReference,
  sketch: SketchDocument | null,
  depth: number,
): OriginShift | null {
  if (reference.kind === 'origin') {
    return zeroShift();
  }
  if (reference.kind !== 'point' || sketch === null) {
    return null;
  }
  const found = sketch.features.find((feature) => feature.id === reference.pointId);
  // 点列の n 番目(`featureId#n`)は 1 つの座標欄で表せないので式にできない。
  return found === undefined || found.kind !== 'point'
    ? null
    : shiftFromCoordinate(found.at, sketch, depth + 1);
}

/**
 * 1 点の指定を式のシフト量へ直す。絶対座標はその式、相対座標は「基準の式 + ずれの式」。
 * 極座標(角度と距離)は掛け算・三角関数が要るので式にはせず null を返す。
 */
function shiftFromCoordinate(
  input: CoordinateInput,
  sketch: SketchDocument | null,
  depth: number,
): OriginShift | null {
  if (depth > MAX_BASE_DEPTH) {
    return null;
  }
  if (input.mode === 'absolute') {
    return { x: input.x, y: input.y, z: input.z };
  }
  if (input.mode !== 'relative') {
    return null;
  }
  const base = shiftFromPointReference(input.base, sketch, depth);
  return base === null ? null : addShift(base, input.dx, input.dy, input.dz);
}

/**
 * 選んだ点から平行移動の量を作る(タスク35 ③)。式へ直せないときは null を返すので、
 * 呼び出し側は解決済みの座標から `originShiftFromPosition` で作り直す。
 */
export function originShiftFor(document: PartDocument, target: OriginTarget): OriginShift | null {
  switch (target.kind) {
    case 'position':
      return originShiftFromPosition(target.position);
    case 'coordinate': {
      const sketch =
        target.sketchId === undefined ? null : (findSketch(document, target.sketchId) ?? null);
      return shiftFromCoordinate(target.at, sketch, 0);
    }
    case 'sketchPoint': {
      const sketch = findSketch(document, target.sketchId);
      if (sketch === undefined) {
        return null;
      }
      const feature = sketch.features.find((item) => item.id === target.featureId);
      return feature === undefined || feature.kind !== 'point'
        ? null
        : shiftFromCoordinate(feature.at, sketch, 0);
    }
    case 'referencePoint': {
      const feature = findReference(document, target.featureId);
      if (feature === undefined || feature.kind !== 'referencePoint') {
        return null;
      }
      // 立体の頂点・辺の中点・面の中心で定義した基準点は式を持たない(FR-329)。
      return feature.definition.kind === 'coordinate'
        ? shiftFromCoordinate(feature.definition.at, null, 0)
        : null;
    }
  }
}
