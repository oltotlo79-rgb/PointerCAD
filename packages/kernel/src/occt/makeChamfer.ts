import type {
  BRepFilletAPI_MakeChamfer,
  OpenCascadeInstance,
  TopoDS_Face,
  TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';

import type { ChamferSizeSpec, ChamferStepSpec } from '../types.js';
import { createAllocations } from './allocations.js';
import type { OcctShapeHandle } from './makeBox.js';
import { resolveFilletEdges } from './makeFillet.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import type { SubShapeTables } from './subShapes.js';
import { boundingDiagonal, edgeAt, faceAt, facesTouchingEdge } from './subShapes.js';

/**
 * C 面取り(FR-408、計画書 P3 §2.6、タスク8)。
 *
 * 対象の立体の辺を、保存してある指紋で選び直してから斜めに削り取る。
 * 大きさの指定は 3 通り(§0.a-0.18、`ChamferSizeSpec`)。
 *   - `equal`         : 距離 1 つ。両側とも同じ距離で 45°(`Add_2`)。基準面は要らない。
 *   - `twoDistances`  : 距離 2 つ。`distance1` が基準面の側(`Add_3`)。
 *   - `distanceAngle` : 距離と角度。角度は基準面から測る(`AddDA`)。
 *
 * 面を取れないときは**必ず日本語の理由を持つ Error で断り、アプリを落とさない**
 * (NFR-RE-1、FR-504)。
 */

/** これ未満の体積(mm³)は「立体が残らなかった」とみなす(makeFillet.ts と同じ下限)。 */
const MIN_SOLID_VOLUME_MM3 = 1e-9;

/** 指紋から辺を 1 本も選び直せなかったとき(§0.a-0.5 の missingSubShape に当たる)。 */
const MISSING_EDGE_MESSAGE =
  '面を取るもとの辺が見つかりません。形が大きく変わったため、選び直してください。';

/** 距離が 0 以下・非数のとき。 */
const DISTANCE_MESSAGE = '面取りの距離は 0 より大きい数にしてください。';

/** 角度が範囲の外のとき。ラジアンで受け取るが、文言は利用者の語彙(度)で書く。 */
const ANGLE_MESSAGE = '面取りの角度は 0 度より大きく 90 度より小さくしてください。';

/** 辺に接する面が 1 つ以下で、基準面を決められないとき。 */
const NO_REFERENCE_FACE_MESSAGE =
  'この辺には面取りできません。立体の外側の辺を選び直してください。';

/** OCCT が面取りし切れなかったとき。 */
const BUILD_FAILED_MESSAGE = '面を取れませんでした。距離を小さくするか、辺を選び直してください。';

/** 面取りできたが、結果が立体になっていないとき。 */
const NOT_SOLID_MESSAGE = '面を取った結果が立体になりませんでした。距離を小さくしてください。';

/** 距離として使える数か。0 と負と非数を断る。 */
function requireDistance(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(DISTANCE_MESSAGE);
  }
}

/**
 * 大きさの指定を、OCCT へ渡す前に検査する。
 *
 * 角度は**ラジアン**で受け取る(`ChamferSizeSpec` の約束。度からの換算は model 側の責務。
 * `docs/報告記録.md` 2026-09-02 18:23 で `MakeEdge_9` の角度をラジアンで取り違えた例がある)。
 * 上限を 90 度ちょうどにしないのは、90 度ではもう一方の距離 `distance·tan(angle)` が
 * 無限大に発散して面取りが定義できないためである(下の `AddDA` の注釈を参照)。
 */
function validateSize(size: ChamferSizeSpec): void {
  switch (size.kind) {
    case 'equal': {
      requireDistance(size.distance);
      return;
    }
    case 'twoDistances': {
      requireDistance(size.distance1);
      requireDistance(size.distance2);
      return;
    }
    case 'distanceAngle': {
      requireDistance(size.distance);
      if (!Number.isFinite(size.angle) || size.angle <= 0 || size.angle >= Math.PI / 2) {
        throw new Error(ANGLE_MESSAGE);
      }
      return;
    }
  }
}

