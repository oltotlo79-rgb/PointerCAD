/**
 * 自動保存の保管庫と制御(要件 FR-805、NFR-RE-2)。
 *
 * 計画書 `docs/plans/P2-ソリッド基礎.md` のタスク16は「保管庫は document.json の文字列をそのまま
 * 保つ」案だったが、タスク15で `.pcad` の読み書き(`writePcadFile` / `readPcadFile`、
 * `packages/io/src/pcad/pcadFile.ts`)が確定したため、統括の指示によりこちらは
 * **`.pcad` のバイト列(ZIP)をそのまま保つ**方式にしている。読み込み側(サムネイル込みの
 * `readPcadFile`)と書式を1本化でき、UI 側は復元候補をそのまま「開く」と同じ経路で扱える。
 *
 * この一式は3層に分かれる。
 *  - `AutoSaveStorage`: 1件だけを読み書きする保管庫の抽象。
 *  - `createMemoryAutoSaveStorage` / `createIndexedDbAutoSaveStorage`: 上の実装2つ。
 *  - `createAutoSaver`: 「間隔ごとに、変更があるときだけ書く」制御(タイマー注入可能)。
 *
 * 文字列(UI に見せる文言)は持たない(ja.json 分離は ui 側、NFR-MA-5)。
 * 例外は外へ出さない(NFR-RE-1)。失敗は戻り値([`AutoSaveStorage`]の実装は静かに諦める)か
 * `createAutoSaver` の `onError` コールバックへ渡すだけで、`Promise` は常に解決する。
 */

import type { PartDocument } from '@pointercad/model';

import { isRecord } from './pcad/guards.js';
import { writePcadFile } from './pcad/pcadFile.js';

/** 自動保存の間隔(FR-805 の既定 5 分)。 */
export const AUTO_SAVE_INTERVAL_MS = 300_000;

/** 自動保存の1件。`bytes` は `writePcadFile` が作る `.pcad` そのもの(要件§8)。 */
export interface AutoSaveRecord {
  /** 保存時刻(ISO 8601)。`.pcad` の中の `savedAt` と同じ値。 */
  readonly savedAt: string;
  /** `.pcad` のバイト列(ZIP)。復元は `readPcadFile` で行う(ui 側)。 */
  readonly bytes: Uint8Array;
  /** 復元カードの表示に使う文書名(要件§0.a-0.12「前回の作業が残っています」)。 */
  readonly documentName: string;
}

/** 自動保存の保管庫の抽象。1件だけを持つ(鍵は実装側が固定する)。 */
export interface AutoSaveStorage {
  read(): Promise<AutoSaveRecord | null>;
  write(record: AutoSaveRecord): Promise<void>;
  clear(): Promise<void>;
}

/**
 * 検査用・IndexedDB が使えない環境用の記憶上の実装。
 * プロセス(タブ)の生存中だけ保つ。例外を投げない。
 */
