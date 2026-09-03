/**
 * 立体の部分形状(頂点・辺)の当たり判定(計画書 docs/plans/P3-加工フィーチャー.md タスク20、
 * §2.3.2、§0.a-0.27)。
 *
 * 対応要件: FR-106(クリック選択とホバー)、NFR-PF-1(60fps)。
 *
 * スケッチの当たり判定(`sketch/pickMath.ts`)と同じく判定は**画面座標**で行い、
 * ワールド → 画面の写し方は呼び出し側から関数(`ProjectToScreen`)で注入する。
 * three.js にも DOM にも触れないので Node で検査できる。射影はタスク23 が `worldToScreen` で行う。
 *
 * **深度(手前か奥か)は見ない(§0.a-0.27)。** 裏側の辺・頂点も画面上の近さだけで拾う。
 * 機械部品の面取りでは裏側の辺を指定したいことが多く、隠れているかを調べるには辺ごとに
 * 光線を飛ばす必要があって NFR-PF-1 を割るため。スケッチ要素の当たり判定(6px、深度を見ない)と
 * 規則が揃うので、利用者にも説明しやすい。この限界はヘルプにも書く(タスク26)。
 *
 * **面はここでは拾わない。** 面は「重なって見えているうちの手前の 1 枚」を選ぶ必要があり、
 * `ProjectToScreen` は画面の x・y しか返さないので深度が分からない。面は `Raycaster` を
 * 1 回だけ回して当たった三角形の番号を得(タスク22 の `pickFace`)、その番号を
 * このファイルの `faceIndexOfTriangle` で面の通し番号へ直す(§2.3.2 の表)。
 */

import { distanceToSegment2d, PICK_RADIUS_PIXELS } from '../sketch/pickMath.js';
import type { ProjectToScreen } from '../sketch/snapMath.js';

import { subShapeElementId } from './subShapeSelection.js';
import type { SolidFaceEntry, SubShapeBody, SubShapeKind } from './subShapeSelection.js';

/** 部分形状の当たり判定の半径(px)。スケッチ要素と同じ 6px に揃える(§2.3.2)。 */
export const SUB_SHAPE_PICK_RADIUS_PIXELS = PICK_RADIUS_PIXELS;

/** 拾った部分形状。 */
export interface SubShapePickResult {
  /** そのままストアの `selection` / `hoveredElementId` に入れられる要素 id(§0.a-0.8)。 */
  readonly elementId: string;
  readonly kind: SubShapeKind;
  /** 画面上の距離(px)。近いほうを選ぶための値。 */
  readonly distance: number;
}

type Screen = readonly [number, number];

/** 画面上で最も近い頂点。半径の外なら null。 */
function pickVertex(
  bodies: readonly SubShapeBody[],
  project: ProjectToScreen,
  pointer: Screen,
  radiusPixels: number,
): SubShapePickResult | null {
  let best: SubShapePickResult | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const body of bodies) {
    for (const vertex of body.vertices) {
      const screen = project(vertex.position);
      // カメラの裏に回った点は写せないので飛ばす(スケッチの当たり判定と同じ扱い)。
      if (screen === null) {
        continue;
      }
      const distance = Math.hypot(screen[0] - pointer[0], screen[1] - pointer[1]);
      if (distance <= radiusPixels && distance < bestDistance) {
        bestDistance = distance;
        best = {
          elementId: subShapeElementId(body.featureId, 'vertex', vertex.index),
          kind: 'vertex',
          distance,
        };
      }
    }
  }
  return best;
}

