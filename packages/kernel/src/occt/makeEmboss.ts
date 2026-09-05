import type {
  OpenCascadeInstance,
  TopoDS_Face,
  TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';

import type { CurveSpec, SubShapeQuery, Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import type { BooleanResult } from './booleanOp.js';
import { booleanOp } from './booleanOp.js';
import { makePlanarFace } from './makePlanarFace.js';
import { matchFace } from './matchSubShape.js';
import { measureArea, measureVolume } from './solidMesh.js';
import type { SubShapeTables } from './subShapes.js';
import { booleanMargin, boundingDiagonal, faceAt } from './subShapes.js';
import { makeCompound } from './transformShape.js';

/**
 * エンボス・刻印(FR-421、FR-504、計画書 P5 §0.a-0.38・タスク39)。
 *
 * **平らな面の上に置いた閉じた輪郭を、面の法線の向きに深さぶん押し出して、
 * 足す(浮き出す = `Fuse`)か引く(彫る = `Cut`)。** 銘板の文字や模様の刻印に使う。
 *
 * **平らな面だけを相手にする(§0.a-0.38 の決定)。** 曲面へ輪郭を沿わせる「ラップ」は
 * 投影と曲がった面での押し出しが要り、自由曲面に近づくので P6 以降へ回してある。
 *
 * **輪郭は世界座標で来る(model 側が面の上に置く)。** この関数は受け取った輪郭を
 * 面の平面へ落として(丸めのぶんのずれを吸収して)から押し出す。面と平行でない輪郭は、
 * 押し出しても「面から測った深さ」が輪郭上の点ごとに変わって意味が定まらないので断る。
 *
 * **作り方(接する形を避ける。P3 §0.a-0.12):**
 *   ① 面を指紋で選び直し、平面であることを確かめる。面の向きが `TopAbs_REVERSED` の
 *      ときは法線の符号を反転して、必ず材料の外を向く向きにする。
 *   ② 輪郭ごとに平らな面を 1 枚張り、面の平面へ落とす。
 *   ③ 落とした輪郭が対象の面からはみ出していないかを、面どうしの共通部分の面積で確かめる。
 *   ④ 押し出す向き(浮き出すなら法線、彫るなら法線の逆)へ、**面より `margin` 手前から**
 *      `depth + margin` だけ押し出す。手前のぶんは材料の中(浮き出す)か材料の外(彫る)に
 *      収まるので、増減する体積は輪郭の面積 × `depth` ちょうどになる。
 *   ⑤ 工具をコンパウンドへまとめ、**ブーリアンは 1 回**(makeHole.ts と同じ理由)。
 *
 * **`makeExtrudeSolid`(タスク33)を呼ばない理由:** あちらは断面 1 つを受け取って
 * 押し出した角柱そのものを返す関数で、`margin` ぶん手前から押し始める決めも、
 * 面の指紋から向きを決める段も持たない。ここで要るのは「面の上の複数の輪郭を
 * まとめて 1 つの工具にして 1 回のブーリアンで足し引きする」ことなので、
 * 共通で使えるところ(`makePlanarFace` / `makeCompound` / `booleanOp` /
 * `boundingDiagonal`)だけを呼んでいる。「長い形に余裕を足す」決めも
 * `subShapes.ts` の `booleanMargin` 1 か所へまとめてあり(§0.a-0.78、タスク42b)、
 * `makeSolidSweep.ts` / `makeHole.ts` / `makeRib.ts` / `makeCut.ts` と同じ値になる。
 */

/** これ未満(mm³)の増減は「形が変わらなかった」とみなす(booleanOp.ts と同じ下限)。 */
const MIN_CHANGED_VOLUME_MM3 = 1e-9;

/**
 * 「輪郭の平面が面と平行」とみなす法線の内積のしきい値。
 * `gp_Dir` は長さ 1 に揃っているので、内積の絶対値がこれを超えていれば平行とみなす。
 */
const PARALLEL_DOT = 1 - 1e-7;

/**
 * はみ出しの判定に使う面積の許容(相対)。
 * 輪郭の面と対象の面の共通部分の面積が、輪郭の面積のこの割合ぶんも欠けていれば
 * 「はみ出している」とみなす。ブーリアンの丸めのぶんだけ見る細い網で足りる。
 */
const AREA_TOLERANCE_RATIO = 1e-6;

/** 面が選び直せなかったとき(FR-504、§2.2.5)。 */
const MISSING_FACE_MESSAGE =
  'エンボスするもとの面が見つかりません。形が大きく変わったため、選び直してください。';

/** 曲面を指されたとき(§0.a-0.38。曲面へのラップは P6 以降)。 */
const NOT_PLANAR_MESSAGE = '彫れるのは平らな面だけです。平らな面を選び直してください。';

/** 輪郭が 1 本も来なかったとき。 */
const NO_PROFILE_MESSAGE = 'エンボスの輪郭が選ばれていません。';

/** 深さが 0 以下・非数のとき。 */
const DEPTH_MESSAGE = '深さは 0 より大きい数にしてください。';

/** 輪郭の平面が面と平行でないとき(深さの測り方が定まらない)。 */
const NOT_PARALLEL_MESSAGE = '輪郭が面と平行ではありません。面の上に輪郭を置いてください。';

/** 輪郭が面の外へはみ出しているとき(NFR-UX-5)。 */
const OUT_OF_FACE_MESSAGE = '輪郭が面からはみ出しています。輪郭を面の中に収めてください。';

/** 押し出しや面の平面の読み取りが成立しなかったとき。 */
const EMBOSS_FAILED_MESSAGE = 'エンボスを作れませんでした。輪郭の位置と深さを見直してください。';

/** ブーリアンは通ったのに形が変わらなかったとき。 */
const NO_CHANGE_MESSAGE = 'エンボスで形が変わりませんでした。深さと輪郭の位置を見直してください。';

/** エンボス 1 段の依頼(計画書 タスク39 の実装内容)。 */
export interface EmbossInput {
  /** 彫る(浮き出す)相手の面の指紋。平らな面だけ。 */
  readonly face: SubShapeQuery;
  /** 面の上に置いた閉じた輪郭。複数可(文字・模様の輪郭を想定)。 */
  readonly profiles: readonly (readonly CurveSpec[])[];
  /** 面から測った深さ(mm)。0 より大きいこと。 */
  readonly depth: number;
  /** true なら浮き出す(和)、false なら彫る(差)。 */
  readonly raised: boolean;
}

/** -0 を +0 へ揃える(subShapes.ts と同じ理由: 値を揺らさない)。 */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function dot(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** 長さ 1 へ揃える。長さが取れない(0・非数)ときは null。 */
function toUnit(value: Vec3Tuple): Vec3Tuple | null {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!Number.isFinite(length) || length <= 0) {
    return null;
  }
  return [
    normalizeZero(value[0] / length),
    normalizeZero(value[1] / length),
    normalizeZero(value[2] / length),
  ];
}

/** 面の平面(法線と平面上の 1 点)。 */
interface PlaneFrame {
  /** 材料の外を向く単位法線。 */
  readonly normal: Vec3Tuple;
  readonly pointOnPlane: Vec3Tuple;
}

/**
 * 面の平面から、外向きの法線と平面上の 1 点を読む。
 *
 * `gp_Pln` が持つ軸は面の向き(Orientation)を見ていないので、面が `TopAbs_REVERSED` の
 * ときは符号を反転して**必ず材料の外を向く**ようにする(makeHole.ts の `readPlaneFrame`・
 * makeDraft.ts の `readNeutralPlane`・subShapes.ts の `readFaceGeometry` と同じ規則)。
 * これを入れないと、浮き出すつもりが材料の中へ潜り、彫るつもりが外へ飛び出す。
 */
function readPlaneFrame(
  oc: OpenCascadeInstance,
  face: TopoDS_Face,
  keep: Allocations['keep'],
  reverseByOrientation: boolean,
): PlaneFrame {
  // 第 2 引数 false は「面の境界(トリム)を読み込まない」指定(subShapes.ts と同じ)。
  const adaptor = keep(new oc.BRepAdaptor_Surface_2(face, false));
  const plane = keep(adaptor.Plane());
  const direction = keep(keep(plane.Axis()).Direction());
  const reversed =
    reverseByOrientation && face.Orientation_1() !== oc.TopAbs_Orientation.TopAbs_FORWARD;
  const sign = reversed ? -1 : 1;
  const normal = toUnit([
    direction.X() * sign,
    direction.Y() * sign,
    direction.Z() * sign,
  ]);
  if (normal === null) {
    // gp_Dir は構築時に長さ 1 へ揃うので、ここへ来るのは下地の平面が壊れている場合だけ。
    throw new Error(EMBOSS_FAILED_MESSAGE);
  }
  const location = keep(plane.Location());
  return { normal, pointOnPlane: [location.X(), location.Y(), location.Z()] };
}

/** 形を offset だけ平行移動した複製を作る(もとの形は変えない)。 */
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
    throw new Error(EMBOSS_FAILED_MESSAGE);
  }
  return keep(mover.Shape());
}

