import type {
  OpenCascadeInstance,
  TopoDS_Face,
  TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';

import type { ExtrudeStepSpec, RevolveStepSpec, TessellationOptions, Vec3Tuple } from '../types.js';
// 確保したものをまとめて解放する入れ物は allocations.ts が正本(計画書 タスク2)。
// P3 の加工(穴・ねじ・面取り)も同じ入れ物を使うので、ここでは持たない。
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makePlanarFace } from './makePlanarFace.js';
import { isValidShape, measureVolume } from './solidMesh.js';
import { boundingDiagonal } from './subShapes.js';

/**
 * BRepPrimAPI_MakePrism_1 / BRepPrimAPI_MakeRevol_1 の Copy に渡す値。
 *
 * 2026-09-03 に Node で実測(計画書 §1.2 の未確認点 1 の後半):
 *   40 × 30 の断面を 10 押し出したとき Copy=true / false のどちらでも
 *   体積 12000、面 6、稜線 12、妥当性 true で結果が変わらなかった。
 * 断面は毎回この関数の中で作り捨てるので複製する意味が無く、OCCT の C++ 側の
 * 既定値と同じ false を採る。
 */
const SWEEP_COPY = false;

/**
 * BRepPrimAPI_MakePrism_1 の Canonize に渡す値。
 *
 * 2026-09-03 に Node で実測(計画書 §1.2 の未確認点 1):
 *   10 × 10 の正方形を Z へ 5 押し出したとき
 *     Canonize=true  体積 500 / 面 6 / 稜線 12 / 平面 6 枚
 *     Canonize=false 体積 500 / 面 6 / 稜線 12 / 平面 2 枚 + 押し出し曲面 4 枚
 *   体積と面数はどちらも同じで、違うのは側面の下地の曲面だけだった。
 *
 * true を採る。平らな断面を押し出した側面は本来ただの平面であり、
 * 平面として持っておいたほうが後段のブーリアン(タスク5)や面の選択が素直に働くため。
 */
const PRISM_CANONIZE = true;

/**
 * 「厚みが出た」とみなす体積の下限(mm³)。
 * これを下回る形は、押し出しの向きが断面と同じ平面にある、
 * 回転軸が断面の平面に直交している、といった理由で潰れている。
 */
const MIN_SOLID_VOLUME = 1e-9;

/** 回転角の上限(ラジアン)。1 周を超える指定は受け取らない。丸めの揺れぶんだけ余裕を持たせる。 */
const MAX_REVOLVE_ANGLE = 2 * Math.PI + 1e-9;

/**
 * 傾き(テーパ)の上限(ラジアン、この値は含まない)。
 * 90 度では側面が断面と同じ平面へ倒れてしまい、立体にならない。
 */
const MAX_TAPER_ANGLE = Math.PI / 2;

/**
 * 「押し出しの向きに垂直な平面」とみなす法線の内積のしきい値。
 * 上下のふた(押し出しの始まりと終わりの面)を側面と見分けるために使う。
 * 1 に十分近い値で切れば足りる(ふたの法線は向きと平行、側面の法線は直交する)。
 */
const CAP_NORMAL_DOT = 1 - 1e-7;

/**
 * 「次の面まで」で使う角柱の余裕(P3 §0.a-0.12 と同じ決め)。
 * 対象の境界箱の対角長へ `対角長 × MARGIN_RATIO + MARGIN_MIN_MM` を足した長さの角柱を作る。
 * 面とちょうど接する形はブーリアンが最も苦手なので、必ず突き抜けさせる。
 */
const MARGIN_RATIO = 0.01;
const MARGIN_MIN_MM = 1;

/** 傾きの角度が受け取れないとき(FR-504)。 */
const TAPER_RANGE_MESSAGE = '押し出しの傾きは 0 度以上 90 度未満にしてください。';

/** 傾きを付けたら形が作れなかったとき(角度が大きすぎて側面どうしがぶつかる等)。 */
const TAPER_FAILED_MESSAGE = '押し出しに傾きを付けられませんでした。角度を小さくしてください。';

/** 「次の面まで」で、押し出す先に材料が無かったとき(NFR-UX-5)。 */
const NO_MATERIAL_AHEAD_MESSAGE = '押し出す先に立体がありません。';

