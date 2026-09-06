/**
 * 3D プリントの点検の結果を「材質の割り当て」に直す純関数(計画書 docs/plans/P6-入出力.md
 * §0.53、タスク46 = 43a)。
 *
 * 対応要件: FR-815(点検の結果を色で示す)、NFR-PF-1(60fps)。
 *
 * three.js にも DOM にもストアにも触れない(Node のまま検査できる)。実際に three を
 * 触るのは `viewport/createSolidLayer.ts` だけにする——`appearance/buildFaceGroups.ts` と
 * `viewport/createSolidLayer.ts` の分け方をそのまま真似ている。
 *
 * ## 3 材質にする理由(§0.53)
 *
 * P5 の材質の分け方(`geometry.addGroup` + ボディごとの材質の配列)をそのまま使い、
 * **点検の間だけ外観の割り当てを一時的に無視して 3 材質**(既定 + 赤 + 橙)にする。
 * 外観の上に点検の色を重ねると、1 ボディの材質が「外観の種類 × 点検の 3 通り」に増え、
 * P5 の上限(1 ボディ 8 材質、`MAX_MATERIALS_PER_BODY`)を簡単に超える。点検を閉じれば
 * 元の外観に戻る(色は上書きせず、割り当てを差し替えているだけ)。
 *
 * ## 薄い肉厚(赤)がせり出し(橙)より優先する理由
 *
 * 1 枚の三角形が両方に当たることがある(薄い庇の下面など)。**赤を勝たせる**のは、
 * せり出しは支持材を足せば刷れるのに対し、薄すぎるところは**造形そのものが抜ける**
 * ——直さないと物にならない側だからである。§0.53 は優先順位を書いていないので、
 * この判断はここ 1 か所に置き、色を塗る側(`createSolidLayer.ts`)は持たない。
 *
 * ## 三角形の番号が画面と点検で一致する理由
 *
 * 点検はカーネルが**書き出し用の三角形を作り直して**測る。その作り直しは面の走査も
 * 向きの規則も画面用とまったく同じ(`kernel/src/occt/exportMesh.ts` の注釈)なので、
 * **細かさの対を画面と同じにすれば並びもそろう**。model の `DISPLAY_MESH_QUALITY` が
 * その対で、点検を頼む側はこれを使う(`KernelBridge.inspectPrintability` の既定)。
 * それでも数が食い違ったときのために `printabilityCovers` で範囲を確かめ、
 * 合わないボディには色を塗らない(ずれた場所を赤くするより、塗らないほうがよい)。
 */

import { readPrintabilityFlag, type AppearanceSpec, type PrintabilityReport } from '@pointercad/model';

import type { FaceGroup } from '../appearance/buildFaceGroups.js';

/** 点検の間の材質の並び。既定(外観を無視した素の色)。 */
export const PRINTABILITY_DEFAULT_MATERIAL_INDEX = 0;
/** しきい値より薄い三角形(赤)。 */
export const PRINTABILITY_THIN_MATERIAL_INDEX = 1;
/** 支持が要る(せり出している)三角形(橙)。 */
export const PRINTABILITY_OVERHANG_MATERIAL_INDEX = 2;

/**
 * 点検の間の 1 ボディの材質の数(§0.53)。**P5 の上限 8 に触れない。**
 * `printabilityAppearances` が返す配列の長さと必ず一致する(下の検査で固定)。
 */
export const PRINTABILITY_MATERIAL_COUNT = 3;

/** 立体 1 つぶんの三角形の枚数(点検を頼んだ順に並べる)。 */
export interface PrintabilityBodyTriangles {
  /** 立体を作ったフィーチャーの id。 */
  readonly featureId: string;
  /** 画面に出ている三角形の枚数。 */
  readonly triangleCount: number;
}

/**
 * 点検の間だけ使う 3 つの外観を作る(§0.53)。
 *
 * **赤と橙は `base` の色だけを差し替えたもの**にする。艶や粗さまで変えると、同じ形の
 * 面が材質ごとに違う立体に見えてしまい、「どこが問題か」より「どこが別の材質か」が
 * 目立つ。色以外を揃えておけば、差は色だけになる。
 *
 * `base` には**外観を割り当てていない立体の見え方**(テーマの色を当てた既定の外観)を
 * 渡す。点検の間は割り当てを無視する決め(§0.53)なので、ここで利用者の外観を混ぜない。
 */
export function printabilityAppearances(
  base: AppearanceSpec,
  thinColor: string,
  overhangColor: string,
): readonly AppearanceSpec[] {
  return [base, { ...base, color: thinColor }, { ...base, color: overhangColor }];
}

/**
 * 点検を頼んだ順から、立体ごとの「結果の中での先頭の三角形の番号」を作る。
 *
 * カーネルは複数の立体を頼まれると三角形を 1 つに連ねてから測る(`mergeExportMeshes`)。
 * 連ねる順は依頼の並びそのままなので、枚数を足し上げれば先頭の位置が出る。
 * **同じ id が 2 度出たときは最初の位置を残す**(後の重複は依頼側の取り違えで、
 * 上書きすると 1 つ目の立体の色が別の場所のものになる)。
 */
export function printabilityTriangleOffsets(
  bodies: readonly PrintabilityBodyTriangles[],
): ReadonlyMap<string, number> {
  const offsets = new Map<string, number>();
  let running = 0;
  for (const body of bodies) {
    if (!offsets.has(body.featureId)) {
      offsets.set(body.featureId, running);
    }
    running += Math.max(0, body.triangleCount);
  }
  return offsets;
}

