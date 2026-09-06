/**
 * 書き出し・読み込みで 2 つ以上のファイルが共用するものの単一の置き場
 * (計画書 P6 §2.8 の断りの表、タスク16)。
 *
 * ## なぜ 1 か所へ寄せるのか
 *
 * タスク17(`readStl.ts`)・タスク18(`readCafMesh.ts`)・タスク7(`xcafDocument.ts`)・
 * タスク13(`writeCafMesh.ts`)は並行して書かれたため、**先に着地したファイルへ触れない**
 * まま同じ文言・同じ型・同じ計算を写す形になった(各ファイルの注釈が「タスク16 で
 * 共有の置き場へ寄せる」と申し送っている)。写しが 2 か所にあると、片方だけ直したときに
 * 画面へ出る断りが読み込みの経路ごとに食い違う。**同じ規約は 1 か所にだけ書く**
 * (`CLAUDE.md`「規約の構成」)ので、ここが正本になる。
 *
 * ## 置いてあるもの
 *
 * | 何 | 使う側 |
 * |---|---|
 * | 読み込んだ三角形の束の型(`ImportedMeshData`) | `readStl.ts` / `readCafMesh.ts` |
 * | 断りの文言 3 種(読めない / 形が無い / 大きすぎる) | 同上 |
 * | 頂点法線と体積の計算 | 同上 |
 * | 書き出しの色の値の断り | `xcafDocument.ts` / `writeCafMesh.ts` |
 *
 * **名前について:** 指示書は `meshShared.ts` を挙げていたが、書き出しの色の断り
 * (`INVALID_EXPORT_COLOR_MESSAGE`)は三角形の網とは関係が無く、STEP の書き出し
 * (`xcafDocument.ts`)も使う。中身は「入出力(exchange)で共用するもの」なので
 * `exchangeShared.ts` とした(指示書が名前を担当の判断に委ねている)。
 *
 * **OCCT を呼ばない。** ここにあるのは素の JavaScript の値と計算だけで、
 * 検査からも model からもそのまま呼べる。
 */

/**
 * 読み込んだ三角形の束(計画書 §2.8。`.pcad` の `meshes/<id>.bin` と同じ並び)。
 *
 * 並びは `tessellate.ts` の `SurfaceMesh`・`exportMesh.ts` の `ExportMesh` と同じで、
 * 位置と法線は頂点ごとに 3 個ずつ、`indices` は三角形ごとに 3 個ずつ並ぶ。
 * `volume` を持つぶんだけ `ExportMesh` より広い(読み込みは体積を数え直せないので、
 * 読んだその場で求めた値を持ち帰る)。
 */
export interface ImportedMeshData {
  /** 頂点の位置(x, y, z の繰り返し)。 */
  readonly positions: Float32Array;
  /** 頂点の法線(単位ベクトル)。ファイルに無ければ三角形から計算したもの。 */
  readonly normals: Float32Array;
  /** 三角形の頂点の番号(3 個で 1 枚。0 始まり)。 */
  readonly indices: Uint32Array;
  /** 三角形の枚数(`indices.length / 3`)。 */
  readonly triangleCount: number;
  /** 閉じた形とみなしたときの体積(mm³)。開いた形では意味を持たない目安。 */
  readonly volume: number;
}

/**
 * 読めなかったとき(壊れている・頭が足りない・その形式でない)の断り(§2.8 の表)。
 *
 * **STEP の `STEP_READ_FAILED_MESSAGE`(`readStep.ts`)と 1 字も違わない。** そちらは
 * STEP だけが使う断りの並び(形が無い・立体が無い)と 1 組になっているので、
 * この共有の置き場へは寄せずにそのまま残してある(寄せると STEP の断りの表が
 * 2 つのファイルに割れる)。**同じ文言であることは、この注釈と `readStep.ts` の
 * 注釈の両方に書いてある。**
 */
export const MESH_READ_FAILED_MESSAGE =
  'このファイルを読めませんでした。ファイルが壊れているか、対応していない形式です。';

/**
 * 読めたが三角形が 1 枚も無かったときの断り(計画書 §2.4 の表)。
 *
 * STL は「ファイルは読めたが面が 0 枚」という状態がありうるので、
 * 下の `MESH_NO_SHAPE_MESSAGE`(そもそも形が入っていない)と文言を分けてある。
 */
export const MESH_NO_FACE_MESSAGE = 'この形には面がありません。';

/**
 * 読めたが形が 1 つも入っていなかったときの断り(計画書 §2.8 の表)。
 *
 * `readStep.ts` の `STEP_NO_SHAPE_MESSAGE` と同じ文言。STEP 側を寄せない理由は
 * `MESH_READ_FAILED_MESSAGE` と同じ。
 */
