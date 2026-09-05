import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type { Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import type { BooleanResult } from './booleanOp.js';
import { booleanOp } from './booleanOp.js';
import type { OcctShapeHandle } from './makeBox.js';
import { boundingDiagonal } from './subShapes.js';

/**
 * 平面による切断(FR-432、FR-424 の分割の統合、計画書 P5 §0.a-0.59・§2.9b.3、タスク27b)。
 *
 * 平面を 1 枚渡すと、その平面で対象を切って**片側だけ**を返す。「反対側も残す」は
 * コマンド側が同じ平面・逆の側でもう 1 段積むことで満たすので(§0.a-0.58)、
 * この関数は常に 1 つの形しか返さない。
 *
 * 切れないときは**必ず日本語の理由を持つ Error で断り、アプリを落とさない**
 * (NFR-RE-1、FR-504)。
 *
 * ## 採った方式(2026-09-05 に Node 上で実測。§1.5-23 / -24)
 *
 * `BRepPrimAPI_MakeHalfSpace_1(face, refPnt)` で作った**半空間**と対象の
 * `booleanOp(oc, 'intersect', …)` を使う(§0.a-0.59 の承認どおり)。40×30×10 の板を
 * `z=3` で切る実測は次のとおりで、(a) 半空間・(b) 大きな箱のどちらも同じ結果になり、
 * 所要も 500ms(NFR-PF-2)に対して十分小さかった。**計画どおり (a) を採る。**
 *
 * | 方式 | 残す側 | 体積 | 面数 | 所要 |
 * |---|---|---|---|---|
 * | (a) 半空間 + intersect | 正 | 8400 | 6 | 168.3ms(初回。WASM の暖機を含む) |
 * | (b) 大きな箱 + intersect | 正 | 8400 | 6 | 46.9ms |
 * | (a) 半空間 + intersect | 負 | 3600 | 6 | 42.3ms |
 * | (b) 大きな箱 + intersect | 負 | 3600 | 6 | 37.2ms |
 *
 * (b) は「平面が軸に平行」なら 2 隅で箱を作れるが、斜めの平面では箱を回さねばならず、
 * 大きさの決め方も別に要る。(a) にはその手間が無い。
 *
 * ## `RefPnt` の向きの規約(実測して固定した。§1.5-23 ③)
 *
 * **`RefPnt` を置いた側の材料が残る。** 上の表がそのまま証拠で、`z=3` の平面に対して
 * `RefPnt` を `z = 3 + S`(法線 `[0,0,1]` の側)へ置くと上側 `40×30×7 = 8400` が残り、
 * `z = 3 − S` へ置くと下側 `40×30×3 = 3600` が残った。つまり
 * `keepPositive` が真なら `RefPnt` を**法線の向きへ**、偽なら**逆向きへ**進めればよい。
 */

/** これ未満の体積(mm³)は「立体が残らなかった」とみなす(booleanOp.ts と同じ下限)。 */
const MIN_SOLID_VOLUME_MM3 = 1e-9;

/**
 * 切断面と対象が正確に接する配置を避けるための余裕。
 * 対角長の 1% + 1mm(P3 §0.a-0.12、makeHole.ts と同じ決め)。
 * ブーリアンが最も苦手なのは「面と面がぴったり重なる」配置なので、
 * 平面の面も参照点もこのぶんだけ対象より大きく・遠くに取る。
 */
const MARGIN_RATIO = 0.01;
const MARGIN_MIN_MM = 1;

/**
 * 境界箱の隅を「平面のどちら側か」で分けるときの許容誤差(対角長に対する比)。
 * ちょうど平面に乗る隅(接するだけの配置)を「残る側」と数えないための幅で、
 * これを 0 にすると丸めの符号でどちらへ倒れるかが決まってしまう。
 */
const SIGN_TOLERANCE_RATIO = 1e-9;

/** 法線の長さが 0、または数値でないとき(§2.9b.3 の断り方の表)。 */
const NORMAL_MESSAGE = '切断面の向きを決められません。';

/**
 * 切断面の通る点が数値でないとき。
 *
 * §2.9b.3 の断り方の表には「法線の長さが 0」の行しか無いが、タスク27b の検証表は
 * 「座標が NaN は OCCT を呼ぶ前に日本語で断る」を求めている(docs/報告記録.md
 * 2026-09-04 00:30 の②)。向きの文言を位置の誤りへ使い回すと直し方が伝わらないので、
 * 位置には位置の言葉を用意した(統括へ報告済み)。
 */
const ORIGIN_MESSAGE = '切断面の位置を決められません。';

/** 平面が対象と交わらず、しかも対象が丸ごと捨てる側にあるとき。 */
const NOTHING_ON_KEEP_SIDE_MESSAGE = '切った先に立体が残りません。切断面の位置を見直してください。';

/** 切る演算そのものが成立しなかったとき。 */
const CUT_FAILED_MESSAGE = '立体を切れませんでした。切断面の位置を見直してください。';

/** 切れたが、残す側に材料が無かったとき(L 字の腕の外を切るなど)。 */
const NOTHING_LEFT_MESSAGE = '切ったら立体が残りませんでした。残す側を切り替えてください。';

/** 切断 1 段の依頼(計画書 タスク27b の実装内容)。 */
export interface CutInput {
  /** 切断面が通る点(mm)。平面上ならどこでもよい。 */
  readonly origin: Vec3Tuple;
  /** 単位法線(model が解決済み)。長さは念のためこちらでも揃える。 */
  readonly normal: Vec3Tuple;
  /** 法線の側を残すなら true(§0.a-0.57 の `keep: 'positive'`)。 */
  readonly keepPositive: boolean;
}

/** 3 つの数がすべて有限か。NaN・∞ を OCCT へ渡さないための門番。 */
function isFiniteVec3(value: Vec3Tuple): boolean {
  return Number.isFinite(value[0]) && Number.isFinite(value[1]) && Number.isFinite(value[2]);
}

/** -0 を +0 へ揃える(subShapes.ts と同じ理由)。 */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
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

/** 境界箱の低い隅と高い隅(mm)。 */
interface BoundingCorners {
  readonly low: Vec3Tuple;
  readonly high: Vec3Tuple;
}

/**
 * 境界箱の 2 隅を読む。
 *
 * `boundingDiagonal`(subShapes.ts)は対角の**長さ**しか返さないが、
 * 「平面が対象と交わるか」は 8 隅の**位置**の符号で決めるので、ここで隅そのものを読む。
 * 測り方(`SetGap(0)` で許容誤差ぶんの膨らみを取り除く・厳密な面から測る)は
 * `boundingDiagonal` とまったく同じにしてあり、同じ形からは同じ箱が出る。
 * 中身の無い形では null を返す。
 */
function readBoundingCorners(oc: OpenCascadeInstance, shape: TopoDS_Shape): BoundingCorners | null {
  const { keep, release } = createAllocations();
  try {
    const box = keep(new oc.Bnd_Box_1());
    // 第 3 引数 false は「三角形分割を使わず厳密な面から測る」指定(subShapes.ts と同じ)。
    oc.BRepBndLib.Add(shape, box, false);
    if (box.IsVoid()) {
      return null;
    }
    box.SetGap(0);
    const low = keep(box.CornerMin());
    const high = keep(box.CornerMax());
    return {
      low: [low.X(), low.Y(), low.Z()],
      high: [high.X(), high.Y(), high.Z()],
    };
  } finally {
    release();
  }
}

/** 境界箱の 8 隅を並べる(低い隅と高い隅の各成分の組み合わせ)。 */
function cornersOf(box: BoundingCorners): readonly Vec3Tuple[] {
  const corners: Vec3Tuple[] = [];
  for (const x of [box.low[0], box.high[0]]) {
    for (const y of [box.low[1], box.high[1]]) {
      for (const z of [box.low[2], box.high[2]]) {
        corners.push([x, y, z]);
      }
    }
  }
  return corners;
}

/** 点から平面までの符号つき距離(法線の側が正)。 */
function signedDistance(point: Vec3Tuple, origin: Vec3Tuple, normal: Vec3Tuple): number {
  return (
    (point[0] - origin[0]) * normal[0] +
    (point[1] - origin[1]) * normal[1] +
    (point[2] - origin[2]) * normal[2]
  );
}

/** 平面と境界箱の関係。 */
type PlanePosition =
  /** 箱が丸ごと残す側にある(切る必要が無い)。 */
  | 'allKept'
  /** 箱が丸ごと捨てる側にある(何も残らない)。 */
  | 'allDropped'
  /** 平面が箱を横切る(ふつうに切る)。 */
  | 'crossing';

/**
 * 境界箱の 8 隅を平面へ代入し、平面が対象と交わるかを見分ける(手順 3)。
 *
 * 「残す側から見た符号」に揃えてから調べるので、`keepPositive` の真偽で式が分かれない。
 * 接するだけ(符号が 0)の隅は**残す側に数えない**。ちょうど上面で切って上側を残す配置は、
 * 厚み 0 の板になって立体が残らないためである。
 */
function classifyPlane(
  box: BoundingCorners,
  origin: Vec3Tuple,
  normal: Vec3Tuple,
  keepPositive: boolean,
  tolerance: number,
): PlanePosition {
  const keepSign = keepPositive ? 1 : -1;
  let lowest = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;
  for (const corner of cornersOf(box)) {
    const distance = signedDistance(corner, origin, normal) * keepSign;
    lowest = Math.min(lowest, distance);
    highest = Math.max(highest, distance);
  }
  // 先に「何も残らない」を見る。箱が平面の上に潰れている(両方が真になる)ような
  // 退化した入力では、黙って複製を返すより断るほうが安全なため。
  if (highest <= tolerance) {
    return 'allDropped';
  }
  if (lowest >= -tolerance) {
    return 'allKept';
  }
  return 'crossing';
}

/**
 * 対象をそのまま複製して返す(平面が対象と交わらず、対象が丸ごと残る側にあるとき)。
 *
 * **引数をそのまま返してはいけない。** 呼び出し側は返した handle の `delete()` で
 * 形を解放するが、`target` は形状キャッシュの持ち物なので解放してはならない
 * (booleanOp.ts と同じ約束)。所有権のはっきりした複製を 1 つ作って返す。
 */
function copyTarget(oc: OpenCascadeInstance, target: TopoDS_Shape): OcctShapeHandle {
  const { keep, release } = createAllocations();
  try {
    // 第 2 引数 true は「下地の幾何も複製する」、第 3 引数 false は
    // 「三角形分割は複製しない」指定。分割はこのあと tessellate が作り直す。
    const maker = keep(new oc.BRepBuilderAPI_Copy_2(target, true, false));
    const shape = keep(maker.Shape());
    return { shape, delete: release };
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * 平面の側を表す半空間の立体を作る(手順 3〜5)。
 *
 * 平面の面は `planePoint` を中心に ±`size` の四角に切る。`planePoint` は
 * **対象の境界箱の中心を平面へ落とした点**で、`input.origin` そのものではない。
 * `origin` は「平面上のどこか 1 点」でしかなく、対象から遠く離れていることがあるため
 * (3 点指定の 1 点目が離れた頂点だったときなど)、そのまま中心にすると
 * 四角が対象を覆いきれない。落とした点なら、対象のどの隅からも高々 `対角長` しか離れない。
 */
function buildHalfSpace(
  oc: OpenCascadeInstance,
  keep: Allocations['keep'],
  planePoint: Vec3Tuple,
  normal: Vec3Tuple,
  size: number,
  keepPositive: boolean,
): TopoDS_Shape {
  const location = keep(new oc.gp_Pnt_3(planePoint[0], planePoint[1], planePoint[2]));
  const direction = keep(new oc.gp_Dir_4(normal[0], normal[1], normal[2]));
  const plane = keep(new oc.gp_Pln_3(location, direction));
  const faceMaker = keep(new oc.BRepBuilderAPI_MakeFace_9(plane, -size, size, -size, size));
  if (!faceMaker.IsDone()) {
    throw new Error(CUT_FAILED_MESSAGE);
  }
  const face = keep(faceMaker.Face());

  // 残す側の代表点。上の注釈の実測どおり「RefPnt を置いた側」が残る。
  const sign = keepPositive ? 1 : -1;
  const reference = keep(
    new oc.gp_Pnt_3(
      planePoint[0] + normal[0] * sign * size,
      planePoint[1] + normal[1] * sign * size,
      planePoint[2] + normal[2] * sign * size,
    ),
  );
  const halfSpaceMaker = keep(new oc.BRepPrimAPI_MakeHalfSpace_1(face, reference));
  if (!halfSpaceMaker.IsDone()) {
    throw new Error(CUT_FAILED_MESSAGE);
  }
  return keep(halfSpaceMaker.Solid());
}

/**
 * `booleanOp` の断りを、切断の言葉へ言い換える。
 * 「立体が残らなかった」だけは直し方が違う(残す側を切り替える)ので言い回しで見分ける
 * (makeHole.ts の `cutHoles`・makeThread.ts の `toJapaneseFailure` と同じ流儀)。
 */
function intersectWithHalfSpace(
  oc: OpenCascadeInstance,
  target: TopoDS_Shape,
  halfSpace: TopoDS_Shape,
): BooleanResult {
  try {
    return booleanOp(oc, 'intersect', target, halfSpace);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(reason.includes('立体が残りませんでした') ? NOTHING_LEFT_MESSAGE : CUT_FAILED_MESSAGE, {
      cause: error,
    });
  }
}

/**
 * 平面で切って片側だけを返す(FR-432)。**対象は消費せず、新しい形を返す。**
 *
 * 手順は §2.9b.3 の骨子のとおりで、①入力の門番(OCCT を呼ぶ前)→ ②境界箱と対角長 →
 * ③平面が交わるかの見分け(交わらないなら複製か断り)→ ④平面の面と参照点 →
 * ⑤半空間 → ⑥積 → ⑦結果の検証、と進む。
 *
 * **引数の `target` は解放しない。** 形はキャッシュの持ち物で、切ったあとも別の段の
 * 入力として使われる(booleanOp.ts / makeDraft.ts と同じ約束)。断ったときも触れない。
 *
 * **「体積が減ったから失敗」も「体積が元と同じだから失敗」も入れない**(手順 5)。
 * 切断は減るのが正しく、平面が対象と交わらないときは元のまま残るのが正しいためである。
 * 見るのは `hasSolid` と「体積 > 1e-9」だけで、これは `booleanOp` が済ませている
 * (docs/報告記録.md 2026-09-03 06:56 の④: 空のブーリアン結果も `IsDone()` は true・
 * `HasErrors()` は false なので、形の中身でしか見分けられない)。
 */
export function makeCut(
  oc: OpenCascadeInstance,
  target: TopoDS_Shape,
  input: CutInput,
): OcctShapeHandle {
  // ① 門番。NaN や ∞ を OCCT へ渡すと、断りではなく異常終了になりうる
  //    (docs/報告記録.md 2026-09-04 00:30 の②)。必ず OCCT を呼ぶ前に弾く。
  if (!isFiniteVec3(input.origin)) {
    throw new Error(ORIGIN_MESSAGE);
  }
  if (!isFiniteVec3(input.normal)) {
    throw new Error(NORMAL_MESSAGE);
  }
  const normal = toUnit(input.normal);
  if (normal === null) {
    throw new Error(NORMAL_MESSAGE);
  }

  // ② 対象の大きさ。対角長は subShapes.ts の 1 つの定義を使う(同じものを 2 つ作らない)。
  const diagonal = boundingDiagonal(oc, target);
  const box = readBoundingCorners(oc, target);
  if (!Number.isFinite(diagonal) || diagonal <= 0 || box === null) {
    // 中身の無い形。切るものが無いので、切断の言葉で断る。
    throw new Error(CUT_FAILED_MESSAGE);
  }
  const margin = diagonal * MARGIN_RATIO + MARGIN_MIN_MM;
  const size = diagonal + margin;

  // ③ 平面が対象と交わるか。交わらないなら、残る側なら複製、残らない側なら断る。
  const position = classifyPlane(
    box,
    input.origin,
    normal,
    input.keepPositive,
    diagonal * SIGN_TOLERANCE_RATIO,
  );
  if (position === 'allDropped') {
    throw new Error(NOTHING_ON_KEEP_SIDE_MESSAGE);
  }
  if (position === 'allKept') {
    return copyTarget(oc, target);
  }

  // ④ 平面の四角の中心は、境界箱の中心を平面へ落とした点にする(buildHalfSpace の注釈)。
  const center: Vec3Tuple = [
    (box.low[0] + box.high[0]) * 0.5,
    (box.low[1] + box.high[1]) * 0.5,
    (box.low[2] + box.high[2]) * 0.5,
  ];
  const offset = signedDistance(center, input.origin, normal);
  const planePoint: Vec3Tuple = [
    center[0] - normal[0] * offset,
    center[1] - normal[1] * offset,
    center[2] - normal[2] * offset,
  ];

  const { keep, release } = createAllocations();
  let halfSpace: TopoDS_Shape;
  try {
    // ⑤ 半空間。
    halfSpace = buildHalfSpace(oc, keep, planePoint, normal, size, input.keepPositive);
  } catch (error) {
    release();
    throw error;
  }

  let result: BooleanResult;
  try {
    // ⑥ 積。
    result = intersectWithHalfSpace(oc, target, halfSpace);
  } finally {
    // 積の結果は自分の中に形を持つので、工具(半空間)はここで解放してよい
    // (makeHole.ts が工具を解放するのと同じ。2026-09-05 に実測)。
    release();
  }

  // ⑦ 結果の検証。`booleanOp` が hasSolid と体積を見ているので、ここは念のための確認で、
  //    見つけたときの直し方(残す側を切り替える)を利用者へ伝えるための一言を持つ。
  if (!(result.volume > MIN_SOLID_VOLUME_MM3)) {
    result.delete();
    throw new Error(NOTHING_LEFT_MESSAGE);
  }
  return result;
}
