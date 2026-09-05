/**
 * 3MF の書き出し(FR-803、計画書 docs/plans/P6-入出力.md §2.6、タスク14)。
 *
 * 3MF は ZIP の中に XML を 3 つ入れた形式で、OCCT には書き出しの口が無い。だから
 * `packages/io` が自前で組み立てる(§0.a-0.18。既にある `fflate` を使うので依存は増えない)。
 *
 * **OCCT を呼ばない。** 三角形は引数で受け取る(§0.a-0.19)。`packages/io` は
 * `packages/kernel` へ依存できない(依存方向 `apps → ui → model → kernel`。
 * `rules/04-設計の規律.md`)ので、kernel の `ExportMesh` を import せず、
 * **同じ並びを受け取れる型 `ThreeMfMeshInput` をこちら側に置く**。位置は x,y,z の平ら、
 * 添字は 3 個 1 組で、`ExportMesh` の `positions` / `indices` をそのまま渡せる
 * (配線はタスク16。`exportShapes({ format: 'mesh' })` の戻りと、依頼に入っている
 * 名前・色を組にする)。
 *
 * **三角形は受け取ったまま書く。** 面積 0 や `NaN` の三角形を落とすのは kernel の
 * 書き出し側の担当で(`docs/報告記録.md` 2026-09-06、タスク12)、ここへ来る並びは
 * 既に落とした後のものである。同じ判定をここへ写すと 3 か所目になり、片方だけ直したときに
 * 形式ごとで枚数が食い違う。頂点の順(反時計回りが外向き)も kernel の `tessellate.ts` が
 * 面の向きに合わせて揃えてあるので、こちらでは入れ替えない。
 *
 * **決定的にする**(§0.a-0.62)。`.pcad` と同じ固定日時(`FIXED_ENTRY_MTIME`)を ZIP の
 * ヘッダへ書き、エントリの並びも固定する。同じ三角形と同じ名前・色からは、いつ・どの
 * 計算機で書いても 1 バイト違わないファイルができる(検査で固定してある)。
 *
 * 中身の決まりは 3MF Core の仕様(§2.6 に写しがある)に従う。ここに書く文面
 * (`[Content_Types].xml` と `_rels/.rels`)は仕様どおりの固定文字列である。
 */

import { strToU8, zipSync, type Zippable } from 'fflate';

import { FIXED_ENTRY_MTIME } from '../pcad/pcadFile.js';
import { escapeXmlAttribute, formatXmlNumber } from './xmlText.js';

/** ZIP のエントリ名(§2.6。3MF Core の最小構成の 3 つ)。 */
export const THREE_MF_CONTENT_TYPES_ENTRY = '[Content_Types].xml';
/** 同上。 */
export const THREE_MF_RELS_ENTRY = '_rels/.rels';
/** 同上。形そのものはここに入る。 */
export const THREE_MF_MODEL_ENTRY = '3D/3dmodel.model';

/** 頂点の並びが 3 の倍数でないときの断り(FR-504、NFR-UX-5)。 */
export const THREE_MF_INVALID_POSITIONS_MESSAGE = '書き出す三角形の頂点の並びが正しくありません。';

/** 添字の並びが 3 の倍数でない・頂点を指していないときの断り。 */
export const THREE_MF_INVALID_INDICES_MESSAGE = '書き出す三角形の添字の並びが正しくありません。';

/**
 * 色の値が 0〜1 の数でないときの断り。
 *
 * `packages/kernel` の `writeCafMesh.ts` / `xcafDocument.ts` の同じ断りと 1 字も違わないが、
 * io は kernel へ依存できないので写しを置くほかない(`testUtils/perfBudget.ts` と同じ事情)。
 */
export const THREE_MF_INVALID_COLOR_MESSAGE = '書き出しの色の値が正しくありません。';

/**
 * 色(sRGB の 0〜1 の r / g / b)。`#rrggbb` を 255 で割った値を受ける。
 *
 * kernel の `RgbTuple`(`occt/xcafDocument.ts`)と同じ形だが、io は kernel へ依存できない
 * ので同じ形をこちらにも置く。タスク16 の配線は `ShapeExportItem.color` をそのまま渡せる。
 */
export type ThreeMfColor = readonly [number, number, number];

/**
 * 色を指定しなかった立体の色。
 *
 * **正本は `packages/model/src/appearance/materialPresets.ts` の `DEFAULT_APPEARANCE.color`
 * (`'#b8bfcc'`)** で、そこから**数値だけ引き写した**(`184/255`、`191/255`、`204/255`)。
 * io は model へ依存できる(依存方向の順で下流)が、ここで文字列の色を解く小さな処理を
 * 足すより、kernel の `DEFAULT_BODY_COLOR` と同じ流儀で数を置くほうが読み手に分かりやすい。
 * **正本とずれたら検査が落ちる**(`writeThreeMf.test.ts` が `DEFAULT_APPEARANCE.color` と
 * 突き合わせている)ので、写しが古くなることはない。
 */
