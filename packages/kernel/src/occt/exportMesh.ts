/**
 * 書き出し用の三角形の作り直し(FR-803、NFR-PF-2、計画書 P6 §0.a-0.13、タスク11)。
 *
 * STL / OBJ / glTF / 3MF は「品質(偏差)を選べる」ことが要件(FR-803)で、
 * 画面用の粗さ(`DEFAULT_LINEAR_DEFLECTION = 0.1`)より細かい三角形を出したい。
 * ところが `BRepMesh_IncrementalMesh` は**形そのものへ三角形を書き込む**ので、
 * 形状キャッシュ(`worker/recomputeSolids.ts` の `shapeCache`)が持っている形へ
 * 直接掛けると、次の描画がキャッシュに残った細かい三角形を使ってしまい重くなる
 * (NFR-PF-1)。**書き出し用の三角形は、画面用のキャッシュを汚さない別の経路で作る。**
 *
 * ## 「複製する」を採った理由(§0.a-0.13 が担当判断に委ねた点、2026-09-06 実測)
 *
 * 計画書は「複製してから掛ける」か「掛けたあと元の粗さで掛け直す」かを、
 * `BRepBuilderAPI_Copy` の費用の実測で決めるとしていた。Node で測った結果は次のとおり。
 *
 * | 形 | `BRepBuilderAPI_Copy_2(S, false, false)` | 偏差 0.1 の三角形分割 | `BRepTools.Clean` |
 * |---|---|---|---|
 * | 20³ の箱(面 6 枚) | 0.79 ms | 4.77 ms | 0.62 ms |
 * | 箱 34 個のコンパウンド(面 204 枚) | 26.4 ms | 111 ms | 3.1 ms |
 *
 * **複製は三角形分割の 4〜6 分の 1 しかかからない**ので、複製を採る。
 * 「掛け直して戻す」は、①掛け直しのぶんもう一度 `BRepMesh` を走らせるので複製より高くつき、
 * ②書き出しの途中で例外が飛ぶとキャッシュの形が細かいままになる(戻し忘れる)、
 * ③書き出しの最中に描画が走るとその瞬間だけ細かい三角形が見える、という 3 つの穴がある。
 * **複製ならキャッシュの形に一切触れない**ので、この 3 つがまとめて消える。
 *
 * `copyGeom = false` を渡すのは、**面や辺の下地の幾何(`Geom_Surface` / `Geom_Curve`)を
 * 複製せず共有する**ため。三角形分割が書き込まれるのは位相の側(`BRep_TFace`)で、
 * 位相は `copyGeom` の値によらず必ず複製されるので、共有しても元の形の三角形は汚れない。
 * `copyMesh = false` は「元に付いている画面用の三角形を持ち込まない」指定で、
 * どのみち掛け直すぶんを写す無駄を省く(§0.a-0.13 の「三角形を持ち込まない引数で」)。
 *
 * `BRepTools.Clean`(実在。`.d.ts` 154238 行、`Clean(theShape, theForce)`)は使わない。
 * 複製は書き出しが終わったその場で捨てるので、捨てる直前に三角形を落としても意味が無く、
 * 元の形には最初から触れていないので落とすものが無いためである。
 *
 * ## 面の走査と向きの規則
 *
 * `tessellate.ts` をそのまま呼ぶ。面の走査(`TopExp.MapShapes_2` の順)、
 * 反転した面の頂点順の入れ替え、`StdPrs_ToolTriangulatedShape.Normal` による法線は
 * 画面用とまったく同じ規則になり、**三角形の表はすべて外向き**に揃う
 * (3MF / STL の仕様が外向きを求める)。同じ規則を 2 か所に書き写すと、
 * 片方だけ直したときに画面と書き出しで裏表が食い違うので、切り出しも複製もしない。
 */

import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import { createAllocations } from './allocations.js';
import { tessellate } from './tessellate.js';

/** 偏差(mm)が正の有限な数でないときの断り(FR-504、NFR-UX-5)。 */
export const EXPORT_DEFLECTION_MESSAGE = '書き出しの品質(偏差)は 0 より大きい数にしてください。';

/** 形の複製が作れなかったときの断り。 */
export const EXPORT_COPY_FAILED_MESSAGE = '書き出し用の形を用意できませんでした。';

/** 角度の偏差(ラジアン)が正の有限な数でないときの断り(FR-504、NFR-UX-5)。 */
export const EXPORT_ANGULAR_DEFLECTION_MESSAGE =
  '書き出しの品質(角度の偏差)は 0 より大きい数にしてください。';

/**
 * `buildExportMesh` の任意の指定。
 *
 * いまは角度の偏差だけ。**省略できる形にしてあるのは、`buildExportMesh(oc, shape, deflectionMm)`
 * で呼んでいる側(P6 タスク10 の書き出しの配線)を壊さないため**で、省略したときの
 * 振る舞いは角度の偏差を足す前とまったく同じになる。
 */
