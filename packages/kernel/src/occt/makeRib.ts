import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type { CurveSpec, Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import type { BooleanResult } from './booleanOp.js';
import { booleanOp } from './booleanOp.js';
import { makeCurveEdge } from './makeSketchEdges.js';
import { distanceBetween } from './measureShape.js';
import { measureVolume } from './solidMesh.js';
import { booleanMargin, boundingDiagonal } from './subShapes.js';
import { makeCompound } from './transformShape.js';

/**
 * リブ(FR-420、計画書 P5 §0.a-0.37・タスク38)。
 *
 * **リブは「開いた線に厚みを付けた壁を、立体に当たるまで伸ばして足す」加工である。**
 * 閉じた輪郭が要らないところが押し出し(FR-401)との違いで、板の補強に使う。
 *
 * **作り方(4 段):**
 *   ① 輪郭(開いた線)から 1 本のワイヤを組み、法線の向きへ `thickness` ぶん押し出して
 *      薄い帯(シェル)にする。`symmetric` なら先に法線の逆へ `thickness / 2` ずらす。
 *   ② その帯を `direction` へ、対象と帯の両方を包む境界箱の対角ぶん(+ 余裕)押し出して
 *      長い壁にする。**`extendToBody: false` のときだけ、長さを輪郭の長さにする**
 *      (タスク42c。材料に届かなければ断る)。
 *   ③ 壁から対象を**引く**(`Cut`)。残った塊のうち**帯に接している塊だけ**を採る。
 *      これが「輪郭から材料に当たるまで」の部分、すなわちリブの本体になる。
 *   ④ 対象と `Fuse` して 1 つの立体にする。
 *
 * **③ で `Common`(対象の内側)ではなく `Cut`(対象の外側)を採る理由:** リブが足す材料は
 * **輪郭と材料の間の空間**であって、材料の内側ではない。計画書タスク38 の検証表の期待値
 * (40×30×10 の板 + 長さ 20・高さ 10・厚み 3 のリブ = 12600 = 12000 + 600)も、
 * 板の**外**に 600 mm³ を足した値になっている。「対象との Common で材料の内側に収まる部分を
 * 求め」という計画書の文だけは、この期待値と合わない(Common を採ると体積は 12000 のまま
 * 1 mm³ も増えない)。**期待値の側を正としてこの実装を書き、統括へ差として報告する。**
 *
 * **タスク33 の `makeExtrudeSolid(end: 'toNext')` を呼べない理由(統括への申し送り):**
 *   1. `toNext` は「対象と `Common` を取り、押し出しの始点に最も近い塊を残す」もので、
 *      残すのは**材料の内側**。リブが要るのは**材料の外側**なので、意味が逆になる。
 *   2. `makeExtrudeSolid` は断面に `makePlanarFace`(閉じた平らな輪郭)を要求する。
 *      リブの断面は開いた線を法線へ掃いた**帯**で、輪郭が円弧を含めば平面ですらない。
 *   同じ手順を 2 か所に書かないため、共通で使えるところ(境界箱の対角 `boundingDiagonal`、
 *   コンパウンド `makeCompound`、和 `booleanOp`)は既存の関数をそのまま呼んでいる。
 *   「長い角柱を作って余裕を足す」決めも `subShapes.ts` の `booleanMargin` 1 か所へ
 *   まとめてあり(§0.a-0.78、タスク42b)、`makeSolidSweep.ts` と同じ値になる。
 */

/** 「厚みが出た」とみなす体積の下限(mm³)。makeSolidSweep.ts と同じ考え方。 */
const MIN_SOLID_VOLUME = 1e-9;

/**
 * 「帯に接している」とみなす距離の上限(mm)。
 * 2026-09-05 に Node で実測したところ、リブの本体になる塊と帯の距離は
 * ちょうど 0、材料の向こう側の塊は 5〜30 mm と桁が違ったので、
 * 丸めのぶんだけ見る細い網で足りる。
 */
const TOUCH_TOLERANCE_MM = 1e-6;

/** 壁が対象に届いたかを長さで見るときの許容(mm)。境界箱の丸めのぶん。 */
const REACH_TOLERANCE_MM = 1e-6;

/** 輪郭が 1 本も選ばれていないとき(計画書 タスク38 の検証表の文言)。 */
const NO_PROFILE_MESSAGE = 'リブの輪郭が選ばれていません。';

/** 厚みが 0 以下のとき(同上)。 */
const THICKNESS_MESSAGE = '厚みは 0 より大きい数にしてください。';

/** 向きが決まらないとき。 */
const NO_DIRECTION_MESSAGE = 'リブの向きが決まりません。輪郭の面と伸ばす向きを確かめてください。';

/** 輪郭がつながっていないとき(makePlanarFace / makeOffsetWire と同じ文言に揃える)。 */
const NOT_CONNECTED_MESSAGE = '選んだ線・円弧がつながっていないため、輪郭を作れませんでした。';

/** 壁を作れなかった・潰れたとき。 */
const NO_THICKNESS_MESSAGE = 'リブに厚みが出ませんでした。厚みと伸ばす向きを見直してください。';

/** 伸ばした先に材料が無かったとき(計画書 タスク38 の検証表の文言、NFR-UX-5)。 */
const NOT_REACHED_MESSAGE = 'リブが立体に届いていません。位置を見直してください。';

/**
 * 「材料まで伸ばさない」リブ(`extendToBody: false`)の壁が材料へ届かないとき。
 *
 * 届かないまま和を取ると**離れた 2 つの塊**になり、1 つのボディという約束が崩れる
 * (§0.a-0.5)。伸ばす長さを利用者が輪郭で決めている以上、勝手に伸ばして
 * つなぐこともできないので、理由をつけて断る(FR-504)。
 */
const NOT_TOUCHING_MESSAGE = 'リブが材料に届きません。';

/** 輪郭がすでに材料の中(または面の上)にあり、足すものが無いとき。 */
const INSIDE_MESSAGE = 'リブの輪郭が立体の中にあります。輪郭を立体の外へ置いてください。';

/** ブーリアンそのものが成立しなかったとき(FR-504、NFR-RE-1)。 */
const RIB_FAILED_MESSAGE = 'リブを作れませんでした。輪郭の位置と向きを見直してください。';

/** リブの依頼(計画書 タスク38)。 */
export interface RibInput {
  /** 輪郭(閉じていなくてよい)。並んだ順につながっていること。 */
  readonly profile: readonly CurveSpec[];
  /** 輪郭の平面の法線。厚みはこの向きへ付ける。 */
  readonly normal: Vec3Tuple;
  /** 壁の厚み(mm)。 */
  readonly thickness: number;
  /** 両側へ付けるか(false なら法線の側だけ)。 */
  readonly symmetric: boolean;
  /** 伸ばす向き(材料へ向かう向き)。 */
  readonly direction: Vec3Tuple;
  /**
   * 材料に届くまで壁を伸ばすか(**省くと true = タスク38 からの振る舞いのまま**)。
   *
   * `false` のときは伸ばす長さを**輪郭の長さ**(稜線の長さの合計)にする。
   * 段の欄に長さが無いので、利用者が引いた輪郭そのものを物差しにするしかなく、
   * model 側の型(`RibFeature.extendToBody`)も「輪郭の長さぶんだけの壁を立てる」と
   * 決めてある(タスク46)。届かない置き方は `NOT_TOUCHING_MESSAGE` で断る。
   */
  readonly extendToBody?: boolean;
}

/**
 * 向きを長さ 1 に揃える。長さが 0 のときや数でないときは null を返す。
 *
 * `makeSolidSweep.ts` に同じ 8 行の関数があるが、あちらは輸出していない
 * (このタスクでは `makeSolidSweep.ts` を変えない決め)。輸出の整理をする
 * タスク42 で共通の置き場へ寄せることを統括へ提案する。
 */
function normalizeDirection(vector: Vec3Tuple): Vec3Tuple | null {
  const [x, y, z] = vector;
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length <= 0) {
    return null;
  }
  return [x / length, y / length, z / length];
}

