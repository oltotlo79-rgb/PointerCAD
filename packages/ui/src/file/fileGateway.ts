/**
 * ファイルの読み書きの口(計画書 docs/plans/P2-ソリッド基礎.md タスク23、§2.10、§0.a-0.10。
 * 種類つきの出し入れは docs/plans/P6-入出力.md §2.2、§0.a-0.4、タスク4)。
 *
 * 対応要件: FR-806(保存・読込)、FR-802(読み込み)、FR-803(書き出し)、NFR-SE-1、
 * 要件§1.5(Web 版とデスクトップ版に機能差を作らない)。
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
 * **口は 2 組ある。**
 *  - `openPcad` / `savePcad` / `hasSaveTarget`: 部品そのもの(`.pcad`)の開く・保存する。
 *    **上書き先を覚える**のはこの組だけで、P2 から振る舞いを変えていない。
 *  - `openFile` / `saveFileAs`: 他の形式との出し入れ(STEP・STL・OBJ・glTF・3MF・DXF・ひな形)。
 *    **上書き先を覚えない**(§0.a-0.4)。覚えてしまうと、書き出しの後の Ctrl+S が
 *    部品ではなく書き出した先を上書きしかねないため。`saveFileAs` は呼ぶたびに名前を訊く。
 *
 * File System Access API は TypeScript の DOM の型定義に**入っていない**(TypeScript 5.9 で確認)。
 * `as` による強制変換は使わない(rules/02-禁止事項.md)ので、`in` と `typeof` で 1 段ずつ
 * 絞り込む小さな判定関数を並べ、返ってきたものも同じやり方で確かめてから使う。
 * ダウンロードとファイル選択の窓が使う `document` / `URL` も同じ流儀で絞る。こうしておくと
 * 検査から偽の相手を渡せる(本物の `globalThis` に欄を差し込むと他の検査へ漏れる)。
 */

import type { FileKind } from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';

