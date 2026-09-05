import { beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from './loadOcct.node.js';
import { withVirtualFile, withVirtualFileInput } from './virtualFile.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

/** 置き場に残っているファイル名(`.` と `..` を除く)。片付けの確認に使う。 */
function remaining(): string[] {
  // FS.readdir の戻りは型の上では any なので、as で決めつけずに実行時に確かめる。
  const listed: unknown = oc.FS.readdir('/pointercad');
  const entries: readonly unknown[] = Array.isArray(listed) ? listed : [];
  const names: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string' && entry !== '.' && entry !== '..') {
      names.push(entry);
    }
  }
  return names;
}

describe('仮想ファイルの出し入れ(P6 タスク6)', () => {
  it('oc.FS の出し入れの口が実行時に存在する(計画書 §1.5-2 の実測)', () => {
    expect(oc.FS).toBeTypeOf('object');
    // 静的メソッドは値として渡さない(@typescript-eslint/unbound-method)ので typeof で判定する。
    expect(typeof oc.FS.writeFile).toBe('function');
    expect(typeof oc.FS.readFile).toBe('function');
    expect(typeof oc.FS.unlink).toBe('function');
    expect(typeof oc.FS.mkdir).toBe('function');
    expect(typeof oc.FS.readdir).toBe('function');
  });

  it('書いたバイト列がそのまま戻り、名前は連番+拡張子になる', () => {
    let given = '';
    const files = withVirtualFile(oc, 'step', (path) => {
      given = path;
      oc.FS.writeFile(path, new Uint8Array([73, 83, 79, 45, 49, 48, 51, 48, 51]));
    });
    expect(given).toMatch(/^\/pointercad\/\d+\.step$/);
    expect(files).toHaveLength(1);
    expect(files[0].name).toMatch(/^\d+\.step$/);
    expect(Array.from(files[0].bytes)).toEqual([73, 83, 79, 45, 49, 48, 51, 48, 51]);
  });

  it('コールバックの後に置き場が空になる', () => {
    withVirtualFile(oc, 'stl', (path) => {
      oc.FS.writeFile(path, new Uint8Array([1, 2, 3, 4]));
    });
    expect(remaining()).toEqual([]);
  });

  it('コールバックが例外を投げても、書きかけのファイルが残らない', () => {
    const reason = new Error('書き出しの途中で断った');
    expect(() =>
      withVirtualFile(oc, 'step', (path) => {
        oc.FS.writeFile(path, new Uint8Array([9, 9, 9]));
        throw reason;
      }),
    ).toThrow(reason);
    expect(remaining()).toEqual([]);
  });

  it('2 つのファイルが作られたら 2 つとも拾う(OBJ の .obj と .mtl。§0.a-0.16)', () => {
    const files = withVirtualFile(oc, 'obj', (path) => {
      oc.FS.writeFile(path, new Uint8Array([111, 98, 106]));
      oc.FS.writeFile(path.replace(/\.obj$/, '.mtl'), new Uint8Array([109, 116, 108]));
    });
    expect(files).toHaveLength(2);
    // 頼んだ名前が先頭。残りは名前順。
    expect(files[0].name.endsWith('.obj')).toBe(true);
    expect(files[1].name.endsWith('.mtl')).toBe(true);
    expect(files[0].name.replace(/\.obj$/, '')).toBe(files[1].name.replace(/\.mtl$/, ''));
    expect(Array.from(files[0].bytes)).toEqual([111, 98, 106]);
    expect(Array.from(files[1].bytes)).toEqual([109, 116, 108]);
    expect(remaining()).toEqual([]);
  });

  it('名前は呼ぶたびに違う(連番が増える)', () => {
    const paths: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      withVirtualFile(oc, 'step', (path) => {
        paths.push(path);
        oc.FS.writeFile(path, new Uint8Array([index]));
      });
    }
    expect(new Set(paths).size).toBe(3);
    const serials = paths.map((path) => Number(/\/(\d+)\.step$/.exec(path)?.[1] ?? -1));
    expect(serials[1]).toBeGreaterThan(serials[0]);
    expect(serials[2]).toBeGreaterThan(serials[1]);
  });

  it('入れ子で 2 つ走っても互いのファイルを拾わない', () => {
    let innerName = '';
    const outer = withVirtualFile(oc, 'step', (outerPath) => {
      oc.FS.writeFile(outerPath, new Uint8Array([1]));
      const inner = withVirtualFile(oc, 'stl', (innerPath) => {
        oc.FS.writeFile(innerPath, new Uint8Array([2, 2]));
      });
      expect(inner).toHaveLength(1);
      innerName = inner[0].name;
      expect(Array.from(inner[0].bytes)).toEqual([2, 2]);
    });
    expect(outer).toHaveLength(1);
    expect(outer[0].name).not.toBe(innerName);
    expect(Array.from(outer[0].bytes)).toEqual([1]);
    expect(remaining()).toEqual([]);
  });

  it('0 バイトのファイルは空の並びとして返す(例外にしない)', () => {
    const files = withVirtualFile(oc, 'stl', (path) => {
      oc.FS.writeFile(path, new Uint8Array(0));
    });
    expect(files).toHaveLength(1);
    expect(files[0].bytes).toBeInstanceOf(Uint8Array);
    expect(files[0].bytes.length).toBe(0);
    expect(remaining()).toEqual([]);
  });

  it('1 つも作られなかったら日本語の理由で断る', () => {
    expect(() =>
      withVirtualFile(oc, 'step', () => {
        // 何も書かない(OCCT の書き手が黙って失敗した場合に相当)。
      }),
    ).toThrow(/書き出しの結果が作られませんでした/);
    expect(remaining()).toEqual([]);
  });

  it('拡張子に使えない文字が入っていたら日本語の理由で断る', () => {
    expect(() =>
      withVirtualFile(oc, '../step', (path) => {
        oc.FS.writeFile(path, new Uint8Array([0]));
      }),
    ).toThrow(/拡張子に使えない文字/);
    expect(remaining()).toEqual([]);
  });

  it('読み込みは渡したバイト列をパスから読ませ、戻り値をそのまま返す', () => {
    const bytes = new Uint8Array([115, 111, 108, 105, 100]);
    const readBack = withVirtualFileInput(oc, 'part.stl', bytes, (path) => {
      expect(path).toMatch(/^\/pointercad\/\d+-part\.stl$/);
      return oc.FS.readFile(path, { encoding: 'binary' });
    });
    expect(Array.from(readBack)).toEqual([115, 111, 108, 105, 100]);
    expect(remaining()).toEqual([]);
  });

  it('読み込みのコールバックが例外を投げても、置いたファイルが残らない', () => {
    const reason = new Error('読み込みの途中で断った');
    expect(() =>
      withVirtualFileInput(oc, 'broken.step', new Uint8Array([1, 2]), () => {
        throw reason;
      }),
    ).toThrow(reason);
    expect(remaining()).toEqual([]);
  });

  it('読み込みの名前に区切り文字が混ざっても置き場の外へ出さない', () => {
    const path = withVirtualFileInput(
      oc,
      'C:\\tmp\\..\\外の場所/part.step',
      new Uint8Array([1]),
      (given) => given,
    );
    expect(path).toMatch(/^\/pointercad\/\d+-part\.step$/);
    expect(remaining()).toEqual([]);
  });
});
