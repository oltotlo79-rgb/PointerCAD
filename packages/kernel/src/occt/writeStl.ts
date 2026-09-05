import type { ExportMesh } from './exportMesh.js';

/**
 * STL の書き出し(計画書 P6 §2.4、タスク12。FR-803)。
 *
 * ## `StlAPI.Write` を使わない理由(統括の決定 2026-09-06。計画書 §0.a-0.14 を改める)
 *
 * 計画書 §0.a-0.14 は `StlAPI.Write(shape, file, ascii)` を推奨していた。だが**書き出し用の
 * 三角形は 1 本の経路(タスク11 の `buildExportMesh`)から全形式(STL / OBJ / glTF / 3MF)へ
 * 配る**と決めたので、この関数は**形ではなく三角形の網を受け取り、バイト列を JS で組む**。
 * 理由は 4 つ。
 *
 * 1. **同じ品質を選んだのに形式ごとに三角形の数が違う、を避ける。** `StlAPI.Write` は
 *    形に付いている三角形をそのまま書くので、誰がいつ三角形を掛けたかで結果が変わる。
 * 2. **品質は「長さと角度の偏差の対」で持つ**(粗い 0.5mm/0.5rad、標準 0.1mm/0.2rad、
 *    細かい 0.02mm/0.1rad。`exportMesh.ts` の実測)。`StlAPI.Write` にはその対を渡す口が無い。
 * 3. **極の面積 0 の三角形を書き出し側で落とす**(下の `forEachExportTriangle`)決定を、
 *    STL / OBJ / glTF / 3MF で同じ 1 か所に実装できる。`StlAPI.Write` に任せると STL だけ
 *    振る舞いが違う。
 * 4. 計画書 §2.17-3 の上限(10 万三角形で 2 秒)の導出そのものが、
 *    「`DataView.setFloat32` は 1 回 10ns 程度」——**自前で組む前提**で書かれている。
 *
 * `oc`(OpenCascadeInstance)は要らない。**この関数は純関数**で、同じ `ExportMesh` からは
 * 必ず同じバイト列が出る(§0.a-0.62 の決定性)。仮想ファイル(§2.2)も経由しない。
 *
 * **実測(2026-09-06、Node の opencascade.js 2.0.0-beta.b5ff984。計画書 §1.5-1):**
 * `oc.StlAPI` は実行時に関数で、`StlAPI.Write` も関数として存在する(`.test.ts` の 1 件目が
 * 毎回確かめる)。**実在は記録するだけで、この実装は使わない**(上の 4 つの理由)。
 *
 * ## バイナリ STL の構造(§2.4)
 *
 * ```
 * 80 バイト   見出し(任意の文字列)
 *  4 バイト   三角形の数(uint32、リトルエンディアン)
 * 50 バイト × 三角形の数
 *    12 バイト  面の法線(float32 × 3)
 *    36 バイト  頂点(float32 × 3 × 3)
 *     2 バイト  属性(0)
 * ```
 *
 * ## 決定性のための決め(§0.a-0.62)
 *
 * - 見出しの 80 バイトは `PointerCAD` + 空白詰めで**固定**。**時刻もファイル名も入れない。**
 *   STEP はヘッダに OCCT が時刻を書くので比較から 1 行落とすほかないが(`writeStep.ts`)、
 *   STL は自前で組むので**バイト列を丸ごと比べられる**。
 * - ASCII の数値は `toPrecision` ではなく `toFixed(6)` の**固定の桁**で書く。
 *   `toPrecision` は値の大きさで桁数が変わり、`1e-7` のような指数表記も出る
 *   (指数表記を読めない STL の読み手が実在する)。
 * - 改行は `\n` に固定する(`\r\n` にすると環境で揺れる)。
 */

