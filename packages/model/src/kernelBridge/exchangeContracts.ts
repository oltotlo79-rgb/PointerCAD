/** exchange data exchanged through the model's kernel bridge. Types only; no Worker lifetime. */
import type {
  ExportMeshQuality,
} from '../exchange/types.js';


/* ------------------------------------------------------------------ *
 * 書き出しと読み込み(FR-802〜804、FR-811、P6 タスク32b)
 * ------------------------------------------------------------------ */

/**
 * 色 1 つ(sRGB の 0〜1)。`exchange/exportColors.ts` の `rgbTupleOf` が返す並びそのままで、
 * kernel の `RgbTuple` と欄が同じ。
 *
 * **model にも名前を置くのは、`packages/ui` が kernel の型を輸入できないから**である
 * (依存の向きは `ui → model → kernel`、rules/04)。書き出しの依頼を組み立てるのは ui なので、
 * ui が読める言葉で受ける口をここに置く(`exchange/types.ts` の `ExportMeshQuality` と同じ理由)。
 */
export type ExportColor = readonly [number, number, number];

/**
 * 書き出す立体 1 つ(model の言葉)。
 *
 * **形も段の鍵も渡さない。** 立体は「それを作ったフィーチャーの id」で指し、鍵
 * (`ResolvedSolidStep.key`)への引き直しは `KernelBridge.exportShapes` が行う
 * (測定の `MeasureTarget` とまったく同じ流儀、§0.a-0.5)。
 *
 * 名前と色は**ファイルへ書き込む値**で、履歴の名前と外観の割り当て(`bodyColorsFor` /
 * `faceColorsFor`)から呼び出し側が組む。**色を書かない指定のときは `null` と省略で渡す**
 * ——形式ごとに「色を書くか」の欄を持つのは STEP だけなので、ほかの形式では
 * 値そのものを空にするのが色を落とす唯一の手立てである(§0.a-0.22)。
 */
export interface ShapeExportBody {
  /** 書き出す立体を作ったフィーチャーの id(= ボディの id)。 */
  readonly featureId: string;
  /** 立体の名前。`null` なら幾何カーネルの既定になる。 */
  readonly name: string | null;
  /** 立体の色。`null` なら色を付けない。 */
  readonly color: ExportColor | null;
  /**
   * 面ごとの色(面の通し番号 → 色。§2.5.1)。**面の割り当ては立体の色より優先する。**
   * 色を付けた面が 1 枚も無い立体では省く(空の表を作らない)。
   */
  readonly faceColors?: ReadonlyMap<number, ExportColor>;
}

/**
 * 書き出しの形式(幾何カーネルの言葉)。**3MF だけ `'mesh'`** で、三角形までを受け取って
 * ZIP と XML は `packages/io` が組む(§0.a-0.19。io は幾何カーネルを呼べない)。
 */
export type ShapeExportFormat = 'step' | 'stl' | 'obj' | 'gltf' | 'mesh';

/** 書き出しの依頼(model の言葉)。 */
export interface ShapeExportOptions {
  readonly partId?: string;
  readonly format: ShapeExportFormat;
  /** 書き出す立体。並びがそのままファイルの中の並びになる。 */
  readonly bodies: readonly ShapeExportBody[];
  /** 三角形の細かさの対(§0.a-0.64)。三角形を使わない形式(STEP)では `null`。 */
  readonly meshQuality: ExportMeshQuality | null;
  /** 色を書くか(§0.a-0.22)。**効くのは STEP だけ**(ほかは `color` を空にして落とす)。 */
  readonly withColors: boolean;
  /** STL を文字で書くか(§0.a-0.14)。STL 以外では見ない。 */
  readonly ascii: boolean;
  /** ファイル名の基(拡張子なし)。`.obj` と `.mtl` は同じ基を使う(§0.a-0.16)。 */
  readonly baseName: string;
}