export interface ExportMeshOptions {
  /**
   * 法線の向きの最大ずれ(ラジアン)。小さいほど丸い面が細かくなる。
   * 省略すると画面用と同じ既定(`DEFAULT_ANGULAR_DEFLECTION` = 0.5)。
   */
  readonly angularDeflectionRad?: number;
}

/**
 * 書き出し用の三角形の網。
 *
 * 並びは `tessellate.ts` の `SurfaceMesh` と同じで、位置と法線は頂点ごとに 3 個ずつ、
 * `indices` は三角形ごとに 3 個ずつ並ぶ。位置を `Float32Array` にしてあるのも
 * `SurfaceMesh` に合わせたためで、STL / glTF / 3MF がどれも 32 ビットの浮動小数で
 * 座標を持つので、ここで 64 ビットにしても書き出す段で落ちる。
 *
 * 面ごとの範囲表(`SurfaceMesh.faceRanges`)は入れていない。タスク11 の受け渡しの
 * 約束が「位置・法線・添字・三角形の数」の 4 つだからで、面ごとの色(タスク13b・14b)が
 * 要るようになったら `tessellate` が既に返している範囲表をここへ足すだけで済む。
 */
export interface ExportMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly triangleCount: number;
}

/**
 * 書き出し用の三角形を、指定した偏差で作り直す(FR-803)。
 *
 * **引数の `shape` には触れない。** 形は形状キャッシュの持ち物なので、複製に対して
 * `BRepMesh_IncrementalMesh` を掛け、複製ごとその場で捨てる。呼び出しの前後で
 * `shape` の三角形は 1 枚も変わらない(検査で固定してある)。
 *
 * ## 角度の偏差を対で受ける理由(2026-09-06 実測、統括の決定)
 *
 * 弦のずれだけを細かくしても、**角度の偏差の既定 0.5 ラジアンが先に効いて**
 * 丸い面はそれ以上細かくならない。球 r=10 を長さ 0.1mm で切ったときの実測は、
 * 角度 0.5rad(既定)で 976 枚・体積の不足 1.43%、0.2rad で 2,020 枚・0.72%、
 * 0.1rad で 8,000 枚・0.18% だった。だから書き出しの品質 3 択は**長さと角度の対**
 * で持つ(粗い 0.5mm/0.5rad、標準 0.1mm/0.2rad、細かい 0.02mm/0.1rad)。
 * 表そのものは `packages/model` の 1 か所が正本で、kernel は数で受け取るだけ。
 *
 * @param deflectionMm 弦の最大ずれ(mm)。小さいほど細かい。品質(高・中・低)から
 *   この数への読み替えは `packages/model` の `EXPORT_DEVIATION_MM` が正本で、
 *   kernel は写しを持たず**数で受け取る**(同じ表が 2 か所にあると片方が古くなるため)。
 * @param options 角度の偏差。**省略できる**(省略すると角度は画面用と同じ既定 0.5rad)。
 */
export function buildExportMesh(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  deflectionMm: number,
  options: ExportMeshOptions = {},
): ExportMesh {
  if (!Number.isFinite(deflectionMm) || deflectionMm <= 0) {
    throw new Error(EXPORT_DEFLECTION_MESSAGE);
  }
  const angularDeflectionRad = options.angularDeflectionRad;
  if (
    angularDeflectionRad !== undefined &&
    (!Number.isFinite(angularDeflectionRad) || angularDeflectionRad <= 0)
  ) {
    throw new Error(EXPORT_ANGULAR_DEFLECTION_MESSAGE);
  }

  const { keep, release } = createAllocations();
  try {
    // 第 2 引数 copyGeom = false(幾何は共有)、第 3 引数 copyMesh = false(三角形は持ち込まない)。
    const copier = keep(new oc.BRepBuilderAPI_Copy_2(shape, false, false));
    if (!copier.IsDone()) {
      throw new Error(EXPORT_COPY_FAILED_MESSAGE);
    }
    // Shape() は copier の中の実体を指すので、控えへ copier の後に積む(解放は逆順)。
    const copied = keep(copier.Shape());

    // 角度のずれを渡さなければ `tessellate` の既定(画面用と同じ 0.5rad)になる。
    // `angularDeflection: undefined` を渡しても `?? DEFAULT_ANGULAR_DEFLECTION` が
    // 既定へ落とすので、省略時と同じ三角形になる(検査で固定してある)。
    const surface = tessellate(oc, copied, {
      linearDeflection: deflectionMm,
      angularDeflection: angularDeflectionRad,
    });

    return {
      positions: surface.positions,
      normals: surface.normals,
      indices: surface.indices,
      triangleCount: surface.triangleCount,
    };
  } finally {
    // 複製・copier は必ずここで捨てる。成功しても失敗しても持ち帰らない
    // (返すのは TypedArray だけなので、OCCT の実体を持ち出す必要が無い)。
    release();
  }
}
