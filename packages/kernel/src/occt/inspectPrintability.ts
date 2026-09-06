import type { ExportMesh } from './exportMesh.js';
import { DEGENERATE_CROSS_LENGTH_MM2 } from './writeStl.js';

/**
 * 3D プリント向けの点検(FR-815、NFR-PF-4。計画書 P6 §0.51・§2.16、タスク42)。
 *
 * 最小肉厚・オーバーハングの角度・水密性の 3 つを、**1 回の呼び出しでまとめて**返す
 * (§0.a-0.30「カーネルを呼ぶ回数を最小にする」)。結果は**三角形ごと**に持つ
 * (ui が色を塗る単位が三角形だから。§0.53、タスク43)。
 *
 * ## OCCT(`oc`)を引数に取らない理由
 *
 * この関数は**純関数**で、`ExportMesh`(三角形の網)だけを見る。`writeStl.ts` が
 * `oc` を取らないのと同じ理由に、この点検固有の理由が 2 つ加わる。
 *
 * 1. **読み込んだ三角形の形(`bodyKind: 'mesh'`、§0.a-0.23)も点検できる。** STL / OBJ /
 *    glTF から読んだ形には B-rep が無いので、OCCT の形を要求する作りにすると
 *    「読み込んだ形は点検できません」という穴ができる。**3D プリントの点検は、
 *    まさにその読み込んだ形にこそ要る。**
 * 2. **書き出す形と同じものを点検できる。** 点検が見るのは STL / 3MF へ実際に書く
 *    三角形(`buildExportMesh` の結果)そのものなので、「点検は通ったのに書き出した
 *    ファイルは別の形だった」が起こらない。品質(偏差)を変えれば点検の結果も同じだけ変わる。
 *
 * ## §1.5-21 の実測(2026-09-06、Node の opencascade.js 2.0.0-beta.b5ff984)
 *
 * `BRepIntCurveSurface_Inter` の実行時のメソッドは
 * `Face Init_1 Init_2 Init_3 Load More Next Pnt Point State Transition U V W`
 * だけで、**列挙(`More` / `Next`)を取らない版は無い**(型定義も実行時も一致)。
 * 加えて `Init_*` / `Load` はどれも `TopoDS_Shape` を要求するので、上の理由 1 の
 * 「読み込んだ三角形の形」には初めから使えない。**だから当たり判定は自前で書く**
 * (計画書 §0.52 が「無ければ自前」と定めたとおり)。
 *
 * ## 3 つの判定(§0.51)
 *
 * | 項目 | 中身 |
 * |---|---|
 * | 最小肉厚 | 三角形の重心から**内向き**(面の法線の逆)へ光線を飛ばし、材料を出るところまでの距離。しきい値(既定 0.8mm)より短ければ「薄い」 |
 * | オーバーハング | 面の法線と真下 (0,0,−1) のなす角 θ が、しきい値(既定 45°)より小さければ「支持が要る」。**造形台に接する三角形(最下点から 0.1mm 以内)は除く** |
 * | 水密性 | 三角形の辺のうち、ちょうど 2 枚に共有されていないものが 1 本でもあれば「閉じていない」 |
 *
 * **造形の向きは Z 上向き固定**(§0.51。向きを選べるようにするのは要件に無い)。
 */

/** 三角形が 1 枚も無い形を点検しようとしたとき(§2.16 の断りの表、NFR-UX-5)。 */
export const PRINTABILITY_NO_TRIANGLE_MESSAGE = '点検できる形がありません。';

/** 最小肉厚のしきい値が正の有限な数でないとき(FR-504、NFR-UX-5)。 */
export const PRINTABILITY_MIN_THICKNESS_MESSAGE =
  '最小肉厚のしきい値は 0 より大きい数にしてください。';

/** オーバーハングの角度が 0〜90 度の有限な数でないとき(FR-504、NFR-UX-5)。 */
export const PRINTABILITY_OVERHANG_ANGLE_MESSAGE =
  'オーバーハングの角度は 0 度以上 90 度以下にしてください。';

/**
 * 最小肉厚のしきい値の既定(mm。§0.51)。
 *
 * 0.4mm のノズルで 2 本ぶん。3D プリントの実務でよく使う値で、式で変えられる。
 * **この値の正本はここ 1 か所**で、model / ui は写しを持たずここから引く
 * (同じ表が 2 か所にあると片方が古くなる。`exportMesh.ts` と同じ決め)。
 */
export const DEFAULT_MIN_THICKNESS_MM = 0.8;

/** オーバーハングの角度のしきい値の既定(度。§0.51)。水平から 45° より寝た下向きの面は支持が要る。 */
export const DEFAULT_OVERHANG_ANGLE_DEG = 45;

/**
 * 造形台に接しているとみなす高さ(mm。§0.51)。
 *
 * 形の最下点からこの範囲に**三角形が丸ごと収まっている**とき、その三角形は台の上に
 * 直に載るので支持が要らない。「重心が低い」ではなく「3 頂点とも低い」で判定するのは、
 * 台から立ち上がる斜面の下端だけが範囲に入ったときに、その斜面まで見逃さないため。
 */
export const BUILD_PLATE_TOLERANCE_MM = 0.1;

/** 点検の指定(どちらも省略できる。省略すると上の既定)。 */
export interface PrintabilityOptions {
  /** 最小肉厚のしきい値(mm)。これより薄いところを「薄い」とする。 */
  readonly minThicknessMm?: number;
  /** オーバーハングの角度のしきい値(度)。水平からこれより寝た下向きの面に支持が要る。 */
  readonly overhangAngleDeg?: number;
}

