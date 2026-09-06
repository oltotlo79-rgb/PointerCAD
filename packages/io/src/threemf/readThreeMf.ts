/**
 * 3MF の読み込み(FR-809、計画書 docs/plans/P6-入出力.md §2.6・§2.8、タスク19)。
 *
 * 3MF は ZIP の中に XML を入れた形式で、OCCT には読み手が無い(§0.a-0.26)。だから
 * `packages/io` が自前で読む。書き出し(`writeThreeMf.ts`)のちょうど逆で、
 * ZIP を `fflate` の `unzipSync` で開き、`3D/3dmodel.model` の
 * `<vertex x= y= z=>` と `<triangle v1= v2= v3=>` を拾う。
 *
 * **OCCT を呼ばない。** 返すのは素の JS の並び(位置・法線・添字)だけで、
 * `packages/io` は `packages/kernel` へ依存できない(依存方向 `apps → ui → model → kernel`。
 * `rules/04-設計の規律.md`)。**kernel の `ImportedMeshData`(`occt/exchangeShared.ts`)と
 * 同じ並び**にしてあるので、タスク16 の配線は写しを作らずそのまま渡せる。
 *
 * **メッシュを B-rep へ戻さない**(§0.a-0.23)。読んだ形は三角形のまま持ち、
 * 表示・測定・書き出しはできるが、穴あけ・面取り・ブーリアンの対象にはしない。
 *
 * **例外を外へ出さない**(§0.a-0.27、NFR-RE-1)。`readPcadFile` と同じ流儀で、
 * 壊れたファイルも結果オブジェクト(`{ ok: false, reason }`)で断る。呼び出し側は
 * `reason` をそのまま画面へ出せる日本語として扱える(NFR-UX-5)。
 *
 * ---
 *
 * ## XML の読み手を自前で書く理由(§1.1)
 *
 * `DOMParser` はブラウザには在るが **Node(Vitest)には無い**。外部の XML パーサーを
 * 足すのは `rules/02-禁止事項.md`(依存の無断変更)に触れるうえ、3MF で要るのは
 * 「タグを順に拾って属性を読む」だけである。だから下の `scanTags` /
 * `readAttributes` の 2 つで足りる(**属性の順序に依らず、`"` と `'` の
 * どちらの引用符も受ける**)。名前空間の接頭辞(`<m:vertex>`)は落として比べる。
 *
 * ## 断りの文言が kernel と同文である理由
 *
 * `MESH_READ_FAILED_MESSAGE` / `MESH_NO_FACE_MESSAGE` / `meshTooLargeMessage` と
 * 上限 500 万の**正本は `packages/kernel/src/occt/exchangeShared.ts`** で、STL(タスク17)と
 * OBJ / glTF(タスク18)がそこから引いている。io は kernel を輸入できないので、
 * ここには**同じ文字列を写して**置く(`testUtils/perfBudget.ts` と同じ事情)。
 * 読み込んだ形式によって断り方が変わっては利用者が困るので、**写しがずれていないことは
 * 検査で固定する**(`readThreeMf.test.ts` に正本の文字列を書き写した検査がある)。
 */

import { strFromU8, unzipSync, type Unzipped } from 'fflate';

import { THREE_MF_MODEL_ENTRY, type ThreeMfColor } from './writeThreeMf.js';

/**
 * 読めなかったとき(ZIP でない・`3D/3dmodel.model` が無い・XML が壊れている)の断り。
 *
 * 正本は kernel の `exchangeShared.ts` の `MESH_READ_FAILED_MESSAGE`(冒頭の注釈)。
 */
export const THREE_MF_READ_FAILED_MESSAGE =
  'このファイルを読めませんでした。ファイルが壊れているか、対応していない形式です。';

/**
 * 読めたが三角形が 1 枚も無かったときの断り。
 *
 * 正本は kernel の `exchangeShared.ts` の `MESH_NO_FACE_MESSAGE`。
 */
export const THREE_MF_NO_FACE_MESSAGE = 'この形には面がありません。';

