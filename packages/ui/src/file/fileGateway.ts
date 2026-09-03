/**
 * ファイルの読み書きの口(計画書 docs/plans/P2-ソリッド基礎.md タスク23、§2.10、§0.a-0.10)。
 *
 * 対応要件: FR-806(保存・読込)、要件§1.5(Web 版とデスクトップ版に機能差を作らない)。
 *
 * UI から `apps/` を import できない(依存方向、rules/04-設計の規律.md)ので、
 * 「開く」「保存する」の**口だけ**をここに置き、実装はストアへ差し込む。
 * ここにあるのはブラウザ用の実装で、デスクトップ版は `setFileGateway` で差し替える。
 *
 * ブラウザ用は 2 段構えにする(§0.a-0.10)。
 *  - File System Access API(`showOpenFilePicker` / `showSaveFilePicker`)があればそれを使う。
 *    開いたファイルの手掛かりを覚えられるので、**同じファイルへの上書き保存**ができる。
 *  - 無ければ、保存はダウンロード(`<a download>`)、読込はファイル選択(`<input type="file">`)へ落とす。
 *    この場合は保存のたびに新しいファイルができるので、上書き保存はできない。
 *
 * File System Access API は TypeScript の DOM の型定義に**入っていない**(TypeScript 5.9 で確認)。
 * `as` による強制変換は使わない(rules/02-禁止事項.md)ので、`in` と `typeof` で 1 段ずつ
 * 絞り込む小さな判定関数を並べ、返ってきたものも同じやり方で確かめてから使う。
 */

import { t } from '../i18n/t.js';

