import type {
  GeomAbs_JoinType,
  OpenCascadeInstance,
  TopoDS_Edge,
  TopoDS_Shape,
  TopoDS_Wire,
  gp_Dir,
  gp_Pnt,
} from 'opencascade.js/dist/opencascade.full.js';

import type { CurveSpec, Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import { makeCurveEdge } from './makeSketchEdges.js';

/**
 * 輪郭のオフセット(FR-321、計画書 P4 §2.5・§0.a-0.22、タスク16)。
 *
 * 平面上でつながった線分・円弧の列を、距離 d だけ離れた別の輪郭へ写す。
 * 元の輪郭は変えない(オフセットは複製系。§0.a-0.10)。
 *
 * **結果は OCCT の形ではなく、線分と円弧の指定(CurveSpec)の列で返す。**
 * こうすると呼び出し側が結果をそのまま makePlanarFace / 押し出しの断面へ渡せて、
 * OCCT の実体の寿命を気にせずに済む(この関数の中で全て解放する)。
 * 計画書の下書きは OCCT の辺の控えを返す形だったが、統括の指示により
 * 「辺ごとに種類を判別して線分・円弧へ戻す」形にした。
 */

/**
 * 角の作り方。
 * - `arc`: 外側の角を半径 = |距離| の丸みでつなぐ(既定)。
 * - `intersection`: 隣り合う辺を延長して尖った角にする。
 */
export type OffsetJoinType = 'arc' | 'intersection';

/** オフセットの依頼。 */
export interface OffsetWireSpec {
  /** オフセット元の輪郭。並んだ順につながっていること。 */
  readonly curves: readonly CurveSpec[];
  /**
   * 符号つき距離(mm)。閉じた輪郭では、輪郭を反時計回りに見て
   * 正が外側・負が内側になる(向きの決めは呼び出し側の責務)。
   */
  readonly distance: number;
  /** 角の作り方。省略時は `arc`。 */
  readonly joinType?: OffsetJoinType;
}

/** オフセットで得た輪郭 1 本。curves は輪郭をたどる順・向きに並ぶ。 */
export interface OffsetContour {
  readonly curves: readonly CurveSpec[];
  /** 輪郭が閉じているか。面の境界に使えるのは閉じているものだけ。 */
  readonly closed: boolean;
}

/** 曲線が 1 本も無い依頼。 */
const NO_CURVE_MESSAGE = '輪郭をオフセットするには曲線が 1 本以上必要です。';

/** 距離が数でない依頼。 */
const INVALID_DISTANCE_MESSAGE = 'オフセットの距離は数で指定してください。';

/** 元の曲線がつながっていないとき(makePlanarFace と同じ文言に揃える)。 */
const NOT_CONNECTED_MESSAGE = '選んだ線・円弧がつながっていないため、輪郭を作れませんでした。';

/** 内側へ寄せすぎて輪郭が潰れたとき(計画書 タスク16 の検証表の文言)。 */
const TOO_FAR_INSIDE_MESSAGE = 'これ以上内側にはオフセットできません。';

/** 外側(または距離 0)で作れなかったとき。 */
const OFFSET_FAILED_MESSAGE = 'その距離ではオフセットできませんでした。距離を変えてください。';

/** 結果に輪郭が 1 本も無かったとき。 */
const EMPTY_RESULT_MESSAGE = 'オフセットの結果が空になりました。距離を変えてください。';

/** 結果に線分・円弧以外の曲線が現れたとき(未対応)。 */
const UNSUPPORTED_CURVE_MESSAGE =
  'オフセットの結果に線分・円弧では表せない曲線が現れたため、まだ扱えません。';

/** 述語ガードが偽になったとき(下の isJoinType の注釈を参照)。 */
const KERNEL_NOT_READY_MESSAGE =
  '幾何カーネルの準備ができていません。アプリを再読み込みしてください。';

const TAU = 2 * Math.PI;

/**
 * BRepOffsetAPI_MakeOffset_3 の構築は列挙(GeomAbs_JoinType)を引数に取り、
 * 型定義では「3 つの値をまとめた入れ物の型」
 * (`{ GeomAbs_Arc: {}; GeomAbs_Tangent: {}; GeomAbs_Intersection: {} }`)になっている。
 * 渡したい値 `oc.GeomAbs_JoinType.GeomAbs_Arc` の型は**空の型 `{}`** なので、
 * そのままでは引数の型に合わず型検査を通らない(makeFillet.ts の ChFi3d_FilletShape と同じ壁)。
 *
 * **2026-09-04 に Node で実測した結果:** 実行時には
 * `new oc.BRepOffsetAPI_MakeOffset_3(wire, oc.GeomAbs_JoinType.GeomAbs_Arc, false)` が
 * そのまま構築でき、40×30 の矩形を +5 で丸角のオフセット(面積 1978.539816339745)が得られた。
 * 列挙値の中身は `{}` で `value` に 0(Arc)/ 1(Tangent)/ 2(Intersection)が入っている。
 * つまり**壁は型検査だけ**である。値をそのまま返す書き方で `pnpm run typecheck` を
 * 実行すると
 * `TS2739: Type '{}' is missing the following properties from type 'GeomAbs_JoinType':
 * GeomAbs_Arc, GeomAbs_Tangent, GeomAbs_Intersection` が 2 件出た(2026-09-04 実測)。そこで
 * **`unknown` を経由する述語ガード 1 つ**で絞る。これは統括が計画書 §0.a-0.23 で
 * 承認した 2 か所のうちの 1 つ(オフセット)で、`as` / `any` / `@ts-ignore` /
 * `eslint-disable` は 1 つも使っていない。
 *
 * **この判定が確かめられること:** 「値が null でないオブジェクトであること」だけ。
 * **確かめられないこと(限界):** それが本当に GeomAbs_JoinType の列挙値かどうか。
 * embind が作る列挙値は中身の見えない空のオブジェクトなので、形を見て見分ける手立てが無い。
 * したがってこのガードは「OCCT の読み込みが済んでいない/壊れている」ことだけを捕まえる網である。
 *
 * **他の箇所へ広げない。** 別の API で同じ壁に当たったら、写す前に統括へ諮る。
 */
function isJoinType(value: unknown): value is GeomAbs_JoinType {
  return typeof value === 'object' && value !== null;
}

/** -0 を +0 へ揃える(subShapes.ts と同じ理由。値の揺れを持ち込まない)。 */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/** 点を数値 3 つのタプルへ直す。 */
function pointToTuple(point: gp_Pnt): Vec3Tuple {
  return [normalizeZero(point.X()), normalizeZero(point.Y()), normalizeZero(point.Z())];
}

/** 向きを数値 3 つのタプルへ直す。sign に -1 を渡すと反転する。 */
function directionToTuple(direction: gp_Dir, sign: number): Vec3Tuple {
  return [
    normalizeZero(direction.X() * sign),
    normalizeZero(direction.Y() * sign),
    normalizeZero(direction.Z() * sign),
  ];
}

/**
 * 開始角を [0, 2π) へ寄せ、掃き角ぶんを終了角にする。
 *
 * OCCT が返す円のパラメータは角度(ラジアン)そのものだが、2π を超える値も出る
 * (実測: 半円をオフセットした辺が [2π, 3π] で返った)。同じ弧を指す角の組は
 * 2π の倍数ぶん自由に選べるので、開始角を 0 以上 2π 未満へ揃えて値のばらつきを無くす。
 * 掃き角(終了角 − 開始角)は必ず正のまま保つので、全周(2π)も潰れない。
 */
function normalizeArcAngles(start: number, end: number): { start: number; end: number } {
  const sweep = end - start;
  const shifted = start % TAU;
  const normalized = shifted < 0 ? shifted + TAU : shifted;
  return { start: normalizeZero(normalized), end: normalizeZero(normalized + sweep) };
}

/**
 * 辺 1 本を線分または円弧の指定へ直す。
 *
 * `reversed` は「ワイヤをたどる向きが、下地の曲線のパラメータの向きと逆」という意味。
 * BRepAdaptor_Curve は辺の向きを見ずに下地の曲線をそのまま渡す(subShapes.ts と同じ実測)ので、
 * 逆向きの辺はここで向きを直す。
 *
 * - 線分: 始点と終点を入れ替える。
 * - 円弧: 法線を反転し、角度の符号を反転して入れ替える。
 *   法線を −n にすると第 2 軸(n × x)も反転するので、角 t の点は角 −t の点になる。
 *   よって [first, last] を逆にたどるのは、法線 −n のもとで [−last, −first] を
 *   たどるのと同じ形・同じ向きになる。
 *
 * 線分・円弧以外(B スプライン等)は、この段では表せないので理由をつけて断る。
 */
function readCurveOfEdge(
  oc: OpenCascadeInstance,
  edge: TopoDS_Edge,
  reversed: boolean,
  allocations: Allocations,
): CurveSpec {
  const { keep } = allocations;
  const adaptor = keep(new oc.BRepAdaptor_Curve_2(edge));
  const curveType = adaptor.GetType();
  const kinds = oc.GeomAbs_CurveType;
  const first = adaptor.FirstParameter();
  const last = adaptor.LastParameter();

  if (curveType === kinds.GeomAbs_Line) {
    const start = pointToTuple(keep(adaptor.Value(first)));
    const end = pointToTuple(keep(adaptor.Value(last)));
    return reversed
      ? { kind: 'segment', from: end, to: start }
      : { kind: 'segment', from: start, to: end };
  }

  if (curveType === kinds.GeomAbs_Circle) {
    const circle = keep(adaptor.Circle());
    const axis = keep(circle.Axis());
    const normal = keep(axis.Direction());
    const position = keep(circle.Position());
    const xDirection = keep(position.XDirection());
    const center = pointToTuple(keep(circle.Location()));
    const angles = reversed ? normalizeArcAngles(-last, -first) : normalizeArcAngles(first, last);
    return {
      kind: 'arc',
      center,
      normal: directionToTuple(normal, reversed ? -1 : 1),
      xAxis: directionToTuple(xDirection, 1),
      radius: normalizeZero(circle.Radius()),
      startAngle: angles.start,
      endAngle: angles.end,
    };
  }

  throw new Error(UNSUPPORTED_CURVE_MESSAGE);
}

/**
 * ワイヤ 1 本を、つながる順の線分・円弧の列へ直す。
 *
 * BRepTools_WireExplorer は辺を**つながる順**に返す(TopExp.MapShapes_2 の並びは
 * つながる順とは限らないので、輪郭を組み立て直すこちらでは使えない)。
 */
function readContour(
  oc: OpenCascadeInstance,
  wire: TopoDS_Wire,
  allocations: Allocations,
): OffsetContour {
  const { keep } = allocations;
  const explorer = keep(new oc.BRepTools_WireExplorer_2(wire));
  const reversedOrientation = oc.TopAbs_Orientation.TopAbs_REVERSED;
  const curves: CurveSpec[] = [];

  while (explorer.More()) {
    const edge = keep(explorer.Current());
    const reversed = explorer.Orientation() === reversedOrientation;
    curves.push(readCurveOfEdge(oc, edge, reversed, allocations));
    explorer.Next();
  }

  return { curves, closed: wire.Closed_1() };
}

/** 結果の形からワイヤを取り出す。距離 0 のときだけ COMPOUND で返る(2026-09-04 実測)。 */
function collectWires(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  allocations: Allocations,
): readonly TopoDS_Wire[] {
  const { keep } = allocations;
  const wireType = oc.TopAbs_ShapeEnum.TopAbs_WIRE;

  if (shape.ShapeType() === wireType) {
    return [keep(oc.TopoDS.Wire_1(shape))];
  }

  const subShapes = keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_2(shape, subShapes, true, true);
  const wires: TopoDS_Wire[] = [];
  const count = Number(subShapes.Size());
  for (let position = 1; position <= count; position += 1) {
    const subShape = keep(subShapes.FindKey(position));
    if (subShape.ShapeType() === wireType) {
      wires.push(keep(oc.TopoDS.Wire_1(subShape)));
    }
  }
  return wires;
}

/** 列挙値を 1 つ選び、述語ガードで絞る(isJoinType の注釈を参照)。 */
function joinTypeValue(oc: OpenCascadeInstance, joinType: OffsetJoinType): GeomAbs_JoinType {
  const value: unknown =
    joinType === 'intersection'
      ? oc.GeomAbs_JoinType.GeomAbs_Intersection
      : oc.GeomAbs_JoinType.GeomAbs_Arc;
  if (!isJoinType(value)) {
    throw new Error(KERNEL_NOT_READY_MESSAGE);
  }
  return value;
}

/**
 * 輪郭を距離 d でオフセットした曲線の列を作る(FR-321)。
 *
 * **閉じているか開いているかは、組み立てたワイヤ自身に聞く。**
 * 閉じた輪郭は IsOpenResult を false にして閉じた輪郭を得る。開いた輪郭は true にして
 * 「片側へずらした 1 本の曲線」を得る(false にすると元の折れ線を取り囲む閉じた輪郭になり、
 * 利用者が期待する「線を平行にずらす」とは別物になる。2026-09-04 実測)。
 *
 * **失敗の見方(2026-09-04 に Node で実測):** 内側へ寄せすぎて輪郭が消える場合
 * (半径 10 の円に −10 / −15)は例外にならず `IsDone()` が false になる。
 * `IsDone()` を見る前に `Shape()` を呼ぶと C++ 例外が飛ぶ
 * (docs/報告記録.md 2026-09-03 06:56 の⑤と同じ扱い)ので、必ず先に成否を見る。
 */
export function makeOffsetWire(
  oc: OpenCascadeInstance,
  spec: OffsetWireSpec,
): readonly OffsetContour[] {
  if (spec.curves.length === 0) {
    throw new Error(NO_CURVE_MESSAGE);
  }
  if (!Number.isFinite(spec.distance)) {
    throw new Error(INVALID_DISTANCE_MESSAGE);
  }

  const join = joinTypeValue(oc, spec.joinType ?? 'arc');
  const allocations = createAllocations();
  const { keep, release } = allocations;

  try {
    const wireMaker = keep(new oc.BRepBuilderAPI_MakeWire_1());
    for (const curve of spec.curves) {
      wireMaker.Add_1(keep(makeCurveEdge(oc, curve)).edge);
    }
    if (!wireMaker.IsDone()) {
      throw new Error(NOT_CONNECTED_MESSAGE);
    }

    const spine = keep(wireMaker.Wire());
    const maker = keep(new oc.BRepOffsetAPI_MakeOffset_3(spine, join, !spine.Closed_1()));

    try {
      // 第 2 引数 Alt は「代わりの高さ」で、平面の輪郭では 0 が既定の使い方。
      maker.Perform(spec.distance, 0);
    } catch (error) {
      // embind 越しの C++ 例外は数値(実体へのポインタ)で飛ぶので、理由へ直す
      // (makeFillet.ts と同じ扱い)。自分で投げた Error はそのまま通す。
      throw error instanceof Error ? error : new Error(OFFSET_FAILED_MESSAGE);
    }

    if (!maker.IsDone()) {
      throw new Error(spec.distance < 0 ? TOO_FAR_INSIDE_MESSAGE : OFFSET_FAILED_MESSAGE);
    }

    const shape = keep(maker.Shape());
    const contours = collectWires(oc, shape, allocations).map((wire) =>
      readContour(oc, wire, allocations),
    );
    const filled = contours.filter((contour) => contour.curves.length > 0);
    if (filled.length === 0) {
      throw new Error(EMPTY_RESULT_MESSAGE);
    }
    return filled;
  } finally {
    release();
  }
}