/**
 * 開ける三角形の上限。
 *
 * 正本は kernel の `exchangeShared.ts` の `MESH_MAX_TRIANGLE_COUNT`。
 * 10 万三角形で約 2.4MB(§2.8 の見積もり)なので、500 万なら約 120MB。
 */
export const THREE_MF_MAX_TRIANGLE_COUNT = 5_000_000;

/**
 * 三角形が多すぎて開けないときの断り(個数を文言に入れる)。
 *
 * 正本は kernel の `exchangeShared.ts` の `meshTooLargeMessage`。
 */
export function threeMfTooLargeMessage(triangleCount: number): string {
  return `この形は大きすぎて開けません(三角形が ${String(triangleCount)} 個)。`;
}

/**
 * 3MF が持てる長さの単位(3MF Core の `<model unit>` が取りうる 6 つ)。
 *
 * **`unit` が無ければ `millimeter`**(3MF Core の既定)。この 6 つ以外の値は
 * 換算の倍率が決められないので断る(下の `toLengthUnit`)。
 */
export type ThreeMfLengthUnit =
  | 'micron'
  | 'millimeter'
  | 'centimeter'
  | 'inch'
  | 'foot'
  | 'meter';

/**
 * 単位 1 つぶんが何 mm か(§0.a-0.6。FR-811「インチのファイルも正しい寸法で開ける」)。
 *
 * `foot` は 12 inch なので `12 × 25.4 = 304.8`。どれも 10 進で厳密に書ける値である。
 */
const UNIT_TO_MILLIMETER: Readonly<Record<ThreeMfLengthUnit, number>> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

/** 読み込んだ立体 1 つぶん(kernel の `ImportedMeshData` と同じ並び + 名前と色)。 */
export interface ThreeMfMesh {
  /** `<object name>` に書いてあった名前。無ければ `null`。 */
  readonly name: string | null;
  /**
   * `<basematerials>` の `displaycolor` から読んだ色(sRGB の 0〜1)。
   *
   * **model は読み込んだ形を既定の外観にする**(§0.a-0.28。色の取り込みは P7 以降)。
   * それでも io が捨てないのは、捨ててしまうと後で拾い直せないためで、
   * 使うかどうかは上の層が決める。
   */
  readonly color: ThreeMfColor | null;
  /** 頂点の位置(x, y, z の繰り返し)。**mm へ換算済み。** */
  readonly positions: Float32Array;
  /** 頂点の法線(単位ベクトル)。3MF には無いので三角形から計算したもの。 */
  readonly normals: Float32Array;
  /** 三角形の頂点の番号(3 個で 1 枚。0 始まり)。 */
  readonly indices: Uint32Array;
  /** 三角形の枚数(`indices.length / 3`)。 */
  readonly triangleCount: number;
  /** 閉じた形とみなしたときの体積(mm³)。開いた形では意味を持たない目安。 */
  readonly volume: number;
}

/** `readThreeMf` の結果。**例外を投げず、断りも値で返す**(`readPcadFile` と同じ流儀)。 */
export type ThreeMfReadResult =
  | {
      readonly ok: true;
      /** 読み込んだ立体。`<build>` の `<item>` ごとに 1 つ(変換を掛けた後の座標)。 */
      readonly meshes: readonly ThreeMfMesh[];
      /**
       * ファイルに書いてあった単位。**座標は既に mm へ換算してある**ので、
       * 上の層(タスク20 の `ImportedSource.unit`)へ渡すのは `'mm'` でよい。
       * これは「元のファイルが何で書かれていたか」の記録である。
       */
      readonly unit: ThreeMfLengthUnit;
    }
  | { readonly ok: false; readonly reason: string };

/** 断りを組み立てる(結果の形を 1 か所にする)。 */
function fail(reason: string): ThreeMfReadResult {
  return { ok: false, reason };
}

/* ------------------------------------------------------------------ *
 * XML の小さな読み手(§1.1)
 * ------------------------------------------------------------------ */

/** Unicode の符号位置の上限(`String.fromCodePoint` が受け付ける最大)。 */
const MAX_CODE_POINT = 0x10ffff;

