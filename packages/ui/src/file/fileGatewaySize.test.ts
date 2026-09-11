import { describe, expect, it, vi } from 'vitest';
import { createBrowserFileGateway, openFileInBrowser } from './fileGateway.js';

function pickedFile(size: unknown, name = '部品.pcad') {
  const arrayBuffer = vi.fn(() => Promise.resolve(new ArrayBuffer(3)));
  return { file: { name, size, arrayBuffer }, arrayBuffer };
}

function inputScope(file: unknown) {
  const listeners = new Map<string, () => void>();
  const remove = vi.fn();
  const input = {
    type: '', accept: '', hidden: false, files: file === undefined ? [] : [file],
    addEventListener: (name: string, callback: () => void) => { listeners.set(name, callback); },
    click: () => { listeners.get('change')?.(); }, remove,
  };
  return { scope: { document: { createElement: () => input, body: { append: vi.fn() } } }, remove };
}

describe('Web読み込み全入口の確保前検査（R07）', () => {
  it.each([300 * 1024 * 1024, Infinity, NaN, -1, 0.5, '3', undefined])('%sのFileを全入口で本文取得前に拒否する', async (size) => {
    for (const kind of ['part', 'assembly', 'drawing'] as const) {
      const { file, arrayBuffer } = pickedFile(size);
      const scope = { showOpenFilePicker: () => Promise.resolve([{ name: file.name, getFile: () => Promise.resolve(file) }]) };
      await expect(createBrowserFileGateway(scope).openPcad(kind)).rejects.toThrow();
      expect(arrayBuffer).not.toHaveBeenCalled();
      const input = inputScope(file);
      await expect(createBrowserFileGateway(input.scope).openPcad(kind)).rejects.toThrow();
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(input.remove).toHaveBeenCalledTimes(1);
    }
    const { file, arrayBuffer } = pickedFile(size, '部品.step');
    const scope = { showOpenFilePicker: () => Promise.resolve([{ name: file.name, getFile: () => Promise.resolve(file) }]) };
    await expect(openFileInBrowser(['step'], scope)).rejects.toThrow();
    const input = inputScope(file);
    await expect(openFileInBrowser(['step'], input.scope)).rejects.toThrow();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(input.remove).toHaveBeenCalledTimes(1);
  });

  it('小さな正常Fileはpicker/input/形式付きから同じ本文を返す', async () => {
    const { file, arrayBuffer } = pickedFile(3, '部品.step');
    const scope = { showOpenFilePicker: () => Promise.resolve([{ name: file.name, getFile: () => Promise.resolve(file) }]) };
    expect((await createBrowserFileGateway(scope).openPcad())?.bytes).toEqual(new Uint8Array(3));
    expect((await createBrowserFileGateway(inputScope(file).scope).openPcad())?.bytes).toEqual(new Uint8Array(3));
    expect((await openFileInBrowser(['step'], scope))?.bytes).toEqual(new Uint8Array(3));
    expect((await openFileInBrowser(['step'], inputScope(file).scope))?.bytes).toEqual(new Uint8Array(3));
    expect(arrayBuffer).toHaveBeenCalledTimes(4);
  });

  it('空選択は取消、不正Fileは失敗として区別し、inputを必ず除去する', async () => {
    const empty = inputScope(undefined);
    expect(await createBrowserFileGateway(empty.scope).openPcad()).toBeNull();
    expect(empty.remove).toHaveBeenCalledTimes(1);
    const invalid = inputScope({ name: 'missing-size.pcad', arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    await expect(createBrowserFileGateway(invalid.scope).openPcad()).rejects.toThrow();
    expect(invalid.remove).toHaveBeenCalledTimes(1);
  });

  it('本文取得の同期例外でもinputを除去し、待ち続けない', async () => {
    const input = inputScope({ name: '読取不能.pcad', size: 3, arrayBuffer: () => { throw new Error('read denied'); } });
    await expect(createBrowserFileGateway(input.scope).openPcad()).rejects.toThrow('read denied');
    expect(input.remove).toHaveBeenCalledTimes(1);
  });

  it('大きすぎる別ファイルを開こうとしても、現在の確定保存先を維持する', async () => {
    const first = pickedFile(3, '保存中.pcad');
    const oversized = pickedFile(300 * 1024 * 1024, '巨大.pcad');
    const write = vi.fn(() => Promise.resolve());
    const close = vi.fn(() => Promise.resolve());
    const handles = [
      { name: first.file.name, getFile: () => Promise.resolve(first.file), createWritable: () => Promise.resolve({ write, close }) },
      { name: oversized.file.name, getFile: () => Promise.resolve(oversized.file) },
    ];
    const showSaveFilePicker = vi.fn(() => Promise.reject(new Error('確定保存先があるため選択してはいけません')));
    const gateway = createBrowserFileGateway({
      showOpenFilePicker: () => { const handle = handles.shift(); return Promise.resolve(handle === undefined ? [] : [handle]); },
      showSaveFilePicker,
    });
    const picked = await gateway.openPcad();
    if (picked?.saveTargetToken === null || picked?.saveTargetToken === undefined || gateway.confirmSaveTarget === undefined) {
      throw new Error('最初の保存先がありません');
    }
    await gateway.confirmSaveTarget(picked.saveTargetToken);
    await expect(gateway.openPcad()).rejects.toThrow();
    expect(oversized.arrayBuffer).not.toHaveBeenCalled();
    const currentBytes = Uint8Array.of(4, 5, 6);
    expect(await gateway.savePcad('保存中.pcad', currentBytes, false)).toBe('保存中.pcad');
    expect(write).toHaveBeenCalledWith(currentBytes);
    expect(close).toHaveBeenCalledTimes(1);
    expect(showSaveFilePicker).not.toHaveBeenCalled();
  });
});
