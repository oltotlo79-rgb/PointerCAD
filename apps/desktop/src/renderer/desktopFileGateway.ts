import { t, type FileGateway, type PickedFile } from '@pointercad/ui';
import type { DrawingPrintOptions } from '@pointercad/ui/print-settings';
import { controlledDesktopExport, desktopCamGateway } from './desktopCamGateway.js';

/**
 * `window.pointercadDesktop`(preload が出す口)を、画面が使う `FileGateway` の形へ直す
 * (計画書 docs/plans/P2-ソリッド基礎.md タスク26、§2.10)。
 *
 * 対応要件: FR-806、要件§1.5(Web 版とデスクトップ版に機能差を作らない)。
 *
 * preload の口が無い・形が違うときは null を返す。そのとき画面はブラウザ用の口のまま動く
 * ので、デスクトップ版でも保存・読込ができなくなることはない(§1.5 の保険)。
 *
 * 形の確認は `in` と `typeof` だけで行い、`as` による強制変換は使わない(rules/02-禁止事項.md)。
 */

/**
 * preload が出す口。返り値を `Promise<unknown>` と書いてあるのは、
 * `typeof x === 'function'` で確かめられるのは「関数であること」までで、
 * 何を返すかは確かめられないため。答えの形はこのファイルの中で 1 つずつ見る。
 */
interface DesktopFileApi {
  beginPcadOpen(kind?: 'part' | 'assembly' | 'drawing' | 'all'): Promise<unknown>;
  readPcadOpenChunk(readId: string, index: number): Promise<unknown>;
  finishPcadOpen(readId: string): Promise<unknown>;
  abortPcadOpen(readId: string): Promise<unknown>;
  rereadPcadOpen(token: string): Promise<unknown>;
  confirmSaveTarget(token: string): Promise<unknown>;
  clearSaveTarget(): Promise<unknown>;
  beginPcadSave(suggestedName: string, saveAs: boolean, kind: 'part' | 'assembly' | 'drawing', totalBytes: number): Promise<unknown>;
  sendPcadSaveChunk(transferId: string, index: number, bytes: Uint8Array, sha256: string): Promise<unknown>;
  commitPcadSave(transferId: string): Promise<unknown>;
  abortPcadSave(transferId: string): Promise<unknown>;
  hasSaveTarget(): Promise<unknown>;
}

/**
 * 種類つきの出し入れの口(P6 計画書 タスク4)。**別の型にしてある**のは、古い preload
 * (この 2 本を出さない版)でも部品の読み書きだけは動かすため(§1.5 の保険)。
 */
interface DesktopExchangeApi {
  openFile(kinds: readonly string[]): Promise<unknown>;
  saveFileAs(fileName: string, kind: string, bytes: Uint8Array, requestId?: string): Promise<unknown>;
  cancelExportSave?(requestId: string): Promise<unknown> | void;
}

/**
 * 印刷の口(P6 計画書 タスク29)。**別の型にしてある**理由は `DesktopExchangeApi` と同じで、
 * この口を出さない古い preload でも他の口は動かすため(§1.5 の保険)。
 */