/**
 * 数値参照を文字へ直す。**範囲の外なら元の文字列のまま**にする。
 *
 * `String.fromCodePoint` は範囲の外の数で例外を投げる。壊れたファイルの
 * `&#x110000;` 1 つで読み込み全体が落ちないよう、ここで受け止める
 * (`readAttributes` は外からも呼べる関数なので、この関数自体が例外を出さないようにする)。
 */
function fromCodePoint(code: number, fallback: string): string {
  if (!Number.isInteger(code) || code < 0 || code > MAX_CODE_POINT) {
    return fallback;
  }
  return String.fromCodePoint(code);
}

/**
 * 実体参照を元の文字へ戻す(`xmlText.ts` の `escapeXmlAttribute` の逆)。
 *
 * 書き出し側が使う 8 種(`&amp;` `&lt;` `&gt;` `&quot;` `&apos;` `&#x9;` `&#xA;` `&#xD;`)を
 * **1 度の走査で**戻す。順に `replace` すると、`&amp;lt;`(元は `&lt;` という文字列)を
 * `&lt;` → `<` と二重に戻してしまうためである。
 *
 * 数値参照は 10 進(`&#65;`)と 16 進(`&#x41;`)のどちらも受ける。3MF を書く道具は
 * 他にもあり、同じ文字を別の書き方で逃がしてくるためである。知らない実体参照
 * (`&nbsp;` など。XML の既定には無い)は**そのままの文字列として残す**——
 * 名前の中の見た目が少し変わるだけで、形は正しく読めるほうがよい(NFR-RE-1)。
 */
function unescapeXml(value: string): string {
  if (!value.includes('&')) {
    // 大半の属性(座標・添字)は実体参照を含まないので、走査そのものを省く。
    return value;
  }
  return value.replace(
    /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g,
    (whole, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
      if (hex !== undefined) {
        return fromCodePoint(Number.parseInt(hex, 16), whole);
      }
      if (dec !== undefined) {
        return fromCodePoint(Number.parseInt(dec, 10), whole);
      }
      switch (named) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default:
          return whole;
      }
    },
  );
}

/** 属性の並びを拾う正規表現(`名前 = "値"` または `名前 = '値'`)。 */
const ATTRIBUTE_PATTERN = /([A-Za-z_:][-\w.:]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * タグ 1 つぶんの文字列から属性を読む(タスク19 の手順 2)。
 *
 * ```ts
 * readAttributes('<vertex z="3" x=\'1\' y="2"/>') // → { x: '1', y: '2', z: '3' }
 * ```
 *
 * **属性の順序に依らない**(名前で引く連想配列にするため)。`"` と `'` の
 * どちらの引用符も受ける(XML の仕様はどちらも許す)。値は実体参照を戻してから返す。
 *
 * タグの名前そのもの(`vertex`)は `=` を伴わないので拾われない。
 */
export function readAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  ATTRIBUTE_PATTERN.lastIndex = 0;
  let match = ATTRIBUTE_PATTERN.exec(tag);
  while (match !== null) {
    const raw = match[2] ?? match[3] ?? '';
    attributes[match[1]] = unescapeXml(raw);
    match = ATTRIBUTE_PATTERN.exec(tag);
  }
  return attributes;
}

/** 拾ったタグ 1 つ。 */
interface XmlTag {
  /** 名前空間の接頭辞を落とした小文字の名前(`m:Vertex` なら `vertex`)。 */
  readonly name: string;
  /** タグの全文(`<vertex x="1"/>`)。属性はここから `readAttributes` で読む。 */
  readonly text: string;
  /** 閉じタグ(`</object>`)か。 */
  readonly closing: boolean;
  /** それ自身で閉じるタグ(`<vertex .../>`)か。 */
  readonly selfClosing: boolean;
}

/** 注釈・処理命令・CDATA の終わりを探す。見つからなければ `-1`。 */
function skipUntil(xml: string, from: number, terminator: string): number {
  const end = xml.indexOf(terminator, from);
  return end === -1 ? -1 : end + terminator.length;
}

/**
 * タグ 1 つの終わりの `>` を探す。**引用符の中の `>` は数えない。**
 *
 * `>` は属性値の中にそのまま書いてよい(XML の仕様。逃がす義務があるのは `<` と `&` だけ)ので、
 * 単純に次の `>` を採ると、そういうファイルでタグを切り損ねる。
 */