/**
 * 辺の基準面を取り出す(§0.a-0.18)。呼び出し側が delete() する。
 *
 * `facesTouchingEdge` は `TopExp` の並びの順に面の通し番号を返すので、既定はその先頭、
 * `swapReferenceFace` が真なら 2 番目を使う。基準面をもう 1 回選ばせると操作が 2 段になり
 * NFR-UX-4 から外れるため、並びで決めて「思っていたのと逆ならつまみ 1 つで直す」形にしてある。
 *
 * 接する面が 1 つ以下の辺(自由辺・殻の縁)には面取りできないので断る。
 *
 * **費用の注意:** `facesTouchingEdge` は呼ぶたびに `TopExp.MapShapes_2` を回すので、
 * 辺の本数 × 面の枚数の費用がかかる(タスク4 の残件(b))。面取りする辺は
 * 実用上は数本〜十数本なので P3 では素直な実装のままにし、
 * 面が数百枚の形で効いてくるならタスク10 の性能実測で一覧を 1 度だけ作る版へ寄せる。
 */
function referenceFaceOf(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  edgeIndex: number,
  swapReferenceFace: boolean,
): TopoDS_Face {
  const touching = facesTouchingEdge(oc, shape, edgeIndex);
  if (touching.length < 2) {
    throw new Error(NO_REFERENCE_FACE_MESSAGE);
  }
  const face = faceAt(oc, shape, touching[swapReferenceFace ? 1 : 0]);
  if (face === null) {
    // 番号は `facesTouchingEdge` が同じ形から数えたものなので、通常はここへ来ない。
    throw new Error(NO_REFERENCE_FACE_MESSAGE);
  }
  return face;
}

/**
 * 辺 1 本を面取りの対象として登録する。
 *
 * **`Add_3` / `AddDA` の意味(2026-09-03 に Node で実測。計画書 §1.4-②③):**
 * 20×20×20 の箱の (0,0) にある縦の辺に、基準面を x=0 の面(`facesTouchingEdge` の先頭)
 * として掛けたところ、
 *   - `Add_3(3, 1, E, F)` → x=0 の面の側へ 3mm、y=0 の面の側へ 1mm 入った
 *     (できた形の頂点は (0,3,0) と (1,0,0))。基準面を y=0 の面に替えると
 *     頂点が (0,1,0) と (3,0,0) になり、**`Dis1` が基準面 `F` の側**だと確かめられた。
 *     体積はどちらも 7970(= 8000 − 20·3·1/2)で、入れ替えても体積は変わらない。
 *   - `AddDA(2, 30°をラジアンにした値, E, F)` → 基準面 x=0 の側へ 2mm、
 *     もう一方へ 1.1547005383792515mm 入った。これは `2·tan(30°)` で、
 *     体積 7976.905989232413 は `8000 − 20·2·(2·tan30°)/2 = 7976.905989232415` と一致した。
 *     したがって **`Dis` は基準面の側の距離、`Angle` は基準面から測った角度**で、
 *     もう一方の距離は `Dis·tan(Angle)` になる(`Dis/tan(Angle)` ではない)。
 *     角度が 90 度に近づくともう一方の距離が発散するので、上の `validateSize` で弾く。
 */
function addChamferedEdge(
  oc: OpenCascadeInstance,
  maker: BRepFilletAPI_MakeChamfer,
  shape: TopoDS_Shape,
  edgeIndex: number,
  spec: ChamferStepSpec,
): void {
  const { keep, release } = createAllocations();

  try {
    const edge = edgeAt(oc, shape, edgeIndex);
    if (edge === null) {
      // 一覧の番号が形と食い違っている(別の形から作った一覧を渡された)合図。
      throw new Error(MISSING_EDGE_MESSAGE);
    }
    keep(edge);

    const size = spec.size;
    if (size.kind === 'equal') {
      maker.Add_2(size.distance, edge);
      return;
    }

    const face = keep(referenceFaceOf(oc, shape, edgeIndex, spec.swapReferenceFace));
    if (size.kind === 'twoDistances') {
      maker.Add_3(size.distance1, size.distance2, edge, face);
      return;
    }
    maker.AddDA(size.distance, size.angle, edge, face);
  } finally {
    // Add_2 / Add_3 / AddDA は辺と面を maker の中へ写し取るので、その場で返してよい
    // (makeFillet.ts の Add_2 と同じ。2026-09-03 実測)。
    release();
  }
}

/**
 * 例外を利用者へ見せる日本語へ揃える。
 *
 * OCCT の C++ 側が投げる例外は、embind を通ると**数値(実体へのポインタ)**として飛んでくる
 * (2026-09-03 実測。辺を 1 本も足さずに `Build` したときは `19453408` だった)。
 * そのまま外へ出すと画面に数字が並ぶだけなので、こちらで理由へ置き換える。
 * 自分で投げた Error(すでに日本語)はそのまま通す。
 */