/** 画面上で最も近い辺。半径の外なら null。 */
function pickEdge(
  bodies: readonly SubShapeBody[],
  project: ProjectToScreen,
  pointer: Screen,
  radiusPixels: number,
): SubShapePickResult | null {
  let best: SubShapePickResult | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const body of bodies) {
    const positions = body.mesh.edgePositions;
    for (const edge of body.edges) {
      // 範囲表が並びの外を指していても落ちないように、必ず配列の中へ丸める
      // (上流が変わって辺が減った直後など、一覧と並びの世代がずれることがある)。
      const begin = Math.max(0, edge.segmentOffset * 6);
      const end = Math.min(begin + Math.max(0, edge.segmentCount) * 6, positions.length);
      for (let offset = begin; offset + 5 < end; offset += 6) {
        const from = project([positions[offset], positions[offset + 1], positions[offset + 2]]);
        const to = project([positions[offset + 3], positions[offset + 4], positions[offset + 5]]);
        if (from === null || to === null) {
          continue;
        }
        // 長さ 0 に退化した線分(`segmentCount > 0` でも始点と終点が同じ。
        // `docs/報告記録.md` 2026-09-03 21:50)は、`distanceToSegment2d` が
        // その点までの距離を返すので 0 除算にならない。
        const distance = distanceToSegment2d(pointer, from, to);
        if (distance <= radiusPixels && distance < bestDistance) {
          bestDistance = distance;
          best = {
            elementId: subShapeElementId(body.featureId, 'edge', edge.index),
            kind: 'edge',
            distance,
          };
        }
      }
    }
  }
  return best;
}

/**
 * 立体の辺・頂点を画面座標で拾う(§0.a-0.27。裏側の辺・頂点も拾う)。
 *
 * - `kind` が `'vertex'` なら頂点だけを見る。
 * - `kind` が `'edge'` なら頂点 → 辺の順に見て、**頂点が勝つ**(小さいものを先に取る。
 *   P1 §2.8 の「点 → 線・円弧 → 面」と同じ考え方)。辺の端は必ず頂点でもあるので、
 *   端をつかみたいときに辺が先に当たると頂点を選べなくなる。
 * - `kind` が `'face'` なら null を返す。面は深度が要るので `Raycaster` の側で拾い、
 *   `faceIndexOfTriangle` で面の通し番号へ直す(このファイル冒頭の注釈、§2.3.2)。
 *
 * 同じ種類の中では画面上で最も近いものを選び、同じ距離なら先に見つけたほうを残す
 * (ボディの並び → 一覧の並びの順なので、同じ入力からは常に同じ結果になる)。
 */
export function pickSolidSubShape(
  bodies: readonly SubShapeBody[],
  project: ProjectToScreen,
  pointer: Screen,
  kind: SubShapeKind,
  radiusPixels: number = SUB_SHAPE_PICK_RADIUS_PIXELS,
): SubShapePickResult | null {
  if (kind === 'face') {
    return null;
  }
  const vertex = pickVertex(bodies, project, pointer, radiusPixels);
  if (kind === 'vertex' || vertex !== null) {
    return vertex;
  }
  return pickEdge(bodies, project, pointer, radiusPixels);
}

/**
 * 面の三角形の番号から、その面の通し番号を引く(範囲表の二分探索)。
 *
 * 一覧は `triangleOffset` の昇順に並んでいる(カーネルが `TopExp` の順に作る。タスク3・4)ことを
 * 前提にする。三角形が 0 枚の面は前後の面と同じ位置から始まるので、**同じ位置から始まる面が
 * 並んでいるときは後のものを採る**(0 枚の面を飛ばして、実際に三角形を持つ面へ行き着く)。
 * どの面の範囲にも入らない番号(欠番・範囲外・整数でない)は null。
 */
export function faceIndexOfTriangle(
  faces: readonly SolidFaceEntry[],
  triangleIndex: number,
): number | null {
  if (!Number.isInteger(triangleIndex) || triangleIndex < 0) {
    return null;
  }
  let low = 0;
  let high = faces.length - 1;
  let candidate: SolidFaceEntry | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const face = faces[middle];
    if (face.triangleOffset <= triangleIndex) {
      candidate = face;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (candidate === null) {
    return null;
  }
  return triangleIndex < candidate.triangleOffset + candidate.triangleCount
    ? candidate.index
    : null;
}
