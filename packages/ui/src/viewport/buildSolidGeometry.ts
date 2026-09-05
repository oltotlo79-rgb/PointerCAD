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
 *
 * P5 タスク7(計画書 docs/plans/P5-高度なソリッド・外観と測定.md §2.5.2、§0.a-0.7)で
 * **箱投影の UV(FR-1108)と、面のまとまり(FR-1106)** を足した。どちらも three.js に
 * 触れない純関数のままで、実際に `BufferGeometry` へ流し込むのは `createSolidLayer.ts`
 * (タスク10)だけである。
 */

import { DEFAULT_APPEARANCE, type AppearanceSpec, type SolidBody } from '@pointercad/model';

import { buildFaceGroups, type FaceGroup } from '../appearance/buildFaceGroups.js';
import type { SolidEdgeEntry, SolidFaceEntry, SolidVertexEntry } from '../solid/subShapeSelection.js';

/** 強調の度合い。選択が最も強く、ホバーはその手前(FR-106)。 */
export type SolidEmphasis = 'none' | 'hovered' | 'selected';

/**
 * 部分形状の一覧を持つボディ(計画書タスク22)。
 *
 * `faces` / `edges` / `vertices` はタスク17 で `SolidBody` 本体に必須の欄として届くように
 * なった(model/src/kernelBridge.ts)。この型は「部分形状の一覧を持つボディ」であることを
 * 呼び出し側の型で示すために残しているだけで、`SolidBody` と同じ欄をそのまま再宣言している
 * (`SolidBody` は構造的にこの型を満たすので、呼び出し側の詰め替えは要らない)。
 */
export interface SolidBodyWithSubShapes extends SolidBody {
  readonly faces: readonly SolidFaceEntry[];
  readonly edges: readonly SolidEdgeEntry[];
  readonly vertices: readonly SolidVertexEntry[];
}

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
  /** 面ごとの三角形の範囲(`pickSubShape.ts` の `faceIndexOfTriangle` が使う)。無ければ空。 */
  readonly faces: readonly SolidFaceEntry[];
  /** 辺ごとの線分の範囲。無ければ空。 */
  readonly edges: readonly SolidEdgeEntry[];
  /** 頂点の一覧。無ければ空。 */
  readonly vertices: readonly SolidVertexEntry[];
  /**
   * 柄(FR-1108)を貼るための箱投影 UV(mm 単位)。頂点 1 つあたり 2 個。
   *
   * 同じ `positions` を持つボディには**同じ並びを返す**(下の `boxProjectedUvOf` が
   * 覚えている)ので、ホバーや選択が変わっただけの組み立て直しでは計算し直さない
   * (NFR-PF-1)。
   */
  readonly uv: Float32Array;
  /** 描画のまとまり(`geometry.addGroup` へ渡す)。索引の全体をちょうど覆う。 */
  readonly groups: readonly FaceGroup[];
  /** `FaceGroup.materialIndex` の順に並んだ外観。0 番はこのボディの既定。 */
  readonly appearances: readonly AppearanceSpec[];
  /**
   * 外観の割り当てが上限(材質 8 種 / まとまり 32 個)を超えたか。
   *
   * 超えたときは**描画を止めず**、このボディの既定 1 色だけで描く形へ落とす
   * (FR-504「止めずに警告する」)。断りの文言を出すのは呼び出し側(タスク11)の役目で、
   * ここは「落とした」ことだけを伝える。
   */
  readonly appearanceLimitExceeded: boolean;
}

/** 1 ボディぶんの外観の割り当て(タスク10 が文書と照合の結果から組み立てて渡す)。 */
export interface BodyAppearanceInput {
  /** 立体全体の割り当て。無ければ `null`。 */
  readonly bodyAppearance: AppearanceSpec | null;
  /** 面の通し番号 → その面だけの割り当て(カーネルの照合の結果、§0.a-0.2)。 */
  readonly faceAppearances: ReadonlyMap<number, AppearanceSpec>;
}

