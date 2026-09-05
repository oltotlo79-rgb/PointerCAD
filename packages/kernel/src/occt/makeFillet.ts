import type {
  ChFi3d_FilletShape,
  OpenCascadeInstance,
  TopoDS_Shape,
} from 'opencascade.js/dist/opencascade.full.js';

import type { ConstantFilletStepSpec, SubShapeQuery } from '../types.js';
import { createAllocations } from './allocations.js';
import type { OcctShapeHandle } from './makeBox.js';
import { matchEdge, matchVertex } from './matchSubShape.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import type { SubShapeTables } from './subShapes.js';
import { boundingDiagonal, edgeAt, edgesTouchingVertex } from './subShapes.js';

/**
 * R 面取り(FR-407、計画書 P3 §2.6、タスク7)。
 *
 * 対象の立体の辺を、保存してある指紋で選び直してから半径 r で丸める。
 * 丸められないときは**必ず日本語の理由を持つ Error で断り、アプリを落とさない**
 * (NFR-RE-1、FR-504)。要件§10 のリスク表が名指ししているとおり、フィレットは
 * B-rep カーネルで最も失敗しやすい演算なので、成否の見方を実測で固めてある。
 */

/** これ未満の体積(mm³)は「立体が残らなかった」とみなす(booleanOp.ts と同じ下限)。 */
const MIN_SOLID_VOLUME_MM3 = 1e-9;

/** 指紋から辺を 1 本も選び直せなかったとき(§0.a-0.5 の missingSubShape に当たる)。 */
const MISSING_EDGE_MESSAGE =
  '丸めるもとの辺が見つかりません。形が大きく変わったため、選び直してください。';

/** 半径が 0 以下・非数のとき。 */
const RADIUS_MESSAGE = '丸める半径は 0 より大きい数にしてください。';

/** 述語ガードが偽になったとき(下の isFilletShape の注釈を参照)。 */
const KERNEL_NOT_READY_MESSAGE =
  '幾何カーネルの準備ができていません。アプリを再読み込みしてください。';

/** OCCT が丸め切れなかったとき。 */
const BUILD_FAILED_MESSAGE = '丸められませんでした。半径を小さくするか、辺を選び直してください。';

/** 丸められたが、結果が立体になっていないとき。 */
const NOT_SOLID_MESSAGE = '丸めた結果が立体になりませんでした。半径を小さくしてください。';

/** 丸められなかった輪郭の本数を添えた理由。 */
function faultyContourMessage(count: number): string {
  return `丸められない辺が ${count} 本ありました。半径を小さくしてください。`;
}

/**
 * BRepFilletAPI_MakeFillet の構築は列挙(ChFi3d_FilletShape)を引数に取り、
 * 型定義では「3 つの値をまとめた入れ物の型」
 * (`{ ChFi3d_Rational: {}; ChFi3d_QuasiAngular: {}; ChFi3d_Polynomial: {} }`)になっている。
 * 渡したい値 `oc.ChFi3d_FilletShape.ChFi3d_Rational` の型は**空の型 `{}`** なので、
 * そのままでは引数の型に合わず型検査を通らない。
 *
 * この API に番号付きの別版は無く(2026-09-03 に opencascade.full.d.ts の 93009 行で確認)、
 * 列挙を避ける書き方が存在しない。そこで **`unknown` を経由する述語ガード 1 つ**で絞る。
 * これは統括が §0.a-0.26 で承認した唯一の例外で、`as` / `any` / `@ts-ignore` /
 * `eslint-disable` は 1 つも使っていない。
 *
 * **この判定が確かめられること:** 「値が null でないオブジェクトであること」だけ。
 * **確かめられないこと(限界):** それが本当に ChFi3d_FilletShape の列挙値かどうか。
 * embind が作る列挙値は中身の見えない空のオブジェクト(`{}`、`value` に 0 が入る)なので、
 * 形を見て見分ける手立てが無い。したがってこのガードは
 * 「OCCT の読み込みが済んでいない/壊れている」ことだけを捕まえる網である。
 * 2026-09-03 に Node で実測したところ、
 * `new oc.BRepFilletAPI_MakeFillet(shape, oc.ChFi3d_FilletShape.ChFi3d_Rational)` は
 * 実行時にそのまま構築できた(§1.4-①。数値 0 を渡しても構築できたが、
 * 意味が読める列挙値のほうを採る)。
 *
 * **他の箇所へ広げない。** 別の API で同じ壁に当たったら、この書き方を写す前に統括へ諮る。
 *
 * **輸出している理由(P5 タスク53、2026-09-05):** 可変半径の R 面取り(FR-426)は
 * 同じ `BRepFilletAPI_MakeFillet` を `Add_3(R1, R2, E)` で使うが、統括の指示により
 * `makeVariableFillet.ts` という別ファイルに置く。そこで同じガードを書き直すと
 * 「同じ書き方を 2 か所に置く」ことになり、計画書 §4 が P5 に許した新しいガードは
 * `makeShell.ts` の 1 か所だけである。**新しいガードを増やさずに済ませるため、
 * ここにある 1 つを輸出して使い回す**(判定の中身は 1 文字も変えていない)。
 */