/**
 * ワイヤの長さ(mm)。`BRepGProp.LinearProperties` は稜線の長さの合計を返す。
 *
 * `makeSweep.ts` に同じ 5 行の関数があるが、あちらは輸出していない
 * (このタスクでは `makeSweep.ts` を変えない決め)。`normalizeDirection` と同じく、
 * 輸出の整理をするときに共通の置き場へ寄せることを統括へ提案する。
 */
function wireLength(
  oc: OpenCascadeInstance,
  wire: TopoDS_Shape,
  keep: Allocations['keep'],
): number {
  const properties = keep(new oc.GProp_GProps_1());
  // 第 3・第 4 引数は SkipShared と UseTriangulation(solidMesh.ts の測り方と同じ指定)。
  oc.BRepGProp.LinearProperties(wire, properties, false, false);
  return properties.Mass();
}

/** 形を向きへ平行移動した複製を作る(もとの形は変えない)。 */
function translateShape(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  shape: TopoDS_Shape,
  offset: Vec3Tuple,
): TopoDS_Shape {
  const trsf = keep(new oc.gp_Trsf_1());
  trsf.SetTranslation_1(keep(new oc.gp_Vec_4(offset[0], offset[1], offset[2])));
  // 第 3 引数 Copy = true は「下地の幾何ごと複製する」指定(transformShape.ts と同じ理由)。
  const mover = keep(new oc.BRepBuilderAPI_Transform_2(shape, trsf, true));
  if (!mover.IsDone()) {
    throw new Error(NO_THICKNESS_MESSAGE);
  }
  return keep(mover.Shape());
}