/** 組み立てに渡す外観一式。省略すると全ボディが既定の外観 1 色になる。 */
export interface AppearanceInput {
  /** 文書の既定の外観。通常は `DEFAULT_APPEARANCE`。 */
  readonly defaultAppearance: AppearanceSpec;
  /** ボディの featureId → その割り当て。無い id は既定だけになる。 */
  readonly byBody: ReadonlyMap<string, BodyAppearanceInput>;
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
function isDrawableBody(body: SolidBodyWithSubShapes): boolean {
  if (!body.isValid) {
    return false;
  }
  return body.mesh.indices.length > 0 || body.mesh.edgePositions.length > 0;
}

/**
 * 位置と法線から、mm 単位の箱投影 UV を作る(FR-1108、§0.a-0.7)。
 *
 * **頂点ごとに法線の絶対値が最大の軸を選び、残る 2 軸の座標(mm)をそのまま UV にする。**
 * 柄の繰り返しの間隔は `texture.repeat = 1 / 間隔(mm)` で当てる(タスク8 の
 * `patternRepeatFor`)ので、ここでは 1mm = 1 の生の座標を渡せばよい。
 *
 * 軸の選び方と残る 2 軸の順序:
 *
 * ```
 * |nz| が最大 → (u, v) = (x, y)
 * |ny| が最大 → (u, v) = (x, z)
 * |nx| が最大 → (u, v) = (y, z)
 * ```
 *
 * **符号では規則を変えない。** `+z` の面も `-z` の面も同じ (x, y) を使い、残る 2 軸は
 * 常に x → y → z の順に並べる。向きを面ごとに反転させると、箱の稜線をまたぐところで
 * 柄が鏡に映ったように反転してしまうため(3 方向で規則をそろえる)。裏側の面では柄が
 * 左右反転して見えるが、木目・縞鋼板・エキスパンドメタルはいずれも対称な柄なので
 * 実害が無い。同じ理由で、絶対値が並んだとき(45°の面)は z → y → x の順で先に選ぶ
 * (どちらへ倒しても継ぎ目は生じるので、決め方を 1 つに固定して結果を再現可能にする。
 * §0.a-0.7 の「45°付近の継ぎ目は受け入れる」)。
 *
 * 法線が 0(または数でない)の頂点は投影面を選べないので `[0, 0]` にする。
 */
export function buildBoxProjectedUv(positions: Float32Array, normals: Float32Array): Float32Array {
  const vertexCount = Math.floor(positions.length / 3);
  const uv = new Float32Array(vertexCount * 2);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const base = vertex * 3;
    // 法線が足りない並びを渡されても落ちないようにする(0 とみなして退化の扱いへ送る)。
    const nx = Math.abs(normals[base] ?? 0);
    const ny = Math.abs(normals[base + 1] ?? 0);
    const nz = Math.abs(normals[base + 2] ?? 0);
    const target = vertex * 2;
    // NaN はどの比較も偽になるので、この条件で退化と同じ扱いになる。
    if (!(nx > 0 || ny > 0 || nz > 0)) {
      uv[target] = 0;
      uv[target + 1] = 0;
      continue;
    }
    if (nz >= nx && nz >= ny) {
      uv[target] = positions[base];
      uv[target + 1] = positions[base + 1];
      continue;
    }
    if (ny >= nx) {
      uv[target] = positions[base];
      uv[target + 1] = positions[base + 2];
      continue;
    }
    uv[target] = positions[base + 1];
    uv[target + 1] = positions[base + 2];
  }
  return uv;
}

/**
 * 同じ並びから 2 度 UV を作らないための控え。
 *
 * ホバーや選択が変わるたびに `buildSolidGeometry` は呼び直されるが、そのとき
 * `positions` はカーネルが返した同じ並びのままである(写さない)。頂点 10 万の UV を
 * 毎回作り直すと 60fps(NFR-PF-1)を脅かすので、並びそのものを鍵にして覚えておく。
 * `WeakMap` なのでボディが捨てられれば一緒に消える。
 *
 * `positions` と `normals` は必ず同じメッシュの対で届く(`SolidBodyMesh`)ため、
 * 鍵は `positions` だけでよい。
 */
const uvByPositions = new WeakMap<Float32Array, Float32Array>();

function boxProjectedUvOf(positions: Float32Array, normals: Float32Array): Float32Array {
  const cached = uvByPositions.get(positions);
  if (cached !== undefined) {
    return cached;
  }
  const uv = buildBoxProjectedUv(positions, normals);
  uvByPositions.set(positions, uv);
  return uv;
}

/** 面の割り当てが 1 つも無いボディに使う空の表(毎回作らない)。 */
const NO_FACE_APPEARANCES: ReadonlyMap<number, AppearanceSpec> = new Map<number, AppearanceSpec>();

