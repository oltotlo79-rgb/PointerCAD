/**
 * `.pcad` の ZIP コンテナの読み書き(計画書 docs/plans/P2-ソリッド基礎.md タスク15、要件§8、FR-801)。
 *
 * `.pcad` は ZIP で、中に次の 2 つだけを入れる。
 *  - `document.json` … 部品文書の封筒(documentJson.ts が作る文字列を UTF-8 にしたもの)。圧縮する。
 *  - `thumbnail.png` … 画面の縮小画像。作れなければ入れない(§0.a-0.18)。PNG は既に圧縮済みなので無圧縮で入れる。
 *
 * **決定的にする。** 同じ部品文書と同じ保存時刻からは、いつ・どの計算機で書き出しても
 * 同じバイト列ができる。ZIP のヘッダには「ファイルの最終更新日時」を書く欄があり、
 * 何も指定しないと fflate が実行時の時刻を入れてしまうので、固定の日時を渡す。
 * 保存した時刻は `document.json` の `savedAt` に入っているので、ZIP のほうの日時は
 * 意味を持たせずに固定してよい。日時を固定するとバイト列が計算機の時計にも時間帯にも
 * 左右されなくなり、「中身が同じなら同じファイル」を検査で確かめられる。
 *
 * 固定値は 1980-01-02 12:00(その計算機の時間帯での時刻)。ZIP の日時欄は 1980 年から
 * 2107 年までしか表せず、fflate は範囲外だと例外を投げる。1980-01-01 だと時間帯によっては
 * 1979 年になってしまうため 1 日ずらし、夏時間の切り替えを避けるため正午にしている。
 *
 * 読み込みは**例外を外へ出さない**(NFR-RE-1)。ZIP でない・`document.json` が無い・
 * 中身が壊れている、のいずれも日本語の理由を添えて返す(FR-504)。
 * 他のアプリが作った圧縮済みの ZIP も読める(fflate が deflate を解ける)。
 */

import type { PartDocument } from '@pointercad/model';
import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped, type Zippable } from 'fflate';

import { parseDocument, serializeDocument, type ParseErrorCode } from './documentJson.js';

/** 部品文書を入れる ZIP のエントリ名(要件§8)。 */
export const PCAD_DOCUMENT_ENTRY = 'document.json';
/** サムネイルを入れる ZIP のエントリ名(要件§8)。 */
export const PCAD_THUMBNAIL_ENTRY = 'thumbnail.png';

/**
 * ZIP のヘッダへ書く固定の日時。年・月・日・時・分・秒がそのまま書かれるので、
 * 時間帯に依らず同じ値になるよう、実行環境の時間帯での日時として組み立てる。
 *
 * **3MF の書き出し(`threemf/writeThreeMf.ts`)も同じ値を使う**(計画書 P6 §2.6。
 * 決定性の決めを 2 か所に書かないため)ので、このファイルから輸出している。
 */
export const FIXED_ENTRY_MTIME = new Date(1980, 0, 2, 12, 0, 0, 0);

/** `document.json` の圧縮の強さ。6 は fflate の既定で、速さと大きさの釣り合いが良い。 */
const DOCUMENT_LEVEL = 6;
/** `thumbnail.png` の圧縮の強さ。PNG は既に圧縮済みなので、掛け直さない。 */
const THUMBNAIL_LEVEL = 0;

export interface WritePcadFileOptions {
  /** 保存時刻(ISO 8601)。検査で時刻を固定するための口。既定は今の時刻。 */
  readonly savedAt?: string;
  /** サムネイルの PNG。作れなかったときは渡さない(そのときは ZIP へ入れない)。 */
  readonly thumbnailPng?: Uint8Array;
}

/**
 * 部品文書(と、あればサムネイル)を `.pcad` のバイト列にする。
 * 例外を投げない。TypedArray と純データしか扱わない。
 */
