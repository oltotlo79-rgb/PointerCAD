import type {
  OpenCascadeInstance,
  STEPCAFControl_Reader,
  TDF_Label,
  TopoDS_Shape,
  XCAFDoc_ColorTool,
} from 'opencascade.js/dist/opencascade.full.js';

import type { SolidBodyKind } from '../types.js';
import type { Allocations } from './allocations.js';
import { createAllocations } from './allocations.js';
import { hasSolid } from './solidMesh.js';
import { withVirtualFileInput } from './virtualFile.js';
import type { RgbTuple } from './xcafDocument.js';

/**
 * STEP の読み込み(計画書 P6 §2.3・§2.4、タスク8。FR-802 / FR-811)。
 *
 * **`STEPCAFControl_Reader` を使う**(書き出しの `STEPCAFControl_Writer` と対)。
 * 素の `STEPControl_Reader` でも形は読めるが、**名前と色は XCAF の文書にしか入らない**。
 * 書き出し(タスク7)が名前と色を書いている以上、読みで捨てるとファイルを往復させた
 * だけで情報が落ちる。`Perform_2(filename, doc, range)` は**列挙を 1 つも取らない**。
 *
 * **単位(FR-811):** 内部は mm 固定(NFR-RE-3)。OCCT は STEP のヘッダの単位
 * (`SI_UNIT` / `CONVERSION_BASED_UNIT`)を読んで、取り込みの単位系へ換算する。
 * その取り込み先の単位は `xstep.cascade.unit`(既定 `MM`)で決まる。
 *
 * ---
 *
 * **実測(2026-09-06、Node の opencascade.js 2.0.0-beta.b5ff984。計画書 §1.5-1、-6):**
 *
 * - 実行時に関数として束縛されているもの: `STEPControl_Reader_1` / `STEPCAFControl_Reader_1` /
 *   `TDF_LabelSequence_1` / `Handle_TDF_Attribute_1` / `TDataStd_Name` / `TDataStd_TreeNode` /
 *   `TCollection_AsciiString_13` / `Quantity_Color_1` / `TColStd_SequenceOfAsciiString_1` /
 *   `Interface_Static`(`.test.ts` の 1 件目が毎回確かめる)。
 * - **§1.5-6 の答え: `SetSystemLengthUnit` を呼んでも呼ばなくても結果は同じ。**
 *   1 inch の箱を単位 INCH の STEP として書いて読むと、**どちらでも体積 16387.064mm³**
 *   (= 25.4³)になった。読み手の `SystemLengthUnit()` は最初から `1`(mm)で、
 *   OCCT がヘッダの `CONVERSION_BASED_UNIT('INCH',…)` を見て 25.4 倍してくれる。
 *   したがって**この実装は `SetSystemLengthUnit` を呼ばず**、代わりに取り込み先の単位を
 *   決める `Interface_Static.SetCVal('xstep.cascade.unit', 'MM')`(既定と同じ値・冪等)を
 *   毎回置き直す。理由: `ChangeReader()` / `Reader()` が返すのは **embind が作った複製**で
 *   (`subShapes.ts` の `FindKey` と同じ性質。取り出して解放しても元の読み手は無事だった)、
 *   複製へ書いた設定が本体へ届く保証が無い一方、`Interface_Static` は静的な設定表で
 *   `CVal` で読み返して確かめられるため。
 * - **`GetFreeShapes(seq)` の out 引数は使える**(§1.5-5)。箱+球の 2 立体を書いた STEP で
 *   `Length()` が 2 になり、`XCAFDoc_ShapeTool.GetShape_2(label)` が体積 12000 と
 *   4188.790205 の形をそれぞれ返した。**`OneShape()` への後退は要らなかった。**
 * - **壊れたバイト列・0 バイトのファイルでも例外は飛ばない。** `Perform_2` が false を返し、
 *   自由な形は 0 個になる。だから断りは戻り値で判定する(NFR-RE-1)。
 * - **名前の取り出しには落とし穴が 2 つある。**
 *   ① `Handle_TDataStd_Name` を `FindAttribute_1` へ渡すと embind が
 *      `BindingError: Expected null or instance of Handle_TDF_Attribute` で断る。
 *      → `Handle_TDF_Attribute_1` で受け、`TDataStd_Name.Restore(...)` で写し取る。
 *   ② `TCollection_ExtendedString` の `ToExtString()` と `Value(i)` は**束縛されていない**
 *      (`UnboundTypeError`)。→ `TCollection_AsciiString_13(ext, 0)` に通す。
 *      第 2 引数 0 は「非 ASCII を置き換えず UTF-8 にする」指定で、`ToCString()` は
 *      その**バイトを 1 バイト 1 文字として並べた文字列**を返す(実測: '箱' が長さ 3 の
 *      'Ã§Â®Â±' に見える)。だから `TextDecoder` で UTF-8 として解き直す。
 * - **立体ごとの色は列挙なしでたどれる**(§0.a-0.17 の述語ガードを増やさずに済む)。
 *   OCCT 7.6 の `XCAFDoc_ColorTool` は色の割り当てを **`TDataStd_TreeNode`** で持つ
 *   (`XCAFDoc_GraphNode` ではない。実測で形のラベルに GraphNode は 1 つも無かった)。
 *   形のラベルの属性を数え上げ、`DynamicType()` の名前が `TDataStd_TreeNode` のものを
 *   写し取り、その**親のラベルが `IsColor` なら**そこから `GetColor_1` で色が読める。
 *   `Quantity_Color` が持つのは線形 RGB なので、`Quantity_Color.Convert_LinearRGB_To_sRGB_1`
 *   で sRGB(`#rrggbb` を 255 で割った値)へ戻す。往復の実測は 1 桁目まで一致した。
 * - **`Reader().FileUnits(...)` でファイルの単位の名前が読める。** mm の STEP は
 *   `['millimetre']`、inch の STEP は `['INCH']`。取り込んだ形の素性(計画書 §2.8 の
 *   `ImportedSource.unit`)へそのまま渡せる。**`Reader()` の複製は必ず解放する**——
 *   解放を忘れると読み込みのたびに読み手 1 つぶんが WASM に残り、続く読み込みが目に見えて
 *   遅くなる(面 504 枚の読み込みが同じ機械で **9,081ms → 2,859ms** に縮んだ)。
 * - 検査用の inch の STEP は `Interface_Static.SetCVal('write.step.unit', 'INCH')` で作れる
 *   (書いたあと必ず `'MM'` へ戻す。設定表は OCCT の実体ごとに 1 つしかない)。
 */

