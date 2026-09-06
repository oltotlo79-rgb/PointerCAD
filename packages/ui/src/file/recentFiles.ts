/**
 * 最近使ったファイルの履歴(計画書 docs/plans/P6-入出力.md §0.a-0.38、タスク28)。
 *
 * 対応要件: FR-807(最近使ったファイル一覧)、NFR-SE-1(モデルデータをブラウザの外へ出さない)。
 *
 * **持つのはファイル名と時刻だけで、場所(パス)は持たない。** Web 版はブラウザが場所を
 * 渡さず(`PickedFile` は名前とバイト列だけ)、デスクトップ版も場所を画面へ渡さないと
 * 決めている(NFR-SE-1)。だから履歴から直に開くことはできず、できるのは
 * ①一覧を出す ②選ぶとその名前を初期値にしたファイル選択の窓を開く、の 2 つだけになる
 * (§0.a-0.38 の承認)。一覧の見せ方と入口はタスク33 が作る。
 *
 * 置き場は端末の `localStorage`(鍵は `pointercad.recentFiles` の 1 つだけ)。
 * **`localStorage` が使えない環境でも動く**(P4 タスク1 の流儀。空の一覧で静かに諦める)。
 * 表示設定(`settings/settings.ts`)と同じく、壊れている値は既定へ落として操作を止めない。
 */

import type { SettingsStorage } from '../settings/settings.js';

/**
 * 履歴 1 件。**この 2 欄しか持たない**(パスを足さない、NFR-SE-1)。
 * 欄が増えると「名前と時刻だけ」という約束が読む人に見えなくなるので、ここで閉じる。
 */
export interface RecentFile {
  /** 拡張子を含むファイル名。フォルダは含まない(`fileNameOf` で落とす)。 */
  readonly name: string;
  /** 開いた・保存した時刻。ISO 8601(`Date` の `toISOString`)。 */
  readonly at: string;
}

/** 覚えておく件数(§0.a-0.38 の既定)。これより古いものは落ちる。 */
export const MAX_RECENT_FILES = 10;

/** `localStorage` に持つ唯一の鍵。値は `RecentFile[]` の JSON。 */
const RECENT_FILES_STORAGE_KEY = 'pointercad.recentFiles';

/**
 * 履歴の読み書きに使う最小限の形。表示設定が使う `SettingsStorage` と同じ
 * (`localStorage` の `getItem` / `setItem` だけ)なので、形の写しは作らず名前だけ付ける。
 */
export type RecentFilesStorage = SettingsStorage;

// ---------------------------------------------------------------------------
// 名前の正規化(パスを持ち込ませない)
// ---------------------------------------------------------------------------

/** フォルダの区切り(Windows の `\` と POSIX の `/` の両方)。 */
const PATH_SEPARATORS: readonly string[] = ['\\', '/'];

/**
 * 場所つきの名前を渡されても**ファイル名だけ**を取り出す(NFR-SE-1)。
 *
 * いまの口(`PickedFile.name`)は名前しか渡してこないが、後から場所つきの名前を
 * 渡す口が増えたときに、履歴へ場所が紛れ込むのをここ 1 か所で止める。
 * 前後の空白も落とす(`withPcadExtension` と同じ扱い)。
 */
export function fileNameOf(name: string): string {
  let result = name.trim();
  for (const separator of PATH_SEPARATORS) {
    const index = result.lastIndexOf(separator);
    if (index >= 0) {
      result = result.slice(index + 1);
    }
  }
  return result.trim();
}

// ---------------------------------------------------------------------------
// 純関数(置き場に触れない)
// ---------------------------------------------------------------------------

/**
 * 履歴へ 1 件足した新しい一覧を返す(元の一覧は変えない)。
 *
 * - **新しいものが先頭。**
 * - **同じ名前は 2 件にしない**(前の 1 件を取り除いてから先頭へ置き直すので、時刻が
 *   新しくなって先頭へ移る)。同じファイルが一覧を埋めてしまうのを防ぐため。
 * - 名前は `fileNameOf` を通すので、場所つきで渡されてもファイル名だけが残る。
 * - 名前が空(空白だけ)なら**何も足さない。** 押しても開けない札を一覧へ出さないため。
 * - `MAX_RECENT_FILES` 件を超えたぶんは古いほうから落とす。
 */
export function pushRecentFile(
  list: readonly RecentFile[],
  entry: RecentFile,
): readonly RecentFile[] {
  const name = fileNameOf(entry.name);
  if (name.length === 0) {
    return list;
  }
  // 同じ名前は大文字小文字まで含めて同じときだけ 1 件とみなす。Windows は大文字小文字を
  // 区別しないが、Web は区別する。環境で履歴の件数が変わらないよう、狭いほう(区別する)へ揃える。
  const others = list.filter((item) => item.name !== name);
  return [{ name, at: entry.at }, ...others].slice(0, MAX_RECENT_FILES);
}

// ---------------------------------------------------------------------------
// 置き場(`localStorage`。無い環境・壊れた値でも止まらない)
// ---------------------------------------------------------------------------

