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
  it('ドラッグで同じ文字を繰り返し描いても字形と送り幅を再計算しない', async () => {
    const commands = vi.fn((text: string, size: number) => font.commands(text, size));
    const advance = vi.fn((text: string, size: number) => font.advance(text, size));
    const store = createFontStore({ read: () => Promise.resolve(new ArrayBuffer(4)), parse: () => ({ ...font, commands, advance }) });
    await store.load();
    const original = store.outline('20', 3.5);
    for (let i = 0; i < 100; i++) expect(store.outline('20', 3.5)).toBe(original);
    expect(commands).toHaveBeenCalledTimes(1); expect(advance).toHaveBeenCalledTimes(1);
    expect(store.outline('20', 7).metrics?.advanceMm).toBe(14);
    store.outline('板', 3.5);
    expect(commands).toHaveBeenCalledTimes(3);
  });
  it('多数の注記では最近使った字形を残し、古い字形を再計算する', async () => {
    const commands = vi.fn((text: string, size: number) => font.commands(text, size));
    const store = createFontStore({ read: () => Promise.resolve(new ArrayBuffer(4)), parse: () => ({ ...font, commands }) });
    await store.load(); store.outline('古い注記', 3.5);
    for (let i = 0; i < 400; i++) { store.outline(`注記${i}`, 3.5); store.outline('選択中', 3.5); }
    const before = commands.mock.calls.length;
    store.outline('選択中', 3.5); expect(commands).toHaveBeenCalledTimes(before);
    store.outline('古い注記', 3.5); expect(commands).toHaveBeenCalledTimes(before + 1);
  });
  it('共有する字形の配列・命令・座標を書換できず、別の文字や高さへ汚染しない', async () => {
    const store = ready(); await store.load();
    const original = store.outline('20', 3.5), path = original.subpaths[0], command = path.commands[0];
    expect(Reflect.set(original.subpaths, '0', { commands: [] })).toBe(false);
    expect(Reflect.set(path, 'commands', [])).toBe(false);
    expect(Reflect.set(path.commands, '0', { kind: 'Z' })).toBe(false);
    expect(Reflect.set(command, 'kind', 'Z')).toBe(false);
    if (command.kind === 'Z') throw new Error('先頭の移動命令がない');
    expect(Reflect.set(command.to, '0', Infinity)).toBe(false);
    expect(store.outline('20', 3.5)).toBe(original);
    expect(store.outline('20', 7).subpaths).not.toBe(original.subpaths);
  });
  it('失敗した字形は記憶せず、次の有効な結果と字体ごとの幅を使う', async () => {
    const commands = vi.fn((text: string, size: number) => font.commands(text, size)).mockImplementationOnce(() => { throw new Error('temporary glyph failure'); });
    const store = createFontStore({ read: () => Promise.resolve(new ArrayBuffer(4)), parse: () => ({ ...font, commands }) });
    await store.load(); expect(store.outline('20', 3.5).status).toBe('invalidText');
    expect(store.outline('20', 3.5).status).toBe('ready'); expect(commands).toHaveBeenCalledTimes(2);
    const other = createFontStore({ read: () => Promise.resolve(new ArrayBuffer(4)), parse: () => ({ ...font, advance: () => 12 }) });
    await other.load(); expect(other.outline('20', 3.5).metrics?.advanceMm).toBe(12);
    expect(store.outline('20', 3.5).metrics?.advanceMm).toBe(7);
  });
  it('注記が少数でも輪郭と長い文字列の保持量が上限を超えない', async () => {
    const dense = vi.fn<DrawingFont['commands']>(() => [{ type: 'M', x: 0, y: 0 },
      ...Array.from({ length: 20_000 }, (_, index) => ({ type: 'L' as const, x: index % 20, y: Math.floor(index / 20) }))]);
    const store = createFontStore({ read: () => Promise.resolve(new ArrayBuffer(4)), parse: () => ({ ...font, commands: dense }) });
    await store.load();
    store.outline('密な輪郭A', 3.5); store.outline('密な輪郭B', 3.5); store.outline('密な輪郭A', 3.5);
    expect(dense).toHaveBeenCalledTimes(3);
    const commands = vi.fn((text: string, size: number) => font.commands(text, size));
    const texts = createFontStore({ read: () => Promise.resolve(new ArrayBuffer(4)), parse: () => ({ ...font, commands }) });
    await texts.load(); const first = '板'.repeat(1000);
    texts.outline(first, 3.5);
    for (let i = 0; i < 30; i++) texts.outline(`${first}${i}`, 3.5);
    const before = commands.mock.calls.length;
    texts.outline(first, 3.5); expect(commands).toHaveBeenCalledTimes(before + 1);
    // 単独で予算を超えるキーも残さず、結果自体は正確に返す。
    const huge = '板'.repeat(20_000);
    expect(texts.outline(huge, 3.5).status).toBe('ready'); texts.outline(huge, 3.5);
    expect(commands).toHaveBeenCalledTimes(before + 3);
  });
});