/** 進捗のどの段か。重い段は肉厚だけで、あとの 2 つは合わせても 1 割に満たない(§2.16 の見積もり)。 */
export type PrintabilityPhase = 'watertight' | 'overhang' | 'thickness';

/** 進捗の知らせ(NFR-PF-4)。Comlink 越しでは Comlink.proxy した関数が受け取る。 */
export interface PrintabilityProgress {
  /** いま走っている段。 */
  readonly phase: PrintabilityPhase;
  /** その段で見終わった三角形の枚数。 */
  readonly processed: number;
  /** 三角形の総数。 */
  readonly total: number;
  /**
   * 全体でどこまで進んだか(0〜1)。
   *
   * 段ごとの割り当ては水密性 0.1・オーバーハング 0.1・肉厚 0.8 で、§2.16 の費用の
   * 見積もり(10ms / 1ms / 50ms)より水密性とオーバーハングに厚く配っている。
   * **進捗の棒が戻って見えないようにする**ためで、正確な残り時間の予想ではない。
   */
  readonly ratio: number;
}

/** 進捗を受け取る口(`worker/recomputeSolids.ts` の `SolidProgressCallback` と同じ形)。 */
export type PrintabilityProgressCallback = (progress: PrintabilityProgress) => void;

/**
 * 中止を尋ねる口。true を返すと、残りの三角形を測らずに打ち切る。
 *
 * Comlink 越しの呼び出しは必ず Promise を返すので、真偽値と Promise のどちらも
 * 受け取れる形にしてある(`SolidCancelToken` と同じ)。
 */
export type PrintabilityCancelToken = () => boolean | Promise<boolean>;

/** 進捗と中止の口(どちらも省略できる)。 */
export interface PrintabilityHooks {
  readonly onProgress?: PrintabilityProgressCallback;
  readonly shouldCancel?: PrintabilityCancelToken;
}

/** 点検の要約(数と真偽だけ。画面の文言は ui が作る)。 */
export interface PrintabilitySummary {
  /** 点検した三角形の総数(面積 0 のものを含む)。 */
  readonly triangleCount: number;
  /** 面積 0(または座標が `NaN`)で点検から外した三角形の枚数(`writeStl.ts` と同じ判定)。 */
  readonly degenerateCount: number;
  /**
   * 肉厚の段で見終わった三角形の枚数(面積 0 で光線を飛ばさなかったものを含む)。
   * 中止すると総数より少なくなるので、**どこまで測れたか**がこの数で分かる。
   */
  readonly inspectedTriangleCount: number;
  /** しきい値より薄かった三角形の枚数。 */
  readonly thinCount: number;
  /** 支持が要る(オーバーハング)三角形の枚数。 */
  readonly overhangCount: number;
  /** ちょうど 2 枚に共有されていない辺の本数。 */
  readonly openEdgeCount: number;
  /** そういう辺を 1 本でも持つ三角形の枚数。 */
  readonly openEdgeTriangleCount: number;
  /** 閉じた形か(開いた辺が 1 本も無いか)。 */
  readonly watertight: boolean;
  /**
   * 測れた肉厚のうち最も薄い値(mm)。**1 本も反対側に当たらなければ `null`**
   * (板 1 枚のような厚みの無い形。0 を返すと「厚さ 0」と読めてしまう)。
   */
  readonly minThicknessFoundMm: number | null;
  /** 判定に使った最小肉厚のしきい値(mm)。 */
  readonly minThicknessMm: number;
  /** 判定に使ったオーバーハングの角度(度)。 */
  readonly overhangAngleDeg: number;
  /** 肉厚の判定に使った格子の升目の大きさ(mm)。形が大きいと既定より粗くなる(下の `chooseCellSize`)。 */
  readonly cellSizeMm: number;
}

/**
 * 点検の結果。
 *
 * **三角形ごとの真偽は 1 ビットずつ詰める**(§2.17-9 の「3n ビット」)。5 万三角形なら
 * 1 本あたり 6,250 バイト、3 本で 18,750 バイト(18.3KiB)で Worker 越しに渡せる。
 * 真偽の配列(`boolean[]`)にすると同じ内容が 5 万要素 × 3 本の構造化複製になり、
 * 転送量も複製の時間も 2 桁増える。**読み出しは `readPrintabilityFlag` を使う。**
 */
export interface PrintabilityResult {
  /** 三角形の総数(ビット列の長さの根拠)。 */
  readonly triangleCount: number;
  /** しきい値より薄い三角形(1 ビット / 三角形)。 */
  readonly thinTriangles: Uint8Array;
  /** 支持が要る三角形(1 ビット / 三角形)。 */
  readonly overhangTriangles: Uint8Array;
  /** 開いた辺を持つ三角形(1 ビット / 三角形)。 */
  readonly openEdgeTriangles: Uint8Array;
  readonly summary: PrintabilitySummary;
  /**
   * 中止で打ち切ったか(NFR-PF-4)。
   *
   * **打ち切っても結果は返す**(投げない)。水密性とオーバーハングは先に終えてあるので
   * そのまま使え、肉厚だけが「測ったところまで」になる
   * (どこまで測ったかは `summary.inspectedTriangleCount`)。
   */
  readonly cancelled: boolean;
}

/** 三角形ごとの真偽を詰めるのに要るバイト数。 */
export function printabilityFlagByteLength(triangleCount: number): number {
  return Math.ceil(triangleCount / 8);
}