function findTagEnd(xml: string, from: number): number {
  let quote = '';
  for (let index = from; index < xml.length; index += 1) {
    const char = xml[index];
    if (quote !== '') {
      if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') {
      return index;
    }
  }
  return -1;
}

/**
 * XML をタグの並びへ畳む。**壊れていれば `null`**(閉じられていないタグ・注釈)。
 *
 * 木を作らないのは、3MF で要るのが「`<object>` の中の `<vertex>` を順に拾う」だけで、
 * 深さの追跡は下の `parseModel` の数個の変数で足りるためである(木を組むと
 * 10 万三角形で無駄な節が 15 万個できる)。
 */
function scanTags(xml: string): XmlTag[] | null {
  const tags: XmlTag[] = [];
  let index = 0;
  while (index < xml.length) {
    const start = xml.indexOf('<', index);
    if (start === -1) {
      break;
    }
    if (xml.startsWith('<!--', start)) {
      const next = skipUntil(xml, start + 4, '-->');
      if (next === -1) {
        return null;
      }
      index = next;
      continue;
    }
    if (xml.startsWith('<![CDATA[', start)) {
      const next = skipUntil(xml, start + 9, ']]>');
      if (next === -1) {
        return null;
      }
      index = next;
      continue;
    }
    const end = findTagEnd(xml, start + 1);
    if (end === -1) {
      return null;
    }
    const text = xml.slice(start, end + 1);
    index = end + 1;
    // 宣言(`<?xml ?>`)と DOCTYPE は中身を見ないので読み飛ばす。
    if (text.startsWith('<?') || text.startsWith('<!')) {
      continue;
    }
    const closing = text.startsWith('</');
    const selfClosing = text.endsWith('/>');
    const nameStart = closing ? 2 : 1;
    let nameEnd = nameStart;
    while (nameEnd < text.length && !' \t\r\n/>'.includes(text[nameEnd])) {
      nameEnd += 1;
    }
    const qualified = text.slice(nameStart, nameEnd);
    if (qualified === '') {
      return null;
    }
    const colon = qualified.lastIndexOf(':');
    const name = (colon === -1 ? qualified : qualified.slice(colon + 1)).toLowerCase();
    tags.push({ name, text, closing, selfClosing });
  }
  return tags;
}

/* ------------------------------------------------------------------ *
 * 値の読み取り
 * ------------------------------------------------------------------ */

/** XML の属性へ書ける 10 進の数の形(指数表記も 3MF の仕様は許す)。 */
const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** 0 以上の整数の形。 */
const INDEX_PATTERN = /^\d+$/;

/**
 * 属性を数として読む。読めなければ `null`(壊れたファイルとして断る材料になる)。
 *
 * `Number('')` が `0` になる・`Number('0x10')` が `16` になるといった JS の緩さを
 * 通さないため、形を正規表現で確かめてから数へ直す。
 */
function readNumber(attributes: Record<string, string>, key: string): number | null {
  const text = attributes[key];
  if (text === undefined || !NUMBER_PATTERN.test(text.trim())) {
    return null;
  }
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : null;
}

