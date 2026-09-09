/**
 * ひな形の保存と「ひな形から新規」の手続き
 * (計画書 docs/plans/P6-入出力.md §2.10・§0.a-0.35・§0.a-0.36、タスク33)。
 *
 * 対応要件: FR-814(ひな形と単位)、FR-806(新規)、NFR-UX-3(失うものがある操作の前に確認)、
 * NFR-RE-1(失敗しても今の文書を壊さない)、要件§1.5(Web 版とデスクトップ版に機能差を作らない)。
 *
 * **判断はすべて純関数、外の世界へ触れる口は引数で受ける**(`exchangeFile.ts` と同じ流儀)。
 * 置き場(ブラウザの中 / 端末)は `TemplateStorage` の 4 つの口だけに閉じてあるので、
 * 検査では記憶上の偽の置き場を差し込める。
 *
 * **持ち場所は 2 つある**(§0.a-0.36 の承認)。
 *  - 置き場(`TemplateStorage`): Web 版はブラウザの中、デスクトップ版も同じ口を使う。
 *    一覧に出せるのはこちらで、「ひな形から新規」の行はここから作る。
 *  - ファイル(`.pcadt`): 「ひな形として保存」は置き場へ入れたあと、同じ中身をファイルにも
 *    書き出せる。環境をまたいで持ち運べるので、Web 版とデスクトップ版に機能差ができない。
 *
 * 中身は部品の `.pcad` と 1 バイトも変わらない(封筒の種別と拡張子だけが違う。§0.a-0.35)ので、
 * 読み書きは `packages/io` の `writePcadFile` / `readPcadFile` をそのまま使う。
 */

import {
  isTemplateKind,
  PCAD_TEMPLATE_KIND,
  readPcadFile,
  writePcadFile,
} from '@pointercad/io';
import {
  documentFromTemplate,
  openTemplate,
  templateFromDocument,
  type LengthUnit,
  type PartDocument,
  type TemplateNotice,
  type TemplateRefusal,
  type ToolDefaults,
} from '@pointercad/model';

import type { MessageKey } from '../i18n/t.js';

import {
  extensionsOf,
  openFileThrough,
  saveFileAsThrough,
  type FileGateway,
} from './fileGateway.js';
import { openErrorMessageKey } from './partFile.js';
import { saveFailureMessageKey } from './saveFailure.js';

// ---------------------------------------------------------------------------
// 置き場(list / get / put / remove の 4 つだけ)
// ---------------------------------------------------------------------------

/**
 * 置き場に入っているひな形 1 つ。
 *
 * 中身は `.pcadt` のバイト列そのもの(自動保存の `AutoSaveRecord` と同じ持ち方)。
 * 文書へ開き直す道筋を 1 本にできるので、置き場から出したものとファイルから開いたものが
 * 同じ経路(`readTemplateBytes`)を通る。
 */
export interface StoredTemplate {
  /** 置き場の鍵。`templateIdOf` が名前から作る(同じ名前で保存し直すと上書きされる)。 */
  readonly id: string;
  /** 一覧に出す名前。 */
  readonly name: string;
  /** 保存した時刻(ISO 8601)。一覧の並び順に使う。 */
  readonly savedAt: string;
  /** `.pcadt` のバイト列。 */
  readonly bytes: Uint8Array;
}

/**
 * 一覧に出すときの見出し(中身のバイト列を読まずに済む 3 欄)。
 *
 * 一覧を作るたびに全部のバイト列を運ぶと、ひな形が 10 個あるだけで数 MB を持ち回ることに
 * なる。開くと決めたときにだけ `get` で中身を取りに行く。
 */
export type StoredTemplateSummary = Omit<StoredTemplate, 'bytes'>;

/**
 * ひな形の置き場(§0.a-0.36)。**口は 4 つだけ**にして、どこに置くか(ブラウザの中か、
 * 記憶の上か)を手続きから隠す。例外は投げない——置き場が使えない環境でも操作を止めない
 * (NFR-RE-1。`AutoSaveStorage` と同じ約束)。
 */
export interface TemplateStorage {
  /** 置き場にあるひな形の見出し。並び順は決めない(並べ替えは `sortTemplates`)。 */
  list(): Promise<readonly StoredTemplateSummary[]>;
  /** 中身を取り出す。無ければ null。 */
  get(id: string): Promise<StoredTemplate | null>;
  /** 入れる(同じ id があれば置き換える)。 */
  put(template: StoredTemplate): Promise<void>;
  /** 取り除く。無い id を渡されても何も起きない。 */
  remove(id: string): Promise<void>;
}

