import { describe, expect, it, vi } from 'vitest';
import { HOME_ORBIT, type OrbitState } from './cameraMath.js';
import { attachSixDofInput, hidOf, requestSixDofDevice } from './sixDofInput.js';
import { DEFAULT_SIX_DOF_MOTION } from './sixDofMotion.js';

/* 3D マウス(設計 B-09 3-5)の読み手。HID の口は偽物。印が切・用途の無い機器・抜けた機器・焦点を失った時は動かさない。 */
type Listener = (event: { readonly reportId: number; readonly data: DataView }) => void;

function fakeDevice(collections = [{ usagePage: 0x01, usage: 0x08 }]) {
  const listeners = new Set<Listener>();
  const state = { opened: false };
  return {
    get opened(): boolean { return state.opened; },
    collections, listeners,
    open: vi.fn(() => { state.opened = true; return Promise.resolve(); }),
    close: vi.fn(() => Promise.resolve()),
    addEventListener: (_type: 'inputreport', listener: Listener) => { listeners.add(listener); },
    removeEventListener: (_type: 'inputreport', listener: Listener) => { listeners.delete(listener); },
    send(values: readonly number[]): void {
      const data = new DataView(new ArrayBuffer(12));
      values.forEach((value, index) => { data.setInt16(index * 2, value, true); });
      for (const listener of listeners) listener({ reportId: 1, data });
    },
  };
}
type FakeDevice = ReturnType<typeof fakeDevice>;

function setup(devices: readonly FakeDevice[], enabled = true) {
  const disconnects = new Set<(event: { readonly device: FakeDevice }) => void>();
  const hid = {
    getDevices: vi.fn(() => Promise.resolve(devices)),
    requestDevice: vi.fn<(options: { readonly filters: readonly object[] }) => Promise<readonly FakeDevice[]>>(() => Promise.resolve(devices)),
    addEventListener: (_type: 'disconnect', listener: (event: { readonly device: FakeDevice }) => void) => { disconnects.add(listener); },
    removeEventListener: (_type: 'disconnect', listener: (event: { readonly device: FakeDevice }) => void) => { disconnects.delete(listener); },
  };
  const frames = new Map<number, (time: number) => void>();
  let nextFrame = 1;
  let current: OrbitState = HOME_ORBIT;
  const flag = { enabled, canOrbit: true };
  const input = attachSixDofInput({
    hid, enabled: () => Promise.resolve(flag.enabled), getOrbit: () => current, setOrbit: (next) => { current = next; },
    viewportHeight: () => 800, canOrbit: () => flag.canOrbit, settings: () => DEFAULT_SIX_DOF_MOTION,
    frame: { request: (callback) => { const id = nextFrame++; frames.set(id, callback); return id; }, cancel: (id) => { frames.delete(id); } },
  });
  const runFrame = (time: number): void => {
    const pending = [...frames.entries()];
    frames.clear();
    for (const [, callback] of pending) callback(time);
  };
  return { input, hid, frames, runFrame, orbit: () => current, flag, disconnect: (device: FakeDevice) => { for (const l of disconnects) l({ device }); } };
}

describe('断る場合', () => {
  it('印が切の時は機器を開かず、報告が来ても視点を動かさない', async () => {
    const device = fakeDevice();
    const side = setup([device], false);
    await side.input.refresh();
    expect(device.open).not.toHaveBeenCalled();
    expect(device.listeners.size).toBe(0);
    expect(side.hid.getDevices).not.toHaveBeenCalled();
  });

  it('多軸の入力機器の用途が無い機器は開かない', async () => {
    const keyboard = fakeDevice([{ usagePage: 0x01, usage: 0x06 }]);
    const side = setup([keyboard]);
    await side.input.refresh();
    expect(keyboard.open).not.toHaveBeenCalled();
  });

  it('切にした時・抜けた時・焦点を失った時は、止まって今の値を捨てる', async () => {
    const device = fakeDevice();
    const side = setup([device]);
    await side.input.refresh();
    device.send([350, 0, 0, 0, 0, 0]);
    expect(side.frames.size).toBe(1);
    side.input.stop();
    expect(side.frames.size).toBe(0);
    side.runFrame(16);
    expect(side.orbit()).toBe(HOME_ORBIT);
    device.send([350, 0, 0, 0, 0, 0]);
    side.disconnect(device);
    expect(device.listeners.size).toBe(0);
    expect(side.frames.size).toBe(0);
    await side.input.refresh();
    side.flag.enabled = false;
    await side.input.refresh();
    expect(device.listeners.size).toBe(0);
    expect(device.close).toHaveBeenCalled();
  });
});

describe('動かす場合', () => {
  it('印が入なら多軸の入力機器を開き、報告の間はコマごとに視点を動かし、静かになったら止まる', async () => {
    const device = fakeDevice();
    const side = setup([device]);
    await side.input.refresh();
    expect(device.open).toHaveBeenCalledOnce();
    device.send([350, 0, 0, 0, 0, 0]);
    side.runFrame(1000);
    expect(side.orbit()).toBe(HOME_ORBIT); // 最初のコマは時刻を覚えるだけ
    side.runFrame(1016);
    expect(side.orbit()).not.toEqual(HOME_ORBIT);
    device.send([0, 0, 0, 0, 0, 0]);
    side.runFrame(1032);
    expect(side.frames.size).toBe(0);
  });

  it('4 分割の正投影の区画では回さない(平行移動は動かす)', async () => {
    const device = fakeDevice();
    const side = setup([device]);
    side.flag.canOrbit = false;
    await side.input.refresh();
    device.send([0, 0, 0, 0, 0, 350]);
    side.runFrame(1000);
    side.runFrame(1016);
    expect(side.orbit()).toBe(HOME_ORBIT);
  });

  it('つなぐ時は多軸の入力機器の用途だけで機器を求める。navigator の hid の形を確かめる', async () => {
    const side = setup([fakeDevice()]);
    expect(await requestSixDofDevice(side.hid)).toBe(true);
    expect(side.hid.requestDevice).toHaveBeenCalledWith({ filters: [{ usagePage: 0x01, usage: 0x08 }] });
    expect(hidOf({ hid: side.hid })).toBe(side.hid);
    expect(hidOf({})).toBeUndefined();
    expect(hidOf({ hid: { getDevices: () => undefined } })).toBeUndefined();
    expect(hidOf(undefined)).toBeUndefined();
  });

  it('外すと、開いた機器を閉じ、報告を聞かない', async () => {
    const device = fakeDevice();
    const side = setup([device]);
    await side.input.refresh();
    side.input.detach();
    expect(device.listeners.size).toBe(0);
    expect(device.close).toHaveBeenCalled();
  });
});