/** 形を direction の向きへ length だけ押し出す。 */
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
    throw new Error(EMBOSS_FAILED_MESSAGE);
  }
  return keep(maker.Shape());
}

/**
 * 輪郭の面が対象の面の中に収まっているかを確かめる。
 *
 * 2 枚の面の共通部分の面積が輪郭の面積と同じなら、輪郭は面の中にある。
 * はみ出していると共通部分がその面積ぶん欠けるので見分けられる。
 *
 * **はみ出しを黙って通さない理由(2026-09-05 に Node で実測):** 計画書 タスク39 の検証表は
 * 「はみ出した部分は効かない見込み」と書いているが、40×30×10 の板の上面へ 10×10 の輪郭を
 * 縁(x = 40)の真上に半分はみ出させて深さ 2 を掛けたところ、
 *   - 彫る  : 体積 11900(= 12000 − 50×2)、面 10 枚。輪郭の半分だけが効いた欠けた形。
 *   - 浮き出す: 体積 12275.495097567966、面 12 枚。**面積 × 深さ(100)ではなく 275.5 増えた。**
 *     材料の外へ出た半分には「接する形を避けるための余裕」(`margin`、この板では 1.5099mm)が
 *     そのまま材料として残り、`12000 + 5×10×2 + 5×10×(2 + margin)` になっていた。
 * つまり浮き出すときは**増える量が margin の取り方で変わる**(利用者からは説明のつかない値になる)。
 * どちらも「深さぶん彫った / 浮き出した」という意図とは違う形なので、断って直し方を示す
 * (NFR-UX-5、FR-504。統括の指示により計画書の「実測して報告」から断りへ変えた)。
 */