/** 開いたファイル 1 つぶん(§2.10)。 */
export interface PickedFile {
  /** 拡張子を含むファイル名。パスは含まない(ブラウザは渡してくれない)。 */
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface FileGateway {
  /** 開く。取り消されたら null。読めなかったときは例外を投げる。 */
  openPcad(): Promise<PickedFile | null>;
  /**
   * 保存する。`saveAs` が false のときは、前に保存した先へ黙って上書きしてよい。
   * 保存できたらファイル名を返す。取り消されたら null。
   */
  savePcad(suggestedName: string, bytes: Uint8Array, saveAs: boolean): Promise<string | null>;
  /** 前に保存した先を覚えているか(「保存」を「名前を付けて保存」に落とすかの判断)。 */
  hasSaveTarget(): boolean;
}

/** 部品ファイルの拡張子(要件§8)。 */
export const PCAD_EXTENSION = '.pcad';

/**
 * 部品ファイルの MIME 型。`.pcad` は世の中に登録された型を持たないので、
 * 「中身は決めのないバイト列」を表す汎用の型を使う。
 */
const PCAD_MIME_TYPE = 'application/octet-stream';

/** ファイル選択の窓に出す種別。名前は利用者が読むので ja.json から引く(NFR-MA-5)。 */
const PCAD_FILE_TYPE = {
  description: t('file.typeDescription'),
  accept: { [PCAD_MIME_TYPE]: [PCAD_EXTENSION] },
};

/**
 * 名前を `.pcad` で終わらせる(大文字小文字は問わない)。
 * すでに `.pcad` で終わっていればそのまま返す。前後の空白は落とす。
 */
export function withPcadExtension(name: string): string {
  const trimmed = name.trim();
  return trimmed.toLowerCase().endsWith(PCAD_EXTENSION) ? trimmed : `${trimmed}${PCAD_EXTENSION}`;
}

// ---------------------------------------------------------------------------
// File System Access API があるかどうかの判定(as を使わずに絞る)
// ---------------------------------------------------------------------------

/** ファイル選択の窓に渡す設定。使う欄だけを書き写したもの。 */
interface PcadFilePickerOptions {
  readonly suggestedName?: string;
  readonly multiple?: boolean;
  readonly types?: readonly {
    readonly description: string;
    readonly accept: Readonly<Record<string, readonly string[]>>;
  }[];
}

type FilePicker = (options: PcadFilePickerOptions) => Promise<unknown>;

interface OpenPickerScope {
  readonly showOpenFilePicker: FilePicker;
}

interface SavePickerScope {
  readonly showSaveFilePicker: FilePicker;
}

function hasOpenPicker(scope: object): scope is OpenPickerScope {
  return 'showOpenFilePicker' in scope && typeof scope.showOpenFilePicker === 'function';
}

function hasSavePicker(scope: object): scope is SavePickerScope {
  return 'showSaveFilePicker' in scope && typeof scope.showSaveFilePicker === 'function';
}

/**
 * File System Access API が使えるか(§0.a-0.10)。
 *
 * 「開く」と「保存する」の両方が揃っているときだけ使えると数える。片方だけがある環境は
 * 知られていないうえ、片方だけ使うと「開いたファイルへ上書き保存できる / できない」が
 * 環境ごとに変わって説明できなくなるため。
 *
 * 調べる相手を引数で受けるのは、検査で偽の `globalThis` を渡せるようにするため
 * (本物の `globalThis` に欄を差し込むと、他の検査へ漏れる)。
 */
export function hasFileSystemAccess(scope: object = globalThis): boolean {
  return hasOpenPicker(scope) && hasSavePicker(scope);
}

// ---------------------------------------------------------------------------
// 返ってきたものを確かめる(as を使わずに絞る)
// ---------------------------------------------------------------------------

/** 読むための手掛かり。File System Access API の使う部分だけを書き写したもの。 */
interface ReadableFileHandle {
  readonly name: string;
  getFile(): Promise<unknown>;
}

/** 書くための手掛かり。 */
interface WritableFileHandle {
  readonly name: string;
  createWritable(): Promise<unknown>;
}

/** 書き込み先。 */
interface WritableFile {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/** 読み出したファイルの中身。 */
interface ReadableFile {
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isReadableFileHandle(value: unknown): value is ReadableFileHandle {
  return (
    isObject(value) &&
    'name' in value &&
    typeof value.name === 'string' &&
    'getFile' in value &&
    typeof value.getFile === 'function'
  );
}

function isWritableFileHandle(value: unknown): value is WritableFileHandle {
  return (
    isObject(value) &&
    'name' in value &&
    typeof value.name === 'string' &&
    'createWritable' in value &&
    typeof value.createWritable === 'function'
  );
}

function isWritableFile(value: unknown): value is WritableFile {
  return (
    isObject(value) &&
    'write' in value &&
    typeof value.write === 'function' &&
    'close' in value &&
    typeof value.close === 'function'
  );
}

function isReadableFile(value: unknown): value is ReadableFile {
  return isObject(value) && 'arrayBuffer' in value && typeof value.arrayBuffer === 'function';
}

/**
 * 並びとして受け取り直す。`Array.isArray` はそのままだと要素の型が `any` になり、
 * 取り出した値の素性が分からなくなるので、ここで `unknown` の並びとして受け止める。
 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * 利用者が窓を閉じた(取り消した)ことを表す失敗か。
 * ブラウザは `AbortError` という名前の失敗を投げる。`DOMException` が `Error` を継いで
 * いない実装もあり得るので、種類ではなく名前の欄だけで見分ける。
 */
function isAbortError(error: unknown): boolean {
  return isObject(error) && 'name' in error && error.name === 'AbortError';
}

// ---------------------------------------------------------------------------
// File System Access API が無いときの落とし先
// ---------------------------------------------------------------------------

/**
 * ダウンロードとして保存する。場所は選べず、ブラウザのダウンロード先へ落ちる。
 *
 * 一時的な URL は使い終わったらすぐ手放す。押した時点でブラウザは保存を始めているので、
 * 直後に手放しても中身は失われない。手放さないと、その場所を指したまま
 * ファイルの中身が記憶に残り続ける。
 */
function downloadBytes(name: string, bytes: Uint8Array): void {
  // Blob は「共有できる記憶を指していないバイト列」しか受け取らない。渡された並びが
  // どちらの記憶を指しているかは呼び出し側次第なので、ここで自前の記憶へ写してから渡す。
  const plain = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  plain.set(bytes);
  const blob = new Blob([plain], { type: PCAD_MIME_TYPE });
  const url = URL.createObjectURL(blob);
  const anchor = globalThis.document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  globalThis.document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * ファイル選択の窓で開く。取り消しは `cancel` の知らせで拾う。
 * 拾えない古いブラウザでは、選ぶまで待ち続ける(その間も画面の操作は止まらない)。
 */
function pickFileWithInput(): Promise<PickedFile | null> {
  return new Promise<PickedFile | null>((resolve, reject) => {
    const input = globalThis.document.createElement('input');
    input.type = 'file';
    input.accept = PCAD_EXTENSION;
    input.hidden = true;

    const finish = (picked: PickedFile | null): void => {
      input.remove();
      resolve(picked);
    };

    input.addEventListener('cancel', () => {
      finish(null);
    });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file === undefined) {
        finish(null);
        return;
      }
      file.arrayBuffer().then(
        (buffer) => {
          finish({ name: file.name, bytes: new Uint8Array(buffer) });
        },
        (error: unknown) => {
          input.remove();
          reject(error instanceof Error ? error : new Error(t('file.openFailed')));
        },
      );
    });

    globalThis.document.body.append(input);
    input.click();
  });
}

// ---------------------------------------------------------------------------
// ブラウザ用の口
// ---------------------------------------------------------------------------

/**
 * ブラウザ用の口(§2.10)。File System Access API があれば使い、無ければ
 * ダウンロード / ファイル選択へ落とす(§0.a-0.10)。
 *
 * 保存先を覚えるのはこの口 1 つの中だけ。作り直せば忘れる。
 */
export function createBrowserFileGateway(): FileGateway {
  /** 直前に保存した先(または開いたファイル)。覚えられるのは File System Access API のときだけ。 */
  let saveTarget: WritableFileHandle | null = null;

  return {
    async openPcad(): Promise<PickedFile | null> {
      const scope: object = globalThis;
      if (!hasOpenPicker(scope)) {
        return pickFileWithInput();
      }
      let picked: unknown;
      try {
        picked = await scope.showOpenFilePicker({ multiple: false, types: [PCAD_FILE_TYPE] });
      } catch (error) {
        if (isAbortError(error)) {
          return null;
        }
        throw error;
      }
      if (!isUnknownArray(picked) || picked.length === 0) {
        // 何も選ばれなかった。取り消しと同じ扱いにする。
        return null;
      }
      const handle = picked[0];
      if (!isReadableFileHandle(handle)) {
        throw new Error(t('file.openFailed'));
      }
      const file = await handle.getFile();
      if (!isReadableFile(file)) {
        throw new Error(t('file.openFailed'));
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (isWritableFileHandle(handle)) {
        // 開いたファイルはそのまま保存先にできる。次の Ctrl+S は同じファイルへ上書きする。
        saveTarget = handle;
      }
      return { name: handle.name, bytes };
    },

    async savePcad(suggestedName, bytes, saveAs): Promise<string | null> {
      const scope: object = globalThis;
      if (!hasSavePicker(scope)) {
        // 場所は選べないので、名前を添えてダウンロードする(§0.a-0.10)。
        downloadBytes(suggestedName, bytes);
        return suggestedName;
      }
      let target = saveAs ? null : saveTarget;
      if (target === null) {
        let picked: unknown;
        try {
          picked = await scope.showSaveFilePicker({ suggestedName, types: [PCAD_FILE_TYPE] });
        } catch (error) {
          if (isAbortError(error)) {
            return null;
          }
          throw error;
        }
        if (!isWritableFileHandle(picked)) {
          throw new Error(t('file.saveFailed'));
        }
        target = picked;
      }
      const writable = await target.createWritable();
      if (!isWritableFile(writable)) {
        throw new Error(t('file.saveFailed'));
      }
      await writable.write(bytes);
      await writable.close();
      saveTarget = target;
      return target.name;
    },

    hasSaveTarget(): boolean {
      return saveTarget !== null;
    },
  };
}