/**
 * 押し出しの終端の指定(FR-415)。
 *
 * `toFace`(指定の面まで)は model 側が面までの距離を計算して渡す約束なので、
 * カーネルから見ると `distance` と同じ扱いになる。**種類を分けて持つのは、
 * 断りの文言と後段(タスク42・45)の配線で区別が要るため**で、長さの計算は増やさない。
 */
export type ExtrudeEndSpec =
  /** 距離を指定して押し出す(いまと同じ)。 */
  | { readonly kind: 'distance'; readonly distance: number }
  /** 断面の両側へ押し出す。前と後ろの長さを別々に指定できる。 */
  | { readonly kind: 'symmetric'; readonly forward: number; readonly backward: number }
  /** 指定の面まで(model が距離を計算済みなので distance と同じ扱いになる)。 */
  | { readonly kind: 'toFace'; readonly distance: number }
  /** 次にぶつかる面まで。対象の形が要る。 */
  | { readonly kind: 'toNext' };

/**
 * 押し出しに後から足した指定(FR-415、FR-401)。**すべて省略できる。**
 *
 * 省略したときは P2 からの押し出し(`spec.distance` ぶんを片側へ、傾きなし)と
 * 1 ドットも変わらない。`packages/kernel/src/types.ts` の `ExtrudeStepSpec` へ
 * 欄を足すのは計画書のタスク42 の仕事なので、このタスクでは**関数の引数**で受け取る。
 */
export interface ExtrudeShapeOptions {
  /** 終端の指定。省略すると `{ kind: 'distance', distance: spec.distance }` と同じ。 */
  readonly end?: ExtrudeEndSpec;
  /**
   * 側面の傾き(ラジアン)。**大きさだけ**を持ち、0 以上 90 度未満。
   * 向きは `taperOutward` で指定する(抜き勾配(FR-417)の `angle` + `reversed` と同じ持ち方)。
   */
  readonly taperAngle?: number;
  /** true で押し出すほど外へ広がり、false(既定)で内へ絞る。 */
  readonly taperOutward?: boolean;
  /** 「次の面まで」の相手。`end.kind === 'toNext'` のときだけ要る。 */
  readonly target?: TopoDS_Shape | null;
}

/** 向きを長さ 1 に揃える。長さが 0 のときや数でないときは null を返す。 */
function normalizeDirection(vector: Vec3Tuple): Vec3Tuple | null {
  const [x, y, z] = vector;
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length <= 0) {
    return null;
  }
  return [x / length, y / length, z / length];
}

/** 3 つとも実数か(NaN と無限大を弾く)。 */
function isFinitePoint(point: Vec3Tuple): boolean {
  return Number.isFinite(point[0]) && Number.isFinite(point[1]) && Number.isFinite(point[2]);
}

/**
 * 押し出しの「始まりの位置」と「伸ばす長さ」。
 * `startOffset` は断面をどれだけ手前(向きの逆)へずらしてから押し始めるか(mm)。
 */
interface ExtrudeRange {
  readonly startOffset: number;
  readonly length: number;
}

/** 終端の指定から、押し始めの位置と長さを決める。長さが取れないときは日本語で断る。 */
function resolveExtrudeRange(
  oc: OpenCascadeInstance,
  end: ExtrudeEndSpec,
  target: TopoDS_Shape | null,
): ExtrudeRange {
  if (end.kind === 'toNext') {
    if (target === null) {
      throw new Error(NO_MATERIAL_AHEAD_MESSAGE);
    }
    // 対象を必ず突き抜ける長さ。ちょうど接する形はブーリアンが最も苦手なので余裕を足す
    // (P3 §0.a-0.12。makeHole.ts の貫通穴と同じ決め)。
    const diagonal = boundingDiagonal(oc, target);
    if (!(diagonal > 0)) {
      throw new Error(NO_MATERIAL_AHEAD_MESSAGE);
    }
    return { startOffset: 0, length: diagonal + 2 * (diagonal * MARGIN_RATIO + MARGIN_MIN_MM) };
  }
  if (end.kind === 'symmetric') {
    if (
      !Number.isFinite(end.forward) ||
      !Number.isFinite(end.backward) ||
      end.forward < 0 ||
      end.backward < 0 ||
      end.forward + end.backward <= 0
    ) {
      throw new Error('押し出す長さは 0 より大きい数にしてください。');
    }
    return { startOffset: end.backward, length: end.forward + end.backward };
  }
  if (!Number.isFinite(end.distance) || end.distance <= 0) {
    throw new Error('押し出す長さは 0 より大きい数にしてください。');
  }
  return { startOffset: 0, length: end.distance };
}