/** 形を向きへ長さ length だけ押し出す。 */
function extrude(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  shape: TopoDS_Shape,
  direction: Vec3Tuple,
  length: number,
): TopoDS_Shape {
  const vector = keep(
    new oc.gp_Vec_4(direction[0] * length, direction[1] * length, direction[2] * length),
  );
  // 第 3・4 引数は Copy / Canonize。makeSolidSweep.ts で実測ずみの決めに合わせる。
  const maker = keep(new oc.BRepPrimAPI_MakePrism_1(shape, vector, false, true));
  // 成否は IsDone() だけで見る(Error() の戻り値は型定義が空の型で、比較に強制変換が要る)。
  if (!maker.IsDone()) {
    throw new Error(NO_THICKNESS_MESSAGE);
  }
  return keep(maker.Shape());
}

/** 形が向きに沿って占める範囲(原点からの符号つき距離、mm)。中身が無ければ null。 */
interface AdvanceRange {
  readonly min: number;
  readonly max: number;
}

/**
 * 境界箱から、向きに沿って占める範囲を求める。
 *
 * 塊がどこから始まるかを見るためだけに使うので、厳密な形ではなく境界箱で足りる
 * (境界箱は必ず形を含むので、「接していない」と誤って捨てることが無い)。
 */
function advanceRange(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  shape: TopoDS_Shape,
  direction: Vec3Tuple,
): AdvanceRange | null {
  const box = keep(new oc.Bnd_Box_1());
  // 第 3 引数 false は「三角形分割を使わず厳密な面から測る」指定(subShapes.ts と同じ)。
  oc.BRepBndLib.Add(shape, box, false);
  if (box.IsVoid()) {
    return null;
  }
  box.SetGap(0);
  const low = keep(box.CornerMin());
  const high = keep(box.CornerMax());
  const lows: Vec3Tuple = [low.X(), low.Y(), low.Z()];
  const highs: Vec3Tuple = [high.X(), high.Y(), high.Z()];

  let min = 0;
  let max = 0;
  for (let axis = 0; axis < 3; axis += 1) {
    const a = lows[axis] * direction[axis];
    const b = highs[axis] * direction[axis];
    min += Math.min(a, b);
    max += Math.max(a, b);
  }
  return { min, max };
}

/** 形の中のソリッドをすべて集める(並びは TopExp.MapShapes_2 の順)。 */
function collectSolids(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  shape: TopoDS_Shape,
): TopoDS_Shape[] {
  const subShapes = keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_2(shape, subShapes, true, true);
  const solidType = oc.TopAbs_ShapeEnum.TopAbs_SOLID;
  const solids: TopoDS_Shape[] = [];
  const count = subShapes.Size();

  for (let position = 1; position <= count; position += 1) {
    const subShape = subShapes.FindKey(position);
    if (subShape.ShapeType() === solidType) {
      solids.push(subShape);
    }
  }
  return solids;
}

/**
 * 2 つの形の最短距離(mm)。
 *
 * 測り方は測定(FR-1102)と同じでよいので `measureShape.ts` の `distanceBetween` を呼ぶ
 * (同じ手順を 2 か所に書かない)。あちらが測れずに断ったときは、利用者はいま
 * 「距離を測る」操作ではなくリブを作っているので、リブの言葉へ言い換える。
 */