export const MESH_NO_SHAPE_MESSAGE = 'このファイルには形が入っていません。';

/**
 * 開ける三角形の上限(計画書 §2.8 の断りの表)。
 *
 * 10 万三角形で約 2.4MB(§2.8 の見積もり)なので、500 万なら約 120MB。
 * これを超えると WASM の記憶と `.pcad` の大きさのどちらも実用の範囲を出る。
 */
export const MESH_MAX_TRIANGLE_COUNT = 5_000_000;

/** 三角形が多すぎて開けないときの断り(計画書 §2.8 の表。個数を文言に入れる)。 */
export function meshTooLargeMessage(triangleCount: number): string {
  return `この形は大きすぎて開けません(三角形が ${String(triangleCount)} 個)。`;
}

/**
 * 書き出しの色の値が 0〜1 の数でないときの断り。
 *
 * STEP(`xcafDocument.ts`)と OBJ / glTF(`writeCafMesh.ts`)が同じ判定をするので、
 * 文言もここが正本。**`packages/io` の 3MF(`writeThreeMf.ts` の
 * `THREE_MF_INVALID_COLOR_MESSAGE`)も同じ文言だが、io は kernel を輸入できる一方で
 * この文言のためだけに kernel へ依存させたくない**ので向こうは写しのままにしてある
 * (`rules/04-設計の規律.md` の依存方向は io → kernel を持たない)。
 */
export const INVALID_EXPORT_COLOR_MESSAGE = '書き出しの色の値が正しくありません。';

/**
 * 三角形から頂点の法線を作る(STL には無い / OBJ・glTF は面ごとに有無が分かれる)。
 *
 * 各三角形の 2 辺の外積を、その 3 頂点へ足し込んでから正規化する。外積の長さは
 * 三角形の面積の 2 倍なので、**正規化せずに足すと自然に面積の重みが付く**(細かい
 * 三角形が多い側へ法線が引っぱられない)。
 *
 * 長さが 0 になるのは、その頂点に付く三角形が全部つぶれている(面積 0)ときだけ。
 * `NaN` を画面へ流すと three.js の描画が黙って壊れるので、そのときは Z の向きを置く。
 */
export function computeVertexNormals(
  positions: Float32Array,
  indices: Uint32Array,
): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const ia = indices[offset] * 3;
    const ib = indices[offset + 1] * 3;
    const ic = indices[offset + 2] * 3;
    const ux = positions[ib] - positions[ia];
    const uy = positions[ib + 1] - positions[ia + 1];
    const uz = positions[ib + 2] - positions[ia + 2];
    const vx = positions[ic] - positions[ia];
    const vy = positions[ic + 1] - positions[ia + 1];
    const vz = positions[ic + 2] - positions[ia + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const base of [ia, ib, ic]) {
      normals[base] += nx;
      normals[base + 1] += ny;
      normals[base + 2] += nz;
    }
  }
  for (let base = 0; base < normals.length; base += 3) {
    const length = Math.hypot(normals[base], normals[base + 1], normals[base + 2]);
    if (length === 0) {
      normals[base + 2] = 1;
      continue;
    }
    normals[base] /= length;
    normals[base + 1] /= length;
    normals[base + 2] /= length;
  }
  return normals;
}

/**
 * 三角形の束から体積を求める(発散定理。符号付き四面体の和)。
 *
 * 原点と三角形が作る四面体の符号付き体積 `(v₁ × v₂)·v₃ / 6` を全部足すと、
 * 閉じた形なら中身の体積になる(外向きなら正、内向きなら負)。読み込んだファイルは
 * 表裏が揃っていないことがあるので**絶対値を取る**。開いた形では意味を持たないが、
 * 「読んだ形の目安」としてプロパティパネルへ出す(§2.18)。
 */
export function computeVolume(positions: Float32Array, indices: Uint32Array): number {
  let sum = 0;
  for (let offset = 0; offset < indices.length; offset += 3) {
    const ia = indices[offset] * 3;
    const ib = indices[offset + 1] * 3;
    const ic = indices[offset + 2] * 3;
    const ax = positions[ia];
    const ay = positions[ia + 1];
    const az = positions[ia + 2];
    const bx = positions[ib];
    const by = positions[ib + 1];
    const bz = positions[ib + 2];
    const cx = positions[ic];
    const cy = positions[ic + 1];
    const cz = positions[ic + 2];
    sum += (ay * bz - az * by) * cx + (az * bx - ax * bz) * cy + (ax * by - ay * bx) * cz;
  }
  return Math.abs(sum) / 6;
}