/**
 * 断面を向きの逆へ `offset` だけずらした面を作る(両側への押し出しの下ごしらえ)。
 * ずらさないとき(offset が 0)はもとの面をそのまま返す。
 */
function shiftFace(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  face: TopoDS_Face,
  direction: Vec3Tuple,
  offset: number,
): TopoDS_Face {
  if (offset === 0) {
    return face;
  }
  const trsf = keep(new oc.gp_Trsf_1());
  trsf.SetTranslation_1(
    keep(
      new oc.gp_Vec_4(-direction[0] * offset, -direction[1] * offset, -direction[2] * offset),
    ),
  );
  // 第 3 引数 Copy = true は「下地の幾何ごと複製する」指定(transformShape.ts と同じ理由)。
  const mover = keep(new oc.BRepBuilderAPI_Transform_2(face, trsf, true));
  if (!mover.IsDone()) {
    throw new Error('断面を押し出せませんでした。断面の形を見直してください。');
  }
  return keep(oc.TopoDS.Face_1(keep(mover.Shape())));
}

/**
 * 押し出した形の「側面」を集める。
 *
 * ふた(押し出しの始まりと終わりの面)は、平面でありその法線が押し出しの向きと平行になる。
 * それ以外はすべて側面である(丸い断面の側面は円筒面になるので、平面かどうかでは選べない)。
 * 部分形状の集め方は solidMesh.ts の `hasSolid` と同じで、列挙を引数に取る
 * TopExp_Explorer を使わず `MapShapes_2` と値どうしの比較で選ぶ。
 */
function collectSideFaces(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  shape: TopoDS_Shape,
  direction: Vec3Tuple,
): TopoDS_Face[] {
  const subShapes = keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_2(shape, subShapes, true, true);
  const faceType = oc.TopAbs_ShapeEnum.TopAbs_FACE;
  const planeType = oc.GeomAbs_SurfaceType.GeomAbs_Plane;
  const sideFaces: TopoDS_Face[] = [];
  const subShapeCount = subShapes.Size();

  for (let subShapeIndex = 1; subShapeIndex <= subShapeCount; subShapeIndex += 1) {
    const subShape = subShapes.FindKey(subShapeIndex);
    if (subShape.ShapeType() !== faceType) {
      continue;
    }
    const face = keep(oc.TopoDS.Face_1(subShape));
    const adaptor = keep(new oc.BRepAdaptor_Surface_2(face, true));
    if (adaptor.GetType() === planeType) {
      const plane = keep(adaptor.Plane());
      const normal = keep(keep(plane.Axis()).Direction());
      const alignment = Math.abs(
        normal.X() * direction[0] + normal.Y() * direction[1] + normal.Z() * direction[2],
      );
      if (alignment > CAP_NORMAL_DOT) {
        continue;
      }
    }
    sideFaces.push(face);
  }
  return sideFaces;
}

/**
 * 押し出した角柱の側面を傾ける(FR-401 のテーパ角)。
 *
 * 抜き勾配(FR-417)と同じ道具 `BRepOffsetAPI_DraftAngle_2` を使う(§0.a-0.34・0.35)。
 * 中立面(動かない面)は断面そのものなので、断面の大きさは指定どおりのまま残り、
 * 押し出した先ほど内へ絞られる(または外へ広がる)。
 *
 * 中立面は「断面の平面の位置」+「押し出しの向きを法線にした平面」で作り直す。
 * 面の向き(表裏)によって `Plane()` の法線が裏返るため、そのまま使うと
 * 同じ指定でも絞る/広げるが入れ替わってしまうため。
 *
 * **符号の意味(2026-09-05 に Node で実測):** 傾ける向き(`Direction`)と中立面の法線を
 * どちらも押し出しの向きに揃えたとき、角度が**正で内へ絞り**(40×30 を 10 押し出して
 * 5° で体積 11397.785043646)、**負で外へ広がる**(同 12622.626333009)。
 * どちらも計画書 §2.11 の手計算(角錐台の積分)と 1e-9 まで一致した。
 */