export function isFilletShape(value: unknown): value is ChFi3d_FilletShape {
  return typeof value === 'object' && value !== null;
}

/**
 * 指紋 1 つを、丸める辺の通し番号(0 本以上)へ直す。
 *
 * - 辺の指紋は `matchEdge` でそのまま選び直す。
 * - 頂点の指紋は `matchVertex` で頂点を選び直してから、
 *   その頂点に集まる辺(`edgesTouchingVertex`)へ展開する(§0.a-0.17)。
 *   OCCT に「頂点を球状に丸める」API は無く、集まる辺を同じ半径で丸めるのが
 *   利用者の言う「角を丸める」に当たるため。
 * - 面の指紋は丸める対象になりえないので 0 本を返す(呼び出し側が断る)。
 *
 * **頂点の経路は保険である。** §0.a-0.17 の追記で、文書には頂点の参照を保存せず
 * UI が確定時に「集まる辺」へ展開して保存すると決まった。頂点の指紋は
 * 通し番号が変わると最高 0.5 点にしかならずしきい値 0.6 に届かない
 * (matchSubShape.ts の MATCH_WEIGHT_VERTEX_INDEX の注釈)ので、
 * 番号が変わらない範囲でしか働かない。それでも `SubShapeQuery` の型が
 * 頂点を含む以上、黙って読み飛ばさずに意味のある扱いを与えておく。
 */
function resolveOneTarget(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  tables: SubShapeTables,
  query: SubShapeQuery,
  scale: number,
): readonly number[] {
  if (query.kind === 'edge') {
    const match = matchEdge(tables.edges, query, scale);
    return match === null ? [] : [match.index];
  }
  if (query.kind === 'vertex') {
    const match = matchVertex(tables.vertices, query, scale);
    return match === null ? [] : edgesTouchingVertex(oc, shape, match.index);
  }
  return [];
}

/**
 * 指紋の一覧から、丸める辺の通し番号を決める(§0.a-0.17)。
 * 重複は取り除き、番号の昇順で返す。
 *
 * **1 つでも選び直せない指紋があれば、部分成功にせず空の配列を返す**(統括の指示)。
 * 「3 本のうち 2 本だけ丸まった立体」は、利用者が意図していない別の形であり、
 * 黙って作ると気づかないまま下流へ伝わるため。空になった理由(0 個だったのか、
 * 一部が外れたのか)は区別せず、呼び出し側が同じ「見つかりません」で断る。
 *
 * C 面取り(タスク8 の `makeChamfer`)も同じ判断を使うので、**この関数を輸入して使い、
 * 同じ判断を 2 か所に書かない**(計画書 タスク8 の手順3)。断りの文言だけが
 * 「丸めるもとの辺」「面を取るもとの辺」で違うので、文言は呼び出し側が決める。
 */
export function resolveFilletEdges(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  tables: SubShapeTables,
  queries: readonly SubShapeQuery[],
  scale: number,
): readonly number[] {
  if (queries.length === 0) {
    return [];
  }

  const found = new Set<number>();
  for (const query of queries) {
    const indices = resolveOneTarget(oc, shape, tables, query, scale);
    if (indices.length === 0) {
      return [];
    }
    for (const index of indices) {
      found.add(index);
    }
  }

  // 同じ辺を 2 度指した指紋があっても Add は 1 回だけになる(集合が重複を落とす)。
  // 並びを番号の昇順に固定するのは、同じ入力から必ず同じ順で Add して
  // 同じ形が出るようにするため(決定性。matchSubShape.ts の同点の決めと同じ考え)。
  return [...found].sort((left, right) => left - right);
}

/**
 * 例外を利用者へ見せる日本語へ揃える。
 *
 * OCCT の C++ 側が投げる例外は、embind を通ると**数値(実体へのポインタ)**として
 * 飛んでくる(2026-09-03 実測。辺を 1 本も足さずに Build したときは `18979680` だった)。
 * そのまま外へ出すと画面に数字が並ぶだけなので、こちらで理由へ置き換える。
 * 自分で投げた Error(すでに日本語)はそのまま通す。
 */
function toJapaneseFailure(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message);
}