interface DesktopPrintApi {
  print(bytes: Uint8Array, options?: DrawingPrintOptions): Promise<unknown>;
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isDesktopFileApi(value: unknown): value is DesktopFileApi {
  return (
    isObject(value) &&
    'beginPcadOpen' in value &&
    typeof value.beginPcadOpen === 'function' &&
    'readPcadOpenChunk' in value &&
    typeof value.readPcadOpenChunk === 'function' &&
    'finishPcadOpen' in value &&
    typeof value.finishPcadOpen === 'function' &&
    'abortPcadOpen' in value &&
    typeof value.abortPcadOpen === 'function' &&
    'rereadPcadOpen' in value &&
    typeof value.rereadPcadOpen === 'function' &&
    'confirmSaveTarget' in value &&
    typeof value.confirmSaveTarget === 'function' &&
    'clearSaveTarget' in value &&
    typeof value.clearSaveTarget === 'function' &&
    'beginPcadSave' in value &&
    typeof value.beginPcadSave === 'function' &&
    'sendPcadSaveChunk' in value &&
    typeof value.sendPcadSaveChunk === 'function' &&
    'commitPcadSave' in value &&
    typeof value.commitPcadSave === 'function' &&
    'abortPcadSave' in value &&
    typeof value.abortPcadSave === 'function' &&
    'hasSaveTarget' in value &&
    typeof value.hasSaveTarget === 'function'
  );
}

/** 「保存」の開始の答え。分ける大きさは本体が決め(本体の `PCAD_SAVE_CHUNK_BYTES`)、ここでは決めない。 */
function isSaveReceipt(value: unknown): value is { readonly transferId: string; readonly chunkBytes: number } {
  return isObject(value) && 'transferId' in value && typeof value.transferId === 'string'
    && 'chunkBytes' in value && typeof value.chunkBytes === 'number'
    && Number.isSafeInteger(value.chunkBytes) && value.chunkBytes > 0;
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
}

/**
 * 部分の並び(順につなぐとファイルの全体)を、つないだ全体の `chunkBytes` ごとの独立した並びとして順に作る。
 * 切れ目は全体の並びを `slice` で分けた時と同じで、部分の境目には依らない。全体の並びは作らない。
 * 各回を独立した並びにするのは、部分や全体の見せ方(`subarray`)を送ると構造化複製が元の領域全体を写すため。
 */
function* savePieces(parts: readonly Uint8Array[], totalBytes: number, chunkBytes: number): Generator<Uint8Array<ArrayBuffer>> {
  let partIndex = 0, partOffset = 0;
  for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
    const piece = new Uint8Array(Math.min(chunkBytes, totalBytes - offset));
    for (let filled = 0; filled < piece.byteLength;) {
      const part = parts[partIndex], length = Math.min(part.byteLength - partOffset, piece.byteLength - filled);
      piece.set(part.subarray(partOffset, partOffset + length), filled);
      filled += length; partOffset += length;
      if (partOffset === part.byteLength) { partIndex += 1; partOffset = 0; }
    }
    yield piece;
  }
}

/**
 * 「保存」の中身(順につなぐとファイルの全体になる部分の並び)を、本体が開始で答えた大きさに分けて順に送り、
 * 確定の答え(名前か null)を返す(案B、2026-11-13。1 回で送ると本体プロセスで全体の写しが 2 つ重なり、
 * 保存中の記憶量の山になった)。大きさ・切れ目・各回の SHA-256 は全体を 1 つで渡した時と同じ。
 * 途中や確定で失敗したら、本体に一時ファイルを捨てさせてから失敗をそのまま返す。取り消し(開始が null)は null。
 */
async function savePcadInChunks(api: DesktopFileApi, suggestedName: string, parts: readonly Uint8Array[], saveAs: boolean,
  kind: 'part' | 'assembly' | 'drawing'): Promise<unknown> {
  const totalBytes = parts.reduce((total, part) => total + part.byteLength, 0);
  const receipt: unknown = await api.beginPcadSave(suggestedName, saveAs, kind, totalBytes);
  if (receipt === null || receipt === undefined) return null;
  if (!isSaveReceipt(receipt)) throw new Error(t('file.saveFailed'));
  const { transferId, chunkBytes } = receipt;
  try {
    let index = 0;
    for (const piece of savePieces(parts, totalBytes, chunkBytes)) {
      const accepted: unknown = await api.sendPcadSaveChunk(transferId, index, piece, await sha256Hex(piece));
      if (accepted !== true) throw new Error(t('file.saveFailed'));
      index += 1;
    }
    return await api.commitPcadSave(transferId);
  } catch (error) {
    await api.abortPcadSave(transferId).catch(() => undefined);
    throw error;
  }
}

function isDesktopPrintApi(value: object): value is DesktopPrintApi {
  return 'print' in value && typeof value.print === 'function';
}