/** 属性を 0 以上の整数として読む。読めなければ `null`。 */
function readIndex(attributes: Record<string, string>, key: string): number | null {
  const text = attributes[key];
  if (text === undefined || !INDEX_PATTERN.test(text.trim())) {
    return null;
  }
  const value = Number(text.trim());
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * `<model unit>` を換算できる単位に直す。**無ければ millimeter**(3MF Core の既定)。
 *
 * 知らない値は `null` を返して**断る**。既定の mm とみなすと、単位を取り違えたまま
 * 1000 倍・1/1000 の形を黙って取り込むことになり、利用者が気づけない(FR-811 の趣旨に反する)。
 * `switch` で書くのは、`as` を使わずに文字列を型へ絞り込むためである。
 */
function toLengthUnit(value: string | undefined): ThreeMfLengthUnit | null {
  switch (value) {
    case undefined:
    case 'millimeter':
      return 'millimeter';
    case 'micron':
      return 'micron';
    case 'centimeter':
      return 'centimeter';
    case 'inch':
      return 'inch';
    case 'foot':
      return 'foot';
    case 'meter':
      return 'meter';
    default:
      return null;
  }
}

/**
 * `displaycolor`(`#rrggbb` または `#rrggbbaa`)を sRGB の 0〜1 にする。
 *
 * 透過(`aa`)は捨てる(§0.a-0.22 で「色だけを扱い、透過率・光沢・粗さは扱わない」)。
 * 読めない書き方は `null`(色は飾りなので、断らずに既定の外観へ落とす)。
 */
function parseDisplayColor(value: string | undefined): ThreeMfColor | null {
  if (value === undefined || !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value)) {
    return null;
  }
  const red = Number.parseInt(value.slice(1, 3), 16) / 255;
  const green = Number.parseInt(value.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(value.slice(5, 7), 16) / 255;
  return [red, green, blue];
}

/**
 * `<item transform>` の 12 個の数を読む。
 *
 * 3MF の変換は **4 行 3 列**(行ベクトル × 行列)で、`m00 m01 m02 m10 m11 m12 m20 m21 m22
 * m30 m31 m32` の順に並ぶ。最後の行が平行移動である。個数が 12 でなければ `null`。
 */
function parseTransform(value: string | undefined): number[] | null {
  if (value === undefined) {
    return null;
  }
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 12) {
    return null;
  }
  const numbers: number[] = [];
  for (const part of parts) {
    if (!NUMBER_PATTERN.test(part)) {
      return null;
    }
    const number = Number(part);
    if (!Number.isFinite(number)) {
      return null;
    }
    numbers.push(number);
  }
  return numbers;
}

/* ------------------------------------------------------------------ *
 * 三角形からの計算(正本は kernel の exchangeShared.ts)
 * ------------------------------------------------------------------ */

/**
 * 三角形から頂点の法線を作る(3MF のファイルに法線は入っていない)。
 *
 * **式の正本は `packages/kernel/src/occt/exchangeShared.ts` の `computeVertexNormals`**
 * (タスク17)。各三角形の 2 辺の外積をその 3 頂点へ足し込んでから正規化する。
 * 外積の長さは三角形の面積の 2 倍なので、**正規化せずに足すと自然に面積の重みが付く**。
 * 長さが 0 になるのは、その頂点に付く三角形が全部つぶれているときだけで、
 * `NaN` を画面へ流すと three.js の描画が黙って壊れるので Z の向きを置く。
 */
function computeVertexNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
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
 * **式の正本は `packages/kernel/src/occt/exchangeShared.ts` の `computeVolume`**(タスク17)。
 * 原点と三角形が作る四面体の符号付き体積 `(v₁ × v₂)·v₃ / 6` を全部足すと、閉じた形なら
 * 中身の体積になる。読み込んだファイルは表裏が揃っていないことがあるので**絶対値を取る**。
 */