/** 読めなかったとき(壊れている・STEP でない)の断り(計画書 §2.8 の表)。 */
export const STEP_READ_FAILED_MESSAGE =
  'このファイルを読めませんでした。ファイルが壊れているか、対応していない形式です。';

/** 読めたが形が 1 つも入っていなかったときの断り(計画書 §2.8 の表)。 */
export const STEP_NO_SHAPE_MESSAGE = 'このファイルには形が入っていません。';

/** 形はあるが閉じた立体が 1 つも無かったときの断り(§2.8 の「面だけの立体」に対応)。 */
export const STEP_NO_SOLID_MESSAGE =
  'このファイルには立体が入っていません。面だけの形は読み込めません。';

/** 読み込んだ形の長さの単位。`'other'` は mm でも inch でもなかったもの。 */
export type StepFileLengthUnit = 'mm' | 'inch' | 'other';

/** 読み込んだ立体 1 つぶん。形の解放は `StepReadResult.delete()` がまとめて行う。 */
export interface StepReadBody {
  /** 読み込んだ形(mm 換算済み)。呼び出し側は解放しない。 */
  readonly shape: TopoDS_Shape;
  /** ファイルに入っていた名前。無ければ `null`。 */
  readonly name: string | null;
  /** ファイルに入っていた色(sRGB の 0〜1)。無ければ `null`。 */
  readonly color: RgbTuple | null;
  /** 閉じた立体か、面だけの殻か。 */
  readonly kind: SolidBodyKind;
}

/** 読み込みの結果。使い終わったら必ず `delete()` する。 */
export interface StepReadResult {
  /** 立体の一覧。ファイルの中の並び(`GetFreeShapes` の順)。 */
  readonly bodies: readonly StepReadBody[];
  /** ファイルが使っていた長さの単位。中身はすでに mm へ換算してある。 */
  readonly unit: StepFileLengthUnit;
  /** OCCT が読み取った単位の名前そのまま(`['millimetre']` / `['INCH']` など)。 */
  readonly unitNames: readonly string[];
  /** 確保したものを作った順の逆に解放する。2 度呼んでも安全。 */
  delete(): void;
}

/** 読み込みの細かい指定。 */
export interface StepReadOptions {
  /** 仮想ファイルへ置くときの名前(既定 `'import.step'`)。拡張子は残す。 */
  readonly fileName?: string;
  /** 色を読むか(既定 true)。false なら `color` は必ず `null` になる。 */
  readonly withColors?: boolean;
}

/** 文書の記憶形式。XCAF の属性を持てる形式で、ファイルへは保存しないので中身は問わない。 */
const STORAGE_FORMAT = 'BinXCAF';

