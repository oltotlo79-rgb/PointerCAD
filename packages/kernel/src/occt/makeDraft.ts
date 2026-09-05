import type {
  OpenCascadeInstance,
  TopoDS_Face,
  TopoDS_Shape,
  gp_Pln,
} from 'opencascade.js/dist/opencascade.full.js';

import type { SubShapeQuery, Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import type { OcctShapeHandle } from './makeBox.js';
import { matchFace } from './matchSubShape.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import type { SubShapeTables } from './subShapes.js';
import { boundingDiagonal, faceAt } from './subShapes.js';

/**
 * 抜き勾配(FR-417、計画書 P5 §0.a-0.35・§2.11、タスク34)。
 *
 * 型抜きや 3D プリントのために、基準にする平らな面(中立面)を 1 枚選び、
 * そこから離れるにつれて広がる(または狭まる)ように側面を傾ける。
 * 中立面そのものは動かないので、上面の寸法を保ったまま抜き勾配だけを足せる。
 *
 * 傾けられないときは**必ず日本語の理由を持つ Error で断り、アプリを落とさない**
 * (NFR-RE-1、FR-504)。
 */

/** これ未満の体積(mm³)は「立体が残らなかった」とみなす(makeFillet.ts と同じ下限)。 */
const MIN_SOLID_VOLUME_MM3 = 1e-9;

/** 中立面(基準の面)の指紋が届かなかったとき。 */
const MISSING_NEUTRAL_FACE_MESSAGE =
  '基準の面が見つかりません。形が大きく変わったため、選び直してください。';

/** 中立面が平面でないとき。傾きの基準になる平面が決まらない。 */
const NEUTRAL_NOT_PLANAR_MESSAGE = '基準にできるのは平らな面だけです。';

/** 傾ける面が 1 枚も指定されていないとき。 */
const NO_TARGET_FACE_MESSAGE = '傾きを付ける面が選ばれていません。';

/**
 * 傾ける面の指紋が 1 つでも届かなかったとき。
 *
 * 計画書 タスク34 の断り方の表には無い文言だが、R 面取り・C 面取りと同じく
 * **部分成功にしない**(選んだ 4 枚のうち 3 枚だけ傾いた立体を黙って作らない)ため、
 * 中立面とは別の言葉で断る(統括へ報告済み)。中立面の文言を使い回すと、
 * 利用者がどちらの面を選び直せばよいか分からなくなる。
 */
const MISSING_TARGET_FACE_MESSAGE =
  '傾きを付ける面が見つかりません。形が大きく変わったため、選び直してください。';

/** 角度が範囲の外のとき。ラジアンで受け取るが、文言は利用者の語彙(度)で書く。 */
const ANGLE_MESSAGE = '抜き勾配の角度は 0 度より大きく 60 度以下にしてください。';

/**
 * 角度の上限(ラジアン)。**60 度**(統括の決定 §0.a-0.72、2026-09-05 14:21)。
 *
 * もとは「90 度未満」だったが、89.99999 度のような値も妥当性検査を通ってしまい、
 * 巨大な形ができる懸念があった(タスク34 の実測)。実用の抜き勾配は 1〜10 度なので、
 * 60 度で断っても作れる形は減らない。**UI(タスク49)も同じ上限にする。**
 */
const MAX_DRAFT_ANGLE = Math.PI / 3;

/** その面には傾きを付けられなかったとき(`AddDone()` が false)。 */
const ADD_FAILED_MESSAGE =
  'この面には傾きを付けられませんでした。別の面を選ぶか、角度を小さくしてください。';

/** OCCT が傾け切れなかった・結果が立体として成り立たないとき。 */
const BUILD_FAILED_MESSAGE = '抜き勾配を付けられませんでした。角度を小さくしてください。';

/** 中立面の平面が壊れていて向きを取り出せないとき(通常は起きない)。 */
const NEUTRAL_BROKEN_MESSAGE = '基準の面の向きを読み取れませんでした。別の面を選び直してください。';

/** 抜き勾配 1 段の依頼(計画書 タスク34 の実装内容)。 */
export interface DraftInput {
  /** 傾ける面の指紋。1 枚以上。重複は 1 度だけ数える。 */
  readonly faces: readonly SubShapeQuery[];
  /** 基準にする平らな面(中立面)の指紋。この面は動かない。 */
  readonly neutralFace: SubShapeQuery;
  /** 角度(ラジアン)。正で外側へ広がる。 */
  readonly angle: number;
  /** 抜き方向を反転する(内側へ狭める)。 */
  readonly reversed: boolean;
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

/**
 * 指紋 1 つから平らな面 1 枚を選び直す。
 *
 * 面以外(辺・頂点)の指紋、しきい値 0.6 に届かない指紋、平面でない面は、
 * それぞれの理由で断る。文言は呼び出し側が渡す(中立面と対象の面で言葉が違うため)。
 */
function resolveFaceIndex(
  tables: SubShapeTables,
  query: SubShapeQuery,
  scale: number,
  missingMessage: string,
): number {
  if (query.kind !== 'face') {
    // 面以外の指紋が来るのは model 側の取り違えだが、利用者への直し方は同じ(面を選び直す)。
    throw new Error(missingMessage);
  }
  const match = matchFace(tables.faces, query, scale);
  if (match === null) {
    throw new Error(missingMessage);
  }
  return match.index;
}

/**
 * 傾ける面の通し番号を決める。重複は取り除き、番号の昇順で返す。
 *
 * **1 つでも選び直せない指紋があれば断る**(`resolveFilletEdges` と同じ判断)。
 * 並びを昇順に固定するのは、同じ入力から必ず同じ順で `Add` して同じ形が出るようにするため
 * (決定性。matchSubShape.ts の同点の決めと同じ考え)。
 */
function resolveTargetFaces(
  tables: SubShapeTables,
  queries: readonly SubShapeQuery[],
  scale: number,
): readonly number[] {
  const found = new Set<number>();
  for (const query of queries) {
    found.add(resolveFaceIndex(tables, query, scale, MISSING_TARGET_FACE_MESSAGE));
  }
  return [...found].sort((left, right) => left - right);
}

/**
 * 中立面の平面(`gp_Pln`)と、材料の外を向く法線を読む。
 *
 * `gp_Pln` が持つ軸は面の向き(Orientation)を見ていないので、面が `TopAbs_REVERSED` の
 * ときは符号を反転して**必ず材料の外を向く**ようにする(makeHole.ts の `readPlaneFrame`・
 * subShapes.ts の `readFaceGeometry` と同じ規則)。平面そのものは向きを持たないので、
 * `gp_Pln` はそのまま使ってよい。
 *
 * 返す `plane` は `keep` 済みなので、呼び出し側の `release()` でまとめて解放される。
 */
function readNeutralPlane(
  oc: OpenCascadeInstance,
  face: TopoDS_Face,
  keep: Allocations['keep'],
): { readonly plane: gp_Pln; readonly outwardNormal: Vec3Tuple } {
  // 第 2 引数 false は「面の境界(トリム)を読み込まない」指定(subShapes.ts と同じ)。
  const adaptor = keep(new oc.BRepAdaptor_Surface_2(face, false));
  const plane = keep(adaptor.Plane());
  const axis = keep(plane.Axis());
  const direction = keep(axis.Direction());
  const reversed = face.Orientation_1() !== oc.TopAbs_Orientation.TopAbs_FORWARD;
  const sign = reversed ? -1 : 1;
  const outwardNormal = toUnit([
    direction.X() * sign,
    direction.Y() * sign,
    direction.Z() * sign,
  ]);

  if (outwardNormal === null) {
    // gp_Dir は構築時に長さ 1 へ揃うので、ここへ来るのは下地の平面が壊れている場合だけ。
    throw new Error(NEUTRAL_BROKEN_MESSAGE);
  }
  return { plane, outwardNormal };
}

/**
 * `Status()` の値を利用者に見せない覚え書きへ直す(計画書 §1.5-16 の実測用)。
 *
 * 戻り値どうしの `===` 比較はできる(列挙の各値は型定義では空の型 `{}` だが、
 * 引数に渡さず比べるだけなら型検査を通る。subShapes.ts の `GetType()` と同じ仕組み)。
 * **利用者へはこの名前を見せない。** 断りの文言は上の定数のとおり日本語で、
 * ここで返す名前は検査と記録のためだけに使う。
 *
 * 2026-09-05 に Node で実測した対応:
 *   - `Draft_NoError`            : 成功したとき(`Build` のあと `IsDone()` が真)。
 *   - `Draft_FaceRecomputation`  : 中立面と平行な面(= 抜き方向に垂直な面)を対象にしたとき、
 *                                  `AddDone()` が false になってこの値が返る。
 *   - `Draft_EdgeRecomputation`  : 角度が大きすぎて面どうしがぶつかり、`Build` のあと
 *                                  `IsDone()` が false になるとき(40×30×10 の板を内向き 57 度、
 *                                  40×4×10 の板を内向き 12 度で再現)。
 *   - `Draft_VertexRecomputation`: 実測では 1 度も出なかった。
 */
export function draftStatusName(oc: OpenCascadeInstance, status: unknown): string {
  const table = oc.Draft_ErrorStatus;
  if (status === table.Draft_NoError) {
    return 'Draft_NoError';
  }
  if (status === table.Draft_FaceRecomputation) {
    return 'Draft_FaceRecomputation';
  }
  if (status === table.Draft_EdgeRecomputation) {
    return 'Draft_EdgeRecomputation';
  }
  if (status === table.Draft_VertexRecomputation) {
    return 'Draft_VertexRecomputation';
  }
  return 'Draft_Unknown';
}

/**
 * 例外を利用者へ見せる日本語へ揃える。
 *
 * OCCT の C++ 側が投げる例外は、embind を通ると**数値(実体へのポインタ)**として飛んでくる
 * (makeFillet.ts / makeChamfer.ts と同じ)。そのまま外へ出すと画面に数字が並ぶだけなので、
 * こちらで理由へ置き換える。自分で投げた Error(すでに日本語)はそのまま通す。
 */
function toJapaneseFailure(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message);
}

/**
 * 抜き勾配(FR-417)。**対象は消費せず、新しい形を返す。**
 *
 * 手順は計画書 タスク34 のとおりで、①角度と枚数の門番 → ②中立面を指紋で選び直して
 * 平面であることを確かめる → ③抜き方向(中立面の外向き法線。`reversed` で反転)→
 * ④対象の面を指紋で選び直して 1 枚ずつ `Add` → ⑤`Build` → ⑥成否と結果の検証、と進む。
 *
 * **引数の `target` は解放しない。** 形はキャッシュの持ち物で、傾けたあとも別の段の
 * 入力として使われる(booleanOp.ts / makeFillet.ts と同じ約束)。断ったときも触れない。
 *
 * **`Add` の第 5 引数 `Flag` は使わない(2026-09-05 に Node で実測)。**
 * 40×30×10 の板の 4 側面に、上面を中立面・方向 +Z・角度 5 度で掛けたところ、
 * `Flag` を true にしても false にしても結果は同じ体積 12622.626333008871 だった。
 * 計画書 §0.a-0.35 は「`Flag` で反転」と書いているが、実測では反転しない。
 * そこで **`reversed` は抜き方向(`gp_Dir`)そのものを反転して実現する**。
 * 方向を反転すると外向き 12622.626333008871 ↔ 内向き 11397.785043645936 が入れ替わり、
 * 解析値(§2.11 の `(1/tan5)·(1200T ± 70T² + (4/3)T³)`、`T = 10·tan5°`)と一致した。
 * `Flag` には計画書の書き方どおり `true` を渡す(意味が無いので値は結果を変えない)。
 *
 * **向きの意味(実測):** 中立面から見て**抜き方向の逆側**にある材料が広がり、
 * 抜き方向の側にある材料は狭まる。上面を中立面にして方向を上面の外向き法線(+Z)に取ると、
 * 材料は全部下側にあるので**下へ行くほど広がる**(型から抜ける形)。
 *
 * **曲がった面も傾けられる(実測):** 対象の面は平面でなくてよい。半径 10・高さ 20 の
 * 円柱の側面に上面基準 5 度を掛けると、上半径 10・下半径 `10 + 20·tan5°` の円錐台
 * (体積 7446.724508549709)になった。門番を平面に限っているのは**中立面だけ**である。
 */
export function makeDraft(
  oc: OpenCascadeInstance,
  target: TopoDS_Shape,
  tables: SubShapeTables,
  input: DraftInput,
): OcctShapeHandle {
  // 角度はラジアン(度からの換算は model の責務。docs/報告記録.md 2026-09-02 18:23)。
  // 0 度は「傾けない」ので段として意味が無く、90 度以上は面が抜き方向と平行になって
  // 傾きが定義できない(実測では 89.99 度で妥当でない巨大な形ができた)。
  // その 89.99 度を入り口で止めるため、上限は 60 度に狭めてある(MAX_DRAFT_ANGLE)。
  if (!Number.isFinite(input.angle) || input.angle <= 0 || input.angle > MAX_DRAFT_ANGLE) {
    throw new Error(ANGLE_MESSAGE);
  }
  if (input.faces.length === 0) {
    throw new Error(NO_TARGET_FACE_MESSAGE);
  }

  // 位置の点を正規化する長さ。境界箱の対角長の半分(matchSubShape.ts の scorePosition)。
  const scale = boundingDiagonal(oc, target) * 0.5;

  const neutralIndex = resolveFaceIndex(
    tables,
    input.neutralFace,
    scale,
    MISSING_NEUTRAL_FACE_MESSAGE,
  );
  // 一覧は通し番号の順で来る約束だが、番号で引き直して並びに依存しないようにする。
  const neutralInfo = tables.faces.find((candidate) => candidate.index === neutralIndex);
  if (neutralInfo === undefined) {
    throw new Error(MISSING_NEUTRAL_FACE_MESSAGE);
  }
  if (neutralInfo.surfaceKind !== 'plane') {
    throw new Error(NEUTRAL_NOT_PLANAR_MESSAGE);
  }

  const targetIndices = resolveTargetFaces(tables, input.faces, scale);

  const { keep, release } = createAllocations();

  try {
    const neutralFace = faceAt(oc, target, neutralIndex);
    if (neutralFace === null) {
      // 一覧の番号が形と食い違っている(別の形から作った一覧を渡された)合図。
      throw new Error(MISSING_NEUTRAL_FACE_MESSAGE);
    }
    keep(neutralFace);

    const { plane, outwardNormal } = readNeutralPlane(oc, neutralFace, keep);
    const sign = input.reversed ? -1 : 1;
    const direction = keep(
      new oc.gp_Dir_4(
        outwardNormal[0] * sign,
        outwardNormal[1] * sign,
        outwardNormal[2] * sign,
      ),
    );

    const maker = keep(new oc.BRepOffsetAPI_DraftAngle_2(target));

    for (const index of targetIndices) {
      const face = faceAt(oc, target, index);
      if (face === null) {
        throw new Error(MISSING_TARGET_FACE_MESSAGE);
      }
      try {
        // 第 5 引数 Flag は結果を変えない(上の注釈の実測)。計画書の書き方どおり true。
        maker.Add(face, direction, input.angle, plane, true);
      } catch (error) {
        throw toJapaneseFailure(error, ADD_FAILED_MESSAGE);
      } finally {
        // Add は面を maker の中へ写し取るので、その場で返してよい
        // (makeFillet.ts の Add_2 と同じ扱い。2026-09-05 実測で解放後も Build が通る)。
        face.delete();
      }
      if (!maker.AddDone()) {
        // 抜き方向に垂直な面(中立面と平行な面)を指すとここへ来る(Draft_FaceRecomputation)。
        throw new Error(ADD_FAILED_MESSAGE);
      }
    }

    const range = keep(new oc.Message_ProgressRange_1());
    try {
      maker.Build(range);
    } catch (error) {
      throw toJapaneseFailure(error, BUILD_FAILED_MESSAGE);
    }

    // IsDone() を見る前に Shape() を呼ぶと C++ 例外が飛ぶ
    // (docs/報告記録.md 2026-09-03 06:56 の⑤。抜き勾配も同じ扱いにする)。
    if (!maker.IsDone()) {
      throw new Error(BUILD_FAILED_MESSAGE);
    }

    const shape = keep(maker.Shape());

    if (!hasSolid(oc, shape) || Math.abs(measureVolume(oc, shape)) < MIN_SOLID_VOLUME_MM3) {
      throw new Error(BUILD_FAILED_MESSAGE);
    }
    // 角度が 90 度に近いと、IsDone() が真のまま妥当でない形が返ることがある(実測 89.99 度)。
    // 妥当性まで見て初めて通す(計画書 タスク34 の手順6)。
    if (!isValidShape(oc, shape)) {
      throw new Error(BUILD_FAILED_MESSAGE);
    }

    return { shape, delete: release };
  } catch (error) {
    release();
    throw error;
  }
}