/**
 * 詰めた真偽を 1 つ読む(ui が色を割り当てるときに使う。タスク43)。
 *
 * 並びは**下位ビットから**で、三角形 `index` は `bits[index >> 3]` の
 * `1 << (index & 7)` のビットにある。範囲の外は `false`(色を塗らない)。
 */
export function readPrintabilityFlag(bits: Uint8Array, index: number): boolean {
  if (index < 0) {
    return false;
  }
  const byte = index >> 3;
  if (byte >= bits.length) {
    return false;
  }
  return (bits[byte] & (1 << (index & 7))) !== 0;
}

/** 詰めた真偽を 1 つ立てる。 */
function setFlag(bits: Uint8Array, index: number): void {
  bits[index >> 3] |= 1 << (index & 7);
}

/** 段ごとの進捗の割り当て(合計 1)。`PrintabilityProgress.ratio` の注釈のとおり。 */
const PHASE_WEIGHTS: Record<PrintabilityPhase, { base: number; span: number }> = {
  watertight: { base: 0, span: 0.1 },
  overhang: { base: 0.1, span: 0.1 },
  thickness: { base: 0.2, span: 0.8 },
};

/**
 * 中止を尋ねる間隔(三角形の枚数)。
 *
 * 2,048 枚ぶんの光線は実測で 1〜3ms(下の性能検査)なので、中止の指示から実際に
 * 止まるまでがその程度で収まる。小さくしすぎると `setTimeout(0)` の往復のほうが
 * 高くつき、大きくしすぎると止まらない時間が延びる。
 */
const CANCEL_CHUNK_TRIANGLES = 2048;

/** 光線と三角形が平行とみなす境目。この下では交点が数値として意味を持たない。 */
const PARALLEL_EPSILON = 1e-12;

/** 重心の真下(真上)にある自分自身や、同じ点を共有する隣を拾わないための最短距離(mm)。 */
const RAY_MIN_DISTANCE_MM = 1e-9;

/** 三角形の内側と認める余裕(重心座標)。辺の上を通る光線を取りこぼさない。 */
const BARYCENTRIC_EPSILON = 1e-9;

/**
 * 格子に入れる項目の数の上限。
 *
 * 升目を細かくするほど 1 つの升目に入る三角形は減るが、**1 枚の大きな三角形が
 * 何百もの升目に登録される**(升目の数だけ項目が増える)。20³ の箱の 1 面は
 * 升目 1.6mm では 13 × 13 の升目に跨がる。三角形の数に比例した上限に、
 * 小さな形でも余裕を持てる下限を足した値で頭を打ち、超えるなら升目を倍にする。
 */
function maxGridEntries(triangleCount: number): number {
  return Math.max(1_000_000, triangleCount * 8);
}

/** 格子の升目の数の上限(記憶の頭打ち)。`Int32Array` で 8MB に収まる大きさ。 */
const MAX_GRID_CELLS = 2_000_000;

/** 三角形ごとに 1 度だけ求めておく値。 */
interface TriangleFacts {
  readonly count: number;
  /** 重心(x, y, z の繰り返し)。 */
  readonly centroids: Float64Array;
  /** 単位法線(x, y, z の繰り返し)。面積 0 の三角形は 0 のまま。 */
  readonly normals: Float64Array;
  /** 面積 0(または `NaN`)なら 1。 */
  readonly degenerate: Uint8Array;
  readonly degenerateCount: number;
  /** 面積を持つ三角形の頂点の最も低い z(造形台の高さ)。 */
  readonly minZ: number;
}

/**
 * 三角形ごとの重心・法線・面積 0 の印をまとめて作る。
 *
 * **法線は `ExportMesh.normals`(頂点ごと)を読まず、頂点の並びから作る。** 頂点の
 * 法線は丸い面をなめらかに見せるためのもので、1 枚の三角形の中で向きが変わる。
 * オーバーハングの判定に要るのは**その三角形が実際にどちらを向いているか**なので、
 * `writeStl.ts` の `forEachExportTriangle` とまったく同じ規則(2 辺の外積)で作る。
 * 面積 0 の判定も同じ `DEGENERATE_CROSS_LENGTH_MM2` を使う。
 */
function collectTriangleFacts(mesh: ExportMesh): TriangleFacts {
  const { positions, indices } = mesh;
  const count = Math.floor(indices.length / 3);
  const centroids = new Float64Array(count * 3);
  const normals = new Float64Array(count * 3);
  const degenerate = new Uint8Array(count);
  let degenerateCount = 0;
  let minZ = Number.POSITIVE_INFINITY;

  for (let triangle = 0; triangle < count; triangle += 1) {
    const ia = indices[triangle * 3] * 3;
    const ib = indices[triangle * 3 + 1] * 3;
    const ic = indices[triangle * 3 + 2] * 3;
    const ax = positions[ia];
    const ay = positions[ia + 1];
    const az = positions[ia + 2];
    const ux = positions[ib] - ax;
    const uy = positions[ib + 1] - ay;
    const uz = positions[ib + 2] - az;
    const vx = positions[ic] - ax;
    const vy = positions[ic + 1] - ay;
    const vz = positions[ic + 2] - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (!(length > DEGENERATE_CROSS_LENGTH_MM2)) {
      // 座標に NaN が混じった三角形も、比較が必ず偽になるのでここへ落ちる。
      degenerate[triangle] = 1;
      degenerateCount += 1;
      continue;
    }
    normals[triangle * 3] = nx / length;
    normals[triangle * 3 + 1] = ny / length;
    normals[triangle * 3 + 2] = nz / length;
    centroids[triangle * 3] = (ax + positions[ib] + positions[ic]) / 3;
    centroids[triangle * 3 + 1] = (ay + positions[ib + 1] + positions[ic + 1]) / 3;
    centroids[triangle * 3 + 2] = (az + positions[ib + 2] + positions[ic + 2]) / 3;
    minZ = Math.min(minZ, az, positions[ib + 2], positions[ic + 2]);
  }

  return { count, centroids, normals, degenerate, degenerateCount, minZ };
}