/**
 * 面積が 0 とみなす境目(2 辺の外積の長さ。**三角形の面積の 2 倍**、単位は mm²)。
 *
 * **この値で落ちるのは、頂点が完全に一致している三角形だけ。** OCCT は球の極や
 * 回転面の継ぎ目で同じ節点を 2 度含む三角形を作ることがあり(2026-09-06 実測で
 * 球 r=10 偏差 0.1 に 2 枚)、外積はちょうど 0 になる。STL / 3MF の仕様は法線を
 * 単位ベクトルで書くよう求めるので、そのままでは 0 で割って `NaN` を書いてしまう。
 *
 * **1e-12 という小ささには理由がある。** 座標は `Float32Array`(有効 7 桁)なので、
 * 座標 10mm のあたりで 1 ulp は約 1e-6mm。細長い三角形の外積はその程度まで小さく
 * なりうるが、**それは「潰れている」のではなく「細い」だけ**で、切削・積層の道具は
 * 細い三角形を問題なく扱う。落としてよいのは幾何を 1 つも運んでいない三角形だけ
 * なので、1 ulp の 2 乗(約 1e-12)より下だけを切る。
 */
export const DEGENERATE_CROSS_LENGTH_MM2 = 1e-12;

/** バイナリ STL の見出し(80 バイト)+ 三角形の数(4 バイト)。 */
const BINARY_HEADER_LENGTH = 84;

/** バイナリ STL の見出しの文字数の枠。 */
const BINARY_HEADER_TEXT_LENGTH = 80;

/** バイナリ STL の三角形 1 枚の長さ(法線 12 + 頂点 36 + 属性 2)。 */
const BINARY_TRIANGLE_LENGTH = 50;

/** ASCII の座標・法線の小数点以下の桁数(決定性のため固定。冒頭の注釈)。 */
const ASCII_FRACTION_DIGITS = 6;

/** 見出しと `solid` の既定の名前。空白詰めに使う 0x20 は ASCII の空白。 */
const DEFAULT_SOLID_NAME = 'PointerCAD';

/** 見出しの空白詰めに使うバイト(ASCII の空白)。 */
const SPACE_BYTE = 0x20;

/**
 * 書き出す 1 枚の三角形。
 *
 * **`forEachExportTriangle` は同じ 1 つの入れ物を書き換えて渡す。** 10 万枚ぶんの
 * 小さな配列を作ると GC が走って §2.17-3 の 2 秒に響くためで、**受け取った側が
 * 持ち帰ってはいけない**(次の三角形で中身が変わる)。書き出しはその場でバイトへ
 * 落とすだけなので、これで困らない。
 */
export interface ExportTriangle {
  /** 3 頂点の座標(a.x, a.y, a.z, b.x, …, c.z の 9 個)。 */
  readonly vertices: Float64Array;
  /** 面の法線(単位ベクトル、3 個)。 */
  readonly normal: Float64Array;
}

/**
 * 三角形の網の並びを 1 枚ずつたどる(STL / OBJ / glTF / 3MF が共用する 1 か所)。
 *
 * **法線は `ExportMesh.normals`(頂点ごと)ではなく、その場で計算した面の法線を渡す。**
 * STL の仕様が求めるのは面の法線で、丸い面の頂点法線をそのまま書くと 1 枚の三角形の
 * 3 頂点で向きが違うことになり、読み手が面を歪めて表示する。
 *
 * **面積 0 の三角形は渡さず、落とした枚数を返り値にする。** 判定を `length > しきい値`
 * と書いてあるので、座標に `NaN` が混じった三角形(外積も `NaN`、比較は必ず偽)も
 * 同じ経路で落ちる。`NaN` を書いた STL はどの道具でも開けないので、これでよい。
 *
 * @returns 面積 0(または `NaN`)で落とした三角形の枚数。
 */