/**
 * R 面取り(FR-407)。**対象は消費せず、新しい形を返す。**
 *
 * 手順は計画書 §2.6.2 のとおりで、①指紋で辺を選び直す → ②`Add_2(radius, edge)` →
 * ③`Build` → ④成否の確認 → ⑤結果の妥当性の確認、と進む。
 *
 * **引数の `target` は解放しない。** 形はキャッシュの持ち物で、丸めたあとも
 * 別の段の入力として使われる(booleanOp.ts と同じ約束)。断ったときも触れない。
 *
 * **成否の見方(2026-09-03 に Node で実測):**
 * - `IsDone()` が真なら成功。20×20×20 の箱の縦 4 稜線を R5 で丸めて体積 7570.796326794894
 *   (計算値 7570.796326795 と一致)を得た。
 * - **`HasResult()` は成功しても偽になる。** 上の成功例でも偽だった。OCCT の
 *   `HasResult()` は「失敗したが途中までの形(`BadShape()`)がある」ことを表す口であり、
 *   成功したかどうかの合図ではない。**計画書 §0.a-0.19 と タスク7 の表は
 *   「`HasResult()` が偽なら断る」と書いているが、そのとおりに実装すると
 *   成功したフィレットまで全部断ってしまう**ので、ここでは失敗の判定に使わない
 *   (実測値を統括へ報告済み)。
 * - 失敗は 2 通りに分かれた。半径が隣の面からはみ出す場合は
 *   `IsDone()` 偽・`NbFaultyContours()` が 1 以上(40×30×10 の板の縦 1 辺に R40)、
 *   隣り合うフィレットどうしがぶつかる場合は
 *   `IsDone()` 偽・`NbFaultyContours()` が 0 で `NbFaultyVertices()` が 1 以上
 *   (20×20×20 の箱の縦 4 稜線に R15、40×30×10 の板の縦 4 稜線に R20)だった。
 *   どちらも例外にはならず、プロセスも落ちなかった。
 */
export function makeFillet(
  oc: OpenCascadeInstance,
  // 半径は**一定**のものだけを受け取る(可変半径は makeVariableFillet.ts、FR-426)。
  // どちらの半径かを振り分けるのは recomputeSolids の 1 か所だけにしてある(§0.a-0.48)。
  spec: ConstantFilletStepSpec,
  target: TopoDS_Shape,
  tables: SubShapeTables,
): OcctShapeHandle {
  if (!Number.isFinite(spec.radius) || spec.radius <= 0) {
    throw new Error(RADIUS_MESSAGE);
  }

  // 位置の点を正規化する長さ。境界箱の対角長の半分(matchSubShape.ts の scorePosition)。
  const scale = boundingDiagonal(oc, target) * 0.5;
  const edgeIndices = resolveFilletEdges(oc, target, tables, spec.targets, scale);
  if (edgeIndices.length === 0) {
    throw new Error(MISSING_EDGE_MESSAGE);
  }

  // 列挙値は unknown を経由してから述語ガードで絞る(§0.a-0.26。isFilletShape の注釈)。
  const filletShape: unknown = oc.ChFi3d_FilletShape.ChFi3d_Rational;
  if (!isFilletShape(filletShape)) {
    throw new Error(KERNEL_NOT_READY_MESSAGE);
  }

  const { keep, release } = createAllocations();

  try {
    const maker = keep(new oc.BRepFilletAPI_MakeFillet(target, filletShape));

    for (const index of edgeIndices) {
      const edge = edgeAt(oc, target, index);
      if (edge === null) {
        // 一覧の番号が形と食い違っている(別の形から作った一覧を渡された)合図。
        throw new Error(MISSING_EDGE_MESSAGE);
      }
      try {
        maker.Add_2(spec.radius, edge);
      } finally {
        // Add_2 は辺を maker の中へ写し取るので、その場で返してよい(2026-09-03 実測)。
        edge.delete();
      }
    }

    const range = keep(new oc.Message_ProgressRange_1());
    try {
      maker.Build(range);
    } catch (error) {
      // 辺が 1 本も無いまま Build すると C++ 例外が飛ぶ(§1.4-④ の実測)。
      // ここへ来るのは上の 0 本の門番をすり抜けた別の理由のときだけだが、
      // 数値のまま外へ出さず理由へ直す。
      throw toJapaneseFailure(error, BUILD_FAILED_MESSAGE);
    }

    // 個数の戻り型 Graphic3d_ZLayerId は型定義のどこにも無いので整数へ直す(§1.3)。
    const faultyContours = Number(maker.NbFaultyContours());
    if (faultyContours > 0) {
      throw new Error(faultyContourMessage(faultyContours));
    }

    // IsDone() を見る前に Shape() を呼ぶと C++ 例外が飛ぶ
    // (docs/報告記録.md 2026-09-03 06:56 の⑤。フィレットも同じ扱いにする)。
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