function computeVolume(positions: Float32Array, indices: Uint32Array): number {
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

/* ------------------------------------------------------------------ *
 * `3D/3dmodel.model` の読み取り
 * ------------------------------------------------------------------ */

/** 読み取りの途中の `<object>`(座標はまだファイルの単位のまま)。 */
interface RawObject {
  readonly id: string;
  readonly name: string | null;
  /** `<basematerials>` の組の id(`pid`)。無ければ `null`。 */
  readonly pid: string | null;
  /** その組の中の添字(`pindex`)。無ければ `null`。 */
  readonly pindex: number | null;
  readonly coordinates: number[];
  readonly corners: number[];
}

/** `<build>` の 1 行。 */
interface BuildItem {
  readonly objectId: string;
  /** 12 個の数(4 行 3 列)。`transform` が無ければ `null`(恒等)。 */
  readonly transform: number[] | null;
}

/** XML から拾ったもの。 */
interface ParsedModel {
  readonly unit: ThreeMfLengthUnit;
  readonly objects: readonly RawObject[];
  readonly items: readonly BuildItem[];
  /** 材質の組の id → その組の `displaycolor` の並び。 */
  readonly materials: ReadonlyMap<string, (ThreeMfColor | null)[]>;
}

/**
 * タグの並びから 3MF の中身を拾う。**壊れていれば `null`。**
 *
 * `<object>` の中では `<vertex>` と `<triangle>` を順に足していく。3MF の添字は
 * **その `<object>` の中の通し番号**なので、立体をまたいで足し込まない。
 */
function parseModel(tags: readonly XmlTag[]): ParsedModel | null {
  let unit: ThreeMfLengthUnit | null = null;
  let sawModel = false;
  const objects: RawObject[] = [];
  const items: BuildItem[] = [];
  const materials = new Map<string, (ThreeMfColor | null)[]>();
  let currentObject: RawObject | null = null;
  let currentMaterialsId: string | null = null;
  let inBuild = false;

  for (const tag of tags) {
    switch (tag.name) {
      case 'model': {
        if (tag.closing || sawModel) {
          break;
        }
        sawModel = true;
        unit = toLengthUnit(readAttributes(tag.text).unit);
        if (unit === null) {
          // 知らない単位は換算できないので、ここで壊れたファイルとして扱う。
          return null;
        }
        break;
      }
      case 'basematerials': {
        if (tag.closing) {
          currentMaterialsId = null;
          break;
        }
        const id = readAttributes(tag.text).id ?? '';
        materials.set(id, []);
        currentMaterialsId = tag.selfClosing ? null : id;
        break;
      }
      case 'base': {
        if (tag.closing || currentMaterialsId === null) {
          break;
        }
        const group = materials.get(currentMaterialsId);
        if (group !== undefined) {
          group.push(parseDisplayColor(readAttributes(tag.text).displaycolor));
        }
        break;
      }
      case 'object': {
        if (tag.closing) {
          if (currentObject === null) {
            return null;
          }
          objects.push(currentObject);
          currentObject = null;
          break;
        }
        if (currentObject !== null) {
          // `<object>` は入れ子にできない(3MF Core)。入れ子は壊れたファイル。
          return null;
        }
        const attributes = readAttributes(tag.text);
        const id = attributes.id;
        if (id === undefined) {
          return null;
        }
        const started: RawObject = {
          id,
          name: attributes.name ?? null,
          pid: attributes.pid ?? null,
          pindex: readIndex(attributes, 'pindex'),
          coordinates: [],
          corners: [],
        };
        if (tag.selfClosing) {
          objects.push(started);
        } else {
          currentObject = started;
        }
        break;
      }
      case 'vertex': {
        if (tag.closing || currentObject === null) {
          break;
        }
        const attributes = readAttributes(tag.text);
        const x = readNumber(attributes, 'x');
        const y = readNumber(attributes, 'y');
        const z = readNumber(attributes, 'z');
        if (x === null || y === null || z === null) {
          return null;
        }
        currentObject.coordinates.push(x, y, z);
        break;
      }
      case 'triangle': {
        if (tag.closing || currentObject === null) {
          break;
        }
        const attributes = readAttributes(tag.text);
        const v1 = readIndex(attributes, 'v1');
        const v2 = readIndex(attributes, 'v2');
        const v3 = readIndex(attributes, 'v3');
        if (v1 === null || v2 === null || v3 === null) {
          return null;
        }
        currentObject.corners.push(v1, v2, v3);
        break;
      }
      case 'build': {
        inBuild = !tag.closing && !tag.selfClosing;
        break;
      }
      case 'item': {
        if (tag.closing || !inBuild) {
          break;
        }
        const attributes = readAttributes(tag.text);
        const objectId = attributes.objectid;
        if (objectId === undefined) {
          return null;
        }
        const rawTransform = attributes.transform;
        const transform = rawTransform === undefined ? null : parseTransform(rawTransform);
        if (rawTransform !== undefined && transform === null) {
          return null;
        }
        items.push({ objectId, transform });
        break;
      }
      default:
        break;
    }
  }

  if (!sawModel || unit === null || currentObject !== null) {
    // `<model>` が無い / `<object>` が閉じていない = 3MF として読めない。
    return null;
  }
  return { unit, objects, items, materials };
}

/* ------------------------------------------------------------------ *
 * 三角形の組み立て
 * ------------------------------------------------------------------ */

/**
 * 1 つの `<object>` から三角形の束を作る。**添字が頂点を指していなければ `null`。**
 *
 * 変換(`<item transform>`)を掛けてから単位を mm へ換算する。変換の平行移動も
 * ファイルの単位で書いてあるので、この順でないと平行移動だけ換算し損ねる。
 */
function buildMesh(
  object: RawObject,
  transform: number[] | null,
  unitScale: number,
  color: ThreeMfColor | null,
): ThreeMfMesh | null {
  const vertexCount = object.coordinates.length / 3;
  const positions = new Float32Array(object.coordinates.length);
  for (let index = 0; index < vertexCount; index += 1) {
    const base = index * 3;
    const x = object.coordinates[base];
    const y = object.coordinates[base + 1];
    const z = object.coordinates[base + 2];
    if (transform === null) {
      positions[base] = x * unitScale;
      positions[base + 1] = y * unitScale;
      positions[base + 2] = z * unitScale;
      continue;
    }
    // 行ベクトル × 4 行 3 列。最後の行(添字 9〜11)が平行移動。
    positions[base] = (x * transform[0] + y * transform[3] + z * transform[6] + transform[9]) * unitScale;
    positions[base + 1] =
      (x * transform[1] + y * transform[4] + z * transform[7] + transform[10]) * unitScale;
    positions[base + 2] =
      (x * transform[2] + y * transform[5] + z * transform[8] + transform[11]) * unitScale;
  }

  const indices = new Uint32Array(object.corners.length);
  for (let index = 0; index < object.corners.length; index += 1) {
    const corner = object.corners[index];
    if (corner >= vertexCount) {
      return null;
    }
    indices[index] = corner;
  }

  return {
    name: object.name === null || object.name === '' ? null : object.name,
    color,
    positions,
    normals: computeVertexNormals(positions, indices),
    indices,
    triangleCount: indices.length / 3,
    volume: computeVolume(positions, indices),
  };
}

/** `<object>` の `pid` / `pindex` から色を引く。引けなければ `null`。 */
function colorOf(object: RawObject, materials: ParsedModel['materials']): ThreeMfColor | null {
  if (object.pid === null || object.pindex === null) {
    return null;
  }
  const group = materials.get(object.pid);
  if (group === undefined || object.pindex >= group.length) {
    return null;
  }
  return group[object.pindex];
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/** ZIP を展開する。ZIP でなければ `fflate` が例外を投げるので受け止めて `null` にする。 */
function unzip(bytes: Uint8Array): Unzipped | null {
  try {
    return unzipSync(bytes);
  } catch {
    return null;
  }
}

/** UTF-8 として読む。読めない並びは置き換え文字になるだけだが、念のため受け止める。 */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return strFromU8(bytes);
  } catch {
    return null;
  }
}

