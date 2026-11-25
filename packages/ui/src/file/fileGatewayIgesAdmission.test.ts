import { describe, expect, it, vi } from 'vitest';

import { openFileInBrowser } from './fileGateway.js';

function htmlPicker(name: string, event: 'change' | 'cancel' = 'change') {
  const arrayBuffer = vi.fn(() => Promise.resolve(Uint8Array.of(1, 2, 3).buffer));
  const remove = vi.fn();
  const listeners = new Map<string, () => void>();
  const input = {
    accept: '', hidden: false, type: '', files: [{ name, size: 3, arrayBuffer }],
    addEventListener: (kind: string, callback: () => void) => { listeners.set(kind, callback); },
    click: () => { listeners.get(event)?.(); },
    remove,
  };
  return { arrayBuffer, remove, input, scope: { document: { createElement: () => input, body: { append: vi.fn() } } } };
}

describe('Web の IGES 読込形式', () => {
  it('非対応の選択では本文を読まず、許可した選択では一度だけ読み込む', async () => {
    const rejected = htmlPicker('面.IGS');
    await expect(openFileInBrowser(['step'], rejected.scope)).rejects.toThrow();
    expect(rejected.input.accept).toBe('.step,.stp');
    expect(rejected.arrayBuffer).not.toHaveBeenCalled();
    expect(rejected.remove).toHaveBeenCalledTimes(1);

    const accepted = htmlPicker('面.IGS');
    expect(await openFileInBrowser(['step', 'iges'], accepted.scope))
      .toEqual({ kind: 'iges', fileName: '面.IGS', bytes: Uint8Array.of(1, 2, 3) });
    expect(accepted.input.accept).toBe('.step,.stp,.iges,.igs');
    expect(accepted.arrayBuffer).toHaveBeenCalledTimes(1);
    expect(accepted.remove).toHaveBeenCalledTimes(1);
  });

  it('ファイル選択の取消は null、DWG の誤選択は変換案内を返す', async () => {
    const cancelled = htmlPicker('面.IGS', 'cancel');
    expect(await openFileInBrowser(['iges'], cancelled.scope)).toBeNull();
    expect(cancelled.arrayBuffer).not.toHaveBeenCalled();
    expect(cancelled.remove).toHaveBeenCalledTimes(1);

    const dwg = htmlPicker('図面.DWG');
    await expect(openFileInBrowser(['step', 'iges'], dwg.scope)).rejects.toThrow('DXFへ変換');
    expect(dwg.arrayBuffer).not.toHaveBeenCalled();
    expect(dwg.remove).toHaveBeenCalledTimes(1);
  });
});