/**
 * 印刷の口を包む。**答えが true のときだけ「印刷した」**とみなし、
 * 取り消し(false)も答えの形が違うときも false にする(取り消しを例外にしない。NFR-RE-1)。
 */
function wrapPrint(api: DesktopPrintApi): NonNullable<FileGateway['print']> {
  return async (bytes, options): Promise<boolean> => (await (options === undefined ? api.print(bytes) : api.print(bytes, options))) === true;
}

function isDesktopExchangeApi(value: object): value is DesktopExchangeApi {
  return (
    'openFile' in value &&
    typeof value.openFile === 'function' &&
    'saveFileAs' in value &&
    typeof value.saveFileAs === 'function'
  );
}

/**
 * 本体プロセスが答えた種類を、頼んだ種類の一覧の中から見つけ直す。
 *
 * 型引数で受けているのは、`FileKind` という型の名前をこのファイルへ持ち込まずに
 * (`apps/desktop` が依存しているのは `@pointercad/ui` だけ)、`as` を使わずに
 * 「頼んだ種類のどれか」という型を取り戻すため。頼んでいない綴りには答えない。
 */
function matchKind<Kind extends string>(kinds: readonly Kind[], value: unknown): Kind | null {
  for (const kind of kinds) {
    if (kind === value) {
      return kind;
    }
  }
  return null;
}

/**
 * 受け取ったバイト列を `Uint8Array` へ揃える。
 *
 * IPC と contextBridge を通ると、本体プロセスで作った `Uint8Array` は画面側の
 * `Uint8Array` として届く(`Buffer` は `Uint8Array` の一種なのでこれで受かる)。
 * 実装の都合で `ArrayBuffer` として届いた場合も受けられるようにしておく。
 * どちらでもなければ null を返し、呼び手が失敗として扱う。
 */
function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return null;
}

/** 「開く」の開始の答え。分ける大きさは本体が決め(本体の `PCAD_OPEN_CHUNK_BYTES`)、ここでは決めない。 */
interface OpenReceipt {
  readonly readId: string;
  readonly name: string;
  readonly size: number;
  readonly chunkBytes: number;
}

function isOpenReceipt(value: unknown): value is OpenReceipt {
  return isObject(value) && 'readId' in value && typeof value.readId === 'string'
    && 'name' in value && typeof value.name === 'string'
    && 'size' in value && typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0
    && 'chunkBytes' in value && typeof value.chunkBytes === 'number'
    && Number.isSafeInteger(value.chunkBytes) && value.chunkBytes > 0;
}

/**
 * 「開く」の本文を、本体が開始で答えた大きさに区切って順に受け取り、この世界(主世界)の 1 本の並びへ組む
 * (2026-11-13。1 回で受けると、IPC の受け取り・世界の境目の写し・この世界の並びが同時に生き、読込の記憶量の山になった)。
 * 各回の長さ・通し番号・合計を確かめ、途中や終わりで失敗したら本体に開いたファイルを閉じさせてから失敗を返す。
 */
async function readPcadInChunks(api: DesktopFileApi, receipt: OpenReceipt): Promise<PickedFile> {
  const { bytes, answer } = await receiveOpenedPcad(api, receipt);
  if (typeof answer !== 'string') throw new Error(t('file.openFailed'));
  const saveTargetToken = answer;
  // bytes はこの「開く」のために作った全域の並びで、ほかに持ち主はいない(読込の Worker へ写さずに移してよい)。
  // 移した後に中身が要った時は、同じ候補の token で本体に読み直させる。
  return { name: receipt.name, bytes, saveTargetToken, owned: true, reread: () => rereadPcad(api, saveTargetToken) };
}