/**
 * 書き出したファイル 1 つ。**名前を変えずにそのまま保存する。**
 * `.obj` の材質の行が `.mtl` を名前で指しているので、変えると色が付かない(§2.4)。
 */
export interface ExportedFile {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

/** 書き出した立体 1 つぶんの三角形(3MF のときだけ返る。§0.a-0.19)。 */
export interface ExportedMeshBody {
  /** 依頼に入れた名前をそのまま返す(io が 3MF の物体の名前に使う)。 */
  readonly name: string | null;
  /** 依頼に入れた色をそのまま返す。 */
  readonly color: ExportColor | null;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

/**
 * 書き出しの結果。**断りは投げずに `kind: 'failed'` で返す**(測定と同じ流儀)。
 * 理由の日本語は幾何カーネルが持っているものをそのまま持ち回る(FR-504、NFR-RE-1)。
 */
export type ShapeExportOutcome =
  | {
      readonly kind: 'files';
      /** 保存するファイル。STEP は `[.step]`、OBJ は `[.obj, .mtl]`、glTF は `[.glb]`。 */
      readonly files: readonly ExportedFile[];
      /** 面積 0 で落とした三角形の枚数。三角形を使わない形式では 0。 */
      readonly droppedTriangleCount: number;
    }
  | { readonly kind: 'meshes'; readonly bodies: readonly ExportedMeshBody[] }
  | { readonly kind: 'failed'; readonly message: string };

/** 読み込みの依頼(model の言葉)。3MF は `packages/io` が読むのでここには入らない。 */
export interface ShapeImportOptions {
  readonly format: 'step' | 'stl' | 'obj' | 'gltf';
  /** 仮想ファイルに付ける名前。中身の判別には使われない。 */
  readonly fileName: string;
  readonly bytes: Uint8Array;
  /** 色を読むか(効くのは STEP だけ。省くと読む)。 */
  readonly withColors?: boolean;
}

/** 読み込んだ三角形の形の中身(`.pcad` の `meshes/<id>.bin` へそのまま入る並び)。 */
export interface ImportedTriangles {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

/** 読み込んだ立体 1 つに共通する欄。 */
export interface ImportedBodyCommon {
  /** ファイルに入っていた名前。無ければ `null`。 */
  readonly name: string | null;
  /** ファイルに入っていた色。無ければ `null`(当面は使わない。§0.a-0.28)。 */
  readonly color: ExportColor | null;
  /** 体積(mm³)。 */
  readonly volume: number;
  /** 画面用の三角形の枚数。 */
  readonly triangleCount: number;
}

/**
 * 読み込んだ立体 1 つ(FR-802、§2.8)。**B-rep を持つ枝と三角形だけの枝を型で分ける。**
 * 「無い値に `null` を入れる」形にすると、受け取る側が確かめ忘れても型検査が助けない
 * (kernel の `ShapeImportBody` と同じ分け方)。
 */
export type ImportedBody =
  | (ImportedBodyCommon & {
      readonly bodyKind: 'solid' | 'shell' | 'mixed';
      /** `.pcad` の `shapes/<id>.brep` へそのまま入れるバイト列。 */
      readonly brepBytes: Uint8Array;
    })
  | (ImportedBodyCommon & {
      readonly bodyKind: 'mesh';
      /** `.pcad` の `meshes/<id>.bin` へ入れる三角形。 */
      readonly mesh: ImportedTriangles;
    });

/**
 * 読み込みの結果(FR-802、FR-811)。**座標はすでに mm へ換算済み**(NFR-RE-3)で、
 * `unit` は「ファイルが何で書かれていたか」の記録である。`'other'`(STL / OBJ)のときは
 * 呼び出し側が利用者へ訊く(§0.a-0.6)。
 */
export type ShapeImportOutcome =
  | {
      readonly kind: 'imported';
      readonly bodies: readonly ImportedBody[];
      readonly unit: 'mm' | 'inch' | 'other';
    }
  | { readonly kind: 'failed'; readonly message: string };