/**
 * その範囲が点検の結果に収まっているか。**収まらないボディには色を塗らない。**
 *
 * 画面の三角形と点検の三角形は、細かさの対をそろえていれば同じ並びになる(冒頭の注釈)。
 * それでも食い違ったとき——たとえば点検の後に形を作り直した、粗さを変えて頼んだ——に
 * そのまま塗ると、**まったく関係の無い面が赤くなる**。数で確かめられる範囲は確かめる。
 */
export function printabilityCovers(
  report: PrintabilityReport,
  triangleOffset: number,
  triangleCount: number,
): boolean {
  return (
    Number.isInteger(triangleOffset) &&
    triangleOffset >= 0 &&
    triangleCount >= 0 &&
    triangleOffset + triangleCount <= report.triangleCount
  );
}

/**
 * 三角形 1 枚の材質の番号(0 = 既定、1 = 薄い、2 = せり出し)。
 *
 * 開いた辺は**材質では示さない**(紫の線で別に描く、§0.53)。面の色にしてしまうと、
 * 「開いている」という辺の性質が面の広さで誇張されるうえ、材質が 4 つに増える。
 */
export function printabilityMaterialIndex(report: PrintabilityReport, triangle: number): number {
  if (readPrintabilityFlag(report.thinTriangles, triangle)) {
    return PRINTABILITY_THIN_MATERIAL_INDEX;
  }
  if (readPrintabilityFlag(report.overhangTriangles, triangle)) {
    return PRINTABILITY_OVERHANG_MATERIAL_INDEX;
  }
  return PRINTABILITY_DEFAULT_MATERIAL_INDEX;
}

/**
 * 立体 1 つぶんの描画のまとまりを作る(`geometry.addGroup` へそのまま渡せる形)。
 *
 * 単位は**索引の個数**(三角形の枚数 × 3)で、`buildFaceGroups.ts` の `FaceGroup` と同じ。
 * 隣り合う三角形の材質が同じなら 1 つのまとまりへ畳む——ドローコールの数は材質の種類
 * ではなくまとまりの数で決まる(§2.5.2)。問題の三角形が散らばるとまとまりは増えるが、
 * **点検の間だけ**の表示なので、まとまりの数に上限は設けない(上限を超えて「塗れません」と
 * 断るより、少し重くても塗って見せるほうが役に立つ。NFR-UX-5 より FR-815 を採る)。
 *
 * 範囲が結果からはみ出すとき(`printabilityCovers` が偽)は**空**を返す。呼び出し側は
 * 空のときそのボディを元の外観のまま描く。
 */
export function buildPrintabilityGroups(
  report: PrintabilityReport,
  triangleOffset: number,
  triangleCount: number,
): readonly FaceGroup[] {
  if (!printabilityCovers(report, triangleOffset, triangleCount) || triangleCount === 0) {
    return [];
  }
  const groups: FaceGroup[] = [];
  let runStart = 0;
  let runIndex = printabilityMaterialIndex(report, triangleOffset);
  for (let triangle = 1; triangle < triangleCount; triangle += 1) {
    const materialIndex = printabilityMaterialIndex(report, triangleOffset + triangle);
    if (materialIndex === runIndex) {
      continue;
    }
    groups.push({ start: runStart * 3, count: (triangle - runStart) * 3, materialIndex: runIndex });
    runStart = triangle;
    runIndex = materialIndex;
  }
  groups.push({
    start: runStart * 3,
    count: (triangleCount - runStart) * 3,
    materialIndex: runIndex,
  });
  return groups;
}

/**
 * 開いた辺を持つ三角形の輪郭を線分列にする(§0.53 の「太い紫の線」)。
 *
 * **三角形の 3 辺すべてを引く。** 点検の結果は三角形ごとの真偽しか持たない
 * (1 ビット × 3 本で Worker 越しに渡す、§2.17-9)ので、3 本のうちどれが開いているかは
 * ここでは分からない。開いた辺は必ずその三角形の輪郭のどこかにあるので、輪郭ごと
 * 引けば見落としは無い(閉じている辺も一緒に引く、という誤差だけが残る)。
 *
 * 返す並びは `THREE.LineSegments` にそのまま渡せる形(線分 1 本あたり 6 個)。
 * 範囲が結果からはみ出すときは空を返す(`buildPrintabilityGroups` と同じ扱い)。
 */
export function buildPrintabilityOpenEdgePositions(
  positions: Float32Array,
  indices: Uint32Array,
  report: PrintabilityReport,
  triangleOffset: number,
  triangleCount: number,
): Float32Array {
  if (!printabilityCovers(report, triangleOffset, triangleCount)) {
    return new Float32Array(0);
  }
  const drawn: number[] = [];
  const available = Math.min(triangleCount, Math.floor(indices.length / 3));
  for (let triangle = 0; triangle < available; triangle += 1) {
    if (!readPrintabilityFlag(report.openEdgeTriangles, triangleOffset + triangle)) {
      continue;
    }
    for (let corner = 0; corner < 3; corner += 1) {
      const from = indices[triangle * 3 + corner] * 3;
      const to = indices[triangle * 3 + ((corner + 1) % 3)] * 3;
      drawn.push(
        positions[from],
        positions[from + 1],
        positions[from + 2],
        positions[to],
        positions[to + 1],
        positions[to + 2],
      );
    }
  }
  return Float32Array.from(drawn);
}