/** 区切りを順に受け取って 1 本の並びへ組み、終わりの答えを返す。途中や終わりで失敗したら取消を呼んでから失敗を返す。 */
async function receiveOpenedPcad(api: DesktopFileApi, receipt: OpenReceipt): Promise<{ bytes: Uint8Array; answer: unknown }> {
  const { readId, size, chunkBytes } = receipt;
  try {
    const bytes = new Uint8Array(size);
    for (let index = 0, offset = 0; offset < size; index += 1, offset += chunkBytes) {
      const piece = toBytes(await api.readPcadOpenChunk(readId, index));
      if (piece === null || piece.byteLength !== Math.min(chunkBytes, size - offset)) throw new Error(t('file.openFailed'));
      bytes.set(piece, offset);
    }
    return { bytes, answer: await api.finishPcadOpen(readId) };
  } catch (error) {
    await api.abortPcadOpen(readId).catch(() => undefined);
    throw openFailure(error);
  }
}

/** 本体の拒否に心当たりの印があれば Web 版と同じ鍵の失敗へ直す。無ければ元の失敗のまま。 */
function openFailure(error: unknown): Error {
  const key = readFailureMessageKey(error);
  if (key !== null) return new Error(t(key), { cause: error });
  return error instanceof Error ? error : new Error(t('file.openFailed'), { cause: error });
}

/** 形の違う開始の答えでも識別子が読めれば、本体に開いたファイルを閉じさせる。 */
async function abortMalformedReceipt(api: DesktopFileApi, receipt: unknown): Promise<void> {
  if (isObject(receipt) && 'readId' in receipt && typeof receipt.readId === 'string') {
    await api.abortPcadOpen(receipt.readId).catch(() => undefined);
  }
}

/**
 * 読み直し(読込の Worker へ並びを移した後に、学習の控えの照合で中身が要った時だけ)。本体は開いた時と同じファイルの時だけ
 * 答え、終わりは同じ token を返す。同じ中身を返せない時は失敗にする(呼び手は控えを照合しない)。
 */
async function rereadPcad(api: DesktopFileApi, token: string): Promise<Uint8Array> {
  let receipt: unknown;
  try {
    receipt = await api.rereadPcadOpen(token);
  } catch (error) {
    throw openFailure(error);
  }
  if (!isOpenReceipt(receipt)) {
    await abortMalformedReceipt(api, receipt);
    throw new Error(t('file.openFailed'));
  }
  const { bytes, answer } = await receiveOpenedPcad(api, receipt);
  if (answer !== token) throw new Error(t('file.openFailed'));
  return bytes;
}

/** 種類つきの「開く」の答えの形。`kind` の綴りは `matchKind` で確かめる。 */
interface OpenedTypedShape {
  readonly name: string;
  readonly bytes: unknown;
  readonly kind: unknown;
}

function isOpenedTypedShape(value: unknown): value is OpenedTypedShape {
  return isObject(value) && 'name' in value && typeof value.name === 'string' && 'bytes' in value && 'kind' in value;
}

/**
 * 本体プロセス(`apps/desktop/src/main/pcadDialogs.ts` の `readBytesFrom`)が「開く」を
 * 大きさ理由で断ったときに文面へ混ぜる印(P12-26 続き。要件§1.5)。
 *
 * Electron の `ipcRenderer.invoke` の拒否は独自のクラスや追加の属性を運ばず、文面だけが
 * `Error invoking remote method '…': Error: <message>` の形で届く(preload は素通しの口)。
 * **日本語の言い回しの一致では判定しない**——この固定の印だけを見て、Web 版
 * (`packages/ui/src/file/readBrowserFile.ts`)と同じ i18n の鍵を選ぶ。
 *
 * 本体プロセス専用の `electron` / `node:fs` を抱き込む `pcadDialogs.ts` をここから import
 * せず、同じ文字列を書き写している(このファイル冒頭の preload との取り決めと同じ理由)。
 */
const READ_TOO_LARGE_REASON_MARKER = 'PCAD_READ_TOO_LARGE:';
const READ_SIZE_CHANGED_REASON_MARKER = 'PCAD_READ_SIZE_CHANGED:';

