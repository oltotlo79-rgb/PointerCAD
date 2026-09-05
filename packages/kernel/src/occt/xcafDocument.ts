import type {
  Handle_TDocStd_Document,
  OpenCascadeInstance,
  Quantity_TypeOfColor,
  TDF_Label,
  TopoDS_Shape,
  XCAFDoc_ColorType,
} from 'opencascade.js/dist/opencascade.full.js';

import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';

/**
 * 書き出し用の文書(XCAF)の組み立て(計画書 P6 §2.5、タスク7。FR-803 / FR-804 / FR-1106)。
 *
 * STEP / OBJ / glTF の書き手はどれも「形の一覧」ではなく**1 つの文書**を受け取る。
 * 文書には形のほかに**名前**と**色**を載せられるので、3 形式で同じ組み立てを共用する。
 *
 * **構造は平ら**にする(§0.a-0.11)。「部品 1 つ = ラベル 1 つ」を並べるだけで、
 * 入れ子の組み立て(アセンブリ)は P7 へ送る。`AddShape` の `makeAssembly` は false。
 *
 * **色は立体ごと**(§0.a-0.22)。面ごとの色はタスク7b で足す。
 *
 * ---
 *
 * **実測(2026-09-06、Node の opencascade.js 2.0.0-beta.b5ff984。計画書 §1.5-1):**
 * `TDocStd_Document` / `Handle_TDocStd_Document_2` / `TCollection_ExtendedString_2` /
 * `XCAFDoc_DocumentTool` / `XCAFDoc_ShapeTool` / `XCAFDoc_ColorTool` / `Quantity_Color_3` /
 * `TDataStd_Name` / `STEPCAFControl_Writer_1` / `TColStd_IndexedDataMapOfStringString_1` /
 * `Message_ProgressRange_1` は**すべて実行時に関数として束縛されている**(`.test.ts` の 1 件目)。
 * 列挙の入れ物 `Quantity_TypeOfColor` / `XCAFDoc_ColorType` も実行時に存在し、
 * それぞれ `values` を含む鍵を持つ(値の中身は空のオブジェクト)。
 *
 * **⚠️ 解放の実測(2026-09-06。ここを間違えると WASM の記憶が壊れる):**
 * 1. **`XCAFDoc_DocumentTool.ShapeTool(...).get()` が返す道具は借り物で、`delete()` してはいけない。**
 *    消すと以後の解放が `memory access out of bounds` になり、同じ実体を使う後続の検査まで巻き添えで落ちる。
 *    消してよいのは `Handle_...` のほう(このファイルは `keep` へ積むのも Handle だけ)。
 * 2. **`TDocStd_Document` は `Handle_TDocStd_Document_2` に包んだ時点で持ち主が移る。**
 *    Handle を消すと文書の実体も消えるので、そのあと `doc.delete()` を呼ぶと二重解放になり
 *    `null function or function signature mismatch` / `unreachable` で落ちる(実測で再現)。
 *    だから**文書そのものは控えへ積まない**。包み(JavaScript 側の小さな入れ物)だけが残るが、
 *    C++ の実体は Handle の解放で確実に返る。
 */

/** 色(0〜1 の r / g / b)。`#rrggbb` を 255 で割った値を受ける(§2.5)。 */
export type RgbTuple = readonly [number, number, number];

/** 書き出す立体 1 つぶん。 */
export interface XcafShapeEntry {
  /** 書き出す形。呼び出し側が持ち主のままで、このファイルは解放しない。 */
  readonly shape: TopoDS_Shape;
  /** 立体の名前。`null` か空文字なら OCCT の既定(`SOLID`)になる。 */
  readonly name: string | null;
  /** 立体の色。`null` なら色を付けない。 */
  readonly color: RgbTuple | null;
}

/** 組み立てた文書。使い終わったら必ず `delete()` する。 */
export interface XcafDocument {
  /** 書き手(`STEPCAFControl_Writer` など)へ渡す文書の取っ手。 */
  readonly handle: Handle_TDocStd_Document;
  /** 立体ごとのラベル。並びは渡した一覧と同じ(タスク7b の面ごとの色が使う)。 */
  readonly labels: readonly TDF_Label[];
  /** 色を 1 つでも実際に載せられたか。列挙が取れない環境では false になる。 */
  readonly colorWritten: boolean;
  /** 確保したものを作った順の逆に解放する。2 度呼んでも安全。 */
  delete(): void;
}

