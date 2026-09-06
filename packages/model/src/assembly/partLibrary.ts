/**
 * アセンブリが抱き込んだ部品文書の出し入れと内容ハッシュ
 * (計画書 docs/plans/P7-アセンブリ.md §2.3、タスク4。FR-601、要件§8)。
 *
 * 要件§8 は「参照部品はアセンブリファイルに相対パス+内容ハッシュで記録(欠損時は警告)」と
 * 定める。その 3 つ(どのファイルから・いつ・どの中身を取り込んだか)を持つのがこのファイルで、
 * **部品の形(B-rep・メッシュ)は 1 バイトも持たない**(§0.a-0.4。形は開くたびに部品ごとに
 * 1 回だけ作り直し、全インスタンスで使い回す)。
 *
 * **抱き込んだ文書はアセンブリ文書の中に入らない。** `AssemblyDocument` が持つのは
 * 「どの `partRef` を置いたか」(`ComponentSource`)だけで、文書そのものと素性は
 * ZIP の別エントリ(`parts/<ref>.json`)と封筒の `partFiles` に入る(§2.2)。
 * その 2 つを 1 つにまとめた入れ物が `PartLibrary` で、**アセンブリ文書と対で持ち回る。**
 * こう分けておくと、部品を差し替えてもアセンブリ文書(Undo の単位)が変わらない場合と
 * 変わる場合を取り違えずに済む。
 *
 * **元のファイルを追いかける判断はここでしない。** `staleParts` が「中身が違う `partRef`」を
 * 数えて返すだけで、「部品が更新されています。取り込み直しますか。」「元のファイルが
 * 見つかりません。取り込んだ形で開いています。」の文言と、**どちらでも読み込みを止めない**
 * 決めごとは上の層(P7 タスク5・6 の ui)が持つ(§2.3、§2.12)。
 */

import type { PartDocument } from '../part/types.js';
import { nextSerialId } from '../sketch/createSketchDocument.js';

/**
 * 抱き込んだ部品 1 つの素性(要件§8)。
 *
 * **`packages/io` の `PcadPartFile` と欄が 1 つ 1 つ同じ**なので、model の側で作った配列を
 * そのまま `writePcadaFile` へ渡せる(構造で合う)。同じ形を 2 か所に書いているのは
 * 依存の向き(`io → model`)のためで、io から model の型を参照するように寄せるのは
 * P7 タスク3 の担当と統括の判断に委ねる(そのときはこちらが正本になる)。
 */
export interface EmbeddedPartFile {
  /** ZIP の中の名前。`parts/<ref>.json` の `<ref>` で、`ComponentSource.partRef` が指す。 */
  readonly ref: string;
  /** 取り込んだときのファイル名(利用者へ見せる)。 */
  readonly fileName: string;
  /** アセンブリのファイルから見た相対パス(要件§8)。 */
  readonly path: string;
  /** 抱き込んだ文書の内容ハッシュ(`contentHashOf` が作る)。 */
  readonly contentHash: string;
  /** 取り込んだ時刻(ISO 8601、UTC)。 */
  readonly importedAt: string;
}

/**
 * 抱き込んだ部品の一式。`partFiles`(素性の並び)と `parts`(`ref` → 文書)の対で、
 * **同じ `ref` の組が必ず両方にそろっている**ことをこのファイルの関数が守る。
 *
 * 並び順は取り込んだ順のまま保つ(`.pcada` へ書くときの並べ替えは io が名前順で行うので、
 * ここで並べ替えると同じことを 2 か所で決めることになる)。
 */
export interface PartLibrary {
  readonly partFiles: readonly EmbeddedPartFile[];
  readonly parts: ReadonlyMap<string, PartDocument>;
}

/** 何も抱き込んでいない一式。新しいアセンブリはここから始まる。 */
export const EMPTY_PART_LIBRARY: PartLibrary = { partFiles: [], parts: new Map() };

/** 抱き込んだ部品文書の `ref` の接頭辞。`part-1`、`part-2`、…(§2.2 の例と同じ綴り)。 */
export const PART_REF_PREFIX = 'part-';

/** 内容ハッシュの計算に使う要約の種類。**変えると既存のファイルの `contentHash` が全部変わる。** */
export const CONTENT_HASH_ALGORITHM = 'SHA-256';