/**
 * 「開く」の本体プロセスの拒否を、Web 版と同じ i18n の鍵へ直す。心当たりの印が無ければ
 * null(呼び出し側は元の失敗をそのまま伝える)。
 */
function readFailureMessageKey(error: unknown): 'file.error.tooLarge' | 'file.error.corrupted' | null {
  if (!(error instanceof Error)) {
    return null;
  }
  if (error.message.includes(READ_TOO_LARGE_REASON_MARKER)) {
    return 'file.error.tooLarge';
  }
  if (error.message.includes(READ_SIZE_CHANGED_REASON_MARKER)) {
    return 'file.error.corrupted';
  }
  return null;
}

/**
 * デスクトップ版のファイルの読み書きの口を作る。preload の口が無ければ null。
 *
 * 調べる相手を引数で受けるのは、検査で偽の `globalThis` を渡せるようにするため
 * (`packages/ui/src/file/fileGateway.ts` の `hasFileSystemAccess` と同じ考え方)。
 */
export function createDesktopFileGateway(scope: object = globalThis): FileGateway | null {
  if (!('pointercadDesktop' in scope)) {
    return null;
  }
  const api: unknown = scope.pointercadDesktop;
  if (!isDesktopFileApi(api)) {
    return null;
  }

  /*
   * 上書き先を覚えているかどうかの控え。
   *
   * `FileGateway.hasSaveTarget()` は**その場で**真偽を返す約束なのに、実体は本体プロセスに
   * あって IPC(`pcad:hasTarget`)でしか聞けない。そこで答えを画面側で控える。
   *  - 起動直後は「覚えていない」から始める。
   *  - 「開く」はまだ変えず、文書の検証後に token の確定が成功したときだけ合わせる。
   *  - 「保存」が成功したら「覚えている」にする(本体プロセスもそこで覚える)。
   *  - 作った直後に 1 度だけ本体プロセスへ聞き、覚えていれば控えも合わせる。画面を読み直しても
   *    本体プロセスの控えは残るため、これが無いと最初の Ctrl+S で余計に窓が出る。
   *
   * 問い合わせ中に確定・解除・保存が起きたときは版を進め、遅れて返った古い答えで
   * 新しい状態を上書きしない。
   */
  let hasTarget = false;
  let targetStateVersion = 0;
  const initialTargetStateVersion = targetStateVersion;

  void api.hasSaveTarget().then(
    (value: unknown) => {
      if (targetStateVersion === initialTargetStateVersion && typeof value === 'boolean') {
        hasTarget = value;
      }
    },
    () => {
      // 聞けなかったときは「覚えていない」まま。次の保存で場所を尋ねるだけで済む。
    },
  );

  /** `savePcad` と `savePcadParts` の共通の保存。中身は順につなぐとファイルの全体になる部分の並び。 */
  const saveContent = async (suggestedName: string, parts: readonly Uint8Array[], saveAs: boolean,
    kind: 'part' | 'assembly' | 'drawing'): Promise<string | null> => {
    const revision = ++targetStateVersion;
    const result: unknown = await savePcadInChunks(api, suggestedName, parts, saveAs, kind);
    if (revision !== targetStateVersion) return null;
    if (result === null || result === undefined) {
      // 取り消された。
      return null;
    }
    if (typeof result !== 'string') {
      throw new Error(t('file.saveFailed'));
    }
    hasTarget = true;
    return result;
  };

  const base: FileGateway = {
    ...desktopCamGateway(api),
    async openPcad(kind): Promise<PickedFile | null> {
      let receipt: unknown;
      try {
        receipt = await api.beginPcadOpen(kind);
      } catch (error) {
        const key = readFailureMessageKey(error);
        if (key !== null) throw new Error(t(key), { cause: error });
        throw error;
      }
      if (receipt === null || receipt === undefined) {
        // 取り消された。
        return null;
      }
      if (!isOpenReceipt(receipt)) {
        await abortMalformedReceipt(api, receipt);
        throw new Error(t('file.openFailed'));
      }
      return readPcadInChunks(api, receipt);
    },

    async confirmSaveTarget(token): Promise<void> {
      const revision = ++targetStateVersion;
      const result: unknown = await api.confirmSaveTarget(token);
      if (revision !== targetStateVersion) return;
      hasTarget = result === true;
      // false なら本体側も古い保存先へ戻らないよう解除済みなので、画面側も false にする。
    },

    clearSaveTarget(): void {
      targetStateVersion += 1;
      hasTarget = false;
      // 画面側は即座に「保存先なし」へ倒す。IPC の失敗時も古い先へは保存しない。
      void api.clearSaveTarget().catch(() => undefined);
    },

    savePcad(suggestedName, bytes, saveAs, kind): Promise<string | null> {
      return saveContent(suggestedName, [bytes], saveAs, kind ?? 'part');
    },

    savePcadParts(suggestedName, parts, saveAs, kind): Promise<string | null> {
      return saveContent(suggestedName, parts, saveAs, kind ?? 'part');
    },

    hasSaveTarget(): boolean {
      return hasTarget;
    },
  };

  // 印刷の口(P6 計画書 タスク29)。古い preload は持たないので、あるときだけ足す。
  // 口が無ければ画面は Web と同じ道筋(`window.print()`)で印刷する(§1.5)。
  const printable: FileGateway = isDesktopPrintApi(api) ? { ...base, print: wrapPrint(api) } : base;

  if (!isDesktopExchangeApi(api)) {
    // 古い preload。部品の読み書きだけを渡す(画面は種類つきの口が無い口として扱い、
    // `openFileThrough` / `saveFileAsThrough` がブラウザ用の実装で答える)。
    return printable;
  }

  return {
    ...printable,

    // 返り値の形(`PickedTypedFile`)は `@pointercad/ui` の公開口に名前が出ていないので、
    // ここには書かずに `FileGateway` から受け取る(引数の種類の型も同じ経路で決まる)。
    async openParameterCsv() {
      let result: unknown;
      try {
        result = await api.openFile(['csv']);
      } catch (error) {
        const key = readFailureMessageKey(error);
        if (key !== null) throw new Error(t(key), { cause: error });
        throw error;
      }
      if (result === null || result === undefined) return null;
      if (!isOpenedTypedShape(result) || result.kind !== 'csv' ||
          !result.name.toLowerCase().endsWith('.csv')) {
        throw new Error(t('file.openFailed'));
      }
      const bytes = toBytes(result.bytes);
      if (bytes === null) throw new Error(t('file.openFailed'));
      if (bytes.byteLength > 1024 * 1024) throw new Error(t('file.error.tooLarge'));
      return { fileName: result.name, bytes };
    },

    async openFile(kinds) {
      let result: unknown;
      try {
        result = await api.openFile(kinds);
      } catch (error) {
        const key = readFailureMessageKey(error);
        if (key !== null) throw new Error(t(key), { cause: error });
        throw error;
      }
      if (result === null || result === undefined) {
        // 取り消された。
        return null;
      }
      if (!isOpenedTypedShape(result)) {
        throw new Error(t('file.openFailed'));
      }
      const bytes = toBytes(result.bytes);
      const kind = matchKind(kinds, result.kind);
      if (bytes === null || kind === null) {
        throw new Error(t('file.openFailed'));
      }
      // `hasTarget` を触らない。ここで開いたものは部品の上書き先にならない(§0.a-0.4)。
      return { kind, fileName: result.name, bytes };
    },

    async saveFileAs(fileName, kind, bytes, control): Promise<boolean> {
      const result: unknown = await controlledDesktopExport(api, control,
        (requestId) => requestId === undefined ? api.saveFileAs(fileName, kind, bytes)
          : api.saveFileAs(fileName, kind, bytes, requestId));
      if (result === true) {
        return true;
      }
      if (result === false || result === null || result === undefined) {
        // 取り消された。
        return false;
      }
      throw new Error(t('file.saveFailed'));
    },
  };
}