export function writePcadFile(
  document: PartDocument,
  options: WritePcadFileOptions = {},
): Uint8Array {
  const text = serializeDocument(document, { savedAt: options.savedAt });
  const documentEntry = strToU8(text);
  const entries: Zippable =
    options.thumbnailPng === undefined
      ? {
          [PCAD_DOCUMENT_ENTRY]: [documentEntry, { level: DOCUMENT_LEVEL, mtime: FIXED_ENTRY_MTIME }],
        }
      : {
          [PCAD_DOCUMENT_ENTRY]: [documentEntry, { level: DOCUMENT_LEVEL, mtime: FIXED_ENTRY_MTIME }],
          [PCAD_THUMBNAIL_ENTRY]: [
            options.thumbnailPng,
            { level: THUMBNAIL_LEVEL, mtime: FIXED_ENTRY_MTIME },
          ],
        };
  return zipSync(entries);
}

/**
 * 読み込めなかった理由。`notZip` と `missingDocument` はこの層で見つけたもの、
 * それ以外は `document.json` の読み手(documentJson.ts)の理由をそのまま通したもの。
 */
export type ReadPcadFileErrorCode = ParseErrorCode | 'notZip' | 'missingDocument';

/** 読み込めなかった理由。`message` はそのまま利用者へ見せる日本語(NFR-UX-5)。 */
export interface ReadPcadFileError {
  readonly code: ReadPcadFileErrorCode;
  readonly message: string;
}

export type ReadPcadFileResult =
  | {
      readonly ok: true;
      readonly document: PartDocument;
      readonly savedAt: string;
      /** サムネイルが入っていたときだけ付く。 */
      readonly thumbnailPng?: Uint8Array;
    }
  | { readonly ok: false; readonly error: ReadPcadFileError };

const NOT_ZIP_MESSAGE = 'ファイルを開けませんでした。壊れているかもしれません。';
const MISSING_DOCUMENT_MESSAGE =
  'PointerCAD のファイルではないようです(document.json が入っていません)。';

function fail(code: ReadPcadFileErrorCode, message: string): ReadPcadFileResult {
  return { ok: false, error: { code, message } };
}

/** ZIP を展開する。ZIP でなければ fflate が例外を投げるので、ここで受け止めて null にする。 */
function unzip(bytes: Uint8Array): Unzipped | null {
  try {
    return unzipSync(bytes);
  } catch {
    return null;
  }
}

/**
 * エントリを取り出す。`Unzipped` は「どんな名前でも引ける」型なので、
 * 名前が実際に入っているかを `in` で確かめてから取り出す。
 */
function findEntry(entries: Unzipped, name: string): Uint8Array | null {
  return name in entries ? entries[name] : null;
}

/** UTF-8 として読む。読めない並びは置き換え文字になるだけで例外にはならないが、念のため受け止める。 */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return strFromU8(bytes);
  } catch {
    return null;
  }
}

/**
 * `.pcad` のバイト列から部品文書を取り出す。
 * 壊れていても例外を投げず、日本語の理由を返す(FR-504、NFR-RE-1)。
 */
export function readPcadFile(bytes: Uint8Array): ReadPcadFileResult {
  const entries = unzip(bytes);
  if (entries === null) {
    return fail('notZip', NOT_ZIP_MESSAGE);
  }
  const documentEntry = findEntry(entries, PCAD_DOCUMENT_ENTRY);
  if (documentEntry === null) {
    return fail('missingDocument', MISSING_DOCUMENT_MESSAGE);
  }
  const text = decodeUtf8(documentEntry);
  if (text === null) {
    return fail('notZip', NOT_ZIP_MESSAGE);
  }
  const parsed = parseDocument(text);
  if (!parsed.ok) {
    // 中身の理由(版が古い・種別が違う・欄が壊れている等)はそのまま通す。
    return { ok: false, error: parsed.error };
  }
  const thumbnail = findEntry(entries, PCAD_THUMBNAIL_ENTRY);
  if (thumbnail === null) {
    return { ok: true, document: parsed.document, savedAt: parsed.savedAt };
  }
  return {
    ok: true,
    document: parsed.document,
    savedAt: parsed.savedAt,
    thumbnailPng: thumbnail,
  };
}
