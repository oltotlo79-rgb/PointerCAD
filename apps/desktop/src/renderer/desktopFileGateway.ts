import { t, type FileGateway, type PickedFile } from '@pointercad/ui';
import type { DrawingPrintOptions } from '@pointercad/ui/print-settings';

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
  openPcad(kind?: 'part' | 'assembly' | 'all'): Promise<unknown>;
  confirmSaveTarget(token: string): Promise<unknown>;
  clearSaveTarget(): Promise<unknown>;
  savePcad(suggestedName: string, bytes: Uint8Array, saveAs: boolean,
    kind?: 'part' | 'assembly'): Promise<unknown>;
  hasSaveTarget(): Promise<unknown>;
}

/**
 * 種類つきの出し入れの口(P6 計画書 タスク4)。**別の型にしてある**のは、古い preload
 * (この 2 本を出さない版)でも部品の読み書きだけは動かすため(§1.5 の保険)。
 */
interface DesktopExchangeApi {
  openFile(kinds: readonly string[]): Promise<unknown>;
  saveFileAs(fileName: string, kind: string, bytes: Uint8Array): Promise<unknown>;
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
    'openPcad' in value &&
    typeof value.openPcad === 'function' &&
    'confirmSaveTarget' in value &&
    typeof value.confirmSaveTarget === 'function' &&
    'clearSaveTarget' in value &&
    typeof value.clearSaveTarget === 'function' &&
    'savePcad' in value &&
    typeof value.savePcad === 'function' &&
    'hasSaveTarget' in value &&
    typeof value.hasSaveTarget === 'function'
  );
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

/** 「開く」の答えの形。 */
interface OpenedShape {
  readonly name: string;
  readonly bytes: unknown;
  readonly saveTargetToken: unknown;
}

function isOpenedShape(value: unknown): value is OpenedShape {
  return (
    isObject(value) &&
    'name' in value &&
    typeof value.name === 'string' &&
    'bytes' in value &&
    'saveTargetToken' in value
  );
}

/** 種類つきの「開く」の答えの形。`kind` の綴りは `matchKind` で確かめる。 */
interface OpenedTypedShape extends OpenedShape {
  readonly kind: unknown;
}

function isOpenedTypedShape(value: unknown): value is OpenedTypedShape {
  return isOpenedShape(value) && 'kind' in value;
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

  const base: FileGateway = {
    async openPcad(kind): Promise<PickedFile | null> {
      const result: unknown = await api.openPcad(kind);
      if (result === null || result === undefined) {
        // 取り消された。
        return null;
      }
      if (!isOpenedShape(result)) {
        throw new Error(t('file.openFailed'));
      }
      const bytes = toBytes(result.bytes);
      if (bytes === null) {
        throw new Error(t('file.openFailed'));
      }
      if (typeof result.saveTargetToken !== 'string') {
        throw new Error(t('file.openFailed'));
      }
      return { name: result.name, bytes, saveTargetToken: result.saveTargetToken };
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

    async savePcad(suggestedName, bytes, saveAs, kind): Promise<string | null> {
      const revision = ++targetStateVersion;
      const result: unknown = await api.savePcad(suggestedName, bytes, saveAs, kind);
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
    async openFile(kinds) {
      const result: unknown = await api.openFile(kinds);
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

    async saveFileAs(fileName, kind, bytes): Promise<boolean> {
      const result: unknown = await api.saveFileAs(fileName, kind, bytes);
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
