import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import type { SixDofGate } from './sixDofGate.js';
import { registerSixDofIpc, type SixDofConfirm } from './sixDofIpc.js';

/** チャンネル名は preload.ts と同じ文字列で呼ぶ(名前が変われば、ここと preload の両方が要る)。 */
const SIX_DOF_ENABLE_CHANNEL = 'pcad:sixDof:enable';
const SIX_DOF_DISABLE_CHANNEL = 'pcad:sixDof:disable';
const SIX_DOF_STATE_CHANNEL = 'pcad:sixDof:state';

/* 3D マウス(設計 B-09 3-5)の印の IPC。画面から入を直接書けず、許可していない送り手・引数つきの呼び出しは断る。 */
function setup(options: { valid?: () => boolean; confirm?: boolean; enabled?: boolean } = {}) {
  let enabled = options.enabled ?? false;
  const gate: SixDofGate = { enabled: () => enabled, set: vi.fn((next: boolean) => { enabled = next; return true; }) };
  const confirm = vi.fn<SixDofConfirm>(() => Promise.resolve(options.confirm ?? true));
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  registerSixDofIpc({ handle: (channel, listener) => { handlers.set(channel, listener); } }, gate, confirm, options.valid ?? (() => true));
  const call = (channel: string, ...args: unknown[]): unknown => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`口がありません: ${channel}`);
    return handler(Object.create(null) as IpcMainInvokeEvent, ...args);
  };
  return { call, gate, confirm, enabled: () => enabled, channels: [...handlers.keys()].sort() };
}

describe('3D マウスの印の IPC は 3 つだけ', () => {
  it('入にする・切にする・今の印を読む、の 3 つを登録する', () => {
    expect(setup().channels).toEqual([SIX_DOF_DISABLE_CHANNEL, SIX_DOF_ENABLE_CHANNEL, SIX_DOF_STATE_CHANNEL].sort());
  });
});

describe('断る場合', () => {
  it('許可していない送り手からは、どの口も印を変えず、確かめの窓も出さない', async () => {
    const enabledSide = setup({ valid: () => false, enabled: true });
    expect(await enabledSide.call(SIX_DOF_DISABLE_CHANNEL)).toBe(false);
    expect(await enabledSide.call(SIX_DOF_STATE_CHANNEL)).toBe(false);
    expect(enabledSide.enabled()).toBe(true);
    const disabledSide = setup({ valid: () => false });
    expect(await disabledSide.call(SIX_DOF_ENABLE_CHANNEL)).toBe(false);
    expect(disabledSide.confirm).not.toHaveBeenCalled();
    expect(disabledSide.enabled()).toBe(false);
  });

  it('引数つきの呼び出しは断る(画面から入の値を渡す口は無い)', async () => {
    const side = setup();
    for (const value of [true, 'true', 1, { enabled: true }]) {
      expect(await side.call(SIX_DOF_ENABLE_CHANNEL, value)).toBe(false);
      expect(await side.call(SIX_DOF_STATE_CHANNEL, value)).toBe(false);
    }
    expect(side.confirm).not.toHaveBeenCalled();
    expect(side.enabled()).toBe(false);
    const enabledSide = setup({ enabled: true });
    expect(await enabledSide.call(SIX_DOF_DISABLE_CHANNEL, false)).toBe(false);
    expect(enabledSide.enabled()).toBe(true);
  });

  it('OS の確かめの窓で「やめる」を選ぶと入にしない', async () => {
    const side = setup({ confirm: false });
    expect(await side.call(SIX_DOF_ENABLE_CHANNEL)).toBe(false);
    expect(side.confirm).toHaveBeenCalledOnce();
    expect(side.enabled()).toBe(false);
  });

  it('確かめの窓を出している間に送り手が変わった時(窓が移った・閉じた)は入にしない', async () => {
    let valid = true;
    const side = setup({ valid: () => valid });
    side.confirm.mockImplementationOnce(() => { valid = false; return Promise.resolve(true); });
    expect(await side.call(SIX_DOF_ENABLE_CHANNEL)).toBe(false);
    expect(side.enabled()).toBe(false);
  });
});

describe('許す場合', () => {
  it('確かめの窓で許可した時だけ入にし、入の間は窓を出さない。切はいつでも確かめずに切にする', async () => {
    const side = setup();
    expect(await side.call(SIX_DOF_ENABLE_CHANNEL)).toBe(true);
    expect(side.enabled()).toBe(true);
    expect(await side.call(SIX_DOF_STATE_CHANNEL)).toBe(true);
    expect(await side.call(SIX_DOF_ENABLE_CHANNEL)).toBe(true);
    expect(side.confirm).toHaveBeenCalledOnce();
    expect(await side.call(SIX_DOF_DISABLE_CHANNEL)).toBe(true);
    expect(side.enabled()).toBe(false);
    expect(side.confirm).toHaveBeenCalledOnce();
  });
});
