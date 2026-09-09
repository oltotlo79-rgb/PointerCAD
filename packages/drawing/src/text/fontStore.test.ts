import { describe, expect, it, vi } from 'vitest';
import { createFontStore, type DrawingFont } from './fontStore.js';

const font: DrawingFont = {
  id: 'sample', hasGlyph: (character) => character !== '🙂', advance: (text, size) => text === '' ? 0 : size * 2,
  commands: (text, size) => text === '' ? [] : [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: size, y: -size }],
};
const ready = () => createFontStore({ read: () => Promise.resolve(new ArrayBuffer(4)), parse: () => font });
describe('字体の取得と失敗時の代替表示(P8-44)', () => {
  it('未読込は枠を返し、文字幅を推測しない', () => {
    const store = ready();
    expect(store.status).toBe('unloaded');
    expect(store.outline('板', 3.5)).toMatchObject({ status: 'unloaded', metrics: null, missingCharacters: [] });
    expect(store.outline('板', 3.5).subpaths[0].commands).toHaveLength(5);
  });
  it('同時に頼まれても取得と解析は1回だけ', async () => {
    const read = vi.fn(() => Promise.resolve(new ArrayBuffer(4))), parse = vi.fn(() => font);
    const store = createFontStore({ read, parse });
    const first = store.load(), second = store.load();
    expect(first).toBe(second);
    expect(store.outline('板', 3.5).status).toBe('loading');
    expect(await first).toBe('ready');
    expect(await store.load()).toBe('ready');
    expect(read).toHaveBeenCalledTimes(1);
    expect(parse).toHaveBeenCalledTimes(1);
  });
  it('解析した字体の実際の送り幅と墨の範囲を返す', async () => {
    const store = ready(); await store.load();
    expect(store.outline('板', 3.5)).toMatchObject({ status: 'ready', metrics: {
      fontId: 'sample', advanceMm: 7, sizeMm: 3.5, inkBounds: { left: 0, bottom: -0, right: 3.5, top: 3.5 },
    } });
  });
  it('欠字を未読込と区別し、サロゲートペアを1文字として返す', async () => {
    const store = ready(); await store.load();
    expect(store.outline('🙂🙂板', 3.5)).toMatchObject({ status: 'missingGlyph', metrics: null, missingCharacters: ['🙂'] });
    expect(store.status).toBe('ready');
  });
  it('取得失敗から再試行できる', async () => {
    const read = vi.fn<() => Promise<ArrayBuffer>>().mockRejectedValueOnce(new Error('network')).mockResolvedValue(new ArrayBuffer(4));
    const store = createFontStore({ read, parse: () => font });
    expect(await store.load()).toBe('failed');
    expect(store.outline('板', 3.5).status).toBe('failed');
    expect(await store.load()).toBe('ready');
  });
  it('同期的な取得/解析の例外も画面へ投げない', async () => {
    for (const store of [createFontStore({ read: () => { throw new Error('read'); } }),
      createFontStore({ read: () => Promise.resolve(new ArrayBuffer(4)), parse: () => { throw new Error('parse'); } })]) {
      expect(await store.load()).toBe('failed');
    }
  });
  it('空文字の実測値は幅0・空の輪郭になる', async () => {
    const store = ready(); await store.load();
    expect(store.outline('', 3.5)).toMatchObject({ status: 'ready', subpaths: [], metrics: { advanceMm: 0 } });
  });
  it('字体側が壊れた座標や幅を返したら代替枠へ戻る', async () => {
    for (const invalid of [{ ...font, advance: () => NaN }, { ...font, commands: () => [{ type: 'L' as const, x: 0, y: 0 }] },
      { ...font, commands: () => { throw new Error('glyph'); } }]) {
      const store = createFontStore({ read: () => Promise.resolve(new ArrayBuffer(4)), parse: () => invalid });
      await store.load(); expect(store.outline('板', 3.5).status).toBe('invalidText');
    }
  });
  it('高さの不正値を字体へ渡さない', async () => {
    const store = ready(); await store.load();
    for (const size of [0, -1, NaN, Infinity]) expect(store.outline('板', size).status).toBe('invalidText');
  });
  it('同じ文字列・高さを何度解決しても完全一致する', async () => {
    const store = ready(); await store.load();
    expect(store.outline('板', 3.5)).toEqual(store.outline('板', 3.5));
  });
});
