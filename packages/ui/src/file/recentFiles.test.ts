/**
 * 最近使ったファイルの履歴の検査(計画書 docs/plans/P6-入出力.md タスク28 の「検証」の表)。
 *
 * 確かめるのは次の 4 つ。
 *  - 新しい順に 10 件まで、同じ名前は 2 件にならない(§0.a-0.38)。
 *  - **履歴に場所(パス)が入らない**(NFR-SE-1)。
 *  - `localStorage` が使えない環境でも例外を投げず、空の一覧で動く(P4 タスク1 の流儀)。
 *  - 壊れた値は空の一覧へ落ちる(NFR-UX-4)。
 *
 * ブラウザの API には触れない。置き場はすべて記憶上の偽物を渡す。
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_RECENT_FILES,
  fileNameOf,
  loadRecentFiles,
  pushRecentFile,
  recordRecentFile,
  saveRecentFiles,
  type RecentFile,
  type RecentFilesStorage,
} from './recentFiles.js';

/** 記憶上の偽の置き場。書かれた生の文字列をそのまま覗ける。 */
interface FakeStorage {
  readonly storage: RecentFilesStorage;
  /** 鍵に書かれている生の文字列(まだ何も書いていなければ null)。 */
  readonly raw: () => string | null;
  /** `setItem` が呼ばれた回数。 */
  readonly writes: () => number;
}

function createFakeStorage(initial: string | null = null): FakeStorage {
  let value = initial;
  let writes = 0;
  return {
    storage: {
      getItem: (key) => (key === 'pointercad.recentFiles' ? value : null),
      setItem: (key, next) => {
        if (key !== 'pointercad.recentFiles') {
          throw new Error(`知らない鍵へ書こうとしました: ${key}`);
        }
        writes += 1;
        value = next;
      },
    },
    raw: () => value,
    writes: () => writes,
  };
}

/** 触ると必ず失敗する置き場(書き込み枠が塞がっている環境の代わり)。 */
const brokenStorage: RecentFilesStorage = {
  getItem: () => {
    throw new Error('読めません');
  },
  setItem: () => {
    throw new Error('書けません');
  },
};

/** 時刻は検査のあいだ動かない。1 分ずつずらした ISO の時刻を作る。 */
function at(minute: number): string {
  return `2026-09-06T10:${String(minute).padStart(2, '0')}:00.000Z`;
}

/** 一覧の名前だけを並べる(順番の確認に使う)。 */
function namesOf(list: readonly RecentFile[]): readonly string[] {
  return list.map((entry) => entry.name);
}

describe('履歴に足す(FR-807、§0.a-0.38)', () => {
  it('何も無いところから読むと空の一覧', () => {
    expect(loadRecentFiles(createFakeStorage().storage)).toEqual([]);
  });

  it('3 件足すと新しい順に 3 件', () => {
    let list: readonly RecentFile[] = [];
    list = pushRecentFile(list, { name: '1.pcad', at: at(1) });
    list = pushRecentFile(list, { name: '2.pcad', at: at(2) });
    list = pushRecentFile(list, { name: '3.pcad', at: at(3) });

    expect(namesOf(list)).toEqual(['3.pcad', '2.pcad', '1.pcad']);
  });

  it(`11 件足すと ${String(MAX_RECENT_FILES)} 件になり、いちばん古いものが落ちる`, () => {
    let list: readonly RecentFile[] = [];
    for (let index = 1; index <= MAX_RECENT_FILES + 1; index += 1) {
      list = pushRecentFile(list, { name: `部品${String(index)}.pcad`, at: at(index) });
    }

    expect(list).toHaveLength(MAX_RECENT_FILES);
    expect(list[0].name).toBe('部品11.pcad');
    expect(list[MAX_RECENT_FILES - 1].name).toBe('部品2.pcad');
    // いちばん古い 1 件だけが落ちている。
    expect(namesOf(list)).not.toContain('部品1.pcad');
  });

  it('同じ名前を 2 回足しても 1 件のまま、時刻が新しくなって先頭へ移る', () => {
    let list: readonly RecentFile[] = [];
    list = pushRecentFile(list, { name: '同じ.pcad', at: at(1) });
    list = pushRecentFile(list, { name: 'ほか.pcad', at: at(2) });
    list = pushRecentFile(list, { name: '同じ.pcad', at: at(3) });

    expect(list).toEqual([
      { name: '同じ.pcad', at: at(3) },
      { name: 'ほか.pcad', at: at(2) },
    ]);
  });

  it('元の一覧は書き換えない(新しい一覧を返すだけ)', () => {
    const before: readonly RecentFile[] = [{ name: '1.pcad', at: at(1) }];

    pushRecentFile(before, { name: '2.pcad', at: at(2) });

    expect(before).toEqual([{ name: '1.pcad', at: at(1) }]);
  });

  it('名前が空白だけなら何も足さない(押しても開けない札を出さない)', () => {
    const before: readonly RecentFile[] = [{ name: '1.pcad', at: at(1) }];

    expect(pushRecentFile(before, { name: '   ', at: at(2) })).toEqual(before);
  });
});