function isInsideFace(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  profileFace: TopoDS_Shape,
  targetFace: TopoDS_Face,
): boolean {
  const profileArea = measureArea(oc, profileFace);
  if (!(profileArea > 0)) {
    return false;
  }
  const common = keep(
    new oc.BRepAlgoAPI_Common_3(profileFace, targetFace, keep(new oc.Message_ProgressRange_1())),
  );
  // 成否は HasErrors() と IsDone() だけで見る(booleanOp.ts と同じ理由)。
  if (common.HasErrors() || !common.IsDone()) {
    throw new Error(EMBOSS_FAILED_MESSAGE);
  }
  const shared = measureArea(oc, keep(common.Shape()));
  return shared >= profileArea * (1 - AREA_TOLERANCE_RATIO);
}

/** 面の指紋から、平らな面 1 枚の通し番号を選び直す。 */
function resolvePlanarFaceIndex(
  tables: SubShapeTables,
  query: SubShapeQuery,
  scale: number,
): number {
  if (query.kind !== 'face') {
    // 面以外(辺・頂点)の指紋が来るのは model 側の取り違えだが、
    // 利用者への直し方は同じ(面を選び直す)なので言い分けない。
    throw new Error(MISSING_FACE_MESSAGE);
  }
  const match = matchFace(tables.faces, query, scale);
  if (match === null) {
    throw new Error(MISSING_FACE_MESSAGE);
  }
  // 一覧は通し番号の順で来る約束だが、番号で引き直して並びに依存しないようにする。
  const info = tables.faces.find((candidate) => candidate.index === match.index);
  if (info === undefined) {
    throw new Error(MISSING_FACE_MESSAGE);
  }
  if (info.surfaceKind !== 'plane') {
    throw new Error(NOT_PLANAR_MESSAGE);
  }
  return match.index;
}

/**
 * 輪郭 1 本から工具(押し出した角柱)を 1 つ作る。
 *
 * 手順は「面を張る → 対象の面の平面へ落とす → 平行とはみ出しを確かめる →
 * `margin` 手前から `depth + margin` だけ押し出す」。
 */
function makeEmbossTool(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  profile: readonly CurveSpec[],
  targetFace: TopoDS_Face,
  frame: PlaneFrame,
  push: Vec3Tuple,
  depth: number,
  margin: number,
): TopoDS_Shape {
  if (profile.length === 0) {
    throw new Error(NO_PROFILE_MESSAGE);
  }

  // 閉じていない・自己交差している・同じ平面に乗っていない輪郭は、
  // makePlanarFace が理由つきで断り、その文言がそのまま呼び出し側へ伝わる。
  const drawn = keep(makePlanarFace(oc, profile));

  // 輪郭の平面が面と平行か。平行でなければ「面から測った深さ」が定まらない。
  const profilePlane = readPlaneFrame(oc, drawn.face, keep, false);
  if (Math.abs(dot(profilePlane.normal, frame.normal)) < PARALLEL_DOT) {
    throw new Error(NOT_PARALLEL_MESSAGE);
  }

  // 対象の面の平面へ落とす(投影は model 側の担当だが、丸めのぶんのずれをここで吸収する)。
  const gap = dot(
    [
      profilePlane.pointOnPlane[0] - frame.pointOnPlane[0],
      profilePlane.pointOnPlane[1] - frame.pointOnPlane[1],
      profilePlane.pointOnPlane[2] - frame.pointOnPlane[2],
    ],
    frame.normal,
  );
  const onPlane =
    gap === 0
      ? drawn.face
      : translateShape(oc, keep, drawn.face, [
          -gap * frame.normal[0],
          -gap * frame.normal[1],
          -gap * frame.normal[2],
        ]);

  if (!isInsideFace(oc, keep, onPlane, targetFace)) {
    throw new Error(OUT_OF_FACE_MESSAGE);
  }

  // 押し出す向きの逆へ margin だけ戻った位置から押し始める(面と接する形を作らない)。
  // 戻したぶんは、浮き出すときは材料の中、彫るときは材料の外に収まるので、
  // 増減する体積は輪郭の面積 × depth ちょうどになる。
  const base = translateShape(oc, keep, onPlane, [
    -push[0] * margin,
    -push[1] * margin,
    -push[2] * margin,
  ]);
  return extrude(oc, keep, base, push, depth + margin);
}