/**
 * まとまりが索引の全体をちょうど覆うようにする(three の `addGroup` の約束)。
 *
 * 面の範囲表に隙間があっても(三角形が付かなかった面などで起こりうる)、覆われない索引が
 * 出ると**その三角形がまったく描かれない**。P2 と同じ絵を出すため、隙間と末尾は
 * このボディの既定(材質 0 番)で埋める。隣り合う同じ材質は 1 つに畳んでドローコールを
 * 増やさない。
 */
function coverAllIndices(groups: readonly FaceGroup[], indexCount: number): readonly FaceGroup[] {
  const covered: FaceGroup[] = [];
  const push = (start: number, count: number, materialIndex: number): void => {
    if (count <= 0) {
      return;
    }
    const last = covered.length > 0 ? covered[covered.length - 1] : undefined;
    if (last !== undefined && last.materialIndex === materialIndex) {
      covered[covered.length - 1] = { start: last.start, count: last.count + count, materialIndex };
      return;
    }
    covered.push({ start, count, materialIndex });
  };

  let cursor = 0;
  for (const group of groups) {
    const start = Math.max(group.start, cursor);
    const end = Math.min(group.start + group.count, indexCount);
    if (end <= start) {
      continue;
    }
    push(cursor, start - cursor, 0);
    push(start, end - start, group.materialIndex);
    cursor = end;
  }
  push(cursor, indexCount - cursor, 0);
  return covered;
}

interface AppearancePlan {
  readonly groups: readonly FaceGroup[];
  readonly appearances: readonly AppearanceSpec[];
  readonly limitExceeded: boolean;
}

/**
 * ボディ 1 つぶんのまとまりと材質の一覧を決める。
 *
 * 材質が 1 種類しか無いとき(= 外観を割り当てていない、または立体全体に 1 つだけ)は
 * **面の範囲表を見ずに索引の全体を 1 つのまとまりにする**。ドローコールが 1 で済み、
 * 面の範囲表がどうであれ P2 と 1 ドットも変わらない絵になる(§0.a-0.12)ため。
 */
function appearancePlanOf(
  body: SolidBodyWithSubShapes,
  indexCount: number,
  appearance: AppearanceInput | undefined,
): AppearancePlan {
  const defaultAppearance = appearance?.defaultAppearance ?? DEFAULT_APPEARANCE;
  const assignment = appearance?.byBody.get(body.featureId);
  const bodyAppearance = assignment?.bodyAppearance ?? null;
  const base = bodyAppearance ?? defaultAppearance;
  const wholeBody: readonly FaceGroup[] = [{ start: 0, count: indexCount, materialIndex: 0 }];

  const plan = buildFaceGroups(
    body.faces ?? [],
    assignment?.faceAppearances ?? NO_FACE_APPEARANCES,
    bodyAppearance,
    defaultAppearance,
  );
  if (plan === null) {
    return { groups: wholeBody, appearances: [base], limitExceeded: true };
  }
  if (plan.appearances.length <= 1) {
    return { groups: wholeBody, appearances: [base], limitExceeded: false };
  }
  return {
    groups: coverAllIndices(plan.groups, indexCount),
    appearances: plan.appearances,
    limitExceeded: false,
  };
}

/**
 * ボディの一覧と強調から、描画用の並び一式を組み立てる。
 *
 * 変化したときにだけ呼ぶ(毎フレーム呼ばない、NFR-PF-1)。並びは写さずにそのまま指すので、
 * 同じボディを渡し直したときの費用はボディの個数に比例するだけで済む(UV も控えから返る)。
 *
 * `appearance` は省略できる(FR-1106 の配線が済むまでと、外観を持たない呼び出しのため)。
 * 省略したときは全ボディが既定の外観 1 色・まとまり 1 つになり、P2 と同じ絵が出る。
 */
export function buildSolidGeometry(
  bodies: readonly SolidBodyWithSubShapes[],
  hoveredBodyId: string | null,
  selectedBodyIds: readonly string[],
  appearance?: AppearanceInput,
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
    const plan = appearancePlanOf(body, mesh.indices.length, appearance);
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
      faces: body.faces ?? [],
      edges: body.edges ?? [],
      vertices: body.vertices ?? [],
      uv: boxProjectedUvOf(mesh.positions, mesh.normals),
      groups: plan.groups,
      appearances: plan.appearances,
      appearanceLimitExceeded: plan.limitExceeded,
    };
    entries.push(entry);
    index.set(entry.featureId, entry);
    triangleOffset += entry.triangleCount;
    edgeOffset += edgeCount;
  }

  return { entries, triangleCount: triangleOffset, edgeCount: edgeOffset, index };
}
