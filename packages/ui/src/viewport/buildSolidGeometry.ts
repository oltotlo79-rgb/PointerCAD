/**
 * ボディ(立体)を描画用の並びへ組み立てる(計画書 docs/plans/P2-ソリッド基礎.md タスク20 手順2)。
 *
 * 対応要件: FR-105(表示スタイル)、FR-106(ホバーと選択)、NFR-PF-1(60fps)。
 *
 * three.js にも DOM にも触れない純関数だけを置く(Node で検査できる)。
 * 組み立てた結果は `createSolidLayer.ts` が受け取り、同じ並び(同じ Float32Array)が
 * 返ってきたときは three.js の入れ物を触らない。ホバーや選択が変わっただけのときは
 * 三角形の並びが前と同じ参照のまま `emphasis` だけが変わるので、
 * 表示側は材質の色を塗り替えるだけで済む(NFR-PF-1)。
 *
 * スケッチ(buildSketchGeometry.ts)は強調の度合いごとに並びを分けているが、ボディは
 * **1 つずつ別の入れ物**に入れる。ボディは面と稜線がボディ単位でまとまっており、
 * 当たり判定(FR-106)も「どのボディに当たったか」を返す必要があるため。
 */

import type { SolidBody } from '@pointercad/model';

/** 強調の度合い。選択が最も強く、ホバーはその手前(FR-106)。 */
export type SolidEmphasis = 'none' | 'hovered' | 'selected';

/** ボディ 1 つぶんの描画データ。並びはカーネルが返したものをそのまま指す(写さない)。 */
export interface SolidDrawEntry {
  /** ボディの id = それを作ったフィーチャーの id(§0.a-0.5)。 */
  readonly featureId: string;
  /** 頂点座標。x, y, z の順に 3 個ずつ。 */
  readonly positions: Float32Array;
  /** 頂点法線。positions と同じ長さ。 */
  readonly normals: Float32Array;
  /** 三角形の頂点番号。3 個ずつ。 */
  readonly indices: Uint32Array;
  /** 稜線の線分列。線分 1 本あたり 6 個(始点 xyz + 終点 xyz)。 */
  readonly edgePositions: Float32Array;
  readonly emphasis: SolidEmphasis;
  /** `entries` の中の位置。表示側の入れ物と 1 対 1 で対応する。 */
  readonly drawIndex: number;
  /** 全ボディを通した三角形の通し番号のうち、このボディが始まる位置。 */
  readonly triangleOffset: number;
  readonly triangleCount: number;
  /** 全ボディを通した稜線の通し番号のうち、このボディが始まる位置。 */
  readonly edgeOffset: number;
  readonly edgeCount: number;
}

export interface SolidGeometryBundle {
  /** 画面に出すボディ。文書の並び順のまま。 */
  readonly entries: readonly SolidDrawEntry[];
  /** 全ボディの三角形の合計(NFR-PF-1 の目安としてプロパティ欄が出す)。 */
  readonly triangleCount: number;
  /** 全ボディの稜線の合計。 */
  readonly edgeCount: number;
  /** featureId → 描画の範囲。当たったボディの見た目を後から追えるようにする。 */
  readonly index: ReadonlyMap<string, SolidDrawEntry>;
}

/** ボディが 1 つも無いとき。起動直後と、片付けたあとの初期値に使う。 */
export const EMPTY_SOLID_GEOMETRY: SolidGeometryBundle = {
  entries: [],
  triangleCount: 0,
  edgeCount: 0,
  index: new Map<string, SolidDrawEntry>(),
};

/**
 * ボディ 1 つの強調の度合いを決める。**選択がホバーより強い**(両方に当たるなら選択)。
 *
 * 渡ってくる id はストアの `selection` / `hoveredElementId` そのままで、スケッチの要素
 * (`point-1`、点列の 1 点 `pa1#0`)が混ざっている。ボディの id は `#` を含まないので、
 * 取り違えは起きない。
 */
export function solidEmphasisOf(
  featureId: string,
  hoveredBodyId: string | null,
  selected: ReadonlySet<string>,
): SolidEmphasis {
  if (selected.has(featureId)) {
    return 'selected';
  }
  return hoveredBodyId === featureId ? 'hovered' : 'none';
}

/**
 * 描く価値があるボディか。
 *
 * `isValid` は「中身のある立体として受け取れたか」で、表示側が毎回自分で確かめずに
 * 済ませるための欄(model の kernelBridge.ts)。ここで 1 回だけ見て、立体になっていない
 * ものは描かない。三角形も稜線も無いものは、描いても何も見えないうえに空の入れ物を
 * 1 つ増やすだけなので同じく外す(FR-504 の理由表示は失敗の一覧が受け持つ)。
 */
function isDrawableBody(body: SolidBody): boolean {
  if (!body.isValid) {
    return false;
  }
  return body.mesh.indices.length > 0 || body.mesh.edgePositions.length > 0;
}

/**
 * ボディの一覧と強調から、描画用の並び一式を組み立てる。
 *
 * 変化したときにだけ呼ぶ(毎フレーム呼ばない、NFR-PF-1)。並びは写さずにそのまま指すので、
 * 同じボディを渡し直したときの費用はボディの個数に比例するだけで済む。
 */
export function buildSolidGeometry(
  bodies: readonly SolidBody[],
  hoveredBodyId: string | null,
  selectedBodyIds: readonly string[],
): SolidGeometryBundle {
  const selected = new Set(selectedBodyIds);
  const entries: SolidDrawEntry[] = [];
  const index = new Map<string, SolidDrawEntry>();
  let triangleOffset = 0;
  let edgeOffset = 0;

  for (const body of bodies) {
    // 1 フィーチャーが作るボディは最大 1 つ(§0.a-0.5)。同じ id が 2 つ来たら
    // 先のものだけを描き、対応表が後のもので上書きされないようにする。
    if (index.has(body.featureId) || !isDrawableBody(body)) {
      continue;
    }
    const mesh = body.mesh;
    const edgeCount = Math.floor(mesh.edgePositions.length / 6);
    const entry: SolidDrawEntry = {
      featureId: body.featureId,
      positions: mesh.positions,
      normals: mesh.normals,
      indices: mesh.indices,
      edgePositions: mesh.edgePositions,
      emphasis: solidEmphasisOf(body.featureId, hoveredBodyId, selected),
      drawIndex: entries.length,
      triangleOffset,
      triangleCount: mesh.triangleCount,
      edgeOffset,
      edgeCount,
    };
    entries.push(entry);
    index.set(entry.featureId, entry);
    triangleOffset += entry.triangleCount;
    edgeOffset += edgeCount;
  }

  return { entries, triangleCount: triangleOffset, edgeCount: edgeOffset, index };
}