function shortestDistance(
  oc: OpenCascadeInstance,
  first: TopoDS_Shape,
  second: TopoDS_Shape,
): number {
  try {
    return distanceBetween(oc, first, second).distance;
  } catch {
    throw new Error(RIB_FAILED_MESSAGE);
  }
}

/** 壁を対象で切った塊のうち、リブの本体になるものを選ぶ。 */
interface RibChunks {
  /** 帯に接している塊(リブの本体)。 */
  readonly kept: readonly TopoDS_Shape[];
  /** 採った塊のどれかが壁の端まで届いている(= 途中で材料に当たらなかった)。 */
  readonly reachedFarEnd: boolean;
}

/**
 * 壁 − 対象 の塊から、リブの本体になるものを選ぶ。
 *
 * **選ぶ決まり: 帯(押し出しの始まりの面)に接している塊。** 輪郭から材料までの空間は
 * 必ず帯から始まるのに対し、材料の向こう側へ抜けた塊は材料の厚みぶん帯から離れている。
 * 輪郭が斜めのときは「始まりの位置」が輪郭上の点ごとに違うので、平面 1 枚では切り分けられない
 * (2026-09-05 実測: 水平 + 斜めの 2 本の輪郭で、本体 2 つの距離が 0、
 * 向こう側の 2 つが 20 mm と 24.96 mm)。
 *
 * 距離は 1 回 15〜40ms かかるので、先に境界箱で明らかに離れている塊を落としてから測る。
 * 境界箱は必ず形を含むため、この間引きで本体を取り落とすことは無い。
 */
function selectRibChunks(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  carved: TopoDS_Shape,
  strip: TopoDS_Shape,
  stripRange: AdvanceRange,
  direction: Vec3Tuple,
  wallLength: number,
): RibChunks {
  const kept: TopoDS_Shape[] = [];
  let reachedFarEnd = false;

  for (const chunk of collectSolids(oc, keep, carved)) {
    const range = advanceRange(oc, keep, chunk, direction);
    if (range === null || range.min > stripRange.max + TOUCH_TOLERANCE_MM) {
      continue;
    }
    if (shortestDistance(oc, chunk, strip) > TOUCH_TOLERANCE_MM) {
      continue;
    }
    // 潰れた塊(輪郭に伸ばす向きと平行な辺があるときに出る)は工具に混ぜない。
    if (Math.abs(measureVolume(oc, chunk)) < MIN_SOLID_VOLUME) {
      continue;
    }
    if (range.max >= stripRange.max + wallLength - REACH_TOLERANCE_MM) {
      reachedFarEnd = true;
    }
    kept.push(chunk);
  }

  return { kept, reachedFarEnd };
}

/**
 * 開いた輪郭に厚みを付けた壁を、対象に当たるまで伸ばして足す(FR-420)。
 *
 * 向き(`normal` / `direction`)は model 側で決めて渡す約束(計画書 §0.a-0.8 と同じ流儀)なので、
 * ここでは輪郭の平面を推し量らない。`direction` は輪郭の平面の中の向き(材料へ向かう向き)、
 * `normal` はその平面の法線で、2 つが平行だと壁が潰れるので断る。
 *
 * 返す値は和(`Fuse`)の結果で、判定のために測った体積を持つ(`BooleanResult`)。
 * **引数の `target` は解放しない**(呼び出し側の持ち物。booleanOp.ts と同じ約束)。
 */