/**
 * 面の上の閉じた輪郭を、深さぶん浮き出す(和)か彫る(差)(FR-421)。
 *
 * **引数の `target` は解放しない**(形状キャッシュの持ち物。booleanOp.ts と同じ約束)。
 * `tables` は `target` から作った部分形状の一覧で、別の形から作った一覧を渡すと
 * 「面が見つからない」で断る。工具はこの関数が最後に解放する。
 *
 * 返す値は `booleanOp` の結果そのもので、**測り済みの体積を持ったまま**返る
 * (`BooleanResult` は `OcctShapeHandle` を広げた型なので、計画書 タスク39 の
 * 戻り値の約束はそのまま満たす)。呼び出し側は体積を測り直さずに使える。
 */
export function makeEmboss(
  oc: OpenCascadeInstance,
  target: TopoDS_Shape,
  tables: SubShapeTables,
  input: EmbossInput,
): BooleanResult {
  if (input.profiles.length === 0) {
    throw new Error(NO_PROFILE_MESSAGE);
  }
  if (!Number.isFinite(input.depth) || input.depth <= 0) {
    throw new Error(DEPTH_MESSAGE);
  }

  // 位置の点を正規化する長さ。境界箱の対角長の半分(matchSubShape.ts の scorePosition)。
  const diagonal = boundingDiagonal(oc, target);
  if (!(diagonal > 0)) {
    // 中身の無い形。ここまで来ることは無い想定だが、0 長の工具を作らせない。
    throw new Error(EMBOSS_FAILED_MESSAGE);
  }
  const faceIndex = resolvePlanarFaceIndex(tables, input.face, diagonal * 0.5);
  // 面と接する形を作らないための余裕(§0.a-0.12。makeHole.ts の貫通穴と同じ決め)。
  const margin = booleanMargin(diagonal);

  const { keep, release } = createAllocations();

  try {
    const face = faceAt(oc, target, faceIndex);
    if (face === null) {
      // 一覧の番号が形と食い違っている(別の形から作った一覧を渡された)合図。
      throw new Error(MISSING_FACE_MESSAGE);
    }
    keep(face);

    const frame = readPlaneFrame(oc, face, keep, true);
    // 浮き出すなら面の外(法線の向き)へ、彫るなら材料の中(法線の逆)へ。
    const push: Vec3Tuple = input.raised
      ? frame.normal
      : [-frame.normal[0], -frame.normal[1], -frame.normal[2]];

    const tools: TopoDS_Shape[] = [];
    for (const profile of input.profiles) {
      tools.push(
        makeEmbossTool(oc, keep, profile, face, frame, push, input.depth, margin),
      );
    }

    // 工具は 1 つのコンパウンドへまとめ、ブーリアンは 1 回だけ回す
    // (穴 20 個で 1 回差しが 1 個ずつの 3 倍速い。makeHole.ts の冒頭の実測)。
    const tool = tools.length === 1 ? tools[0] : keep(makeCompound(oc, tools)).shape;
    const result = booleanOp(oc, input.raised ? 'union' : 'subtract', target, tool);

    try {
      // 彫れば減り、浮き出せば増える(計画書 タスク39 の手順3)。変わらないなら、
      // 輪郭がすでに材料の外(浮き出す側に何も無い)などで意図が果たせていない。
      const change = result.volume - measureVolume(oc, target);
      const changed = input.raised
        ? change >= MIN_CHANGED_VOLUME_MM3
        : change <= -MIN_CHANGED_VOLUME_MM3;
      if (!changed) {
        throw new Error(NO_CHANGE_MESSAGE);
      }
      return result;
    } catch (error) {
      result.delete();
      throw error;
    }
  } finally {
    // ブーリアンの結果は自分の中に形を持つので、工具はここで解放してよい
    // (makeHole.ts が工具を解放するのと同じ)。断ったときも同じ経路で全部返す。
    release();
  }
}