/*
  決定的な文字列化。

  `crypto.subtle.digest` はバイト列しか受け取らないので、部品文書を先に文字列にする。
  そのとき **同じ中身からは必ず同じ文字列**が出ないと、保存し直しただけで「部品が
  更新されています」と誤って知らせてしまう。素の `JSON.stringify` は欄の並び順を
  そのまま出す(作り方が違えば違う文字列になる)ので、**鍵を並べ替えてから書く**。

  `packages/io` の `serializeDocument` を呼べれば 1 か所で済むが、依存の向きが
  `io → model` なので model からは呼べない(`rules/04`)。そこでここに決定的な写しを持つ。
  **io の文字列と 1 バイト同じにする必要はない**——このハッシュは model の中だけで作って
  model の中だけで比べるものだからである(io が書く `parts/<ref>.json` は封筒つきで
  `savedAt` を含むため、そもそも保存のたびに変わる。ハッシュの対象は封筒ではなく
  **文書そのもの**である、というのがこの分け方の要点)。

  欄を 1 つ 1 つ書き写す形にしないのは、`PartDocument` に欄が増えるたびにここを直し忘れると
  **中身が変わってもハッシュが変わらない**という一番まずい壊れ方をするためである。
  鍵を並べ替えるだけの写しなら、欄が増えても自動で対象に入る。
*/

/** `Record<string, unknown>` かどうか(配列と `null` は除く)。`unknown` から `any` へ落とさない。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 読み取り専用の配列かどうか。`Array.isArray` の絞り込みが `any[]` になるのを避ける。 */
function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * 値 1 つを決定的な JSON の文字列にする。
 *
 * - オブジェクトの鍵は**辞書順**に並べ替える(欄の順序だけが違う同じ内容が同じ文字列になる)。
 * - 配列の順序は**そのまま**(履歴の順序は意味を持つ。FR-501)。
 * - `undefined` の欄は書かない(`JSON.stringify` と同じ扱い。省略できる欄がある)。
 * - 数値は `JSON.stringify` に任せる(`-0` は `0`、往復できる最短の表記で機種に依らない)。
 */
function canonicalTextOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (isArray(value)) {
    return `[${value.map((item) => canonicalTextOf(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    const parts: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      // 値の無い欄は鍵ごと書かない(書くと `{"a":undefined}` が JSON にならない)。
      if (child === undefined) {
        continue;
      }
      parts.push(`${JSON.stringify(key)}:${canonicalTextOf(child)}`);
    }
    return `{${parts.join(',')}}`;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  // 関数・シンボル・undefined は文書に入らない。入っていたら「無いもの」として書く。
  return 'null';
}

/**
 * 部品文書を決定的な 1 本の文字列にする(ハッシュの対象。**封筒は含まない**)。
 *
 * 輸出しているのは、`packages/io` の検査から「書いた `parts/<ref>.json` を読み直しても
 * この文字列が変わらない」ことを確かめられるようにするため(P7 タスク3 への申し送り)。
 */
export function canonicalPartDocumentText(document: PartDocument): string {
  return canonicalTextOf(document);
}

/** バイト列を 16 進の小文字にする。 */
function hexTextOf(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, '0');
  }
  return text;
}

/**
 * 部品文書の内容ハッシュ(要件§8)。SHA-256 の 16 進 64 文字。
 *
 * **計算はこの 1 か所だけ**(手順 2 の決め)。`crypto.subtle.digest` は約束(Promise)を返すので
 * この関数と、これを使う `embedPart` / `replacePartDocument` も約束を返す。同期にできるのは
 * 比べるだけの `staleParts` と、取り出すだけの `partOf` である。
 *
 * `crypto.subtle` が使える根拠(2026-09-06 実測、§1.5-24):
 * Node の Vitest(v25.9.0)で `globalThis.crypto.subtle.digest` が働くことを確かめた。
 * ブラウザと Worker では**安全なコンテキスト**でだけ使えるが、この製品は Web 版が
 * `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` を立てた配信、デスクトップ版が
 * `app://` スキーム(`apps/desktop/src/main/appProtocol.ts` の `secure: true`)なので、
 * どちらも安全なコンテキストである(そうでなければ既存の `SharedArrayBuffer` も動かない)。
 * Worker は作った側のコンテキストを継ぐので同じく使える。
 */
export async function contentHashOf(document: PartDocument): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalPartDocumentText(document));
  const digest = await crypto.subtle.digest(CONTENT_HASH_ALGORITHM, bytes);
  return hexTextOf(new Uint8Array(digest));
}

/** 次に抱き込む部品の `ref`。既存の最大連番 + 1 で、**消しても番号を再利用しない**(§0.a-0.19)。 */
export function nextPartRef(library: PartLibrary): string {
  return nextSerialId(
    library.partFiles.map((partFile) => partFile.ref),
    PART_REF_PREFIX,
  );
}

/** 抱き込んだ部品文書を取り出す。知らない `ref` なら `undefined`(例外を投げない)。 */
export function partOf(library: PartLibrary, partRef: string): PartDocument | undefined {
  return library.parts.get(partRef);
}

/** 抱き込んだ部品の素性を取り出す。知らない `ref` なら `undefined`。 */
export function partFileOf(library: PartLibrary, partRef: string): EmbeddedPartFile | undefined {
  return library.partFiles.find((partFile) => partFile.ref === partRef);
}