export function createMemoryAutoSaveStorage(): AutoSaveStorage {
  let stored: AutoSaveRecord | null = null;
  return {
    read: () => Promise.resolve(stored),
    write: (record) => {
      stored = record;
      return Promise.resolve();
    },
    clear: () => {
      stored = null;
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// IndexedDB(ブラウザ用)
// ---------------------------------------------------------------------------

/*
 * packages/io の tsconfig は DOM の型を持たない(Node のユニットテストでも使われるため。
 * 計画書§1.1「idb は入れない」と同じ理由で、このファイルのためだけに DOM lib を足すことも
 * しない)。そのため IndexedDB の型は、実際に使う分だけを自前で最小限に宣言する。
 * ブラウザの実装がこれらのメソッドを持つことは信頼してよい契約とみなす(OCCT の embind バインディ
 * ングと同じ扱い)。読み書きする中身(AutoSaveRecord)だけは isAutoSaveRecord で実際に検査する。
 */
interface MinimalIDBRequest<T> {
  readonly result: T;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}
interface MinimalIDBOpenDBRequest extends MinimalIDBRequest<MinimalIDBDatabase> {
  onupgradeneeded: (() => void) | null;
}
interface MinimalIDBObjectStore {
  get(key: string): MinimalIDBRequest<unknown>;
  put(value: unknown, key: string): MinimalIDBRequest<unknown>;
  delete(key: string): MinimalIDBRequest<undefined>;
}
interface MinimalIDBTransaction {
  objectStore(name: string): MinimalIDBObjectStore;
}
interface MinimalIDBObjectStoreNames {
  contains(name: string): boolean;
}
interface MinimalIDBDatabase {
  readonly objectStoreNames: MinimalIDBObjectStoreNames;
  createObjectStore(name: string): unknown;
  transaction(storeName: string, mode: 'readonly' | 'readwrite'): MinimalIDBTransaction;
  close(): void;
}
interface MinimalIDBFactory {
  open(name: string, version: number): MinimalIDBOpenDBRequest;
}

/** globalThis を「indexedDB を持つかもしれない」形として扱う局所的な型(`as` を使わない)。 */
type GlobalWithIndexedDb = typeof globalThis & { readonly indexedDB?: MinimalIDBFactory };

/** いまの実行環境の `indexedDB`。無ければ null(Node のテスト、対応していないブラウザ)。 */
function currentIndexedDbFactory(): MinimalIDBFactory | null {
  const globalWithIndexedDb: GlobalWithIndexedDb = globalThis;
  return globalWithIndexedDb.indexedDB ?? null;
}

/** ストアから読んだ値が本当に自動保存の1件かを検査する(`as` を使わず、guards.ts の流儀に合わせる)。 */
function isAutoSaveRecord(value: unknown): value is AutoSaveRecord {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.savedAt === 'string' &&
    typeof value.documentName === 'string' &&
    value.bytes instanceof Uint8Array
  );
}

/** データベースを開く。無ければ(初回)ストアを作る。開けなければ null(例外を外へ出さない)。 */
function openIndexedDb(
  factory: MinimalIDBFactory,
  dbName: string,
  storeName: string,
): Promise<MinimalIDBDatabase | null> {
  return new Promise((resolve) => {
    let opened: MinimalIDBOpenDBRequest | null = null;
    try {
      opened = factory.open(dbName, 1);
    } catch {
      // 開けなかった(不正な名前・保存領域が使えない等)。null のまま次の分岐へ渡す。
    }
    if (opened === null) {
      resolve(null);
      return;
    }
    const request: MinimalIDBOpenDBRequest = opened;
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(storeName)) {
        database.createObjectStore(storeName);
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      resolve(null);
    };
  });
}

/** 1つの IDBRequest を Promise へ包む。失敗は null(例外を外へ出さない)。 */
function runIdbRequest<T>(request: MinimalIDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      resolve(null);
    };
  });
}

/** データベースを開き、指定の1操作だけを行って閉じる。`indexedDB` が無ければ何もせず null。 */
async function withObjectStore<T>(
  dbName: string,
  storeName: string,
  mode: 'readonly' | 'readwrite',
  run: (store: MinimalIDBObjectStore) => MinimalIDBRequest<T>,
): Promise<T | null> {
  const factory = currentIndexedDbFactory();
  if (factory === null) {
    return null;
  }
  const database = await openIndexedDb(factory, dbName, storeName);
  if (database === null) {
    return null;
  }
  try {
    const transaction = database.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    return await runIdbRequest(run(store));
  } catch {
    return null;
  } finally {
    database.close();
  }
}

const DEFAULT_DB_NAME = 'pointercad';
const DEFAULT_STORE_NAME = 'autosave';
/** 自動保存は常に1件だけを保つので、鍵は固定する(要件§8-2.9)。 */
const RECORD_KEY = 'current';