/**
 * XML を読む前に `<triangle` の数を数える(§0.a-0.27 の 3 段構えの ①)。
 *
 * **なぜ読む前に数えるのか。** 500 万三角形の 3MF は展開後の XML だけで 300MB 前後になり、
 * タグへ畳んでから断ると、断るためだけに記憶を食い尽くす(`readStl.ts` が
 * バイナリ STL の頭の個数だけで断るのと同じ考え)。文字列の走査は 1 回だけなので、
 * 上限に収まるふつうのファイルでは費用が問題にならない。
 *
 * `<triangles>`(囲みのほう)を数えないよう、次の 1 文字が `s` のものは飛ばす。
 * 注釈の中の `<triangle` まで数えてしまうが、**多すぎるかどうかの門**としては
 * 多めに数えるほうが安全側である。
 */
function countTriangleTags(xml: string): number {
  let count = 0;
  let index = xml.indexOf('<triangle');
  while (index !== -1) {
    if (xml[index + 9] !== 's') {
      count += 1;
    }
    index = xml.indexOf('<triangle', index + 9);
  }
  return count;
}

/**
 * 3MF のバイト列から三角形の束を読む(FR-809、§2.6)。
 *
 * ```ts
 * const result = readThreeMf(bytes);
 * if (!result.ok) {
 *   showMessage(result.reason); // そのまま画面へ出せる日本語
 *   return;
 * }
 * // result.meshes[i].positions / normals / indices はそのまま three.js へ渡せる(mm)
 * ```
 *
 * **座標は mm へ換算済み**(`<model unit>` の倍率と `<item transform>` を掛けた後の値)。
 * 立体は `<build>` の `<item>` ごとに 1 つ返す。`<build>` が空のファイルは、
 * `<resources>` の `<object>` をそのまま(変換なしで)返す——`<build>` を書かない道具が
 * 実在し、そこで断ると「形が入っているのに開けない」ことになるためである。
 *
 * **例外を投げない。** 壊れたファイル・面が 0 枚・大きすぎる形は、日本語の理由を添えた
 * `{ ok: false, reason }` で返す(§0.a-0.27、NFR-RE-1)。
 */
