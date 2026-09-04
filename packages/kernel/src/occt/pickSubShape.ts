/**
 * 指紋から立体の面・辺・頂点を選び直して、その形そのものを取り出す
 * (計画書 P3 §2.2.4「選び直しはカーネルの中で行う」、P4 タスク25・26)。
 *
 * 穴(`makeHole.ts`)・R 面取り(`makeFillet.ts`)・C 面取り(`makeChamfer.ts`)は
 * それぞれの中で「採点 → 通し番号 → 形の取り出し」を行っているが、どれも**その加工に
 * 必要な形(平面・辺の並び)へすぐ変換してしまう**ので、投影(FR-325)のように
 * 「面や辺そのものを 1 つ受け取りたい」用途には使えない。この 3 段だけをここへ切り出す。
 *
 * 採点(`matchSubShape.ts`)・一覧(`subShapes.ts`)は既存のものをそのまま使うので、
 * **重みもしきい値も選び方も加工フィーチャーと完全に同じ**である(§0.a-0.4)。
 * 同じ指紋からは加工と投影で必ず同じ面が選ばれる。
 */

import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type { SubShapeQuery } from '../types.js';
import { matchEdge, matchFace, matchVertex } from './matchSubShape.js';
import { boundingDiagonal, edgeAt, faceAt, vertexAt, type SubShapeTables } from './subShapes.js';

/**
 * 指紋に合う部分形状が無かったときの断り(FR-504、NFR-RE-1)。
 * 語尾は `makeHole.ts` / `makeFillet.ts` / `makeChamfer.ts` と揃えてある
 * (model 側の `recomputePart.ts` がこの語尾で `missingSubShape` へ詰め替える)。
 */
export const MISSING_SUB_SHAPE_MESSAGE =
  '選んだ面(辺)が見つかりません。形が大きく変わったため、選び直してください。';

/**
 * 指紋に最も近い部分形状を選び直し、その形を返す。届かなければ null。
 *
 * **戻り値は新しく作られた形なので、呼び出し側が `delete()` する。**
 * 引数の `shape` には触れない(形状キャッシュの持ち物のため)。
 */
export function pickSubShape(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  tables: SubShapeTables,
  query: SubShapeQuery,
): TopoDS_Shape | null {
  // 位置の点を部品の大きさで割るための長さ。加工フィーチャーと同じ決め方にする。
  const scale = boundingDiagonal(oc, shape) * 0.5;
  switch (query.kind) {
    case 'face': {
      const match = matchFace(tables.faces, query, scale);
      return match === null ? null : faceAt(oc, shape, match.index);
    }
    case 'edge': {
      const match = matchEdge(tables.edges, query, scale);
      return match === null ? null : edgeAt(oc, shape, match.index);
    }
    case 'vertex': {
      const match = matchVertex(tables.vertices, query, scale);
      return match === null ? null : vertexAt(oc, shape, match.index);
    }
  }
}