/** 水密性の数え上げの結果。 */
interface EdgeReport {
  readonly openEdgeTriangles: Uint8Array;
  readonly openEdgeCount: number;
  readonly openEdgeTriangleCount: number;
}

/**
 * 同じ位置の頂点を 1 つにまとめる(溶接)。
 *
 * **添字だけでは辺の共有を数えられない。** `buildExportMesh` は面ごとに節点を積むので、
 * 20³ の箱は頂点 8 個の形なのに節点が 24 個ある(隣り合う面は同じ角を別の番号で持つ)。
 * 添字のまま数えると箱の 12 本の辺が全部「開いている」ことになってしまう。
 *
 * **突き合わせは float32 の完全一致で行う**(丸めない)。OCCT の三角形分割は辺の上の
 * 節点を隣り合う面で**共有して**作るので、同じ角の座標は double の段階で同一の値になり、
 * `Float32Array` へ落としても同じビットになる。2026-09-06 の実測でも、箱・球・円柱・
 * 円錐・トーラス・ブーリアンの差(中空の箱)のすべてで開いた辺は 0 本だった。
 * **わざと丸めない**のは、丸めると「ほとんど同じだが升目の境をまたぐ 2 点」が
 * 逆に離れてしまい、突き合わせが入力の位置で揺れるためである(決定性、§0.a-0.62)。
 */
function weldVertices(positions: Float32Array): Int32Array {
  const nodeCount = Math.floor(positions.length / 3);
  const representative = new Int32Array(nodeCount);
  const known = new Map<string, number>();
  for (let node = 0; node < nodeCount; node += 1) {
    const key = `${String(positions[node * 3])},${String(positions[node * 3 + 1])},${String(positions[node * 3 + 2])}`;
    const found = known.get(key);
    if (found === undefined) {
      known.set(key, node);
      representative[node] = node;
    } else {
      representative[node] = found;
    }
  }
  return representative;
}

/**
 * 辺の共有数を数え、ちょうど 2 枚に共有されていない辺と、その辺を持つ三角形を拾う(§0.51 ③)。
 *
 * **面積 0 の三角形は数に入れない。** 球の極や回転面の継ぎ目で OCCT が作る「同じ節点を
 * 2 度含む三角形」は、辺の 1 本が長さ 0、残りの 2 本が同じ 1 組になるため、そのまま数えると
 * 長さ 0 の辺が「1 枚にしか使われていない辺」として残る(2026-09-06 実測: 球 r=10 偏差 0.1 で
 * 開いた辺が 2 本、円錐で 1 本。面積 0 を外すと 0 本)。この三角形は面積を持たないので
 * 形の内と外を分ける役目も持たず、閉じているかの判定から外すのが正しい。
 *
 * 辺の鍵は「小さいほうの節点 × 節点の総数 + 大きいほうの節点」の数値にする。文字列より
 * 速く、節点が 500 万個(`MESH_MAX_TRIANGLE_COUNT` の形でも届かない数)でも
 * 2.5e13 で `Number.MAX_SAFE_INTEGER` の内側に収まる。
 */
function collectEdgeReport(mesh: ExportMesh, facts: TriangleFacts): EdgeReport {
  const representative = weldVertices(mesh.positions);
  const nodeCount = representative.length;
  const shared = new Map<number, number>();
  const { indices } = mesh;

  /** 辺の鍵。頂点の組を小さい順に並べて 1 つの数にする。 */
  const edgeKey = (from: number, to: number): number =>
    from < to ? from * nodeCount + to : to * nodeCount + from;

  for (let triangle = 0; triangle < facts.count; triangle += 1) {
    if (facts.degenerate[triangle] === 1) {
      continue;
    }
    const a = representative[indices[triangle * 3]];
    const b = representative[indices[triangle * 3 + 1]];
    const c = representative[indices[triangle * 3 + 2]];
    for (const key of [edgeKey(a, b), edgeKey(b, c), edgeKey(c, a)]) {
      shared.set(key, (shared.get(key) ?? 0) + 1);
    }
  }

  let openEdgeCount = 0;
  for (const times of shared.values()) {
    if (times !== 2) {
      openEdgeCount += 1;
    }
  }

  const openEdgeTriangles = new Uint8Array(printabilityFlagByteLength(facts.count));
  let openEdgeTriangleCount = 0;
  // 開いた辺が 1 本も無ければ、印を付ける三角形も無いので 2 周目を回さない。
  if (openEdgeCount > 0) {
    for (let triangle = 0; triangle < facts.count; triangle += 1) {
      if (facts.degenerate[triangle] === 1) {
        continue;
      }
      const a = representative[indices[triangle * 3]];
      const b = representative[indices[triangle * 3 + 1]];
      const c = representative[indices[triangle * 3 + 2]];
      const open =
        shared.get(edgeKey(a, b)) !== 2 ||
        shared.get(edgeKey(b, c)) !== 2 ||
        shared.get(edgeKey(c, a)) !== 2;
      if (open) {
        setFlag(openEdgeTriangles, triangle);
        openEdgeTriangleCount += 1;
      }
    }
  }

  return { openEdgeTriangles, openEdgeCount, openEdgeTriangleCount };
}