/**
 * 置き場に残すひな形の上限。
 *
 * 画面から消す入口を作らない(操作は「ひな形として保存」「ひな形から新規」の 2 つだけ、
 * §0.a-0.36)ので、際限なく溜まらないよう**古いものから落ちる**ようにする。
 * 最近使ったファイル(`MAX_RECENT_FILES`)と同じ考え方で、同じ 10 件にそろえてある。
 */
export const MAX_STORED_TEMPLATES = 10;

/** ひな形のファイルの拡張子。表の正本は `fileGateway.ts` の `FILE_KIND_SPECS` 1 か所だけ。 */
const TEMPLATE_EXTENSION = extensionsOf('pcadt')[0];

/**
 * 名前を `.pcadt` で終わらせる(大文字小文字は問わない)。前後の空白は落とす。
 * `withPcadExtension` と同じ振る舞いで、拡張子だけが違う。
 */
export function withTemplateExtension(name: string): string {
  const trimmed = name.trim();
  return trimmed.toLowerCase().endsWith(TEMPLATE_EXTENSION)
    ? trimmed
    : `${trimmed}${TEMPLATE_EXTENSION}`;
}

/**
 * 名前から置き場の鍵を作る。
 *
 * **同じ名前で保存し直したら上書きする**ための決めで、名前をそのまま鍵にする
 * (前後の空白と拡張子だけ落とす)。別の鍵を採ると、同じ名前のひな形が一覧に 2 行並び、
 * 利用者にはどちらが新しいのか見分けられない。
 */
export function templateIdOf(name: string): string {
  const trimmed = name.trim();
  return trimmed.toLowerCase().endsWith(TEMPLATE_EXTENSION)
    ? trimmed.slice(0, trimmed.length - TEMPLATE_EXTENSION.length).trim()
    : trimmed;
}

/**
 * 新しいものが先頭に来る並び(元の一覧は変えない)。時刻が同じときは名前の順。
 * 時刻は ISO 8601 なので、文字として比べるだけで新しい順になる。
 */
export function sortTemplates(
  list: readonly StoredTemplateSummary[],
): readonly StoredTemplateSummary[] {
  return [...list].sort((left, right) => {
    if (left.savedAt !== right.savedAt) {
      return left.savedAt < right.savedAt ? 1 : -1;
    }
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
}

/**
 * 上限を超えたぶんの id(古いほうから)。`MAX_STORED_TEMPLATES` 件までは残る。
 * 一覧が上限以下なら空の並びを返す(消すものが無い)。
 */
export function templateIdsToDrop(
  list: readonly StoredTemplateSummary[],
  max: number = MAX_STORED_TEMPLATES,
): readonly string[] {
  return sortTemplates(list)
    .slice(Math.max(0, max))
    .map((entry) => entry.id);
}

// ---------------------------------------------------------------------------
// 置き場の実装(記憶の上 / ブラウザの中)
// ---------------------------------------------------------------------------

/** 見出しだけを取り出す(中身のバイト列を運ばない)。 */
function summaryOf(template: StoredTemplate): StoredTemplateSummary {
  return { id: template.id, name: template.name, savedAt: template.savedAt };
}

/**
 * 検査用・ブラウザの置き場が使えない環境用の記憶上の実装。
 * そのタブが生きている間だけ保つ(`createMemoryAutoSaveStorage` と同じ役目)。
 */
export function createMemoryTemplateStorage(): TemplateStorage {
  const stored = new Map<string, StoredTemplate>();
  return {
    list: () => Promise.resolve([...stored.values()].map(summaryOf)),
    get: (id) => Promise.resolve(stored.get(id) ?? null),
    put: (template) => {
      stored.set(template.id, template);
      return Promise.resolve();
    },
    remove: (id) => {
      stored.delete(id);
      return Promise.resolve();
    },
  };
}

/*
 * ブラウザの中の置き場。**自動保存(`packages/io` の `createIndexedDbAutoSaveStorage`)と
 * 同じ流儀**にそろえる(§0.a-0.36 の承認)。ただし**データベースは別にする**:
 * 自動保存のデータベース(`pointercad`)は版 1 で開かれていて、同じ版のまま別の入れ物を
 * 足すことはできない(版を上げると、先に開いた側が開けなくなる)。名前を分ければ、
 * どちらの側も自分の版だけを見ていればよい。
 *
 * 実際の読み書きは Node の単体検査では確かめられない(`indexedDB` が無い。
 * `packages/io` の同じ注記と同じ理由)ので、ここで検査するのは「置き場が無いときの分岐」
 * だけにし、通しの確認は画面での実測(統括の実機確認)へ送る。
 */

/** ひな形を入れるデータベースと入れ物の名前。 */
const TEMPLATE_DB_NAME = 'pointercad-templates';
const TEMPLATE_STORE_NAME = 'templates';
/** データベースの版。入れ物を増やすときだけ上げる。 */
const TEMPLATE_DB_VERSION = 1;

/**
 * いまの実行環境の `indexedDB`。無ければ null(Node の検査、使えないブラウザ)。
 *
 * `globalThis` を「持っているかもしれない」形で受け直すのは、DOM の型では必ず在ることに
 * なっているため(`as` は使わない。`packages/io` の `GlobalWithIndexedDb` と同じ書き方)。
 */
function currentIndexedDb(): IDBFactory | null {
  const scope: { readonly indexedDB?: IDBFactory } = globalThis;
  return scope.indexedDB ?? null;
}

/** 置き場から読んだ値が本当にひな形 1 件かを確かめる(`as` を使わずに絞る)。 */
function isStoredTemplate(value: unknown): value is StoredTemplate {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return (
    'id' in value &&
    typeof value.id === 'string' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'savedAt' in value &&
    typeof value.savedAt === 'string' &&
    'bytes' in value &&
    value.bytes instanceof Uint8Array
  );
}

/** 1 つの依頼を約束へ包む。失敗は null(例外を外へ出さない)。 */
function runRequest<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      resolve(null);
    };
  });
}