/**
 * 取り込み先の長さの単位を決める OCCT の設定名と値。
 *
 * 既定が `'MM'` なので置き直しても振る舞いは変わらないが、**同じ OCCT の実体を使う
 * 別の処理(検査で inch の STEP を作るときなど)が書き換えた場合に取りこぼさない**
 * ようにする。設定表は実体ごとに 1 つしかない。
 */
const CASCADE_UNIT_NAME = 'xstep.cascade.unit';
const CASCADE_UNIT_MM = 'MM';

/** `TCollection_AsciiString` へ写すときの「非 ASCII を置き換えない(= UTF-8 にする)」指定。 */
const KEEP_NON_ASCII = 0;

/**
 * `ToCString()` が返す「1 バイト 1 文字」の文字列を UTF-8 として解き直す。
 *
 * 文字コードがすべて 0〜255 のときだけバイト列とみなす。1 文字でも 256 以上が
 * 混ざっていれば、すでに文字列として解けているとみなしてそのまま返す
 * (embind の文字列の扱いが将来変わっても壊れないようにするため)。
 */
function decodeCString(raw: string): string {
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (code > 0xff) {
      return raw;
    }
    bytes[index] = code;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * ラベルに付いた名前を読む。無ければ `null`。
 *
 * `FindAttribute_1` は `Handle_TDF_Attribute` しか受け取らない(冒頭の実測 ①)ので、
 * いったんそれで受けてから、空の `TDataStd_Name` へ `Restore` で写し取る。
 * `Restore` は「同じ種類の属性から中身を写す」OCCT の常道で、強制変換を使わずに
 * 派生した型のメソッド(`Get()`)へ辿り着ける唯一の道である。
 */
function readLabelName(
  oc: OpenCascadeInstance,
  label: TDF_Label,
  keep: Allocations['keep'],
): string | null {
  const attribute = keep(new oc.Handle_TDF_Attribute_1());
  if (!label.FindAttribute_1(oc.TDataStd_Name.GetID(), attribute)) {
    return null;
  }
  const holder = keep(new oc.TDataStd_Name());
  holder.Restore(attribute);
  const text = keep(holder.Get());
  const ascii = keep(new oc.TCollection_AsciiString_13(text, KEEP_NON_ASCII));
  const decoded = decodeCString(ascii.ToCString());
  return decoded.length === 0 ? null : decoded;
}

/**
 * ラベルに割り当てられた色を読む。無ければ `null`。
 *
 * 色の割り当ては `TDataStd_TreeNode` の親子で表されている(冒頭の実測)。
 * 形のラベルに付いた木の節を 1 つずつ見て、**親のラベルが色のラベルなら**その色を返す。
 * 種類(面の色 / 線の色 / 一般)を区別する `XCAFDoc_ColorType` は列挙なので使わない
 * ——親が色かどうかは `IsColor` で確かめられ、区別しなくても「その立体の色」は決まる。
 */
function readLabelColor(
  oc: OpenCascadeInstance,
  colorTool: XCAFDoc_ColorTool,
  label: TDF_Label,
  keep: Allocations['keep'],
): RgbTuple | null {
  const iterator = keep(new oc.TDF_AttributeIterator_2(label, true));
  while (iterator.More()) {
    const held = keep(iterator.Value());
    const type = keep(held.get().DynamicType()).get();
    if (type.SubType_2('TDataStd_TreeNode')) {
      const node = keep(new oc.TDataStd_TreeNode());
      node.Restore(held);
      if (node.HasFather()) {
        const owner = keep(keep(node.Father()).get().Label());
        if (colorTool.IsColor(owner)) {
          const color = keep(new oc.Quantity_Color_1());
          if (colorTool.GetColor_1(owner, color)) {
            // Quantity_Color が持つのは線形 RGB。`#rrggbb` を 255 で割った値
            // (= sRGB)へ戻してから返す(xcafDocument.ts の書き出しと同じ約束)。
            return [
              oc.Quantity_Color.Convert_LinearRGB_To_sRGB_1(color.Red()),
              oc.Quantity_Color.Convert_LinearRGB_To_sRGB_1(color.Green()),
              oc.Quantity_Color.Convert_LinearRGB_To_sRGB_1(color.Blue()),
            ];
          }
        }
      }
    }
    iterator.Next();
  }
  return null;
}

/** OCCT が読み取った単位の名前を、内部で使う 3 通りへ畳む。 */
function classifyUnit(names: readonly string[]): StepFileLengthUnit {
  const first = (names[0] ?? '').trim().toLowerCase();
  if (first === 'mm' || first === 'millimetre' || first === 'millimeter') {
    return 'mm';
  }
  if (first === 'in' || first === 'inch') {
    return 'inch';
  }
  return 'other';
}

/** ファイルが使っていた長さの単位の名前を読む(読み込みのあとで呼ぶ)。 */
function readUnitNames(
  oc: OpenCascadeInstance,
  reader: STEPCAFControl_Reader,
  keep: Allocations['keep'],
): string[] {
  const lengths = keep(new oc.TColStd_SequenceOfAsciiString_1());
  const angles = keep(new oc.TColStd_SequenceOfAsciiString_1());
  const solidAngles = keep(new oc.TColStd_SequenceOfAsciiString_1());
  // `Reader()` の戻りは embind が作った複製(`subShapes.ts` の `FindKey` と同じ性質)。
  // 2026-09-06 に「3 回続けて取り出して解放し、そのあと元の読み手も解放する」で
  // 落ちないことを確かめてあるので、控えへ積んで必ず返す(積まないと 1 回の読み込みごとに
  // 読み手の複製が残る)。取り出した複製でも `NbShapes()` は元と同じ値を返す。
  const inner = keep(reader.Reader());
  inner.FileUnits(lengths, angles, solidAngles);
  const names: string[] = [];
  const count = Number(lengths.Length());
  for (let index = 1; index <= count; index += 1) {
    names.push(decodeCString(keep(lengths.Value(index)).ToCString()));
  }
  return names;
}

/**
 * STEP のバイト列を読んで、立体の一覧を返す(§2.3、FR-802 / FR-811)。
 *
 * ```ts
 * const read = readStep(oc, bytes);
 * try {
 *   for (const body of read.bodies) { ... }   // body.shape は mm
 * } finally {
 *   read.delete();
 * }
 * ```
 *
 * 読めなかったとき・形が無いとき・閉じた立体が 1 つも無いときは**日本語の理由**で断る
 * (NFR-RE-1。呼び出し側は例外を受けて断りの文言をそのまま見せられる)。
 * 仮想ファイルは `withVirtualFileInput` が必ず片付ける(§2.2)。
 */
export function readStep(
  oc: OpenCascadeInstance,
  bytes: Uint8Array,
  options: StepReadOptions = {},
): StepReadResult {
  const fileName = options.fileName ?? 'import.step';
  const withColors = options.withColors ?? true;

  // 取り込み先の単位を mm に固定する(冒頭の実測。既定と同じ値なので冪等)。
  oc.Interface_Static.SetCVal(CASCADE_UNIT_NAME, CASCADE_UNIT_MM);

  return withVirtualFileInput(oc, fileName, bytes, (path) => {
    const { keep, release } = createAllocations();
    try {
      const format = keep(new oc.TCollection_ExtendedString_2(STORAGE_FORMAT, false));
      // 文書そのものは控えへ積まない(Handle が持ち主になる。xcafDocument.ts の注釈 2)。
      const doc = new oc.TDocStd_Document(format);
      const handle = keep(new oc.Handle_TDocStd_Document_2(doc));

      const reader = keep(new oc.STEPCAFControl_Reader_1());
      reader.SetColorMode(withColors);
      reader.SetNameMode(true);
      const range = keep(new oc.Message_ProgressRange_1());
      if (!reader.Perform_2(path, handle, range)) {
        // 壊れたバイト列でも例外は飛ばず false が返る(冒頭の実測)。
        throw new Error(STEP_READ_FAILED_MESSAGE);
      }

      const unitNames = readUnitNames(oc, reader, keep);

      const main = keep(doc.Main());
      // `.get()` の戻りは借り物なので控えへ積まない。積むのは Handle だけ。
      const shapeTool = keep(oc.XCAFDoc_DocumentTool.ShapeTool(main)).get();
      const colorTool = keep(oc.XCAFDoc_DocumentTool.ColorTool(main)).get();

      const labels = keep(new oc.TDF_LabelSequence_1());
      shapeTool.GetFreeShapes(labels);
      const count = Number(labels.Length());
      if (count === 0) {
        throw new Error(STEP_NO_SHAPE_MESSAGE);
      }

      const bodies: StepReadBody[] = [];
      let solidFound = false;
      for (let index = 1; index <= count; index += 1) {
        const label = keep(labels.Value(index));
        const shape = keep(oc.XCAFDoc_ShapeTool.GetShape_2(label));
        const solid = hasSolid(oc, shape);
        solidFound = solidFound || solid;
        bodies.push({
          shape,
          name: readLabelName(oc, label, keep),
          color: withColors ? readLabelColor(oc, colorTool, label, keep) : null,
          kind: solid ? 'solid' : 'shell',
        });
      }
      if (!solidFound) {
        throw new Error(STEP_NO_SOLID_MESSAGE);
      }

      return { bodies, unit: classifyUnit(unitNames), unitNames, delete: release };
    } catch (error) {
      // 途中で断ったらその場で全部返す(`allocations.ts` の使い方の見本と同じ)。
      release();
      throw error;
    }
  });
}