/** 形を囲む箱(格子の外枠)。 */
interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

/** 面積を持つ三角形の頂点だけで囲む箱を作る。 */
function collectBounds(mesh: ExportMesh, facts: TriangleFacts): Bounds {
  const { positions, indices } = mesh;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let triangle = 0; triangle < facts.count; triangle += 1) {
    if (facts.degenerate[triangle] === 1) {
      continue;
    }
    for (let corner = 0; corner < 3; corner += 1) {
      const base = indices[triangle * 3 + corner] * 3;
      minX = Math.min(minX, positions[base]);
      maxX = Math.max(maxX, positions[base]);
      minY = Math.min(minY, positions[base + 1]);
      maxY = Math.max(maxY, positions[base + 1]);
      minZ = Math.min(minZ, positions[base + 2]);
      maxZ = Math.max(maxZ, positions[base + 2]);
    }
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

/** 一様格子(uniform grid)。升目ごとの三角形の一覧を、詰めた 2 本の配列で持つ。 */
interface UniformGrid {
  readonly cellSizeMm: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly bounds: Bounds;
  /** 升目 i の項目は `items[cellStart[i]] … items[cellStart[i + 1] - 1]`。 */
  readonly cellStart: Int32Array;
  readonly items: Int32Array;
}

/** ある升目の大きさで、格子が持つ項目の数(三角形 × 跨がる升目)を数える。 */
function countGridEntries(
  mesh: ExportMesh,
  facts: TriangleFacts,
  bounds: Bounds,
  cellSizeMm: number,
  nx: number,
  ny: number,
  nz: number,
): number {
  const { positions, indices } = mesh;
  let total = 0;
  for (let triangle = 0; triangle < facts.count; triangle += 1) {
    if (facts.degenerate[triangle] === 1) {
      continue;
    }
    let loX = Number.POSITIVE_INFINITY;
    let hiX = Number.NEGATIVE_INFINITY;
    let loY = Number.POSITIVE_INFINITY;
    let hiY = Number.NEGATIVE_INFINITY;
    let loZ = Number.POSITIVE_INFINITY;
    let hiZ = Number.NEGATIVE_INFINITY;
    for (let corner = 0; corner < 3; corner += 1) {
      const base = indices[triangle * 3 + corner] * 3;
      loX = Math.min(loX, positions[base]);
      hiX = Math.max(hiX, positions[base]);
      loY = Math.min(loY, positions[base + 1]);
      hiY = Math.max(hiY, positions[base + 1]);
      loZ = Math.min(loZ, positions[base + 2]);
      hiZ = Math.max(hiZ, positions[base + 2]);
    }
    const spanX =
      cellIndex(hiX, bounds.minX, cellSizeMm, nx) - cellIndex(loX, bounds.minX, cellSizeMm, nx) + 1;
    const spanY =
      cellIndex(hiY, bounds.minY, cellSizeMm, ny) - cellIndex(loY, bounds.minY, cellSizeMm, ny) + 1;
    const spanZ =
      cellIndex(hiZ, bounds.minZ, cellSizeMm, nz) - cellIndex(loZ, bounds.minZ, cellSizeMm, nz) + 1;
    total += spanX * spanY * spanZ;
  }
  return total;
}

/** 座標を升目の番号へ落とす(範囲の外は端の升目へ寄せる)。 */
function cellIndex(value: number, min: number, cellSizeMm: number, cells: number): number {
  const raw = Math.floor((value - min) / cellSizeMm);
  if (raw < 0) {
    return 0;
  }
  return raw >= cells ? cells - 1 : raw;
}

/** 升目の数を数える(0 にならないよう必ず 1 以上)。 */
function cellCount(size: number, cellSizeMm: number): number {
  if (!(size > 0)) {
    return 1;
  }
  return Math.max(1, Math.min(MAX_GRID_CELLS, Math.ceil(size / cellSizeMm)));
}

/** 升目の大きさと、そのときの升目の数。 */
interface CellPlan {
  readonly cellSizeMm: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

/**
 * 升目の大きさを決める(手順 2)。
 *
 * **出発点は「最小肉厚のしきい値の 2 倍」**(§2.16 の推奨。既定 1.6mm)。ここから、
 * ①升目の総数が `MAX_GRID_CELLS` を超える、②格子へ登録する項目が `maxGridEntries` を
 * 超える、のどちらかなら升目を倍にして測り直す。**大きい形ほど升目を粗くする**ので、
 * 記憶の量が形の大きさに引きずられない。倍にするたびに項目は約 1/8 になるので、
 * この繰り返しはすぐ止まる(上限 40 回は、しきい値 1e-9mm から地球の大きさまでを覆う)。
 */
function chooseCellSize(mesh: ExportMesh, facts: TriangleFacts, bounds: Bounds, minThicknessMm: number): CellPlan {
  const sizeX = bounds.maxX - bounds.minX;
  const sizeY = bounds.maxY - bounds.minY;
  const sizeZ = bounds.maxZ - bounds.minZ;
  const limit = maxGridEntries(facts.count);
  let cellSizeMm = minThicknessMm * 2;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const nx = cellCount(sizeX, cellSizeMm);
    const ny = cellCount(sizeY, cellSizeMm);
    const nz = cellCount(sizeZ, cellSizeMm);
    if (nx * ny * nz <= MAX_GRID_CELLS) {
      const entries = countGridEntries(mesh, facts, bounds, cellSizeMm, nx, ny, nz);
      if (entries <= limit) {
        return { cellSizeMm, nx, ny, nz };
      }
    }
    cellSizeMm *= 2;
  }
  // ここへ来るのは形が升目に対して極端に大きいときだけ。1 つの升目に全部入れる
  // (総当たりになるが、答えは正しい)。
  return { cellSizeMm, nx: 1, ny: 1, nz: 1 };
}

/**
 * 一様格子を組む(手順 2)。
 *
 * 升目ごとに配列を持つと 60 万個の小さな配列ができて GC が重くなるので、
 * **数える → 先頭の位置を足し上げる → 詰める**の 3 周で `Int32Array` 2 本にする。
 */
function buildGrid(mesh: ExportMesh, facts: TriangleFacts, bounds: Bounds, plan: CellPlan): UniformGrid {
  const { positions, indices } = mesh;
  const { cellSizeMm, nx, ny, nz } = plan;
  const cells = nx * ny * nz;
  const counts = new Int32Array(cells);

  /** 三角形の囲み箱が跨がる升目を 1 つずつ渡す。 */
  const forEachCell = (triangle: number, visit: (cell: number) => void): void => {
    let loX = Number.POSITIVE_INFINITY;
    let hiX = Number.NEGATIVE_INFINITY;
    let loY = Number.POSITIVE_INFINITY;
    let hiY = Number.NEGATIVE_INFINITY;
    let loZ = Number.POSITIVE_INFINITY;
    let hiZ = Number.NEGATIVE_INFINITY;
    for (let corner = 0; corner < 3; corner += 1) {
      const base = indices[triangle * 3 + corner] * 3;
      loX = Math.min(loX, positions[base]);
      hiX = Math.max(hiX, positions[base]);
      loY = Math.min(loY, positions[base + 1]);
      hiY = Math.max(hiY, positions[base + 1]);
      loZ = Math.min(loZ, positions[base + 2]);
      hiZ = Math.max(hiZ, positions[base + 2]);
    }
    const fromX = cellIndex(loX, bounds.minX, cellSizeMm, nx);
    const toX = cellIndex(hiX, bounds.minX, cellSizeMm, nx);
    const fromY = cellIndex(loY, bounds.minY, cellSizeMm, ny);
    const toY = cellIndex(hiY, bounds.minY, cellSizeMm, ny);
    const fromZ = cellIndex(loZ, bounds.minZ, cellSizeMm, nz);
    const toZ = cellIndex(hiZ, bounds.minZ, cellSizeMm, nz);
    for (let z = fromZ; z <= toZ; z += 1) {
      for (let y = fromY; y <= toY; y += 1) {
        for (let x = fromX; x <= toX; x += 1) {
          visit((z * ny + y) * nx + x);
        }
      }
    }
  };

  for (let triangle = 0; triangle < facts.count; triangle += 1) {
    if (facts.degenerate[triangle] === 1) {
      continue;
    }
    forEachCell(triangle, (cell) => {
      counts[cell] += 1;
    });
  }

  const cellStart = new Int32Array(cells + 1);
  let running = 0;
  for (let cell = 0; cell < cells; cell += 1) {
    cellStart[cell] = running;
    running += counts[cell];
  }
  cellStart[cells] = running;

  const items = new Int32Array(running);
  const cursor = cellStart.slice(0, cells);
  for (let triangle = 0; triangle < facts.count; triangle += 1) {
    if (facts.degenerate[triangle] === 1) {
      continue;
    }
    forEachCell(triangle, (cell) => {
      items[cursor[cell]] = triangle;
      cursor[cell] += 1;
    });
  }

  return { cellSizeMm, nx, ny, nz, bounds, cellStart, items };
}

/** 光線を飛ばすのに要る作業用の記憶(光線ごとに作り直さない)。 */
interface RayScratch {
  /** 三角形ごとに「どの光線で最後に試したか」。同じ三角形を升目の数だけ試すのを避ける。 */
  readonly lastRay: Int32Array;
}

/**
 * 光線と三角形の交わり(Möller–Trumbore)。**材料から出る向きの当たりだけ**を採る。
 *
 * 閉じた形の内側を進む光線が最初に出会う面は、必ず「材料から出る」面である。
 * 外積で作った法線 `n` と進む向き `d` の内積が正のときがそれで、この式の判別式
 * `det = (d × e2)·e1` はちょうど `−n·d` に等しいので、**`det < 0` だけを採れば
 * 出口だけが残る**(裏面の間引きと同じ 1 行で済む)。こうすると、隙間を挟んで
 * 向こう側にある別のボディの表面(入口)を「肉厚」と読み違えることがない。
 *
 * @returns 当たったときの距離(mm)。当たらなければ `Infinity`。
 */
function intersectTriangle(
  mesh: ExportMesh,
  triangle: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
): number {
  const { positions, indices } = mesh;
  const ia = indices[triangle * 3] * 3;
  const ib = indices[triangle * 3 + 1] * 3;
  const ic = indices[triangle * 3 + 2] * 3;
  const ax = positions[ia];
  const ay = positions[ia + 1];
  const az = positions[ia + 2];
  const e1x = positions[ib] - ax;
  const e1y = positions[ib + 1] - ay;
  const e1z = positions[ib + 2] - az;
  const e2x = positions[ic] - ax;
  const e2y = positions[ic + 1] - ay;
  const e2z = positions[ic + 2] - az;

  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  // det ≥ 0 は「入口」か「平行」。どちらも肉厚ではない(上の注釈)。
  if (det > -PARALLEL_EPSILON) {
    return Number.POSITIVE_INFINITY;
  }
  const invDet = 1 / det;

  const tx = ox - ax;
  const ty = oy - ay;
  const tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < -BARYCENTRIC_EPSILON || u > 1 + BARYCENTRIC_EPSILON) {
    return Number.POSITIVE_INFINITY;
  }

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * invDet;
  if (v < -BARYCENTRIC_EPSILON || u + v > 1 + BARYCENTRIC_EPSILON) {
    return Number.POSITIVE_INFINITY;
  }

  const distance = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return distance > RAY_MIN_DISTANCE_MM ? distance : Number.POSITIVE_INFINITY;
}