function toJapaneseFailure(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message);
}

/**
 * C 面取り(FR-408)。**対象は消費せず、新しい形を返す。**
 *
 * 手順は計画書 §2.6.2 のとおりで、①指紋で辺を選び直す → ②大きさに応じて
 * `Add_2` / `Add_3` / `AddDA` → ③`Build` → ④成否の確認 → ⑤結果の妥当性の確認、と進む。
 *
 * **辺の選び直しは R 面取りと同じ `resolveFilletEdges` を使う**(計画書 タスク8 の手順3)。
 * 「1 本でも選び直せなければ部分成功にせず断る」「重複は 1 度だけ」「番号の昇順で Add する」
 * という判断を 2 か所に書かないため。断りの文言だけがこちらの語彙(「面を取るもとの辺」)になる。
 *
 * **引数の `target` は解放しない。** 形はキャッシュの持ち物で、面取りしたあとも
 * 別の段の入力として使われる(booleanOp.ts / makeFillet.ts と同じ約束)。断ったときも触れない。
 *
 * **成否の見方(2026-09-03 に Node で実測):**
 * - `BRepFilletAPI_MakeChamfer` に `HasResult()` / `NbFaultyContours()` /
 *   `NbFaultyVertices()` は**そもそも存在しない**(型定義 92968 行の宣言と親
 *   `BRepFilletAPI_LocalOperation`(93104 行)・`BRepBuilderAPI_MakeShape`(11768 行)を確認)。
 *   フィレット側だけが持つ口である。したがって成否は `IsDone()` と結果の検証で見る。
 *   なお `HasResult()` はフィレットでは成功時でも false になる(タスク7 の実測)ので、
 *   仮にあったとしても成否の判定には使えない。
 * - 距離が大きすぎる失敗は例外にならず `IsDone()` が false になった。
 *   20×20×20 の箱で、縦 1 辺に 25mm(辺の間隔 20 を超える)、縦 4 辺に 15mm
 *   (隣の面取りとぶつかる)がどちらも false。**縦 1 辺に 15mm は成功する**(体積 5750)。
 * - 辺を 1 本も足さずに `Build` すると C++ 例外(数値)が飛ぶ。上の 0 本の門番で防ぐ。
 *
 * **体積が増えても失敗にしない。** 凹んだ辺(内側の角)を面取りすると材料が足されて
 * 体積は増える。これは正しい結果なので、「体積が増えたら失敗」という判定は入れない
 * (タスク7 の実測で確かめた性質。検査でも固定してある)。
 */
export function makeChamfer(
  oc: OpenCascadeInstance,
  spec: ChamferStepSpec,
  target: TopoDS_Shape,
  tables: SubShapeTables,
): OcctShapeHandle {
  validateSize(spec.size);

  // 位置の点を正規化する長さ。境界箱の対角長の半分(matchSubShape.ts の scorePosition)。
  const scale = boundingDiagonal(oc, target) * 0.5;
  const edgeIndices = resolveFilletEdges(oc, target, tables, spec.targets, scale);
  if (edgeIndices.length === 0) {
    throw new Error(MISSING_EDGE_MESSAGE);
  }

  const { keep, release } = createAllocations();

  try {
    const maker = keep(new oc.BRepFilletAPI_MakeChamfer(target));

    for (const index of edgeIndices) {
      addChamferedEdge(oc, maker, target, index, spec);
    }

    const range = keep(new oc.Message_ProgressRange_1());
    try {
      maker.Build(range);
    } catch (error) {
      throw toJapaneseFailure(error, BUILD_FAILED_MESSAGE);
    }

    // IsDone() を見る前に Shape() を呼ぶと C++ 例外が飛ぶ
    // (docs/報告記録.md 2026-09-03 06:56 の⑤。面取りも同じ扱いにする)。
    if (!maker.IsDone()) {
      throw new Error(BUILD_FAILED_MESSAGE);
    }

    const shape = keep(maker.Shape());

    if (!hasSolid(oc, shape) || Math.abs(measureVolume(oc, shape)) < MIN_SOLID_VOLUME_MM3) {
      throw new Error(NOT_SOLID_MESSAGE);
    }
    if (!isValidShape(oc, shape)) {
      throw new Error(NOT_SOLID_MESSAGE);
    }

    return { shape, delete: release };
  } catch (error) {
    release();
    throw error;
  }
}