function isRecentFilesStorage(value: unknown): value is RecentFilesStorage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getItem' in value &&
    typeof value.getItem === 'function' &&
    'setItem' in value &&
    typeof value.setItem === 'function'
  );
}

/**
 * 実行環境の `localStorage`。無ければ null。
 *
 * プライベートブラウジング等、`localStorage` という欄に**触れるだけで例外を投げる**
 * 実装があるので、存在確認そのものを try/catch で包む(`settings/settings.ts` の
 * 同名の関数と同じ判断。あちらは公開していないので、ここでも同じ小さな判定を持つ)。
 * 調べる相手を引数で受けるのは、検査で偽の `globalThis` を渡せるようにするため。
 */
function browserStorage(scope: object = globalThis): RecentFilesStorage | null {
  try {
    if (!('localStorage' in scope)) {
      return null;
    }
    const storage: unknown = scope.localStorage;
    return isRecentFilesStorage(storage) ? storage : null;
  } catch {
    return null;
  }
}

/**
 * 並びとして受け取り直す。`Array.isArray` はそのままだと要素の型が `any` になり、
 * 取り出した値の素性が分からなくなるので、`unknown` の並びとして受け止める
 * (`fileGateway.ts` の同名の関数と同じ受け方)。
 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** 保存されている 1 件として妥当か。**名前と時刻の 2 欄が揃い、時刻が読める**ことまで見る。 */
function isValidRecentFile(value: unknown): value is RecentFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('name' in value) || typeof value.name !== 'string' || value.name.trim().length === 0) {
    return false;
  }
  if (!('at' in value) || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) {
    return false;
  }
  // 場所が混ざっている値は「壊れている」とみなす(前の版が書いたものでも履歴へ入れない、NFR-SE-1)。
  // 名前をいったん定数へ受けるのは、関数の中では絞り込みが引き継がれないため。
  const name = value.name;
  return PATH_SEPARATORS.every((separator) => !name.includes(separator));
}

/**
 * 保存されている履歴を読む。**無い・壊れている・`localStorage` が使えない**のいずれでも
 * 空の一覧を返す(NFR-UX-4、P4 タスク1 の流儀)。例外は外へ出さない。
 *
 * 1 件でも壊れていたら**一覧ごと捨てる。** 半分だけ採ると、利用者から見て「なぜこの
 * ファイルだけ消えたのか」を説明できない一覧になるため(表示設定の壊れた値の扱いと同じ判断)。
 */
export function loadRecentFiles(
  storage: RecentFilesStorage | null = browserStorage(),
): readonly RecentFile[] {
  if (storage === null) {
    return [];
  }
  try {
    const raw = storage.getItem(RECENT_FILES_STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isUnknownArray(parsed) || !parsed.every(isValidRecentFile)) {
      return [];
    }
    // 欄が余分に付いていても 2 欄だけを写す(保存された形をそのまま持ち回らない)。
    // 前の版が 10 件より多く書いていても、読む側で上限まで切りそろえる。
    return parsed.slice(0, MAX_RECENT_FILES).map((entry) => ({ name: entry.name, at: entry.at }));
  } catch {
    return [];
  }
}

/**
 * 履歴を保存する。`localStorage` が使えない環境では黙って諦める(操作は止めない、NFR-RE-1)。
 * 上限を超えた一覧を渡されても、書くのは `MAX_RECENT_FILES` 件までにする。
 */
export function saveRecentFiles(
  list: readonly RecentFile[],
  storage: RecentFilesStorage | null = browserStorage(),
): void {
  if (storage === null) {
    return;
  }
  try {
    const trimmed = list
      .slice(0, MAX_RECENT_FILES)
      .map((entry) => ({ name: fileNameOf(entry.name), at: entry.at }));
    storage.setItem(RECENT_FILES_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // 書き込み枠が塞がっている等。開く・保存はもう終わっているので、失敗は伝えない。
  }
}

/** `recordRecentFile` の省ける欄。検査から偽の置き場と決まった時刻を渡すために開けてある。 */
export interface RecordRecentFileOptions {
  /** 記録する時刻(ISO 8601)。省略すると「いま」。 */
  readonly at?: string;
  /** 置き場。省略すると端末の `localStorage`(無ければ履歴を残さない)。 */
  readonly storage?: RecentFilesStorage | null;
}

/**
 * 「開いた」「保存した」を履歴へ 1 件足して書き戻し、足した後の一覧を返す
 * (読む→足す→書くの 3 つを 1 か所にまとめる。呼ぶ側は順番を気にしなくてよい)。
 *
 * 置き場が無い環境では、足した一覧を返すだけで何も書かない(例外は投げない)。
 */
export function recordRecentFile(
  name: string,
  options: RecordRecentFileOptions = {},
): readonly RecentFile[] {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const at = options.at ?? new Date().toISOString();
  const next = pushRecentFile(loadRecentFiles(storage), { name, at });
  saveRecentFiles(next, storage);
  return next;
}
