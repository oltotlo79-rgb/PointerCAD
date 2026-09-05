import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type { SubShapeQuery } from '../types.js';
import { createAllocations } from './allocations.js';
import type { OcctShapeHandle } from './makeBox.js';
import { isFilletShape, resolveFilletEdges } from './makeFillet.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import type { SubShapeTables } from './subShapes.js';
import { boundingDiagonal, edgeAt } from './subShapes.js';

/**
 * 半径の変わる R 面取り(FR-426。計画書 P5 §2.12・§0.a-0.48、タスク53)。
 *
 * 辺 1 本の中で丸みの大きさを変える。始点側の半径と終点側の半径を別々に指定すると、
 * OCCT がその間をなめらかにつなぐ。半径が一定の R 面取り(FR-407)は `makeFillet.ts` の
 * 担当で、**そちらは 1 行も変えていない**(段への組み込みと 2 つの統合の判断は
 * 計画書のタスク42・55 の仕事)。
 *
 * **API は `Add_3(R1, R2, E)`**(§0.a-0.48)。`SetRadius_5` / `_6` は名前に反して
 * 一定半径なので使わない(§1.4-7)。
 *
 * **どちらの端が R1 か(2026-09-05 に Node で実測):** 20³ の箱の縦稜線
 * (下端 z = 0、上端 z = 20)に `Add_3(2, 5, edge)` を掛けたところ、
 * 角の点 (0, 0, 0) から形までの距離が 0.8284271247461885(半径 2 の丸みが作る
 * `r(√2 − 1)` = 0.8284271247461903 と一致)、点 (0, 0, 20) からは
 * 2.0703174550748566(半径 5 のときの 2.0710678118654755 と 0.00075 差)になった。
 * つまり **R1 は辺の始点側**(`SolidEdgeInfo.start` の側)、R2 は終点側である。
 *
 * **体積の実測(同日):** 20³ の縦稜線 1 本を
 *   R2 → R5 : 7943.407681943796
 *   R5 → R2 : 7943.407681943795(入れ替えても同じ)
 *   R5 一定 : 7892.6990816987245(解析値 8000 − (1 − π/4)·20·25 と一致)
 *   R2 一定 : 7982.831853071794(解析値 8000 − (1 − π/4)·20·4 と一致)
 * 計画書の検証表が挙げる近似値 7944.203522483337(半径が長さに比例して変わると見なし、
 * 断面積を `(r1² + r1r2 + r2²)/3` で平均した値)との差は 0.796 mm³ で、
 * **削れた量に対して 1.43%** だった。OCCT の可変半径は半径そのものを直線で変える法則ではなく
 * 面をなめらかにつなぐ近似なので、解析値とはこの程度ずれる。**計画書の期待値(相対 1%)は
 * 満たせないため、検査では「一定 R2 と一定 R5 の間にあること」「両端の半径が指定どおりであること」
 * 「近似値との差が削れた量の 2% 以内であること」で固定した**(統括へ報告済み)。
 */

/** これ未満の体積(mm³)は「立体が残らなかった」とみなす(booleanOp.ts と同じ下限)。 */
const MIN_SOLID_VOLUME_MM3 = 1e-9;

/** 指紋から辺を 1 本も選び直せなかったとき(makeFillet.ts と同じ文言に揃える)。 */
const MISSING_EDGE_MESSAGE =
  '丸めるもとの辺が見つかりません。形が大きく変わったため、選び直してください。';

/** 半径が 0 以下・非数のとき(makeFillet.ts と同じ文言)。 */
const RADIUS_MESSAGE = '丸める半径は 0 より大きい数にしてください。';

/** 丸める辺が 1 本も指定されていないとき。 */
const NO_TARGET_MESSAGE = '丸める辺が選ばれていません。';

/** 述語ガードが偽になったとき(makeFillet.ts の isFilletShape の注釈を参照)。 */
const KERNEL_NOT_READY_MESSAGE =
  '幾何カーネルの準備ができていません。アプリを再読み込みしてください。';

/** OCCT が丸め切れなかったとき(makeFillet.ts と同じ文言)。 */
const BUILD_FAILED_MESSAGE = '丸められませんでした。半径を小さくするか、辺を選び直してください。';

/** 丸められたが、結果が立体になっていないとき(makeFillet.ts と同じ文言)。 */
const NOT_SOLID_MESSAGE = '丸めた結果が立体になりませんでした。半径を小さくしてください。';

/** 丸められなかった輪郭の本数を添えた理由(makeFillet.ts と同じ文言)。 */
function faultyContourMessage(count: number): string {
  return `丸められない辺が ${count} 本ありました。半径を小さくしてください。`;
}

/** 辺 1 本ぶんの依頼。始点側と終点側で半径が違う。 */
export interface VariableFilletTarget {
  /** 丸める辺の指紋。頂点の指紋なら、その頂点に集まる辺すべてが同じ 2 値で丸まる。 */
  readonly target: SubShapeQuery;
  /** 辺の始点側の半径(mm)。0 より大きいこと。 */
  readonly startRadius: number;
  /** 辺の終点側の半径(mm)。0 より大きいこと。 */
  readonly endRadius: number;
}

/** 半径の変わる R 面取り 1 段の依頼。 */
export interface VariableFilletInput {
  /** 丸める辺の一覧。1 本以上。同じ辺を 2 度指したときは**先に書いたほうの半径**を使う。 */
  readonly targets: readonly VariableFilletTarget[];
}

/** 辺の通し番号ごとの半径の組。 */
interface EdgeRadii {
  readonly index: number;
  readonly startRadius: number;
  readonly endRadius: number;
}