function applyTaper(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  prism: TopoDS_Shape,
  baseFace: TopoDS_Face,
  direction: Vec3Tuple,
  signedAngle: number,
): TopoDS_Shape {
  const sideFaces = collectSideFaces(oc, keep, prism, direction);
  if (sideFaces.length === 0) {
    throw new Error(TAPER_FAILED_MESSAGE);
  }

  const baseAdaptor = keep(new oc.BRepAdaptor_Surface_2(baseFace, true));
  const basePlane = keep(baseAdaptor.Plane());
  const pullDirection = keep(new oc.gp_Dir_4(direction[0], direction[1], direction[2]));
  const neutralPlane = keep(new oc.gp_Pln_3(keep(basePlane.Location()), pullDirection));
  const drafter = keep(new oc.BRepOffsetAPI_DraftAngle_2(prism));

  for (const face of sideFaces) {
    drafter.Add(face, pullDirection, signedAngle, neutralPlane, true);
    // 1 枚でも受け取れなかったら、そこで止めて理由を出す(FR-504)。
    if (!drafter.AddDone()) {
      throw new Error(TAPER_FAILED_MESSAGE);
    }
  }

  drafter.Build(keep(new oc.Message_ProgressRange_1()));
  if (!drafter.IsDone()) {
    throw new Error(TAPER_FAILED_MESSAGE);
  }
  return keep(drafter.Shape());
}

/**
 * 立体の重心が、断面の平面から押し出しの向きへどれだけ進んだ位置にあるか(mm)。
 *
 * 「次の面まで」で塊が 2 つ以上できたとき、手前の塊を選ぶために使う。
 * 重心そのものへの直線距離ではなく**押し出しの向きに沿った量**で比べるのは、
 * 塊ごとに横方向の重心の位置が違い、直線距離では前後を取り違えうるため。
 *
 * 重心だけが要るので `measureShape.ts` の `measureMassProperties` は呼ばない
 * (あちらは主軸まわりの 2 次モーメントまで測るので、ここでは余分な計算になる)。
 */
function advanceOfCentre(
  oc: OpenCascadeInstance,
  solid: TopoDS_Shape,
  basePoint: readonly [number, number, number],
  direction: Vec3Tuple,
): number {
  const { keep, release } = createAllocations();
  try {
    const properties = keep(new oc.GProp_GProps_1());
    // 第 3〜5 引数は OnlyClosed / SkipShared / UseTriangulation。solidMesh.ts と同じ指定。
    oc.BRepGProp.VolumeProperties_1(solid, properties, false, false, false);
    const centre = keep(properties.CentreOfMass());
    return (
      (centre.X() - basePoint[0]) * direction[0] +
      (centre.Y() - basePoint[1]) * direction[1] +
      (centre.Z() - basePoint[2]) * direction[2]
    );
  } finally {
    release();
  }
}

/**
 * 「次の面まで」(FR-415)。長い角柱と対象の共通部分を取り、手前の塊だけを残す(§0.a-0.33)。
 *
 * ブーリアンは `booleanOp.ts` を通さず直に組み立てている。断りの文言が
 * 押し出し専用(「押し出す先に立体がありません。」)であることと、
 * 結果の塊を 1 つ選び出す後処理がここにしか無いため。
 */