/** 組み立ての細かい指定。 */
export interface XcafDocumentOptions {
  /** 色を載せるか(既定 true。§0.a-0.22 で「既定は書き出す」)。 */
  readonly withColors?: boolean;
  /**
   * 確保の控えを外から渡す。渡さなければ自前で 1 つ作る。
   * 検査で「確保の回数と解放の回数が一致すること」を数えるためと、
   * 面ごとの色(タスク7b)が同じ控えを使い回すために開けてある。
   */
  readonly allocations?: Allocations;
}

/** 文書の記憶形式。XCAF の属性を持てる形式で、ファイルへは保存しないので中身は問わない。 */
const STORAGE_FORMAT = 'BinXCAF';

/** 書き出す立体が 1 つも無いとき(NFR-UX-5、計画書 §2.3 の検証表)。 */
const NO_SHAPE_MESSAGE = '書き出せる立体がありません。';

/** 色の値が 0〜1 の数でないとき。呼び出し側の取り違えを黙って通さない。 */
const INVALID_COLOR_MESSAGE = '書き出しの色の値が正しくありません。';

/**
 * 列挙(`Quantity_TypeOfColor`)を引数に取る API のための述語ガード。
 *
 * **これは統括が計画書 P6 §0.a-0.17 と §4 で承認した、P6 で新しく作る唯一の述語ガードの
 * 置き場**である(P3 の `makeFillet.ts`、P4 の `makeOffsetWire.ts`、P5 の `makeShell.ts` /
 * `makeSweep.ts` に続く 5 か所目。着手時に Grep で数えた既存は 4 ファイル・5 関数
 * —— `makeFillet.ts` の `isFilletShape`、`makeOffsetWire.ts` の `isJoinType`、
 * `makeShell.ts` の `isOffsetMode` / `isJoinType`、`makeSweep.ts` の `isTransitionMode`)。
 * `as` / `any` / `@ts-ignore` / `eslint-disable` は 1 つも使っていない。
 *
 * **なぜ要るか:** 色を作れるのは `Quantity_Color_3(c1, c2, c3, theType: Quantity_TypeOfColor)`
 * だけで(`_4` は JavaScript から作れない `NCollection_Vec3<float>` を要求する)、色を載せるのは
 * `SetColor_5(S, Color, type: XCAFDoc_ColorType)` だけ。**列挙を避けられる版が存在しない。**
 * 型定義では列挙の各値が `{}` と宣言されているため、そのまま渡すと型検査が通らない。
 *
 * **この判定が確かめられること:** 「値が null でないオブジェクトであること」だけ。
 * **確かめられないこと(限界):** それが本当に列挙の値かどうか。embind の列挙値は中身の
 * 見えない空のオブジェクトなので、形を見て見分ける手立てが無い。したがってこのガードは
 * 「OCCT の読み込みが済んでいない/壊れている」ことだけを捕まえる網である。
 *
 * **偽のときは落とさず、色なしで書き出す**(計画書 §2.5 の検証表、NFR-RE-1)。
 * 色が付かないことは形が失われることより軽く、書き出し自体を諦める理由にならない。
 *
 * **他の箇所へ広げない。** 別の API で同じ壁に当たったら、写す前に統括へ諮る。
 */
function isTypeOfColor(value: unknown): value is Quantity_TypeOfColor {
  return typeof value === 'object' && value !== null;
}

/**
 * 列挙(`XCAFDoc_ColorType`)を引数に取る API のための述語ガード。
 * 理由・限界・承認の範囲は上の `isTypeOfColor` と同じ(§0.a-0.17 がこの 2 つを
 * `xcafDocument.ts` の 1 か所へ置くことを承認している)。
 */
function isColorType(value: unknown): value is XCAFDoc_ColorType {
  return typeof value === 'object' && value !== null;
}

/** 色を載せるのに要る 2 つの列挙値。 */
interface ColorEnums {
  /** 渡す 3 つの値を「sRGB のまま」と解釈させる指定。 */
  readonly typeOfColor: Quantity_TypeOfColor;
  /** 面の色として載せる指定。 */
  readonly colorType: XCAFDoc_ColorType;
}

/**
 * 色に要る列挙値を取り出す。取れなければ `null`(色なしで書き出す道へ落ちる)。
 *
 * **`Quantity_TOC_sRGB` を選ぶ根拠(2026-09-06 実測、計画書 §1.5-11 の STEP 側の答え):**
 * `#b8bfcc`(= 0.7215686…, 0.7490196…, 0.8)を渡して STEP を書いたところ、
 * - `Quantity_TOC_sRGB`: `COLOUR_RGB('',0.721568617591,0.749019597622,0.800000010877)`
 *   —— **渡した値がそのまま出る**(差は 1e-8 台。OCCT が色を float で持つための丸め)。
 * - `Quantity_TOC_RGB`: `COLOUR_RGB('',0.865876693501,0.880315125789,0.906331759313)`
 *   —— 渡した値を**線形**とみなして sRGB へ直したもの(0.7216 の sRGB 符号化は 0.8659)。
 *
 * STEP の `COLOUR_RGB` は sRGB の値を書く決まりなので、`#rrggbb` を 255 で割った値を
 * そのまま渡せる `Quantity_TOC_sRGB` が正しい。**OBJ / glTF(タスク13)は書き手が違うので、
 * そちらは §1.5-11 のとおり改めて実測する。**
 */