/**
 * ブラウザ用の IndexedDB 実装。データベース `pointercad`(既定)・オブジェクトストア
 * `autosave`(既定)・鍵 `current` の1件だけを扱う。
 *
 * **`indexedDB` が無い環境での挙動(統括への報告事項)**: `read` は常に `null`、
 * `write` / `clear` は何もしない(例外は投げない)。「理由つきで失敗する」案ではなく
 * 「静かに何もしない」を選んだ。自動保存は失敗しても操作を止めてはいけない機能
 * (NFR-RE-1「止めずに警告する」)であり、`AutoSaveStorage` の戻り値には失敗理由を運ぶ場所が
 * 無いため、`createAutoSaver` 側の `onError` を経由しない限りは黙って諦めるのが筋が良いと判断した。
 *
 * IndexedDB の実際の読み書きは Node のユニットテストでは検証できない
 * (`docs/報告記録.md` 2026-09-02 14:50 の④と同じ理由)。ここで検査するのは
 * 「`indexedDB` が無いときの分岐」だけで、実際の読み書きは E2E(タスク27)へ送る。
 */
export function createIndexedDbAutoSaveStorage(
  dbName: string = DEFAULT_DB_NAME,
  storeName: string = DEFAULT_STORE_NAME,
): AutoSaveStorage {
  return {
    async read() {
      const value = await withObjectStore(dbName, storeName, 'readonly', (store) =>
        store.get(RECORD_KEY),
      );
      return isAutoSaveRecord(value) ? value : null;
    },
    async write(record) {
      await withObjectStore(dbName, storeName, 'readwrite', (store) =>
        store.put(record, RECORD_KEY),
      );
    },
    async clear() {
      await withObjectStore(dbName, storeName, 'readwrite', (store) => store.delete(RECORD_KEY));
    },
  };
}

// ---------------------------------------------------------------------------
// 自動保存の制御(間隔・タイマー注入・重複防止)
// ---------------------------------------------------------------------------

/** 注入するタイマーが返す値の型。呼び出し側が渡す任意の値をそのまま運べるよう `unknown` にする。 */
export type AutoSaveTimerHandle = unknown;

type ScheduleFn = (handler: () => void, ms: number) => AutoSaveTimerHandle;
type CancelFn = (handle: AutoSaveTimerHandle) => void;

/**
 * 既定のタイマー。実行環境(ブラウザ・Node とも)の `setTimeout` / `clearTimeout` をそのまま使う。
 *
 * `packages/io` の型検査には(DOM lib を持たなくても)Node の型(`@types/node`)が自動で効いており、
 * その `clearTimeout` の引数は `NodeJS.Timeout | string | number | undefined` に限られ、
 * 外部から注入される `unknown` の `AutoSaveTimerHandle` をそのままは渡せない(実測、`as` は使わない
 * 方針のため型を合わせない)。そこで、ここで発行した実物のタイマー識別子は外へ出さず、
 * 自前の連番(`AutoSaveTimerHandle` としては単なる `number`)に対応づけて内部の Map に持つ。
 */
let nextDefaultTimerId = 0;
const activeDefaultTimers = new Map<number, ReturnType<typeof setTimeout>>();

function defaultScheduleFn(handler: () => void, ms: number): AutoSaveTimerHandle {
  const id = nextDefaultTimerId;
  nextDefaultTimerId += 1;
  const real = setTimeout(() => {
    activeDefaultTimers.delete(id);
    handler();
  }, ms);
  activeDefaultTimers.set(id, real);
  return id;
}
function defaultCancelFn(handle: AutoSaveTimerHandle): void {
  if (typeof handle !== 'number') {
    return;
  }
  const real = activeDefaultTimers.get(handle);
  if (real !== undefined) {
    clearTimeout(real);
    activeDefaultTimers.delete(handle);
  }
}

export interface AutoSaverOptions {
  readonly storage: AutoSaveStorage;
  /** 自動保存の間隔(ミリ秒)。既定 `AUTO_SAVE_INTERVAL_MS`(5分)。 */
  readonly intervalMs?: number;
  /** 検査で時刻を固定するための口。既定は `Date.now`。 */
  readonly now?: () => number;
  /** タイマーの差し替え口(検査で時間を進めるため)。既定は環境の `setTimeout`。 */
  readonly setTimeout?: ScheduleFn;
  /** タイマーの差し替え口。既定は環境の `clearTimeout`。 */
  readonly clearTimeout?: CancelFn;
  /** 書き込みに失敗したときの通知。例外は外へ出さない(NFR-RE-1)。 */
  readonly onError?: (error: unknown) => void;
}

