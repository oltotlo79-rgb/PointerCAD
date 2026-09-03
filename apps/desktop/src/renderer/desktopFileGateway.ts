import { t, type FileGateway, type PickedFile } from '@pointercad/ui';

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
  openPcad(): Promise<unknown>;
  savePcad(suggestedName: string, bytes: Uint8Array, saveAs: boolean): Promise<unknown>;
  hasSaveTarget(): Promise<unknown>;
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isDesktopFileApi(value: unknown): value is DesktopFileApi {
  return (
    isObject(value) &&
    'openPcad' in value &&
    typeof value.openPcad === 'function' &&
    'savePcad' in value &&
    typeof value.savePcad === 'function' &&
    'hasSaveTarget' in value &&
    typeof value.hasSaveTarget === 'function'
  );
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
}

function isOpenedShape(value: unknown): value is OpenedShape {
  return isObject(value) && 'name' in value && typeof value.name === 'string' && 'bytes' in value;
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
   *  - 「開く」「保存」が成功したら「覚えている」にする(本体プロセスもそこで覚える)。
   *  - 作った直後に 1 度だけ本体プロセスへ聞き、覚えていれば控えも合わせる。画面を読み直しても
   *    本体プロセスの控えは残るため、これが無いと最初の Ctrl+S で余計に窓が出る。
   *
   * 控えは「覚えていない → 覚えている」の向きにしか動かないので、遅れて返ってきた
   * 問い合わせの答えが、その間に成功した保存の結果を打ち消すことはない。
   */
  let hasTarget = false;

  void api.hasSaveTarget().then(
    (value: unknown) => {
      if (value === true) {
        hasTarget = true;
      }
    },
    () => {
      // 聞けなかったときは「覚えていない」まま。次の保存で場所を尋ねるだけで済む。
    },
  );

  return {
    async openPcad(): Promise<PickedFile | null> {
      const result: unknown = await api.openPcad();
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
      // 開いたファイルはそのまま上書き先になる(本体プロセスが覚えている)。
      hasTarget = true;
      return { name: result.name, bytes };
    },

    async savePcad(suggestedName, bytes, saveAs): Promise<string | null> {
      const result: unknown = await api.savePcad(suggestedName, bytes, saveAs);
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
}