function resolveColorEnums(oc: OpenCascadeInstance): ColorEnums | null {
  // 列挙値はいったん unknown を経由してから述語ガードで絞る(makeShell.ts と同じ書き方)。
  const typeOfColor: unknown = oc.Quantity_TypeOfColor.Quantity_TOC_sRGB;
  const colorType: unknown = oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf;
  if (!isTypeOfColor(typeOfColor) || !isColorType(colorType)) {
    return null;
  }
  return { typeOfColor, colorType };
}

/** 色の 3 つの値が 0〜1 の有限の数であることを確かめる。違えば日本語の理由で断る。 */
function checkColor(color: RgbTuple): void {
  for (const value of color) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(INVALID_COLOR_MESSAGE);
    }
  }
}

/**
 * 立体の一覧から XCAF の文書を 1 つ組み立てる(§2.5)。
 *
 * ```ts
 * const document = buildXcafDocument(oc, [{ shape, name: '本体', color: [0.72, 0.75, 0.8] }]);
 * try {
 *   writer.Perform_2(document.handle, path, range);
 * } finally {
 *   document.delete();
 * }
 * ```
 *
 * 立体が 1 つも無ければ日本語の理由で断る(**空のまま書き手へ渡すと、OCCT はファイルを
 * 1 つも作らずに成功を返す**ため、利用者には「保存できたのに中身が無い」ように見える)。
 */
export function buildXcafDocument(
  oc: OpenCascadeInstance,
  entries: readonly XcafShapeEntry[],
  options: XcafDocumentOptions = {},
): XcafDocument {
  if (entries.length === 0) {
    throw new Error(NO_SHAPE_MESSAGE);
  }
  for (const entry of entries) {
    if (entry.color !== null) {
      checkColor(entry.color);
    }
  }

  const withColors = options.withColors ?? true;
  const palette = withColors ? resolveColorEnums(oc) : null;
  const { keep, release } = options.allocations ?? createAllocations();

  try {
    const format = keep(new oc.TCollection_ExtendedString_2(STORAGE_FORMAT, false));
    // 文書そのものは控えへ積まない(冒頭の注釈 2。Handle が持ち主になる)。
    const doc = new oc.TDocStd_Document(format);
    const handle = keep(new oc.Handle_TDocStd_Document_2(doc));
    const main = keep(doc.Main());
    // `.get()` の戻りは借り物なので控えへ積まない(冒頭の注釈 1)。積むのは Handle だけ。
    const shapeTool = keep(oc.XCAFDoc_DocumentTool.ShapeTool(main)).get();
    const colorTool = keep(oc.XCAFDoc_DocumentTool.ColorTool(main)).get();

    const labels: TDF_Label[] = [];
    let colorWritten = false;
    for (const entry of entries) {
      // makeAssembly = false で平らに積む(§0.a-0.11)。makePrepare = true は
      // 書き手が求める下ごしらえ(部分形状の登録)を OCCT に任せる指定。
      const label = keep(shapeTool.AddShape(entry.shape, false, true));
      labels.push(label);

      if (entry.name !== null && entry.name.length > 0) {
        // 第 2 引数の true は「渡した文字列が多バイト(UTF-8)である」の指定。
        // 日本語の名前が STEP の PRODUCT 行へそのまま出ることを実測で確かめてある。
        const text = keep(new oc.TCollection_ExtendedString_2(entry.name, true));
        keep(oc.TDataStd_Name.Set_1(label, text));
      }

      if (palette !== null && entry.color !== null) {
        const color = keep(
          new oc.Quantity_Color_3(
            entry.color[0],
            entry.color[1],
            entry.color[2],
            palette.typeOfColor,
          ),
        );
        if (colorTool.SetColor_5(entry.shape, color, palette.colorType)) {
          colorWritten = true;
        }
      }
    }

    return { handle, labels, colorWritten, delete: release };
  } catch (error) {
    // 途中で断ったらその場で全部返す(`allocations.ts` の使い方の見本と同じ)。
    release();
    throw error;
  }
}