export interface AutoSaver {
  /** 文書が変わったことを記録する。次の間隔の到来で、変更があるときだけ書く。 */
  markDirty(document: PartDocument): void;
  /** 間隔を待たず、いま渡した文書をすぐ書く(変更の有無を問わない)。 */
  saveNow(document: PartDocument): Promise<void>;
  /** 以後の自動保存(間隔ごとの書き込み)を止める。進行中の書き込みは止めない。 */
  stop(): void;
  /** 起動時の復元候補を読む。 */
  readLatest(): Promise<AutoSaveRecord | null>;
  /** 控えを消す(利用者が「破棄」を選んだとき)。 */
  discard(): Promise<void>;
}

/**
 * 自動保存の制御(FR-805、NFR-RE-2、計画書§0.a-0.11 / 0.12)。
 * `markDirty` で変更を記録し、`intervalMs` ごとに、前回書いた文書と違うときだけ
 * `writePcadFile` して保管庫へ書く(未変更なら書かない)。
 * 書き込み中に新しい依頼が来ても、二重に書き込みを始めず今動いている書き込みへ相乗りする
 * (「書き込み中の重複を避ける」)。例外は外へ出さない: 失敗は `onError` へ渡すだけで、
 * `saveNow` の戻り値の `Promise` は常に解決する。
 */
export function createAutoSaver(options: AutoSaverOptions): AutoSaver {
  const { storage, onError } = options;
  const intervalMs = options.intervalMs ?? AUTO_SAVE_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const scheduleFn = options.setTimeout ?? defaultScheduleFn;
  const cancelFn = options.clearTimeout ?? defaultCancelFn;

  /** markDirty / saveNow で渡された、最後に見た文書。 */
  let latestDocument: PartDocument | null = null;
  /** 最後に書き込みへ成功した文書(参照の一致で「変更があるか」を判定する)。 */
  let lastSavedDocument: PartDocument | null = null;
  /** 進行中の書き込み。null なら空いている。 */
  let writeInFlight: Promise<void> | null = null;
  let stopped = false;
  let timerHandle: AutoSaveTimerHandle = null;

  function hasPendingChange(): boolean {
    return latestDocument !== null && latestDocument !== lastSavedDocument;
  }

  function runWrite(document: PartDocument): Promise<void> {
    if (writeInFlight !== null) {
      // 書き込み中の重複を避ける: 新しい依頼は今動いている書き込みへ相乗りする。
      return writeInFlight;
    }
    const savedAt = new Date(now()).toISOString();
    const bytes = writePcadFile(document, { savedAt });
    const attempt = storage
      .write({ savedAt, bytes, documentName: document.name })
      .then(() => {
        lastSavedDocument = document;
      })
      .catch((error: unknown) => {
        onError?.(error);
      })
      .finally(() => {
        writeInFlight = null;
      });
    writeInFlight = attempt;
    return attempt;
  }

  function scheduleTick(): void {
    if (stopped) {
      return;
    }
    timerHandle = scheduleFn(tick, intervalMs);
  }

  function tick(): void {
    if (stopped) {
      return;
    }
    if (hasPendingChange() && latestDocument !== null) {
      void runWrite(latestDocument);
    }
    scheduleTick();
  }

  scheduleTick();

  return {
    markDirty(document) {
      latestDocument = document;
    },
    saveNow(document) {
      latestDocument = document;
      return runWrite(document);
    },
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      if (timerHandle !== null) {
        cancelFn(timerHandle);
        timerHandle = null;
      }
    },
    readLatest() {
      return storage.read();
    },
    discard() {
      return storage.clear();
    },
  };
}