export const DEFAULT_THREE_MF_COLOR: ThreeMfColor = [184 / 255, 191 / 255, 204 / 255];

/** 書き出す立体 1 つぶん。 */
export interface ThreeMfMeshInput {
  /** 立体の名前。`null` か空文字なら通し名(`body_1` など)になる。 */
  readonly name: string | null;
  /** 立体の色(sRGB の 0〜1)。`null` なら既定の色(`DEFAULT_THREE_MF_COLOR`)。 */
  readonly color: ThreeMfColor | null;
  /** 頂点の座標(mm)。x,y,z の順に平らに並ぶ。長さは 3 の倍数。 */
  readonly positions: ArrayLike<number>;
  /** 三角形の添字。3 個 1 組で頂点を指す。長さは 3 の倍数。 */
  readonly indices: ArrayLike<number>;
}

/** `writeThreeMf` の任意の指定。 */
export interface WriteThreeMfOptions {
  /**
   * 色を書くか(§0.a-0.22。省くと書く)。`false` なら `<basematerials>` を作らず、
   * `<object>` にも材質の指定を付けない(形だけの 3MF になる)。
   */
  readonly withColors?: boolean;
}

/** 3MF Core の名前空間(§2.6)。 */
const MODEL_NAMESPACE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';

/** 長さの単位。内部は mm 固定なので常にこれ(§0.a-0.7)。 */
const MODEL_UNIT = 'millimeter';

/**
 * 材質の組の資源 id。資源の id は `<object>` と番号を共有するので、材質を 1 番、
 * 立体を 2 番からにする。**色を書かないときも立体は 2 番から始める**——色の有無で
 * `<item objectid>` の番号が動かないほうが、読む側にも検査にも分かりやすいため。
 */
const BASE_MATERIALS_ID = 1;

/** 最初の立体の資源 id。 */
const FIRST_OBJECT_ID = 2;

/** XML の圧縮の強さ。`.pcad` の `document.json` と同じ 6(§2.6)。 */
const XML_LEVEL = 6;

/** `[Content_Types].xml`(§2.6 の固定の文面。3MF Core が求める 2 つの既定)。 */
const CONTENT_TYPES_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
  '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
  '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>',
  '</Types>',
  '',
].join('\n');

/** `_rels/.rels`(§2.6 の固定の文面。3D モデルの入口を 1 つだけ指す)。 */
const RELS_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
  '  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>',
  '</Relationships>',
  '',
].join('\n');

/**
 * 色を `#rrggbbff` にする(§2.6。**3MF は 8 桁(RGBA)、小文字**)。
 * 透過は書かない(§0.a-0.22 で「柄と透過率と光沢と粗さは書き出さない」)ので、末尾は常に `ff`。
 */
function formatDisplayColor(color: ThreeMfColor): string {
  let text = '#';
  for (const value of color) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(THREE_MF_INVALID_COLOR_MESSAGE);
    }
    text += Math.round(value * 255)
      .toString(16)
      .padStart(2, '0');
  }
  return `${text}ff`;
}

/** ファイルへ書く名前。空の名前は通し名にする(`<base name>` は省けない属性のため)。 */
function resolveName(name: string | null, index: number): string {
  return name === null || name === '' ? `body_${String(index + 1)}` : name;
}

/** 頂点の行を書き出す。長さの検査もここで行う。 */
function pushVertices(lines: string[], positions: ArrayLike<number>): number {
  if (positions.length % 3 !== 0) {
    throw new Error(THREE_MF_INVALID_POSITIONS_MESSAGE);
  }
  const vertexCount = positions.length / 3;
  for (let index = 0; index < vertexCount; index += 1) {
    const x = formatXmlNumber(positions[index * 3]);
    const y = formatXmlNumber(positions[index * 3 + 1]);
    const z = formatXmlNumber(positions[index * 3 + 2]);
    // 何万行も並ぶので字下げしない(XML を小さく保つため)。
    lines.push(`<vertex x="${x}" y="${y}" z="${z}"/>`);
  }
  return vertexCount;
}

/** 添字が頂点を指していることを確かめて返す。 */
function checkIndex(value: number, vertexCount: number): number {
  if (!Number.isInteger(value) || value < 0 || value >= vertexCount) {
    throw new Error(THREE_MF_INVALID_INDICES_MESSAGE);
  }
  return value;
}