/** 開いたファイル 1 つぶん(§2.10)。 */
export interface PickedFile {
  /** 拡張子を含むファイル名。パスは含まない(ブラウザは渡してくれない)。 */
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** 種類まで分かったファイル 1 つぶん(§2.2)。パスは含まない(NFR-SE-1)。 */
export interface PickedTypedFile {
  /** どの形式として読むか。頼んだ種類(`openFile` の引数)の中から選ばれる。 */
  readonly kind: FileKind;
  /** 拡張子を含むファイル名。 */
  readonly fileName: string;
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
  /**
   * 種類を選んでファイルを開く(FR-802、FR-813、FR-807)。取り消されたら null。
   * **上書き先は覚えない**(§0.a-0.4)ので、`hasSaveTarget()` の答えは変わらない。
   *
   * 省略できる欄にしてあるのは、差し込み側(検査の偽の口や古いデスクトップ版)を
   * 壊さないため。省略された口へは `openFileThrough` がブラウザ用の実装で答える。
   */
  openFile?(kinds: readonly FileKind[]): Promise<PickedTypedFile | null>;
  /**
   * 名前を訊いて書き出す(FR-803、FR-812、FR-814)。書けたら true、取り消されたら false。
   * **呼ぶたびに名前を訊く**(上書き先を覚えない。§0.a-0.4)。
   * 省略できる理由は `openFile` と同じ。
   */
  saveFileAs?(fileName: string, kind: FileKind, bytes: Uint8Array): Promise<boolean>;
  /**
   * 印刷する(FR-810。P6 計画書 §2.11、タスク29)。PNG のバイト列を渡すと、
   * 印刷できたら true、取り消されたら false を返す(**取り消しは例外にしない**)。
   *
   * **この口を持つのはデスクトップ版だけ。** ブラウザは `window.print()` で印刷できるので、
   * ここへ実装を置かない(口があるかどうかが「デスクトップ版か」の判断になる。
   * 使い分けは `printView.ts` の `desktopPrintOf`)。
   */
  print?(png: Uint8Array): Promise<boolean>;
}

/** 部品ファイルの拡張子(要件§8)。 */
export const PCAD_EXTENSION = '.pcad';

/**
 * 部品ファイルの MIME 型。`.pcad` は世の中に登録された型を持たないので、
 * 「中身は決めのないバイト列」を表す汎用の型を使う。
 */
const PCAD_MIME_TYPE = 'application/octet-stream';

// ---------------------------------------------------------------------------
// ファイルの種類 → 拡張子・MIME 型の表(**この 1 か所だけ**)
// ---------------------------------------------------------------------------

/** ファイル選択の窓に出す種別 1 つぶん。File System Access API の `types` の要素と同じ形。 */
interface FilePickerType {
  readonly description: string;
  readonly accept: Readonly<Record<string, readonly string[]>>;
}

/** ファイルの種類ごとの見せ方。 */
interface FileKindSpec {
  /**
   * 形式の呼び名。STEP・STL・OBJ・glTF・3MF・DXF は形式そのものの名前(固有名詞)で、
   * 訳す言葉ではないのでここに直接書く。日本語の説明が要る種類は `descriptionKey` を持つ。
   */
  readonly label: string;
  /**
   * 利用者へ見せる説明の文言のキー(NFR-MA-5。文言は `ja.json` が持つ)。
   * 無い種類は `label` をそのまま出す。ひな形(`.pcadt`)の説明の文言はタスク5 が
   * `ja.json` へ足す予定なので、それまでは呼び名だけを出す。
   */
  readonly descriptionKey?: MessageKey;
  /**
   * MIME 型 → その型が名乗る拡張子。File System Access API の `accept` と同じ形にしてある。
   * glTF だけ 1 つの種類が 2 つの MIME 型を持つ(バイナリの `.glb` と JSON の `.gltf`)。
   */
  readonly accept: Readonly<Record<string, readonly string[]>>;
}

/**
 * ファイルの種類ごとの拡張子と MIME 型(§2.2)。**表はここ 1 か所だけ**にある。
 *
 * 種類の一覧(`FileKind`)の正本は `@pointercad/model` の `exchange/types.ts`(タスク2)で、
 * ここは写しを作らず import して `Record` の鍵に使う。種類が増えれば型検査がここを落とす。
 *
 * MIME 型は IANA に登録のあるものを使う(`model/step`・`model/stl`・`model/obj`・
 * `model/gltf-binary`・`model/gltf+json`・`model/3mf`・`image/vnd.dxf`)。
 * `.pcad` / `.pcadt` は登録が無いので汎用のバイト列の型にする。
 *
 * デスクトップ版のダイアログのフィルタは `apps/desktop/src/main/pcadDialogs.ts` に
 * 同じ内容を写してある(本体プロセスから `@pointercad/ui` を読むと画面用の実装まで
 * 抱き込むため。既存の `PCAD_FILE_FILTER` と同じ理由)。
 */
const FILE_KIND_SPECS: Readonly<Record<FileKind, FileKindSpec>> = {
  pcad: {
    label: 'PointerCAD',
    descriptionKey: 'file.typeDescription',
    accept: { [PCAD_MIME_TYPE]: [PCAD_EXTENSION] },
  },
  pcadt: {
    label: 'PointerCAD',
    accept: { [PCAD_MIME_TYPE]: ['.pcadt'] },
  },
  step: { label: 'STEP', accept: { 'model/step': ['.step', '.stp'] } },
  stl: { label: 'STL', accept: { 'model/stl': ['.stl'] } },
  obj: { label: 'OBJ', accept: { 'model/obj': ['.obj'] } },
  glb: {
    label: 'glTF',
    accept: { 'model/gltf-binary': ['.glb'], 'model/gltf+json': ['.gltf'] },
  },
  '3mf': { label: '3MF', accept: { 'model/3mf': ['.3mf'] } },
  dxf: { label: 'DXF', accept: { 'image/vnd.dxf': ['.dxf'] } },
};

/** その種類の拡張子(先頭の `.` を含む)。並びは表の順で、先頭が代表(書き出しで足す拡張子)。 */
export function extensionsOf(kind: FileKind): readonly string[] {
  return Object.values(FILE_KIND_SPECS[kind].accept).flat();
}

/** その種類を書き出すときに使う MIME 型(表の先頭)。ダウンロードの `Blob` に渡す。 */
function primaryMimeTypeOf(kind: FileKind): string {
  // 表は必ず 1 つ以上の MIME 型を持つ。空の表を書けば下の `?? ` ではなく型検査が落ちるべきだが、
  // `Record` の値の空でないことは型で言えないので、取り出せなかったときは汎用の型へ落とす。
  return Object.keys(FILE_KIND_SPECS[kind].accept)[0] ?? PCAD_MIME_TYPE;
}

/** ファイル選択の窓に出す種別 1 つを組み立てる。 */
function fileTypeOf(kind: FileKind): FilePickerType {
  const spec = FILE_KIND_SPECS[kind];
  const key = spec.descriptionKey;
  return { description: key === undefined ? spec.label : t(key), accept: spec.accept };
}

/** ファイル選択の窓へ渡す種別の並び。頼まれた順のまま出す(先頭が既定の種別になる)。 */
function filePickerTypesFor(kinds: readonly FileKind[]): readonly FilePickerType[] {
  return kinds.map(fileTypeOf);
}

/**
 * `<input type="file">` の `accept` に書く文字列(`.step,.stp,.stl` のような並び)。
 * 同じ拡張子を 2 度書かない(頼まれた種類が拡張子を分け合うことは今は無いが、増えても壊れない)。
 */
export function acceptAttributeFor(kinds: readonly FileKind[]): string {
  const seen: string[] = [];
  for (const kind of kinds) {
    for (const extension of extensionsOf(kind)) {
      if (!seen.includes(extension)) {
        seen.push(extension);
      }
    }
  }
  return seen.join(',');
}

/**
 * ファイル名の拡張子から、頼んだ種類のどれかを選び直す。**頼んでいない種類は答えない**
 * (「STEP と STL を開く」と言われた窓で `.dxf` を選ばれても、DXF として読み込まない)。
 * 大文字小文字は問わない。見分けられなければ null。
 */
export function fileKindOfName(fileName: string, kinds: readonly FileKind[]): FileKind | null {
  const lower = fileName.toLowerCase();
  for (const kind of kinds) {
    for (const extension of extensionsOf(kind)) {
      if (lower.endsWith(extension)) {
        return kind;
      }
    }
  }
  return null;
}

/** ファイル選択の窓に出す種別(`.pcad`)。名前は利用者が読むので ja.json から引く(NFR-MA-5)。 */
const PCAD_FILE_TYPE = fileTypeOf('pcad');

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
  readonly types?: readonly FilePickerType[];
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

/** 名前つきの中身(`<input type="file">` が渡してくるファイル)。 */
interface NamedReadableFile extends ReadableFile {
  readonly name: string;
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/**
 * 欄を持てるもの(素の入れ物と、クラスや関数)。`URL` は静的な欄を持つクラスなので
 * `typeof` は `'function'` になる。`isObject` では落ちてしまうためこちらで受ける。
 */
function isRecordLike(value: unknown): value is object {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
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

function isNamedReadableFile(value: unknown): value is NamedReadableFile {
  return isReadableFile(value) && 'name' in value && typeof value.name === 'string';
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
// File System Access API が無いときの落とし先(document / URL も 1 段ずつ絞る)
// ---------------------------------------------------------------------------

/** ダウンロードの引き金に使う `<a>`。書き込むだけの欄は確かめない(無ければ書けば増える)。 */
interface DownloadAnchor {
  href: string;
  download: string;
  hidden: boolean;
  click(): void;
  remove(): void;
}

/** ファイル選択に使う `<input type="file">`。 */
interface FilePickerInput {
  type: string;
  accept: string;
  hidden: boolean;
  /** 選ばれたファイル。選ばれなければ空・null・undefined のいずれもあり得る。 */
  readonly files?: { readonly [index: number]: unknown } | null;
  addEventListener(type: string, listener: () => void): void;
  click(): void;
  remove(): void;
}

interface DomDocument {
  createElement(tagName: string): unknown;
  readonly body: { append(node: unknown): void };
}

interface ObjectUrls {
  createObjectURL(blob: unknown): string;
  revokeObjectURL(url: string): void;
}

interface DocumentScope {
  readonly document: DomDocument;
}

interface ObjectUrlScope {
  readonly URL: ObjectUrls;
}

function isDomDocument(value: unknown): value is DomDocument {
  return (
    isRecordLike(value) &&
    'createElement' in value &&
    typeof value.createElement === 'function' &&
    'body' in value &&
    isRecordLike(value.body) &&
    'append' in value.body &&
    typeof value.body.append === 'function'
  );
}

function isObjectUrls(value: unknown): value is ObjectUrls {
  return (
    isRecordLike(value) &&
    'createObjectURL' in value &&
    typeof value.createObjectURL === 'function' &&
    'revokeObjectURL' in value &&
    typeof value.revokeObjectURL === 'function'
  );
}

function hasDocument(scope: object): scope is DocumentScope {
  return 'document' in scope && isDomDocument(scope.document);
}

function hasObjectUrls(scope: object): scope is ObjectUrlScope {
  return 'URL' in scope && isObjectUrls(scope.URL);
}

function isDownloadAnchor(value: unknown): value is DownloadAnchor {
  return (
    isObject(value) &&
    'click' in value &&
    typeof value.click === 'function' &&
    'remove' in value &&
    typeof value.remove === 'function'
  );
}

function isFilePickerInput(value: unknown): value is FilePickerInput {
  return (
    isObject(value) &&
    'addEventListener' in value &&
    typeof value.addEventListener === 'function' &&
    'click' in value &&
    typeof value.click === 'function' &&
    'remove' in value &&
    typeof value.remove === 'function'
  );
}

/**
 * ダウンロードとして保存する。場所は選べず、ブラウザのダウンロード先へ落ちる。
 *
 * 一時的な URL は使い終わったらすぐ手放す。押した時点でブラウザは保存を始めているので、
 * 直後に手放しても中身は失われない。手放さないと、その場所を指したまま
 * ファイルの中身が記憶に残り続ける。
 */
function downloadBytes(scope: object, name: string, mimeType: string, bytes: Uint8Array): void {
  if (!hasDocument(scope) || !hasObjectUrls(scope)) {
    // ダウンロードすらできない相手(ブラウザではない)。書けなかったこととして断る。
    throw new Error(t('file.saveFailed'));
  }
  // Blob は「共有できる記憶を指していないバイト列」しか受け取らない。渡された並びが
  // どちらの記憶を指しているかは呼び出し側次第なので、ここで自前の記憶へ写してから渡す。
  const plain = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  plain.set(bytes);
  const blob = new Blob([plain], { type: mimeType });
  const url = scope.URL.createObjectURL(blob);
  const anchor = scope.document.createElement('a');
  if (!isDownloadAnchor(anchor)) {
    // 引き金を作れなかった。先に取った URL を手放してから断る(記憶を残さない)。
    scope.URL.revokeObjectURL(url);
    throw new Error(t('file.saveFailed'));
  }
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  scope.document.body.append(anchor);
  anchor.click();
  anchor.remove();
  scope.URL.revokeObjectURL(url);
}

/**
 * ファイル選択の窓で開く。取り消しは `cancel` の知らせで拾う。
 * 拾えない古いブラウザでは、選ぶまで待ち続ける(その間も画面の操作は止まらない)。
 */
function pickFileWithInput(accept: string, scope: object): Promise<PickedFile | null> {
  return new Promise<PickedFile | null>((resolve, reject) => {
    if (!hasDocument(scope)) {
      reject(new Error(t('file.openFailed')));
      return;
    }
    const created = scope.document.createElement('input');
    if (!isFilePickerInput(created)) {
      reject(new Error(t('file.openFailed')));
      return;
    }
    const input = created;
    input.type = 'file';
    input.accept = accept;
    input.hidden = true;

    const finish = (picked: PickedFile | null): void => {
      input.remove();
      resolve(picked);
    };

    input.addEventListener('cancel', () => {
      finish(null);
    });
    input.addEventListener('change', () => {
      const file: unknown = input.files?.[0];
      if (!isNamedReadableFile(file)) {
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

    scope.document.body.append(input);
    input.click();
  });
}

// ---------------------------------------------------------------------------
// 種類つきの出し入れ(ブラウザ用。上書き先を覚えない)
// ---------------------------------------------------------------------------

/**
 * 種類を選んでファイルを開く(§2.2)。取り消されたら null。
 *
 * **上書き先を覚えない。** 覚えるのは `.pcad` の `savePcad` / `openPcad` だけで(§0.a-0.4)、
 * ここは口の状態を一切触らないただの関数にしてある。
 *
 * 拡張子で種類を見分けられなかったときは断る。中身の先頭のバイト列で見分ける段構え
 * (§0.a-0.27)は読み込む側の担当で、ここでは「どの形式として読むか」を決められない。
 */
export async function openFileInBrowser(
  kinds: readonly FileKind[],
  scope: object = globalThis,
): Promise<PickedTypedFile | null> {
  if (!hasOpenPicker(scope)) {
    const picked = await pickFileWithInput(acceptAttributeFor(kinds), scope);
    if (picked === null) {
      return null;
    }
    const kind = fileKindOfName(picked.name, kinds);
    if (kind === null) {
      throw new Error(t('file.openFailed'));
    }
    return { kind, fileName: picked.name, bytes: picked.bytes };
  }
  let picked: unknown;
  try {
    picked = await scope.showOpenFilePicker({
      multiple: false,
      types: filePickerTypesFor(kinds),
    });
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
  const kind = fileKindOfName(handle.name, kinds);
  if (kind === null) {
    throw new Error(t('file.openFailed'));
  }
  const file = await handle.getFile();
  if (!isReadableFile(file)) {
    throw new Error(t('file.openFailed'));
  }
  return { kind, fileName: handle.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/**
 * 名前を訊いて書き出す(§2.2)。書けたら true、取り消されたら false(例外は投げない)。
 *
 * **呼ぶたびに名前を訊く。** 前に書いた先を覚えないので、2 回続けて呼べば 2 回とも窓が出る
 * (§0.a-0.4)。部品の上書き保存(`savePcad`)とはここが違う。
 */
export async function saveFileAsInBrowser(
  fileName: string,
  kind: FileKind,
  bytes: Uint8Array,
  scope: object = globalThis,
): Promise<boolean> {
  if (!hasSavePicker(scope)) {
    // 場所は選べないので、名前を添えてダウンロードする(§0.a-0.10)。
    downloadBytes(scope, fileName, primaryMimeTypeOf(kind), bytes);
    return true;
  }
  let picked: unknown;
  try {
    picked = await scope.showSaveFilePicker({
      suggestedName: fileName,
      types: [fileTypeOf(kind)],
    });
  } catch (error) {
    if (isAbortError(error)) {
      return false;
    }
    throw error;
  }
  if (!isWritableFileHandle(picked)) {
    throw new Error(t('file.saveFailed'));
  }
  const writable = await picked.createWritable();
  if (!isWritableFile(writable)) {
    throw new Error(t('file.saveFailed'));
  }
  await writable.write(bytes);
  await writable.close();
  return true;
}

/**
 * 差し込まれた口を通してファイルを開く。口が `openFile` を持たない(古い差し替え・検査の
 * 偽の口)ときは、ブラウザ用の実装で答える。呼ぶ側が毎回この分岐を書かなくて済むようにする。
 */
export function openFileThrough(
  gateway: FileGateway,
  kinds: readonly FileKind[],
): Promise<PickedTypedFile | null> {
  return gateway.openFile === undefined ? openFileInBrowser(kinds) : gateway.openFile(kinds);
}

/** 差し込まれた口を通して書き出す。口が `saveFileAs` を持たないときの扱いは上と同じ。 */
export function saveFileAsThrough(
  gateway: FileGateway,
  fileName: string,
  kind: FileKind,
  bytes: Uint8Array,
): Promise<boolean> {
  return gateway.saveFileAs === undefined
    ? saveFileAsInBrowser(fileName, kind, bytes)
    : gateway.saveFileAs(fileName, kind, bytes);
}

// ---------------------------------------------------------------------------
// ブラウザ用の口
// ---------------------------------------------------------------------------

/**
 * ブラウザ用の口(§2.10)。File System Access API があれば使い、無ければ
 * ダウンロード / ファイル選択へ落とす(§0.a-0.10)。
 *
 * 保存先を覚えるのはこの口 1 つの中だけ。作り直せば忘れる。
 * **覚えるのは `.pcad` の分だけ**で、`saveFileAs` / `openFile` は控えを触らない(§0.a-0.4)。
 *
 * 調べる相手を引数で受けるのは、検査で偽の `globalThis` を渡せるようにするため
 * (`hasFileSystemAccess` と同じ考え方)。既定は本物の `globalThis` なので、
 * 引数なしで呼ぶ側(ストア・デスクトップ版の保険)から見た振る舞いは変わらない。
 */
export function createBrowserFileGateway(scope: object = globalThis): FileGateway {
  /** 直前に保存した先(または開いたファイル)。覚えられるのは File System Access API のときだけ。 */
  let saveTarget: WritableFileHandle | null = null;

  return {
    async openPcad(): Promise<PickedFile | null> {
      if (!hasOpenPicker(scope)) {
        return pickFileWithInput(PCAD_EXTENSION, scope);
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
      if (!hasSavePicker(scope)) {
        // 場所は選べないので、名前を添えてダウンロードする(§0.a-0.10)。
        downloadBytes(scope, suggestedName, PCAD_MIME_TYPE, bytes);
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

    openFile(kinds): Promise<PickedTypedFile | null> {
      // 控え(`saveTarget`)には触らない。書き出し・読み込みは `.pcad` の上書き先を汚さない。
      return openFileInBrowser(kinds, scope);
    },

    saveFileAs(fileName, kind, bytes): Promise<boolean> {
      return saveFileAsInBrowser(fileName, kind, bytes, scope);
    },
  };
}