describe('履歴に場所(パス)を持たない(NFR-SE-1)', () => {
  it('Windows のパスを渡してもファイル名だけを残す', () => {
    expect(fileNameOf('C:\\Users\\yuya\\Documents\\部品1.pcad')).toBe('部品1.pcad');
  });

  it('POSIX のパスを渡してもファイル名だけを残す', () => {
    expect(fileNameOf('/home/yuya/部品1.pcad')).toBe('部品1.pcad');
  });

  it('書き出した JSON にフォルダの名前が 1 文字も残らない', () => {
    const fake = createFakeStorage();

    recordRecentFile('C:\\Users\\yuya\\Documents\\部品1.pcad', {
      at: at(1),
      storage: fake.storage,
    });

    const raw = fake.raw();
    expect(raw).not.toBeNull();
    expect(raw).not.toContain('Users');
    expect(raw).not.toContain('yuya');
    expect(raw).not.toContain('\\');
    expect(loadRecentFiles(fake.storage)).toEqual([{ name: '部品1.pcad', at: at(1) }]);
  });

  it('保存された値に場所が混じっていたら壊れているとみなして読み捨てる', () => {
    const stored = JSON.stringify([{ name: 'C:\\部品1.pcad', at: at(1) }]);

    expect(loadRecentFiles(createFakeStorage(stored).storage)).toEqual([]);
  });

  it('書くときにも場所を落とす(直に渡された一覧が場所を持っていても)', () => {
    const fake = createFakeStorage();

    saveRecentFiles([{ name: '/home/yuya/部品1.pcad', at: at(1) }], fake.storage);

    expect(loadRecentFiles(fake.storage)).toEqual([{ name: '部品1.pcad', at: at(1) }]);
  });
});

describe('壊れた値・置き場が無い環境(NFR-UX-4、P4 タスク1 の流儀)', () => {
  it('壊れた JSON は空の一覧へ落ちる', () => {
    expect(loadRecentFiles(createFakeStorage('{壊れている').storage)).toEqual([]);
  });

  it('並びでない JSON も空の一覧へ落ちる', () => {
    expect(loadRecentFiles(createFakeStorage('{"name":"1.pcad"}').storage)).toEqual([]);
  });

  it('1 件でも壊れていたら一覧ごと捨てる(半分だけ採らない)', () => {
    const stored = JSON.stringify([
      { name: '1.pcad', at: at(1) },
      { name: 2, at: at(2) },
    ]);

    expect(loadRecentFiles(createFakeStorage(stored).storage)).toEqual([]);
  });

  it('時刻が読めない値も壊れているとみなす', () => {
    const stored = JSON.stringify([{ name: '1.pcad', at: 'きのう' }]);

    expect(loadRecentFiles(createFakeStorage(stored).storage)).toEqual([]);
  });

  it('余分な欄が付いていても 2 欄だけを写す', () => {
    const stored = JSON.stringify([{ name: '1.pcad', at: at(1), path: 'C:\\秘密' }]);

    expect(loadRecentFiles(createFakeStorage(stored).storage)).toEqual([
      { name: '1.pcad', at: at(1) },
    ]);
  });

  it('前の版が 10 件より多く書いていても、読むときに上限まで切りそろえる', () => {
    const many = Array.from({ length: MAX_RECENT_FILES + 5 }, (_ignored, index) => ({
      name: `部品${String(index)}.pcad`,
      at: at(index),
    }));

    expect(loadRecentFiles(createFakeStorage(JSON.stringify(many)).storage)).toHaveLength(
      MAX_RECENT_FILES,
    );
  });

  it('置き場が無い(`localStorage` が使えない)ときは空の一覧で、書いても例外を投げない', () => {
    expect(loadRecentFiles(null)).toEqual([]);
    expect(() => {
      saveRecentFiles([{ name: '1.pcad', at: at(1) }], null);
    }).not.toThrow();
    expect(recordRecentFile('1.pcad', { at: at(1), storage: null })).toEqual([
      { name: '1.pcad', at: at(1) },
    ]);
  });

  it('置き場が触るたびに失敗しても、読み書きは例外を投げない', () => {
    expect(loadRecentFiles(brokenStorage)).toEqual([]);
    expect(() => {
      saveRecentFiles([{ name: '1.pcad', at: at(1) }], brokenStorage);
    }).not.toThrow();
    expect(recordRecentFile('1.pcad', { at: at(1), storage: brokenStorage })).toEqual([
      { name: '1.pcad', at: at(1) },
    ]);
  });

  it('置き場を指定しなくても(端末の `localStorage` を探す既定でも)例外を投げない', () => {
    // 検査は Node で走るので `localStorage` は無い。無い環境で既定の経路を通しても
    // 落ちないことをここで押さえる(P4 タスク1 の失敗の再発防止)。
    expect(recordRecentFile('部品1.pcad', { at: at(1) })[0]).toEqual({
      name: '部品1.pcad',
      at: at(1),
    });
  });
});

describe('読む→足す→書くを 1 か所で(recordRecentFile)', () => {
  it('置き場に書き戻すので、次に読むと足した後の一覧になる', () => {
    const fake = createFakeStorage();

    recordRecentFile('1.pcad', { at: at(1), storage: fake.storage });
    recordRecentFile('2.pcad', { at: at(2), storage: fake.storage });

    expect(namesOf(loadRecentFiles(fake.storage))).toEqual(['2.pcad', '1.pcad']);
    expect(fake.writes()).toBe(2);
  });

  it('時刻を省くと「いま」を入れる(ISO 8601 で、読み直せる)', () => {
    const before = Date.now();

    const list = recordRecentFile('1.pcad', { storage: null });

    const recorded = Date.parse(list[0].at);
    expect(Number.isFinite(recorded)).toBe(true);
    expect(recorded).toBeGreaterThanOrEqual(before);
  });
});