export function readThreeMf(bytes: Uint8Array): ThreeMfReadResult {
  try {
    const entries = unzip(bytes);
    if (entries === null) {
      return fail(THREE_MF_READ_FAILED_MESSAGE);
    }
    if (!(THREE_MF_MODEL_ENTRY in entries)) {
      return fail(THREE_MF_READ_FAILED_MESSAGE);
    }
    const xml = decodeUtf8(entries[THREE_MF_MODEL_ENTRY]);
    if (xml === null) {
      return fail(THREE_MF_READ_FAILED_MESSAGE);
    }

    // 読む前の門(多すぎる)。上の注釈のとおり、畳む前に数えるほうが安全である。
    const roughTriangleCount = countTriangleTags(xml);
    if (roughTriangleCount > THREE_MF_MAX_TRIANGLE_COUNT) {
      return fail(threeMfTooLargeMessage(roughTriangleCount));
    }

    const tags = scanTags(xml);
    if (tags === null) {
      return fail(THREE_MF_READ_FAILED_MESSAGE);
    }
    const parsed = parseModel(tags);
    if (parsed === null) {
      return fail(THREE_MF_READ_FAILED_MESSAGE);
    }

    const byId = new Map<string, RawObject>();
    for (const object of parsed.objects) {
      byId.set(object.id, object);
    }
    const unitScale = UNIT_TO_MILLIMETER[parsed.unit];
    const meshes: ThreeMfMesh[] = [];
    if (parsed.items.length === 0) {
      for (const object of parsed.objects) {
        const mesh = buildMesh(object, null, unitScale, colorOf(object, parsed.materials));
        if (mesh === null) {
          return fail(THREE_MF_READ_FAILED_MESSAGE);
        }
        meshes.push(mesh);
      }
    } else {
      for (const item of parsed.items) {
        const object = byId.get(item.objectId);
        if (object === undefined) {
          // 置いてある形の実体が無いファイルは、形が食い違っているので断る。
          return fail(THREE_MF_READ_FAILED_MESSAGE);
        }
        const mesh = buildMesh(object, item.transform, unitScale, colorOf(object, parsed.materials));
        if (mesh === null) {
          return fail(THREE_MF_READ_FAILED_MESSAGE);
        }
        meshes.push(mesh);
      }
    }

    let triangleCount = 0;
    for (const mesh of meshes) {
      triangleCount += mesh.triangleCount;
    }
    if (triangleCount > THREE_MF_MAX_TRIANGLE_COUNT) {
      // 同じ `<object>` を何度も置いた形は、門をくぐった後で初めて上限を超える。
      return fail(threeMfTooLargeMessage(triangleCount));
    }
    if (triangleCount === 0) {
      return fail(THREE_MF_NO_FACE_MESSAGE);
    }
    return { ok: true, meshes, unit: parsed.unit };
  } catch {
    // ここへ来るのは記憶が足りないときだけ(`Float32Array` の確保など)。
    // **例外を外へ出さない**という約束(§0.a-0.27)を最後に守るための受け皿である。
    return fail(THREE_MF_READ_FAILED_MESSAGE);
  }
}