/** 取り込みの時刻を検査から固定するための口(既定は今の時刻)。 */
export interface EmbedPartOptions {
  /** 取り込んだ時刻(ISO 8601、UTC)。 */
  readonly importedAt?: string;
}

/** `embedPart` の結果。`partRef` は**置く側(`ComponentSource`)がそのまま使う名前**。 */
export interface EmbedPartResult {
  readonly library: PartLibrary;
  readonly partRef: string;
  /**
   * 同じ中身をすでに抱き込んでいたので**既存の `partRef` を返した**とき真。
   * このとき `library` は渡したものと同じ(何も増えない)。
   */
  readonly reused: boolean;
}

/**
 * 部品文書を抱き込む(FR-601、要件§8)。
 *
 * **同じ部品文書を 2 回抱き込まない。** 内容ハッシュが同じものがすでにあれば、その
 * `partRef` を返して一式は増やさない(同じ部品を 2 個置いても形は 1 つ、§0.a-0.8)。
 * このとき**取り込み元のファイル名と相対パスは最初のものを残す**——中身が同じなら
 * どちらから取り込んでも開いた結果は変わらず、後から来たほうで上書きすると、
 * 先に取り込んだ部品を指していた「元のファイル」の追いかけ先が黙って変わってしまうため。
 */
export async function embedPart(
  library: PartLibrary,
  document: PartDocument,
  fileName: string,
  path: string,
  options: EmbedPartOptions = {},
): Promise<EmbedPartResult> {
  const contentHash = await contentHashOf(document);
  const existing = library.partFiles.find((partFile) => partFile.contentHash === contentHash);
  if (existing !== undefined) {
    return { library, partRef: existing.ref, reused: true };
  }
  const ref = nextPartRef(library);
  const parts = new Map(library.parts);
  parts.set(ref, document);
  return {
    library: {
      partFiles: [
        ...library.partFiles,
        {
          ref,
          fileName,
          path,
          contentHash,
          importedAt: options.importedAt ?? new Date().toISOString(),
        },
      ],
      parts,
    },
    partRef: ref,
    reused: false,
  };
}

/**
 * 抱き込んだ部品文書を差し替える(§0.a-0.11。「部品を別窓で直して戻る」と、
 * 元のファイルが更新されていたときの「取り込み直す」の 2 つがこれを通る)。
 *
 * **内容ハッシュと取り込み時刻を更新する**(中身が変わったのだから、どちらも新しくなる)。
 * ファイル名と相対パスは変えない——差し替えても「どのファイルから取り込んだか」は同じである。
 *
 * 知らない `ref` を渡されたら**何もせず元の一式を返す**(例外を投げない。NFR-RE-1)。
 * 差し替えた結果が別の `ref` と同じ中身になっても**まとめない**——置いた部品
 * (`ComponentSource.partRef`)がその `ref` を指しているので、消すと参照が切れるためである。
 *
 * **合致の選び直し**(§2.11)はここではしない。部品の形が変われば部分形状の指紋が動くので、
 * 呼んだ側が P7 タスク38 の選び直しを続けて通す(このファイルは文書の出し入れだけを持つ)。
 */
export async function replacePartDocument(
  library: PartLibrary,
  partRef: string,
  next: PartDocument,
  options: EmbedPartOptions = {},
): Promise<PartLibrary> {
  if (!library.parts.has(partRef)) {
    return library;
  }
  const contentHash = await contentHashOf(next);
  const importedAt = options.importedAt ?? new Date().toISOString();
  const parts = new Map(library.parts);
  parts.set(partRef, next);
  return {
    partFiles: library.partFiles.map((partFile) =>
      partFile.ref === partRef ? { ...partFile, contentHash, importedAt } : partFile,
    ),
    parts,
  };
}

/**
 * 元のファイルのほうが変わっている部品を数える(要件§8、§2.3)。
 *
 * `hashesOnDisk` は「`partRef` → いま元のファイルから作った内容ハッシュ」。
 * **中身が違うものだけ**を取り込んだ順に返す。
 *
 * **元のファイルが読めなかったものは `hashesOnDisk` に入れない**(呼んだ側が入れない)。
 * 「見つからない」と「更新されている」は利用者へ出す文言が違い(§2.12)、
 * どちらでも読み込みを止めないからである。ここに載っていない `ref` は数に入れない。
 */
export function staleParts(
  library: PartLibrary,
  hashesOnDisk: ReadonlyMap<string, string>,
): readonly string[] {
  const stale: string[] = [];
  for (const partFile of library.partFiles) {
    const onDisk = hashesOnDisk.get(partFile.ref);
    if (onDisk !== undefined && onDisk !== partFile.contentHash) {
      stale.push(partFile.ref);
    }
  }
  return stale;
}