export function forEachExportTriangle(
  meshes: readonly ExportMesh[],
  visit: (triangle: ExportTriangle) => void,
): number {
  const vertices = new Float64Array(9);
  const normal = new Float64Array(3);
  const triangle: ExportTriangle = { vertices, normal };
  let dropped = 0;
  for (const mesh of meshes) {
    const { positions, indices } = mesh;
    for (let offset = 0; offset + 2 < indices.length; offset += 3) {
      const ia = indices[offset] * 3;
      const ib = indices[offset + 1] * 3;
      const ic = indices[offset + 2] * 3;
      for (let axis = 0; axis < 3; axis += 1) {
        vertices[axis] = positions[ia + axis];
        vertices[3 + axis] = positions[ib + axis];
        vertices[6 + axis] = positions[ic + axis];
      }
      const ux = vertices[3] - vertices[0];
      const uy = vertices[4] - vertices[1];
      const uz = vertices[5] - vertices[2];
      const vx = vertices[6] - vertices[0];
      const vy = vertices[7] - vertices[1];
      const vz = vertices[8] - vertices[2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const length = Math.hypot(nx, ny, nz);
      if (!(length > DEGENERATE_CROSS_LENGTH_MM2)) {
        dropped += 1;
        continue;
      }
      normal[0] = nx / length;
      normal[1] = ny / length;
      normal[2] = nz / length;
      visit(triangle);
    }
  }
  return dropped;
}

/** 書き出しの指定。 */
export interface StlWriteOptions {
  /** `true` なら ASCII、`false` ならバイナリ(§2.4)。 */
  readonly ascii: boolean;
  /**
   * `solid` の行に書く名前(既定 `PointerCAD`)。
   *
   * **効くのは ASCII だけ。** バイナリの見出し 80 バイトは固定にしてある。名前に日本語が
   * 入ると UTF-8 では 80 バイトに収まらないことがあり、切り詰めると文字の途中で切れて
   * 壊れた見出しになる。見出しは形に何の影響も与えないので、固定にして揺れを断つ。
   */
  readonly name?: string;
}

/**
 * 書き出しの結果。
 *
 * **落とした枚数を `writeStl` の戻りに入れたのは、数え直しを避けるため。** 別関数で
 * 数えると三角形をもう一度全部たどることになり(10 万枚で無駄が二重になる)、
 * しかも「書いたバイト列」と「数えた枚数」が別々に作られるので食い違いうる。
 * 利用者への知らせ(タスク16)は「面積 0 の三角形を n 枚除きました」の 1 行なので、
 * 書いたその場の数をそのまま渡すのが正しい。
 */
export interface StlWriteResult {
  /** STL のバイト列。 */
  readonly bytes: Uint8Array;
  /** 実際に書いた三角形の枚数(落としたぶんを除く)。 */
  readonly triangleCount: number;
  /** 面積 0(または `NaN`)で落とした三角形の枚数。 */
  readonly droppedTriangleCount: number;
}

/** `solid` の行に置ける形へ名前を整える。改行やタブが混じると ASCII の行組みが壊れる。 */
function normalizeSolidName(name: string | undefined): string {
  if (name === undefined) {
    return DEFAULT_SOLID_NAME;
  }
  const collapsed = name.replace(/\s+/gu, ' ').trim();
  return collapsed === '' ? DEFAULT_SOLID_NAME : collapsed;
}

/** ASCII の数値 1 つ。桁を固定して決定性を保つ(冒頭の注釈)。 */
function formatAsciiNumber(value: number): string {
  return value.toFixed(ASCII_FRACTION_DIGITS);
}

/** バイナリ STL を組む。 */
function writeBinaryStl(
  meshes: readonly ExportMesh[],
  keptTriangleCount: number,
): Uint8Array {
  const bytes = new Uint8Array(BINARY_HEADER_LENGTH + BINARY_TRIANGLE_LENGTH * keptTriangleCount);
  for (let index = 0; index < BINARY_HEADER_TEXT_LENGTH; index += 1) {
    bytes[index] =
      index < DEFAULT_SOLID_NAME.length ? DEFAULT_SOLID_NAME.charCodeAt(index) : SPACE_BYTE;
  }
  const view = new DataView(bytes.buffer);
  view.setUint32(BINARY_HEADER_TEXT_LENGTH, keptTriangleCount, true);
  let offset = BINARY_HEADER_LENGTH;
  forEachExportTriangle(meshes, ({ vertices, normal }) => {
    for (let axis = 0; axis < 3; axis += 1) {
      view.setFloat32(offset + axis * 4, normal[axis], true);
    }
    offset += 12;
    for (let index = 0; index < 9; index += 1) {
      view.setFloat32(offset + index * 4, vertices[index], true);
    }
    offset += 36;
    // 属性の 2 バイトは 0。色を入れる拡張が各社ばらばらにあるが、STL に色は書かない(§0.15)。
    view.setUint16(offset, 0, true);
    offset += 2;
  });
  return bytes;
}

/** ASCII の STL を組む。 */
function writeAsciiStl(meshes: readonly ExportMesh[], name: string): Uint8Array {
  const lines: string[] = [`solid ${name}`];
  forEachExportTriangle(meshes, ({ vertices, normal }) => {
    lines.push(
      `  facet normal ${formatAsciiNumber(normal[0])} ${formatAsciiNumber(normal[1])} ${formatAsciiNumber(normal[2])}`,
      '    outer loop',
    );
    for (let corner = 0; corner < 3; corner += 1) {
      const base = corner * 3;
      lines.push(
        `      vertex ${formatAsciiNumber(vertices[base])} ${formatAsciiNumber(vertices[base + 1])} ${formatAsciiNumber(vertices[base + 2])}`,
      );
    }
    lines.push('    endloop', '  endfacet');
  });
  lines.push(`endsolid ${name}`, '');
  return new TextEncoder().encode(lines.join('\n'));
}

/**
 * 三角形の網の並びを STL のバイト列にする(§2.4、FR-803)。
 *
 * ```ts
 * const mesh = buildExportMesh(oc, shape, 0.1, { angularDeflectionRad: 0.2 });
 * const { bytes, droppedTriangleCount } = writeStl([mesh], { ascii: false });
 * ```
 *
 * **複数のボディは 1 つの STL に連ねる**(§2.4。STL は三角形の網を 1 つしか持てない)。
 * 計画書は `makeCompound` でまとめてから 1 つの形として渡す手順だったが、三角形を
 * 受け取る形にしたので**並びをそのまま順につなぐ**だけで足りる(コンパウンドを作る
 * ぶんの複製と解放が消える)。
 *
 * **空の並びは断らずに「三角形 0 枚」を返す**(バイナリなら 84 バイト、ASCII なら
 * `solid` と `endsolid` の 2 行)。§2.4 の断りの表にある「書き出せる立体がありません」は
 * `packages/model` 側が立体を選ぶ段で出すもので、そこを通った先の kernel が同じ判定を
 * 重ねると、断りの文言の持ち主が 2 か所になる(P5 §0.a-0.83 と同じ理由)。
 * 0 枚の STL は仕様どおり組み立てられるので、ここで例外にする根拠が無い。
 */
export function writeStl(
  meshes: readonly ExportMesh[],
  options: StlWriteOptions,
): StlWriteResult {
  let total = 0;
  for (const mesh of meshes) {
    total += Math.floor(mesh.indices.length / 3);
  }
  // 1 周目は数えるだけ。バイナリは三角形の数を**見出しの直後に書く**ので、
  // 書き始める前に確定していなければならない(後から入れ替えるより、外積をもう一度
  // 計算するほうが安い。10 万枚で数 ms)。ASCII も同じ道を通して枚数の食い違いを断つ。
  const droppedTriangleCount = forEachExportTriangle(meshes, () => {
    // 数えるだけなので何もしない。
  });
  const triangleCount = total - droppedTriangleCount;
  const bytes = options.ascii
    ? writeAsciiStl(meshes, normalizeSolidName(options.name))
    : writeBinaryStl(meshes, triangleCount);
  return { bytes, triangleCount, droppedTriangleCount };
}