export function makeRib(
  oc: OpenCascadeInstance,
  target: TopoDS_Shape,
  input: RibInput,
): BooleanResult {
  if (input.profile.length === 0) {
    throw new Error(NO_PROFILE_MESSAGE);
  }
  if (!Number.isFinite(input.thickness) || input.thickness <= 0) {
    throw new Error(THICKNESS_MESSAGE);
  }

  const normal = normalizeDirection(input.normal);
  const direction = normalizeDirection(input.direction);
  if (normal === null || direction === null) {
    throw new Error(NO_DIRECTION_MESSAGE);
  }
  // 省略は「材料まで伸ばす」(タスク38 からの振る舞い)。
  const extendToBody = input.extendToBody ?? true;

  const { keep, release } = createAllocations();

  try {
    // ① 輪郭 → ワイヤ → 帯(厚みの向きへ掃いたシェル)。
    const wireMaker = keep(new oc.BRepBuilderAPI_MakeWire_1());
    for (const curve of input.profile) {
      wireMaker.Add_1(keep(makeCurveEdge(oc, curve)).edge);
    }
    if (!wireMaker.IsDone()) {
      throw new Error(NOT_CONNECTED_MESSAGE);
    }
    const wire = keep(wireMaker.Wire());

    const half = input.thickness / 2;
    const base = input.symmetric
      ? translateShape(oc, keep, wire, [-normal[0] * half, -normal[1] * half, -normal[2] * half])
      : wire;
    const strip = extrude(oc, keep, base, normal, input.thickness);

    // ② 帯を材料の向きへ伸ばす。対象と帯の両方を包む箱の対角に余裕を足した長さなら、
    //    輪郭が対象からどれだけ離れていても必ず突き抜ける。
    const bothShapes = keep(makeCompound(oc, [target, strip]));
    const diagonal = boundingDiagonal(oc, bothShapes.shape);
    if (!(diagonal > 0)) {
      throw new Error(NOT_REACHED_MESSAGE);
    }
    // 壁を伸ばす長さの余裕(§0.a-0.12、makeSolidSweep.ts の `toNext` と同じ決め)。
    // 対象の面とちょうど接する形はブーリアンが最も苦手なので、必ず突き抜けさせる。
    //
    // **「材料まで伸ばさない」(`extendToBody: false`)ときだけ、長さを輪郭の長さにする。**
    // 分岐はこの 1 行だけで、③④(壁 − 対象 → 帯に接する塊 → 和)はどちらでも同じ道を通る。
    const wallLength = extendToBody
      ? diagonal + 2 * booleanMargin(diagonal)
      : wireLength(oc, wire, keep);
    const wall = extrude(oc, keep, strip, direction, wallLength);

    // 法線と伸ばす向きが平行だと、帯を自分の面の中で掃くことになり体積が出ない。
    if (Math.abs(measureVolume(oc, wall)) < MIN_SOLID_VOLUME) {
      throw new Error(NO_THICKNESS_MESSAGE);
    }

    // 伸ばさないときは、壁が材料に当たっているかを先に見る(当たっていなければ和が
    // 離れた 2 つの塊になる)。ブーリアンより手前で断るほうが速く、理由も正しく出せる。
    if (!extendToBody && shortestDistance(oc, wall, target) > TOUCH_TOLERANCE_MM) {
      throw new Error(NOT_TOUCHING_MESSAGE);
    }

    // ③ 壁から対象を引き、帯に接している塊(= 輪郭から材料までの空間)だけを残す。
    const carver = keep(
      new oc.BRepAlgoAPI_Cut_3(wall, target, keep(new oc.Message_ProgressRange_1())),
    );
    // 成否は HasErrors() と IsDone() だけで見る(booleanOp.ts と同じ理由)。
    if (carver.HasErrors() || !carver.IsDone()) {
      throw new Error(RIB_FAILED_MESSAGE);
    }
    const carved = keep(carver.Shape());

    const stripRange = advanceRange(oc, keep, strip, direction);
    if (stripRange === null) {
      throw new Error(NO_THICKNESS_MESSAGE);
    }
    const { kept, reachedFarEnd } = selectRibChunks(
      oc,
      keep,
      carved,
      strip,
      stripRange,
      direction,
      wallLength,
    );

    // 壁の端まで届いた = 途中で材料に当たらなかった。どこまで伸ばすかが決まらないので断る。
    // **伸ばさないときは端まで残るのが当たり前**(長さを輪郭が決めている)なので見ない。
    // 材料に当たっているかは、壁を作った直後に距離で確かめてある。
    if (extendToBody && reachedFarEnd) {
      throw new Error(NOT_REACHED_MESSAGE);
    }
    // 帯から始まる塊が 1 つも無い = 輪郭がすでに材料の中か面の上にある(足すものが無い)。
    if (kept.length === 0) {
      throw new Error(INSIDE_MESSAGE);
    }

    // ④ 対象と和を取る。塊が複数のときはコンパウンドにまとめて 1 回で足す
    //    (塊どうしは重なっていないので、重なる工具の落とし穴は起きない)。
    const tool = kept.length === 1 ? kept[0] : keep(makeCompound(oc, kept)).shape;
    return booleanOp(oc, 'union', target, tool);
  } finally {
    // 和の結果は自分の中に形を持つので、材料になった塊はここで解放してよい
    // (makeHole.ts が工具を解放するのと同じ)。
    release();
  }
}