/**
 * 格子をたどって最も近い出口までの距離を測る(3D DDA。Amanatides & Woo)。
 *
 * 升目を 1 つずつ進み、その升目の三角形だけを試す。**その升目を出るところまでに
 * 当たりが見つかったらそこで止める**(先の升目にもっと近い当たりは無いため)。
 * これが「素朴な全数比較 5 万² = 25 億回」を避ける仕掛けである(§0.52)。
 *
 * @param source 自分自身の三角形の番号(必ず飛ばす)。
 * @param rayId 同じ三角形を升目ごとに二度試さないための通し番号。
 */
function castRay(
  mesh: ExportMesh,
  grid: UniformGrid,
  scratch: RayScratch,
  source: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  rayId: number,
): number {
  const { bounds, cellSizeMm, nx, ny, nz } = grid;
  let x = cellIndex(ox, bounds.minX, cellSizeMm, nx);
  let y = cellIndex(oy, bounds.minY, cellSizeMm, ny);
  let z = cellIndex(oz, bounds.minZ, cellSizeMm, nz);

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

  /** 次にその軸の升目の境をまたぐまでの距離。 */
  const nextBoundary = (
    origin: number,
    min: number,
    cell: number,
    step: number,
    direction: number,
  ): number => {
    if (step === 0) {
      return Number.POSITIVE_INFINITY;
    }
    const edge = min + (step > 0 ? cell + 1 : cell) * cellSizeMm;
    return (edge - origin) / direction;
  };

  let tMaxX = nextBoundary(ox, bounds.minX, x, stepX, dx);
  let tMaxY = nextBoundary(oy, bounds.minY, y, stepY, dy);
  let tMaxZ = nextBoundary(oz, bounds.minZ, z, stepZ, dz);
  const tDeltaX = stepX === 0 ? Number.POSITIVE_INFINITY : cellSizeMm / Math.abs(dx);
  const tDeltaY = stepY === 0 ? Number.POSITIVE_INFINITY : cellSizeMm / Math.abs(dy);
  const tDeltaZ = stepZ === 0 ? Number.POSITIVE_INFINITY : cellSizeMm / Math.abs(dz);

  const maxSteps = nx + ny + nz + 3;
  let best = Number.POSITIVE_INFINITY;
  for (let step = 0; step < maxSteps; step += 1) {
    const cell = (z * ny + y) * nx + x;
    const from = grid.cellStart[cell];
    const to = grid.cellStart[cell + 1];
    for (let slot = from; slot < to; slot += 1) {
      const triangle = grid.items[slot];
      if (triangle === source || scratch.lastRay[triangle] === rayId) {
        continue;
      }
      scratch.lastRay[triangle] = rayId;
      const distance = intersectTriangle(mesh, triangle, ox, oy, oz, dx, dy, dz);
      if (distance < best) {
        best = distance;
      }
    }
    const leave = Math.min(tMaxX, tMaxY, tMaxZ);
    if (best <= leave) {
      return best;
    }
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      x += stepX;
      if (x < 0 || x >= nx) {
        return best;
      }
      tMaxX += tDeltaX;
    } else if (tMaxY <= tMaxZ) {
      y += stepY;
      if (y < 0 || y >= ny) {
        return best;
      }
      tMaxY += tDeltaY;
    } else {
      z += stepZ;
      if (z < 0 || z >= nz) {
        return best;
      }
      tMaxZ += tDeltaZ;
    }
  }
  return best;
}