/**
 * 例外を利用者へ見せる日本語へ揃える。
 *
 * OCCT の C++ 側が投げる例外は、embind を通ると**数値(実体へのポインタ)**として飛んでくる
 * (makeFillet.ts と同じ)。自分で投げた Error はそのまま通す。
 */
function toJapaneseFailure(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message);
}

/**
 * 依頼を「辺の通し番号 → 半径の組」の並びへ直す。番号の昇順で返す。
 *
 * 辺の選び直しは `makeFillet.ts` の `resolveFilletEdges` をそのまま使う
 * (**同じ判断を 2 か所に書かない**)。あちらは指紋の一覧をまとめて番号へ直すが、
 * ここでは半径が辺ごとに違うので **1 件ずつ**渡す。頂点の指紋を「集まる辺」へ広げる
 * 決め(§0.a-0.17)も、1 件ずつ渡すことでそのまま効く。
 *
 * **1 つでも選び直せない指紋があれば断る**(部分成功にしない。`makeFillet.ts` と同じ判断)。
 * 並びを昇順に固定するのは、同じ入力から必ず同じ順で `Add_3` して同じ形が出るようにするため。
 */
function resolveTargets(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  tables: SubShapeTables,
  targets: readonly VariableFilletTarget[],
  scale: number,
): readonly EdgeRadii[] {
  const found = new Map<number, EdgeRadii>();

  for (const entry of targets) {
    if (
      !Number.isFinite(entry.startRadius) ||
      entry.startRadius <= 0 ||
      !Number.isFinite(entry.endRadius) ||
      entry.endRadius <= 0
    ) {
      throw new Error(RADIUS_MESSAGE);
    }
    const indices = resolveFilletEdges(oc, shape, tables, [entry.target], scale);
    if (indices.length === 0) {
      throw new Error(MISSING_EDGE_MESSAGE);
    }
    for (const index of indices) {
      // 先に書いたほうを残す。同じ辺に 2 通りの半径を渡されたとき、あとの指定で
      // 黙って上書きすると、利用者が最初に指定した見た目が消える。
      if (!found.has(index)) {
        found.set(index, {
          index,
          startRadius: entry.startRadius,
          endRadius: entry.endRadius,
        });
      }
    }
  }

  return [...found.values()].sort((left, right) => left.index - right.index);
}

/**
 * 半径の変わる R 面取り(FR-426)。**対象は消費せず、新しい形を返す。**
 *
 * 引数の `target` は解放しない(形はキャッシュの持ち物。booleanOp.ts と同じ約束)。
 * 断ったときも触れない。失敗は必ず日本語の理由を持つ `Error` で返し、
 * アプリを落とさない(NFR-RE-1、FR-504)。
 *
 * **成否の見方は `makeFillet.ts` と同じ。** `HasResult()` は成功しても偽になるので使わず、
 * `NbFaultyContours()` と `IsDone()` で見る。`IsDone()` を見る前に `Shape()` を呼ぶと
 * C++ 例外が飛ぶので、必ず先に成否を見る。
 *
 * **半径の値そのものは検査しない(OCCT が断らない)。** 2026-09-05 の実測では
 * `Add_3(0, 5, edge)` も `Add_3(-1, 5, edge)` も `IsDone()` が真になり、
 * 指定と違う形が黙って出た。そこで**この関数の入り口で 0 以下と非数を断る**。
 */
export function makeVariableFillet(
  oc: OpenCascadeInstance,
  target: TopoDS_Shape,
  tables: SubShapeTables,
  input: VariableFilletInput,
): OcctShapeHandle {
  if (input.targets.length === 0) {
    throw new Error(NO_TARGET_MESSAGE);
  }

  // 位置の点を正規化する長さ。境界箱の対角長の半分(matchSubShape.ts の scorePosition)。
  const scale = boundingDiagonal(oc, target) * 0.5;
  const edges = resolveTargets(oc, target, tables, input.targets, scale);
  if (edges.length === 0) {
    throw new Error(MISSING_EDGE_MESSAGE);
  }

  // 列挙値は unknown を経由してから述語ガードで絞る(§0.a-0.26。makeFillet.ts の注釈)。
  // **新しいガードは作らず、makeFillet.ts の 1 つを輸入して使い回す**(§4)。
  const filletShape: unknown = oc.ChFi3d_FilletShape.ChFi3d_Rational;
  if (!isFilletShape(filletShape)) {
    throw new Error(KERNEL_NOT_READY_MESSAGE);
  }

  const { keep, release } = createAllocations();

  try {
    const maker = keep(new oc.BRepFilletAPI_MakeFillet(target, filletShape));

    for (const entry of edges) {
      const edge = edgeAt(oc, target, entry.index);
      if (edge === null) {
        // 一覧の番号が形と食い違っている(別の形から作った一覧を渡された)合図。
        throw new Error(MISSING_EDGE_MESSAGE);
      }
      try {
        maker.Add_3(entry.startRadius, entry.endRadius, edge);
      } finally {
        // Add_3 は辺を maker の中へ写し取るので、その場で返してよい(makeFillet.ts と同じ)。
        edge.delete();
      }
    }

    const range = keep(new oc.Message_ProgressRange_1());
    try {
      maker.Build(range);
    } catch (error) {
      throw toJapaneseFailure(error, BUILD_FAILED_MESSAGE);
    }

    // 個数の戻り型 Graphic3d_ZLayerId は型定義のどこにも無いので整数へ直す(§1.4)。
    const faultyContours = Number(maker.NbFaultyContours());
    if (faultyContours > 0) {
      throw new Error(faultyContourMessage(faultyContours));
    }

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