/** データベースを開く。無ければ(初回)入れ物を作る。開けなければ null。 */
function openTemplateDb(factory: IDBFactory): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let opened: IDBOpenDBRequest | null = null;
    try {
      opened = factory.open(TEMPLATE_DB_NAME, TEMPLATE_DB_VERSION);
    } catch {
      // 開けなかった(保存領域が使えない等)。null のまま次の分岐へ渡す。
    }
    if (opened === null) {
      resolve(null);
      return;
    }
    const request: IDBOpenDBRequest = opened;
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(TEMPLATE_STORE_NAME)) {
        // 鍵は記録の中の `id` を使う(鍵を別に渡さずに済む)。
        database.createObjectStore(TEMPLATE_STORE_NAME, { keyPath: 'id' });
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

/** データベースを開き、指定の 1 操作だけを行って閉じる。使えなければ何もせず null。 */
async function withTemplateStore<T>(
  mode: 'readonly' | 'readwrite',
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const factory = currentIndexedDb();
  if (factory === null) {
    return null;
  }
  const database = await openTemplateDb(factory);
  if (database === null) {
    return null;
  }
  try {
    const store = database.transaction(TEMPLATE_STORE_NAME, mode).objectStore(TEMPLATE_STORE_NAME);
    return await runRequest(run(store));
  } catch {
    return null;
  } finally {
    database.close();
  }
}

/**
 * ブラウザの中の置き場(§0.a-0.36)。使えない環境では `list` が空、`get` が null、
 * `put` / `remove` が何もしない(例外は投げない。自動保存と同じ約束)。
 */
export function createIndexedDbTemplateStorage(): TemplateStorage {
  return {
    async list() {
      // `getAll` の戻りは DOM の型では素性の分からない並びなので、`unknown` の並びとして
      // 受け止めてから 1 件ずつ確かめる(`as` を使わない。`fileGateway.ts` と同じ流儀)。
      const values = await withTemplateStore<unknown[]>('readonly', (store) => store.getAll());
      if (values === null) {
        return [];
      }
      // 1 件でも壊れていたら、その 1 件だけを外す(一覧ごと捨てると、無事なひな形まで
      // 消えたように見える。壊れた 1 件は開こうとした時に断られる)。
      return values.filter(isStoredTemplate).map(summaryOf);
    },
    async get(id) {
      const value = await withTemplateStore<unknown>('readonly', (store) => store.get(id));
      return isStoredTemplate(value) ? value : null;
    },
    async put(template) {
      await withTemplateStore('readwrite', (store) => store.put(template));
    },
    async remove(id) {
      await withTemplateStore('readwrite', (store) => store.delete(id));
    },
  };
}

// ---------------------------------------------------------------------------
// 読み込み(バイト列 → ひな形。純関数)
// ---------------------------------------------------------------------------

/**
 * ひな形として開けない理由の文言(§2.8 の断りの表)。
 *
 * **断りのコードも文言も増やさない**——`.pcad` の種別違いと同じ `file.error.wrongKind`
 * (「PointerCAD の部品ファイルではないようです。」)へ寄せる(`packages/io` の
 * `isTemplateKind` の注記、`docs/報告記録.md` 2026-09-04 01:40 の③)。
 */
const TEMPLATE_REFUSAL_KEYS: Readonly<Record<TemplateRefusal, MessageKey>> = {
  notTemplate: 'file.error.wrongKind',
};

/** ひな形を読んだ結果。読めたら**新しい部品の材料**がそろって返る。 */
export type ReadTemplateOutcome =
  | {
      readonly ok: true;
      /** ひな形から起こした新しい部品(新しい id、履歴は空)。 */
      readonly document: PartDocument;
      /** ひな形が持ち運んでいた表示の単位(FR-811、FR-814)。 */
      readonly lengthUnit: LengthUnit;
      /** ひな形が持ち運んでいた道具の既定値(FR-814)。 */
      readonly toolDefaults: ToolDefaults;
      /**
       * 知らせることがあれば入る(形の入ったひな形)。無ければ null。
       *
       * **文言ではなくコードのまま返す。** model が「断りと知らせはコードだけを返し、
       * 利用者へ見せる文言は ui が持つ」(`part/templates.ts` の冒頭)と決めているのに
       * 合わせ、画面に近い側(ツールバーの配線)で `ja.json` の文言へ直す。
       */
      readonly notice: TemplateNotice | null;
    }
  | { readonly ok: false; readonly messageKey: MessageKey };

/**
 * `.pcadt` のバイト列からひな形を読み、新しい部品を起こす(FR-814、§2.10)。
 *
 * 置き場から出したものもファイルから開いたものも**同じここを通る**(読めなかった理由の
 * 言い換えを 2 か所に持たない。`readPartDocument` と同じ考え方)。
 *
 * **形の入ったひな形も断らない。** 知らせを 1 つ返して、履歴を空にして開く(§2.10。
 * 履歴を空にするのは model の `documentFromTemplate`)。
 */
export function readTemplateBytes(bytes: Uint8Array): ReadTemplateOutcome {
  const result = readPcadFile(bytes);
  if (!result.ok) {
    // 読めなかった理由の言い換えは `partFile.ts` の表 1 つだけが持つ(写しを作らない)。
    return { ok: false, messageKey: openErrorMessageKey(result.error.code) };
  }
  const opened = openTemplate({
    // ひな形かどうかは**封筒の種別**で決める(拡張子は名前を変えれば何とでもなる、§0.a-0.35)。
    isTemplate: isTemplateKind(result.kind),
    document: result.document,
    lengthUnit: result.lengthUnit,
    toolDefaults: result.toolDefaults,
  });
  if (!opened.ok) {
    return { ok: false, messageKey: TEMPLATE_REFUSAL_KEYS[opened.reason] };
  }
  return {
    ok: true,
    document: documentFromTemplate(opened.template),
    lengthUnit: opened.template.lengthUnit,
    toolDefaults: opened.template.toolDefaults,
    notice: opened.notice,
  };
}

// ---------------------------------------------------------------------------
// 手続き(外の世界へ触れる口は引数で受ける)
// ---------------------------------------------------------------------------

/** 手続きが外の世界へ触れる口。検査では偽物を差し込む。 */
export interface TemplateDeps {
  /** ファイルの出し入れ(ストアが持っている口をそのまま渡す)。 */
  readonly gateway: FileGateway;
  /** ひな形の置き場。 */
  readonly storage: TemplateStorage;
  /** 保存する時刻(ISO 8601)。検査では固定した値を渡す。 */
  readonly now?: () => string;
}

/** 「ひな形として保存」に渡すもの。 */
export interface SaveTemplateRequest {
  /** いま開いている部品。ここから履歴を落としたものがひな形になる。 */
  readonly document: PartDocument;
  /** いまの表示の単位(端末の設定。§0.a-0.1)。 */
  readonly lengthUnit: LengthUnit;
  /** いまの道具の既定値。 */
  readonly toolDefaults: ToolDefaults;
  /** ひな形の名前。空白だけなら部品の名前を使う。 */
  readonly name: string;
}

/** 「ひな形として保存」の結果。 */
export type SaveTemplateOutcome =
  | {
      readonly ok: true;
      /** 置き場へ入った 1 件。 */
      readonly saved: StoredTemplateSummary;
      /** ファイルにも書いたか(窓を取り消したら false。置き場へは残っている)。 */
      readonly wroteFile: boolean;
    }
  | { readonly ok: false; readonly messageKey: MessageKey };

/**
 * いまの部品をひな形として保存する(FR-814、§2.10)。
 *
 * **置き場が先、ファイルは後。** 置き場へ入れてからファイルの窓を出すので、窓を取り消しても
 * ひな形は残る(「保存したのに何も残らなかった」を作らない)。ファイルにも書けるので、
 * Web 版で作ったひな形をデスクトップ版へ持って行ける(要件§1.5)。
 *
 * **履歴は持ち越さない**(`templateFromDocument`)。パラメータ表・外観・単位・道具の
 * 既定値だけが新しい部品へ引き継がれる(§2.10 の表)。
 */
export async function saveTemplate(
  deps: TemplateDeps,
  request: SaveTemplateRequest,
): Promise<SaveTemplateOutcome> {
  const name = request.name.trim().length > 0 ? request.name.trim() : request.document.name;
  const template = templateFromDocument(request.document, {
    lengthUnit: request.lengthUnit,
    toolDefaults: request.toolDefaults,
    name,
  });
  const savedAt = deps.now?.() ?? new Date().toISOString();
  const bytes = writePcadFile(template.document, {
    // 封筒の種別だけがひな形と部品を分ける(§0.a-0.35)。ZIP の作りは 1 文字も変わらない。
    kind: PCAD_TEMPLATE_KIND,
    lengthUnit: template.lengthUnit,
    toolDefaults: template.toolDefaults,
    savedAt,
  });
  const record: StoredTemplate = { id: templateIdOf(name), name, savedAt, bytes };
  await deps.storage.put(record);
  // 上限を超えたぶんを古いほうから落とす(消す入口を画面に作らないため。§0.a-0.36)。
  for (const id of templateIdsToDrop(await deps.storage.list())) {
    await deps.storage.remove(id);
  }

  let wroteFile: boolean;
  try {
    wroteFile = await saveFileAsThrough(
      deps.gateway,
      withTemplateExtension(name),
      'pcadt',
      bytes,
    );
  } catch (error) {
    // ファイルへは書けなかったが、置き場には残っている。理由だけを伝える(NFR-UX-5)。
    return { ok: false, messageKey: saveFailureMessageKey(error) };
  }
  return { ok: true, saved: summaryOf(record), wroteFile };
}

/** どのひな形から始めるか。 */
export type TemplateSource =
  /** 置き場の 1 件(一覧の行から選んだもの)。 */
  | { readonly from: 'stored'; readonly id: string }
  /** ファイル(`.pcadt`)を選んで開く。 */
  | { readonly from: 'file' };

/** 「ひな形から新規」の結果。取り消しは断りを出さない(NFR-UX-3)。 */
export type NewFromTemplateOutcome =
  | (ReadTemplateOutcome & { readonly ok: true })
  | { readonly ok: false; readonly messageKey: MessageKey }
  /** 一覧に出ていたひな形が置き場から消えていた(別のタブで上書きされた等)。 */
  | { readonly ok: false; readonly missing: true }
  | { readonly ok: false; readonly cancelled: true };

/**
 * ひな形から新しい部品を起こす(FR-814、§2.10)。
 *
 * **読み切って中身も確かめられたときだけ**新しい部品を返す(NFR-RE-1)。呼び出し側は
 * 返ってきた文書をそのまま差し替えればよく、途中で失敗した場合は今の部品を触らずに済む。
 */
export async function newFromTemplate(
  deps: TemplateDeps,
  source: TemplateSource,
): Promise<NewFromTemplateOutcome> {
  if (source.from === 'stored') {
    const stored = await deps.storage.get(source.id);
    if (stored === null) {
      return { ok: false, missing: true };
    }
    const outcome = readTemplateBytes(stored.bytes);
    if (outcome.ok) {
      // ひな形は「開いた文書」ではなく新しい文書の出発点なので、前の保存先を持ち越さない。
      deps.gateway.clearSaveTarget?.();
    }
    return outcome;
  }
  let picked;
  try {
    picked = await openFileThrough(deps.gateway, ['pcadt']);
  } catch {
    return { ok: false, messageKey: 'file.openFailed' };
  }
  if (picked === null) {
    // 窓を取り消した。何も起きなかったので断りも出さない。
    return { ok: false, cancelled: true };
  }
  const outcome = readTemplateBytes(picked.bytes);
  if (outcome.ok) {
    deps.gateway.clearSaveTarget?.();
  }
  return outcome;
}