/** 指定を確かめて既定で埋める。 */
function resolveOptions(options: PrintabilityOptions): {
  minThicknessMm: number;
  overhangAngleDeg: number;
} {
  const minThicknessMm = options.minThicknessMm ?? DEFAULT_MIN_THICKNESS_MM;
  const overhangAngleDeg = options.overhangAngleDeg ?? DEFAULT_OVERHANG_ANGLE_DEG;
  if (!Number.isFinite(minThicknessMm) || minThicknessMm <= 0) {
    throw new Error(PRINTABILITY_MIN_THICKNESS_MESSAGE);
  }
  if (!Number.isFinite(overhangAngleDeg) || overhangAngleDeg < 0 || overhangAngleDeg > 90) {
    throw new Error(PRINTABILITY_OVERHANG_ANGLE_MESSAGE);
  }
  return { minThicknessMm, overhangAngleDeg };
}

/** 制御をいったん返す(進捗の知らせと中止の指示を Worker が拾えるようにする)。 */
function yieldToMessages(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * 3D プリント向けの点検(FR-815、NFR-PF-4)。
 *
 * ```ts
 * const mesh = buildExportMesh(oc, shape, 0.1, { angularDeflectionRad: 0.2 });
 * const result = await inspectPrintability(mesh, { minThicknessMm: 0.8, overhangAngleDeg: 45 });
 * if (!result.summary.watertight) { … }
 * ```
 *
 * **投げるのは 3 つだけ**(三角形が 0 枚、しきい値が数でない、角度が範囲の外)。
 * それ以外はどんな形でも結果を返す(FR-504、NFR-RE-1)。
 *
 * 中止(`hooks.shouldCancel`)は**肉厚の段でだけ**尋ねる。水密性とオーバーハングは
 * 5 万三角形でも実測 10ms 台で終わるので、そこで刻んでも待ち時間は縮まらず、
 * 逆に「中止したのに水密性の答えが無い」半端な結果を作ってしまうためである。
 */
export async function inspectPrintability(
  mesh: ExportMesh,
  options: PrintabilityOptions = {},
  hooks: PrintabilityHooks = {},
): Promise<PrintabilityResult> {
  const { minThicknessMm, overhangAngleDeg } = resolveOptions(options);
  const facts = collectTriangleFacts(mesh);
  if (facts.count === 0) {
    throw new Error(PRINTABILITY_NO_TRIANGLE_MESSAGE);
  }
  const { onProgress, shouldCancel } = hooks;
  const report = (phase: PrintabilityPhase, processed: number): void => {
    if (onProgress === undefined) {
      return;
    }
    const { base, span } = PHASE_WEIGHTS[phase];
    onProgress({
      phase,
      processed,
      total: facts.count,
      ratio: base + (span * processed) / facts.count,
    });
  };

  // ① 水密性(§0.51 ③)。
  report('watertight', 0);
  const edges = collectEdgeReport(mesh, facts);
  report('watertight', facts.count);

  // ② オーバーハング(§0.51 ②)。法線と真下のなす角 θ が小さいほど寝ている。
  // cos θ = −nz(法線は単位ベクトル)なので、θ < しきい値 は −nz > cos(しきい値)。
  report('overhang', 0);
  const overhangTriangles = new Uint8Array(printabilityFlagByteLength(facts.count));
  const overhangCosine = Math.cos((overhangAngleDeg * Math.PI) / 180);
  const plateZ = facts.minZ + BUILD_PLATE_TOLERANCE_MM;
  let overhangCount = 0;
  for (let triangle = 0; triangle < facts.count; triangle += 1) {
    if (facts.degenerate[triangle] === 1) {
      continue;
    }
    if (-facts.normals[triangle * 3 + 2] <= overhangCosine) {
      continue;
    }
    // 造形台に載っている三角形は支持が要らない(§0.51 の但し書き)。
    let onPlate = true;
    for (let corner = 0; corner < 3 && onPlate; corner += 1) {
      if (mesh.positions[mesh.indices[triangle * 3 + corner] * 3 + 2] > plateZ) {
        onPlate = false;
      }
    }
    if (onPlate) {
      continue;
    }
    setFlag(overhangTriangles, triangle);
    overhangCount += 1;
  }
  report('overhang', facts.count);

  // ③ 最小肉厚(§0.51 ①)。格子で候補を絞り、重心から内向きの光線を 1 本ずつ飛ばす。
  const bounds = collectBounds(mesh, facts);
  const plan = chooseCellSize(mesh, facts, bounds, minThicknessMm);
  const grid = buildGrid(mesh, facts, bounds, plan);
  const scratch: RayScratch = { lastRay: new Int32Array(facts.count).fill(-1) };
  const thinTriangles = new Uint8Array(printabilityFlagByteLength(facts.count));
  let thinCount = 0;
  let minThicknessFoundMm = Number.POSITIVE_INFINITY;
  let inspected = 0;
  let cancelled = false;

  report('thickness', 0);
  for (let triangle = 0; triangle < facts.count; triangle += 1) {
    if (triangle > 0 && triangle % CANCEL_CHUNK_TRIANGLES === 0) {
      report('thickness', triangle);
    }
    // 中止の口が渡されているときだけ制御を返す(渡されていなければ拾うものが無い。
    // `worker/recomputeSolids.ts` と同じ決め)。
    if (shouldCancel !== undefined && triangle % CANCEL_CHUNK_TRIANGLES === 0) {
      await yieldToMessages();
      if (await shouldCancel()) {
        cancelled = true;
        break;
      }
    }
    inspected += 1;
    if (facts.degenerate[triangle] === 1) {
      continue;
    }
    const distance = castRay(
      mesh,
      grid,
      scratch,
      triangle,
      facts.centroids[triangle * 3],
      facts.centroids[triangle * 3 + 1],
      facts.centroids[triangle * 3 + 2],
      -facts.normals[triangle * 3],
      -facts.normals[triangle * 3 + 1],
      -facts.normals[triangle * 3 + 2],
      triangle,
    );
    if (!Number.isFinite(distance)) {
      // 反対側が無い(開いた板の面など)。厚みを測れないので「薄い」とは言わない。
      continue;
    }
    if (distance < minThicknessFoundMm) {
      minThicknessFoundMm = distance;
    }
    if (distance < minThicknessMm) {
      setFlag(thinTriangles, triangle);
      thinCount += 1;
    }
  }
  report('thickness', inspected);

  return {
    triangleCount: facts.count,
    thinTriangles,
    overhangTriangles,
    openEdgeTriangles: edges.openEdgeTriangles,
    summary: {
      triangleCount: facts.count,
      degenerateCount: facts.degenerateCount,
      inspectedTriangleCount: inspected,
      thinCount,
      overhangCount,
      openEdgeCount: edges.openEdgeCount,
      openEdgeTriangleCount: edges.openEdgeTriangleCount,
      watertight: edges.openEdgeCount === 0,
      minThicknessFoundMm: Number.isFinite(minThicknessFoundMm) ? minThicknessFoundMm : null,
      minThicknessMm,
      overhangAngleDeg,
      cellSizeMm: grid.cellSizeMm,
    },
    cancelled,
  };
}