/** 三角形の行を書き出す。 */
function pushTriangles(lines: string[], indices: ArrayLike<number>, vertexCount: number): void {
  if (indices.length % 3 !== 0) {
    throw new Error(THREE_MF_INVALID_INDICES_MESSAGE);
  }
  const triangleCount = indices.length / 3;
  for (let index = 0; index < triangleCount; index += 1) {
    const v1 = checkIndex(indices[index * 3], vertexCount);
    const v2 = checkIndex(indices[index * 3 + 1], vertexCount);
    const v3 = checkIndex(indices[index * 3 + 2], vertexCount);
    lines.push(
      `<triangle v1="${String(v1)}" v2="${String(v2)}" v3="${String(v3)}"/>`,
    );
  }
}

/**
 * `3D/3dmodel.model` の中身を組み立てる。
 *
 * 立体ごとに `<object>` を 1 つ作り、`<build>` に `<item>` を 1 つずつ並べる(§2.6)。
 * 色は立体ごとに `<basematerials>` の 1 行(`<base>`)として並べ、`<object>` の
 * `pid` / `pindex` で指す。**面ごとの色(タスク14b)はこの並びの後ろへ `<base>` を足し、
 * `<triangle>` に `p1` を付ける**だけで済むので、いまの並び(立体の順 = 添字の順)を崩さない。
 */
function buildModelXml(parts: readonly ThreeMfMeshInput[], withColors: boolean): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(`<model unit="${MODEL_UNIT}" xml:lang="en-US" xmlns="${MODEL_NAMESPACE}">`);
  lines.push('  <resources>');

  // 中身の無い `<basematerials>` は仕様が許さないので、立体が 1 つも無いときは作らない。
  if (withColors && parts.length > 0) {
    lines.push(`    <basematerials id="${String(BASE_MATERIALS_ID)}">`);
    parts.forEach((part, index) => {
      const name = escapeXmlAttribute(resolveName(part.name, index));
      const color = formatDisplayColor(part.color ?? DEFAULT_THREE_MF_COLOR);
      lines.push(`      <base name="${name}" displaycolor="${color}"/>`);
    });
    lines.push('    </basematerials>');
  }

  parts.forEach((part, index) => {
    const objectId = FIRST_OBJECT_ID + index;
    const material = withColors
      ? ` pid="${String(BASE_MATERIALS_ID)}" pindex="${String(index)}"`
      : '';
    // 名前は色を書かないときにも残したいので、`<base>` とは別に `<object>` にも書く。
    const name = part.name === null || part.name === '' ? '' : ` name="${escapeXmlAttribute(part.name)}"`;
    lines.push(`    <object id="${String(objectId)}" type="model"${material}${name}>`);
    lines.push('      <mesh>');
    lines.push('        <vertices>');
    const vertexCount = pushVertices(lines, part.positions);
    lines.push('        </vertices>');
    lines.push('        <triangles>');
    pushTriangles(lines, part.indices, vertexCount);
    lines.push('        </triangles>');
    lines.push('      </mesh>');
    lines.push('    </object>');
  });

  lines.push('  </resources>');
  lines.push('  <build>');
  parts.forEach((_part, index) => {
    lines.push(`    <item objectid="${String(FIRST_OBJECT_ID + index)}"/>`);
  });
  lines.push('  </build>');
  lines.push('</model>');
  lines.push('');
  return lines.join('\n');
}

/**
 * 立体ごとの三角形を 3MF のバイト列にする(FR-803)。
 *
 * **空の並びは断らずに「立体の入っていない 3MF」を返す**(kernel の `writeStl` /
 * `writeCafMesh` と同じ判断)。書き出せる立体が 1 つも無いことを利用者へ断るのは model の
 * `selectExportBodies`(`nothingToExport`)の役目で、ここまで来た時点では既に済んでいる。
 * 書く側が形式ごとに違う判断をすると、形式を変えただけで断り方が変わってしまう。
 *
 * 入力の作り間違い(頂点の並びが 3 の倍数でない・添字が頂点を指していない・色が 0〜1 でない)
 * は日本語の理由を添えて投げる。壊れた 3MF を無音で作らないためで、`buildExportMesh` が
 * 品質の値を断るのと同じ流儀である。
 */
export function writeThreeMf(
  parts: readonly ThreeMfMeshInput[],
  options: WriteThreeMfOptions = {},
): Uint8Array {
  const withColors = options.withColors ?? true;
  const modelXml = buildModelXml(parts, withColors);
  // エントリの並びも固定する(決定性)。3MF の読み手は名前で引くので、並びは自由に決めてよい。
  const entries: Zippable = {
    [THREE_MF_CONTENT_TYPES_ENTRY]: [
      strToU8(CONTENT_TYPES_XML),
      { level: XML_LEVEL, mtime: FIXED_ENTRY_MTIME },
    ],
    [THREE_MF_RELS_ENTRY]: [strToU8(RELS_XML), { level: XML_LEVEL, mtime: FIXED_ENTRY_MTIME }],
    [THREE_MF_MODEL_ENTRY]: [strToU8(modelXml), { level: XML_LEVEL, mtime: FIXED_ENTRY_MTIME }],
  };
  return zipSync(entries);
}
