import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';

/**
 * OCCT(WASM)の仮想ファイルへの出し入れ(計画書 P6 §2.2、タスク6。FR-802 / FR-803)。
 *
 * OCCT の読み書き(STEP / STL / OBJ / glTF)は「ファイル名」しか受け取らない。
 * 実際のディスクへは書かず、Emscripten が WASM の中に持つ仮想のファイル置き場
 * (`oc.FS`)へ書かせてから、そのバイト列を取り出す。
 *
 * **規律:** 確保したものを必ず解放する(計画書 P5 §4、`allocations.ts`)のと同じ規律を
 * ファイルにも当てはめる。仮想の置き場は WASM の記憶を食い、残ったままだと次の
 * 書き出しが古い中身を読む。だから `finally` で必ず消す。
 *
 * **実測(2026-09-06、Node の opencascade.js 2.0.0-beta.b5ff984):**
 * - `oc.FS` は実行時に存在し、`writeFile` / `readFile` / `unlink` / `mkdir` / `readdir`
 *   はいずれも関数(`.test.ts` の 1 件目が毎回確かめる)。
 * - `readdir` は `'.'` と `'..'` を必ず含む配列を返す(型は `any` なので実行時に確かめる)。
 * - 既にある場所へ `mkdir` すると `errno` が 20(EEXIST)の例外になる。`code` は付かず、
 *   `message` は `'FS error'` の一言なので、`errno` で見分けるほかない。
 * - `readFile(path, { encoding: 'binary' })` は自前の `ArrayBuffer` を持つ `Uint8Array`
 *   を返す(`byteOffset` は 0、`buffer.byteLength` は中身と同じ)。WASM の記憶を直接
 *   指してはいないので、写し直さずそのまま返してよい。
 * - 0 バイトのファイルは長さ 0 の `Uint8Array` になり、例外にはならない。
 */

/** 出し入れに使う仮想の置き場。実際のディスクとは無関係。 */
const VIRTUAL_DIRECTORY = '/pointercad';

/**
 * 既にある場所へ `mkdir` したときの `errno`(2026-09-06 実測。EEXIST)。
 * これ以外の失敗(親が無い、名前が不正など)は握りつぶさずに投げ直す。
 */
const ERRNO_EEXIST = 20;

/**
 * ファイル名に使う連番。
 *
 * 同じ置き場を複数の書き出しが共有するため、名前が重なると互いの中身を壊す。
 * 連番は 1 つのモジュールで数え上げるので、入れ子でも続けて呼んでもぶつからない。
 */
let sequence = 0;

/** 次の連番を 1 つ取り出す。 */
function nextSerial(): number {
  sequence += 1;
  return sequence;
}

/** 仮想ファイルから取り出した 1 つぶんの中身。 */
export interface VirtualFileOutput {
  /** 置き場の中での名前(`1.obj` のような、連番+拡張子)。 */
  readonly name: string;
  /** ファイルの中身。0 バイトなら長さ 0 の並び。 */
  readonly bytes: Uint8Array;
}

/** 片付けの結果。最初の失敗だけを持ち帰り、本来の理由を上書きしないために使う。 */
interface CleanupResult {
  readonly failed: boolean;
  readonly error: unknown;
}

/**
 * 例外から `errno` を取り出す(無ければ `undefined`)。
 *
 * `oc.FS` が投げるのは Emscripten の `ErrnoError` で、型定義には現れない。
 * `as` で決めつけず、`in` と `typeof` で実際に確かめてから読む。型の絞り込みを
 * 外へ持ち出す述語(`x is T`)は作らない(計画書 P6 §4 の規約)。
 */
function errnoOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'errno' in error) {
    const value = error.errno;
    if (typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

/**
 * 置き場の中のファイル名を読む。
 *
 * `FS.readdir` の戻りは型定義の上では `any` なので、`as` で決めつけずに
 * 実行時に配列と文字列であることを確かめる。`'.'` と `'..'` は落とす。
 */
function readDirectoryNames(oc: OpenCascadeInstance): string[] {
  const listed: unknown = oc.FS.readdir(VIRTUAL_DIRECTORY);
  const entries: readonly unknown[] = Array.isArray(listed) ? listed : [];
  const names: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string' && entry !== '.' && entry !== '..') {
      names.push(entry);
    }
  }
  return names;
}

/**
 * 置き場を用意する。既にあるとき(EEXIST)だけを見逃し、ほかの失敗は投げ直す。
 *
 * OCCT の実体ごとに別の仮想ファイル系を持つ(Node の検査とブラウザの Worker は
 * 別々)ため、モジュール側で「作った」と覚え込まずに毎回確かめる。
 */
function ensureVirtualDirectory(oc: OpenCascadeInstance): void {
  try {
    oc.FS.mkdir(VIRTUAL_DIRECTORY);
  } catch (error) {
    if (errnoOf(error) !== ERRNO_EEXIST) {
      throw error;
    }
  }
}

/** 拡張子を `step` のような形に整える。使えない文字が入っていたら日本語の理由で断る。 */
function normalizeExtension(extension: string): string {
  const body = extension.startsWith('.') ? extension.slice(1) : extension;
  if (body.length === 0 || !/^[0-9A-Za-z]+$/.test(body)) {
    throw new Error(`書き出しの拡張子に使えない文字が入っています: ${extension}`);
  }
  return body.toLowerCase();
}

/**
 * 読み込みに渡された名前を、置き場の中の 1 つの名前へ整える。
 *
 * 区切り文字を含む名前をそのまま繋ぐと置き場の外へ書けてしまうため、
 * 末尾の名前だけを使う。拡張子は残す(OCCT の読み手が拡張子で形式を見分けるため)。
 */
function normalizeInputName(name: string): string {
  const parts = name.split(/[\\/]/);
  const base = parts[parts.length - 1] ?? '';
  if (base.length === 0 || base === '.' || base === '..') {
    throw new Error(`読み込みに使うファイル名が空です: ${name}`);
  }
  return base;
}

/** 指定した名前を全部消す。最初の失敗を持ち帰り、残りも最後まで消す。 */
function removeFiles(oc: OpenCascadeInstance, names: readonly string[]): CleanupResult {
  let failed = false;
  let error: unknown = undefined;
  for (const name of names) {
    try {
      oc.FS.unlink(`${VIRTUAL_DIRECTORY}/${name}`);
    } catch (failure) {
      // 1 つの失敗で残りを漏らすと WASM の記憶が増え続けるので、最後まで消してから知らせる。
      if (!failed) {
        failed = true;
        error = failure;
      }
    }
  }
  return { failed, error };
}

/**
 * 仮想ファイルへ書かせて、できたバイト列を受け取る(§2.2)。
 *
 * ```ts
 * const files = withVirtualFile(oc, 'step', (path) => {
 *   writer.Write(path);            // OCCT に path へ書かせる
 * });
 * // files[0].bytes が STEP の中身
 * ```
 *
 * `/pointercad/<連番>.<拡張子>` を作って `fn` に絶対パスを渡す。**`fn` の実行中に
 * 置き場へ増えたファイルは全部拾って返す**(OBJ の書き出しは `.obj` と `.mtl` の
 * 2 つを作る。計画書 §0.a-0.16)。並びは自分で頼んだ名前が先頭で、あとは名前順。
 *
 * `fn` が例外を投げても、書き出しが 1 つも作られなくても、**作られたものは `finally`
 * で必ず消す**。1 つも作られなかったときは日本語の理由で断る(NFR-RE-1。呼び出し側は
 * 「書けなかった」ことを黙って空の結果として受け取らない)。
 */