function keepNearestChunk(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  prism: TopoDS_Shape,
  target: TopoDS_Shape,
  basePoint: readonly [number, number, number],
  direction: Vec3Tuple,
): TopoDS_Shape {
  const common = keep(
    new oc.BRepAlgoAPI_Common_3(target, prism, keep(new oc.Message_ProgressRange_1())),
  );
  // 成否は HasErrors() と IsDone() だけで見る(booleanOp.ts と同じ理由)。
  if (common.HasErrors() || !common.IsDone()) {
    throw new Error(NO_MATERIAL_AHEAD_MESSAGE);
  }
  const result = keep(common.Shape());

  const subShapes = keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_2(result, subShapes, true, true);
  const solidType = oc.TopAbs_ShapeEnum.TopAbs_SOLID;
  const subShapeCount = subShapes.Size();

  let nearest: TopoDS_Shape | null = null;
  let nearestAdvance = Number.POSITIVE_INFINITY;

  for (let subShapeIndex = 1; subShapeIndex <= subShapeCount; subShapeIndex += 1) {
    const subShape = subShapes.FindKey(subShapeIndex);
    if (subShape.ShapeType() !== solidType) {
      continue;
    }
    // 接するだけの配置で出る丸めの残りかす(体積のほとんど無い塊)は数えない。
    if (Math.abs(measureVolume(oc, subShape)) < MIN_SOLID_VOLUME) {
      continue;
    }
    const advance = advanceOfCentre(oc, subShape, basePoint, direction);
    if (advance < nearestAdvance) {
      nearestAdvance = advance;
      nearest = subShape;
    }
  }

  if (nearest === null) {
    throw new Error(NO_MATERIAL_AHEAD_MESSAGE);
  }
  return nearest;
}

/**
 * 断面を direction の向きへ押し出す(FR-401、FR-415)。
 *
 * 向きは model 側で決めて渡す約束(計画書 §0.a-0.8)なので、ここでは反転を扱わない。
 * 向きは長さ 1 に揃えてから長さを掛ける。断面が閉じていない・自己交差している・
 * 平面に乗っていない場合は makePlanarFace が理由つきで断り、その文言がそのまま呼び出し側へ伝わる。
 *
 * 第 4 引数 `shaping` は省略できる(P2 からの呼び出し側は 1 行も変わらない)。
 * 終端の指定(距離 / 両側 / 指定の面まで / 次の面まで)と側面の傾きはここで受け取る。
 */
