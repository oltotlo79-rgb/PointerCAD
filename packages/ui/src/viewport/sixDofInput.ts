import type { OrbitState } from './cameraMath.js';
import {
  isSixDofStill, movedBySixDof, readSixDofReport, SIX_DOF_AT_REST, sixDofViewMotion, type SixDofMotionSettings, type SixDofReading,
} from './sixDofMotion.js';

/**
 * 3D マウス(多軸の入力機器。設計 B-09 3-5)の読み手。印が入の時だけ、許可済みの機器のうち多軸の入力機器の用途を持つ物を
 * 開き、報告を読んで、コマごとに視点を動かす。印が切の時・窓が焦点を失った時・機器が抜けた時は、動きを止める。
 * HID の口は差し込む(単体は偽物で確かめる。実機では確かめていない)。
 */
interface HidCollectionLike {
  readonly usagePage: number;
  readonly usage: number;
}

interface HidReportLike {
  readonly reportId: number;
  readonly data: DataView;
}

interface HidDeviceLike {
  readonly opened: boolean;
  readonly collections: readonly HidCollectionLike[];
  open(): Promise<void>;
  close(): Promise<void>;
  addEventListener(type: 'inputreport', listener: (event: HidReportLike) => void): void;
  removeEventListener(type: 'inputreport', listener: (event: HidReportLike) => void): void;
}

interface HidLike {
  getDevices(): Promise<readonly HidDeviceLike[]>;
  requestDevice(options: { readonly filters: readonly HidCollectionLike[] }): Promise<readonly HidDeviceLike[]>;
  addEventListener(type: 'disconnect', listener: (event: { readonly device: HidDeviceLike }) => void): void;
  removeEventListener(type: 'disconnect', listener: (event: { readonly device: HidDeviceLike }) => void): void;
}

/** HID の規格の多軸の入力機器の用途(Generic Desktop・Multi-axis Controller)。 */
const MULTI_AXIS: HidCollectionLike = { usagePage: 0x01, usage: 0x08 };
/** 1 コマで動かす時間の上限(窓が裏にあってコマが止まった後に、大きく跳ばないように)。 */
const MAX_FRAME_SECONDS = 0.05;

function isMultiAxis(device: HidDeviceLike): boolean {
  return device.collections.some((collection) => collection.usagePage === MULTI_AXIS.usagePage && collection.usage === MULTI_AXIS.usage);
}

function isHidLike(value: unknown): value is HidLike {
  return typeof value === 'object' && value !== null
    && ['getDevices', 'requestDevice', 'addEventListener', 'removeEventListener'].every((name) => typeof Reflect.get(value, name) === 'function');
}

/** 環境の HID の口(navigator.hid)。無い・形が違う時は undefined。呼ぶのは、デスクトップ版の口がある時だけにする。 */
export function hidOf(navigatorLike: unknown): HidLike | undefined {
  if (typeof navigatorLike !== 'object' || navigatorLike === null) return undefined;
  const hid: unknown = Reflect.get(navigatorLike, 'hid');
  return isHidLike(hid) ? hid : undefined;
}

/** 「3D マウスをつなぐ…」: 多軸の入力機器の用途だけを候補にして、機器の選択を求める。選ばれたら true。 */
export async function requestSixDofDevice(hid: Pick<HidLike, 'requestDevice'>): Promise<boolean> {
  const devices = await hid.requestDevice({ filters: [MULTI_AXIS] });
  return devices.some(isMultiAxis);
}

interface SixDofInputOptions {
  readonly hid: HidLike;
  /** 主プロセスの印(切なら機器を開かない)。 */
  readonly enabled: () => Promise<boolean>;
  readonly getOrbit: () => OrbitState;
  readonly setOrbit: (next: OrbitState) => void;
  readonly viewportHeight: () => number;
  /** 回してよい視点か(4 分割の正投影の区画は回さない)。 */
  readonly canOrbit: () => boolean;
  readonly settings: () => SixDofMotionSettings;
  readonly frame: { readonly request: (callback: (time: number) => void) => number; readonly cancel: (id: number) => void };
}

interface SixDofInput {
  /** 印や機器が変わった時に呼ぶ(印が入なら機器を開き直し、切なら全部閉じて止める)。 */
  readonly refresh: () => Promise<void>;
  /** 窓が焦点を失った時: 動きを止め、今の値を捨てる。 */
  readonly stop: () => void;
  readonly detach: () => void;
}

export function attachSixDofInput(options: SixDofInputOptions): SixDofInput {
  const opened = new Map<HidDeviceLike, (event: HidReportLike) => void>();
  let reading: SixDofReading = SIX_DOF_AT_REST;
  let frameId: number | null = null;
  let lastTime: number | null = null;
  let detached = false;

  const stop = (): void => {
    reading = SIX_DOF_AT_REST;
    lastTime = null;
    if (frameId !== null) options.frame.cancel(frameId);
    frameId = null;
  };
  const step = (time: number): void => {
    frameId = null;
    const full = sixDofViewMotion(reading, options.settings());
    const motion = options.canOrbit() ? full : { ...full, orbitYaw: 0, orbitPitch: 0 };
    if (detached || isSixDofStill(motion)) { lastTime = null; return; }
    const seconds = lastTime === null ? 0 : Math.min(MAX_FRAME_SECONDS, Math.max(0, (time - lastTime) / 1000));
    lastTime = time;
    if (seconds > 0) options.setOrbit(movedBySixDof(options.getOrbit(), motion, seconds, options.viewportHeight()));
    frameId = options.frame.request(step);
  };
  const receive = (event: HidReportLike): void => {
    reading = readSixDofReport(reading, event.reportId, event.data);
    if (frameId === null && !detached) frameId = options.frame.request(step);
  };
  const forget = (device: HidDeviceLike): void => {
    const listener = opened.get(device);
    if (listener === undefined) return;
    device.removeEventListener('inputreport', listener);
    opened.delete(device);
    void device.close().catch(() => undefined);
    if (opened.size === 0) stop();
  };
  const onDisconnect = (event: { readonly device: HidDeviceLike }): void => { forget(event.device); };
  const closeAll = (): void => { for (const device of [...opened.keys()]) forget(device); stop(); };

  const refresh = async (): Promise<void> => {
    if (detached) return;
    if (!await options.enabled().catch(() => false)) { closeAll(); return; }
    const devices = await options.hid.getDevices().catch((): readonly HidDeviceLike[] => []);
    for (const device of devices) {
      if (detached || opened.has(device) || !isMultiAxis(device)) continue;
      try {
        if (!device.opened) await device.open();
      } catch {
        continue;
      }
      if (detached) { void device.close().catch(() => undefined); return; }
      const listener = (event: HidReportLike): void => { receive(event); };
      device.addEventListener('inputreport', listener);
      opened.set(device, listener);
    }
  };

  options.hid.addEventListener('disconnect', onDisconnect);
  return {
    refresh,
    stop,
    detach: () => {
      if (detached) return;
      detached = true;
      options.hid.removeEventListener('disconnect', onDisconnect);
      closeAll();
    },
  };
}