export function withVirtualFile(
  oc: OpenCascadeInstance,
  extension: string,
  fn: (path: string) => void,
): readonly VirtualFileOutput[] {
  const name = `${nextSerial()}.${normalizeExtension(extension)}`;
  ensureVirtualDirectory(oc);
  // 呼び出しの前後で置き場を見比べ、この呼び出しで増えたものだけを自分の後始末の対象にする。
  // 入れ子の呼び出しは自分の分を消してから戻るので、他人のファイルを巻き込むことはない。
  const before = new Set(readDirectoryNames(oc));

  let failed = false;
  let failure: unknown = undefined;
  try {
    fn(`${VIRTUAL_DIRECTORY}/${name}`);
  } catch (error) {
    failed = true;
    failure = error;
  }

  const created = readDirectoryNames(oc).filter(
    (candidate) => candidate === name || !before.has(candidate),
  );
  const ordered = [
    ...created.filter((candidate) => candidate === name),
    ...created.filter((candidate) => candidate !== name).sort((a, b) => a.localeCompare(b)),
  ];

  const outputs: VirtualFileOutput[] = [];
  let readFailed = false;
  let readFailure: unknown = undefined;
  if (!failed) {
    for (const entry of ordered) {
      try {
        outputs.push({
          name: entry,
          bytes: oc.FS.readFile(`${VIRTUAL_DIRECTORY}/${entry}`, { encoding: 'binary' }),
        });
      } catch (error) {
        if (!readFailed) {
          readFailed = true;
          readFailure = error;
        }
      }
    }
  }

  // 読めても読めなくても、作られたものは必ず消す。
  const cleanup = removeFiles(oc, ordered);

  // 本来の理由(利用者へ見せる日本語)を片付けの失敗で上書きしない。
  if (failed) {
    throw failure;
  }
  if (readFailed) {
    throw readFailure;
  }
  if (outputs.length === 0) {
    throw new Error(`書き出しの結果が作られませんでした: ${VIRTUAL_DIRECTORY}/${name}`);
  }
  if (cleanup.failed) {
    throw cleanup.error;
  }
  return outputs;
}

/**
 * バイト列を仮想ファイルへ置いてから読ませる(§2.2 の逆向き)。
 *
 * ```ts
 * const shape = withVirtualFileInput(oc, 'part.step', bytes, (path) => reader.ReadFile(path));
 * ```
 *
 * 名前は `<連番>-<渡された名前>` にする。**拡張子を残す**のは OCCT の読み手が
 * 拡張子で形式を見分けるため、**連番を前に付ける**のは同じ名前のファイルを続けて
 * 読んでもぶつからないようにするため。`fn` の戻り値はそのまま返す。
 *
 * `fn` が例外を投げても、**置いたファイルは `finally` で必ず消す**。
 */
export function withVirtualFileInput<T>(
  oc: OpenCascadeInstance,
  name: string,
  bytes: Uint8Array,
  fn: (path: string) => T,
): T {
  const stored = `${nextSerial()}-${normalizeInputName(name)}`;
  ensureVirtualDirectory(oc);
  oc.FS.writeFile(`${VIRTUAL_DIRECTORY}/${stored}`, bytes);

  // 片付けは必ず行うが、`finally` の中で throw すると本来の理由を消してしまう
  // (`no-unsafe-finally` も禁じている)。結果と失敗をいったん控えてから知らせる。
  let outcome: { readonly value: T } | undefined = undefined;
  let failed = false;
  let failure: unknown = undefined;
  try {
    outcome = { value: fn(`${VIRTUAL_DIRECTORY}/${stored}`) };
  } catch (error) {
    failed = true;
    failure = error;
  }
  const cleanup = removeFiles(oc, [stored]);
  if (failed) {
    throw failure;
  }
  if (cleanup.failed) {
    throw cleanup.error;
  }
  if (outcome === undefined) {
    // fn が例外を投げなければ必ず値が入るので、ここへは来ない。
    // 型の上の取りこぼしを黙って通さないために理由を付けて断る。
    throw new Error(`読み込みの結果を受け取れませんでした: ${VIRTUAL_DIRECTORY}/${stored}`);
  }
  return outcome.value;
}