export function makeExtrudeSolid(
  oc: OpenCascadeInstance,
  spec: ExtrudeStepSpec,
  options: TessellationOptions = {},
  shaping: ExtrudeShapeOptions = {},
): OcctShapeHandle {
  const end: ExtrudeEndSpec = shaping.end ?? { kind: 'distance', distance: spec.distance };
  const taperAngle = shaping.taperAngle ?? 0;
  const target = shaping.target ?? null;

  if (!Number.isFinite(taperAngle) || taperAngle < 0 || taperAngle >= MAX_TAPER_ANGLE) {
    throw new Error(TAPER_RANGE_MESSAGE);
  }

  const direction = normalizeDirection(spec.direction);
  if (direction === null) {
    throw new Error('押し出す向きが決まりません。断面が平らかどうかを確かめてください。');
  }

  const { startOffset, length } = resolveExtrudeRange(oc, end, target);

  const { keep, release } = createAllocations();

  try {
    const profileFace = keep(makePlanarFace(oc, spec.profile, options));
    const baseFace = shiftFace(oc, keep, profileFace.face, direction, startOffset);
    const vector = keep(
      new oc.gp_Vec_4(direction[0] * length, direction[1] * length, direction[2] * length),
    );
    const maker = keep(new oc.BRepPrimAPI_MakePrism_1(baseFace, vector, SWEEP_COPY, PRISM_CANONIZE));

    // 成否は IsDone() だけで見る。Error() の戻り値(BRepBuilderAPI_*Error)は
    // 型定義では空の型 `{}` になっており、比較に強制変換が要るため使わない。
    if (!maker.IsDone()) {
      throw new Error('断面を押し出せませんでした。断面の形を見直してください。');
    }

    let shape: TopoDS_Shape = keep(maker.Shape());

    // 断面と同じ平面へ押し出すと OCCT は成功を返すが、体積 0 の潰れた形になる。
    // 傾きや切り取りの前に見ておくと、潰れた形を相手にした無駄な計算をしないで済む。
    // 面の向きが裏返っている断面では符号が負になり得るので絶対値で見る。
    if (Math.abs(measureVolume(oc, shape)) < MIN_SOLID_VOLUME) {
      throw new Error('押し出しても厚みが出ませんでした。長さを大きくしてください。');
    }

    let reshaped = false;

    if (taperAngle > 0) {
      // 傾きは切り取りより先にかける。中立面が断面なので、角柱がどれだけ長くても
      // 同じ高さの断面の大きさは変わらず、「次の面まで」と組み合わせても形が変わらない。
      shape = applyTaper(
        oc,
        keep,
        shape,
        baseFace,
        direction,
        // 符号の意味は 2026-09-05 に Node で実測した(applyTaper の注釈)。
        shaping.taperOutward === true ? -taperAngle : taperAngle,
      );
      reshaped = true;
    }

    if (end.kind === 'toNext' && target !== null) {
      const baseAdaptor = keep(new oc.BRepAdaptor_Surface_2(baseFace, true));
      const basePoint = keep(keep(baseAdaptor.Plane()).Location());
      const start: readonly [number, number, number] = [
        basePoint.X(),
        basePoint.Y(),
        basePoint.Z(),
      ];
      shape = keepNearestChunk(oc, keep, shape, target, start, direction);
      reshaped = true;
    }

    // 作り変えた形だけ measureVolume をもう一度呼ぶ。体積を測るのは安くない
    // (面 26 枚の板で 1 回 7.5〜11ms。booleanOp.ts の BooleanResult の注釈)ので、
    // 角柱のまま何も変えていないときは上で測った結果をそのまま信じる。
    if (reshaped && Math.abs(measureVolume(oc, shape)) < MIN_SOLID_VOLUME) {
      throw new Error('押し出しても厚みが出ませんでした。長さを大きくしてください。');
    }

    return { shape, delete: release };
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * 断面を軸まわりに angle(ラジアン)だけ回す(FR-402)。
 *
 * 角度は必ずラジアンで受け取る。度で受け取ると MakeEdge_9 と同じ取り違えが起きるため、
 * 度からの換算は model 側の責務にしてある(計画書 §0.a-0.9)。
 */
export function makeRevolveSolid(
  oc: OpenCascadeInstance,
  spec: RevolveStepSpec,
  options: TessellationOptions = {},
): OcctShapeHandle {
  if (!Number.isFinite(spec.angle) || spec.angle <= 0 || spec.angle > MAX_REVOLVE_ANGLE) {
    throw new Error('回転の角度は 0 より大きく 360 度以下にしてください。');
  }

  const axisDirection = normalizeDirection(spec.axisDirection);
  if (axisDirection === null || !isFinitePoint(spec.axisOrigin)) {
    throw new Error('回転の軸が決まりません。軸を選び直してください。');
  }

  const { keep, release } = createAllocations();

  try {
    const face = keep(makePlanarFace(oc, spec.profile, options));
    const origin = keep(
      new oc.gp_Pnt_3(spec.axisOrigin[0], spec.axisOrigin[1], spec.axisOrigin[2]),
    );
    const towards = keep(new oc.gp_Dir_4(axisDirection[0], axisDirection[1], axisDirection[2]));
    const axis = keep(new oc.gp_Ax1_2(origin, towards));
    const maker = keep(new oc.BRepPrimAPI_MakeRevol_1(face.face, axis, spec.angle, SWEEP_COPY));

    // 断面が軸をまたいでいると、OCCT は IsDone() に false を返す(2026-09-03 実測)。
    // このとき Shape() を呼ぶと C++ の例外がそのまま飛んでくるので、先に IsDone() を見る。
    if (!maker.IsDone()) {
      throw new Error('断面が回転軸と重なっているため、回せませんでした。断面を軸から離してください。');
    }

    const shape = keep(maker.Shape());

    if (!isValidShape(oc, shape)) {
      throw new Error('断面が回転軸と重なっているため、回せませんでした。断面を軸から離してください。');
    }

    // 軸が断面の平面に直交していると、OCCT は成功を返すが体積 0 の形になる(2026-09-03 実測)。
    if (Math.abs(measureVolume(oc, shape)) < MIN_SOLID_VOLUME) {
      throw new Error('回しても厚みが出ませんでした。軸と断面の向きを見直してください。');
    }

    return { shape, delete: release };
  } catch (error) {
    release();
    throw error;
  }
}
