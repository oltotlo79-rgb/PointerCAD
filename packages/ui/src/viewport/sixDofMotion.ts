import { belowMagnitude } from '@pointercad/model';
import { orbit, pan, zoom, type OrbitState } from './cameraMath.js';

/**
 * 3D マウス(多軸の入力機器。設計 B-09 3-5 / final.md §3.4)の報告を読み、視点の動きに直す純粋な関数。
 * 報告の形は HID の多軸の入力機器の規格の形: 古い機器は報告 1 に平行 3 軸・報告 2 に回転 3 軸・報告 3 にボタン、
 * 新しい機器は報告 1 に 6 軸。各軸は符号つき 16 ビット(小さい桁が先)。実機では確かめていない(単体の検査まで)。
 */
const AXES = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz'] as const;
type SixDofAxis = (typeof AXES)[number];
/** 軸に割り当てる視点の動き。視点の形はロールを持たないので無い。 */
type SixDofTarget = 'panX' | 'panY' | 'zoom' | 'orbitYaw' | 'orbitPitch' | 'none';

interface SixDofAxisSetting {
  readonly target: SixDofTarget;
  /** 0.1〜10。 */
  readonly sensitivity: number;
  readonly invert: boolean;
}

export interface SixDofMotionSettings {
  readonly axes: Readonly<Record<SixDofAxis, SixDofAxisSetting>>;
  /** 最大量に対する割合(0〜0.5)。これより小さい動きは無視する。 */
  readonly deadzone: number;
  /** いちばん大きい軸だけを使う。 */
  readonly dominantAxisOnly: boolean;
}

const axis = (target: SixDofTarget): SixDofAxisSetting => ({ target, sensitivity: 1, invert: false });
/** 既定の割り当て(final.md §3.4 の案)。 */
export const DEFAULT_SIX_DOF_MOTION: SixDofMotionSettings = {
  axes: { tx: axis('panX'), ty: axis('zoom'), tz: axis('panY'), rx: axis('orbitPitch'), ry: axis('none'), rz: axis('orbitYaw') },
  deadzone: 0.08,
  dominantAxisOnly: false,
};

/** 軸の今の値(報告の生の値)とボタン(ビットの並び)。 */
export interface SixDofReading {
  readonly axes: Readonly<Record<SixDofAxis, number>>;
  readonly buttons: number;
}

export const SIX_DOF_AT_REST: SixDofReading = { axes: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 }, buttons: 0 };

function readAxes(data: DataView, names: readonly SixDofAxis[]): Partial<Record<SixDofAxis, number>> {
  return Object.fromEntries(names.map((name, index) => [name, data.getInt16(index * 2, true)]));
}

/** 報告 1 つで今の値を更新する。知らない報告・長さの足りない報告は、今の値のまま。 */
export function readSixDofReport(reading: SixDofReading, reportId: number, data: DataView): SixDofReading {
  if (reportId === 1 && data.byteLength >= 12) return { ...reading, axes: { ...reading.axes, ...readAxes(data, AXES) } };
  if (reportId === 1 && data.byteLength >= 6) return { ...reading, axes: { ...reading.axes, ...readAxes(data, ['tx', 'ty', 'tz']) } };
  if (reportId === 2 && data.byteLength >= 6) return { ...reading, axes: { ...reading.axes, ...readAxes(data, ['rx', 'ry', 'rz']) } };
  if (reportId === 3 && data.byteLength >= 1) {
    let buttons = 0;
    for (let index = Math.min(data.byteLength, 4) - 1; index >= 0; index--) buttons = buttons * 256 + data.getUint8(index);
    return { ...reading, buttons };
  }
  return reading;
}

/** 視点の動き(1 秒あたりの、最大量に対する割合に感度を掛けた量)。 */
interface SixDofViewMotion {
  readonly panX: number;
  readonly panY: number;
  readonly zoom: number;
  readonly orbitYaw: number;
  readonly orbitPitch: number;
}

/** 軸の最大量(機器の報告の範囲の目安。実機では確かめていない)。 */
const FULL_SCALE = 350;
const STILL: SixDofViewMotion = { panX: 0, panY: 0, zoom: 0, orbitYaw: 0, orbitPitch: 0 };

/** 軸の値を視点の動きに直す。不感帯より小さい軸は 0、範囲の外は最大量に切る。同じ動きに割り当てた軸は足す。 */
export function sixDofViewMotion(reading: SixDofReading, settings: SixDofMotionSettings): SixDofViewMotion {
  const ratios = AXES.map((name) => {
    const ratio = Math.max(-1, Math.min(1, reading.axes[name] / FULL_SCALE));
    return { name, ratio: belowMagnitude(ratio, settings.deadzone) ? 0 : ratio };
  });
  const strongest = Math.max(...ratios.map((entry) => Math.abs(entry.ratio)));
  const motion: Record<Exclude<SixDofTarget, 'none'>, number> = { ...STILL };
  for (const { name, ratio } of ratios) {
    const setting = settings.axes[name];
    if (ratio === 0 || setting.target === 'none' || (settings.dominantAxisOnly && belowMagnitude(ratio, strongest))) continue;
    motion[setting.target] += ratio * setting.sensitivity * (setting.invert ? -1 : 1);
  }
  return motion;
}

export function isSixDofStill(motion: SixDofViewMotion): boolean {
  return motion.panX === 0 && motion.panY === 0 && motion.zoom === 0 && motion.orbitYaw === 0 && motion.orbitPitch === 0;
}

/** 最大量の時の 1 秒あたりの量(回転と平行移動は画面の画素、拡大縮小はホイールの量)。 */
const ORBIT_PIXELS_PER_SECOND = 400;
const PAN_PIXELS_PER_SECOND = 600;
const ZOOM_WHEEL_PER_SECOND = 400;

/** 視点を seconds 秒分だけ動かす(回転 → 平行移動 → 拡大縮小の順)。 */
export function movedBySixDof(current: OrbitState, motion: SixDofViewMotion, seconds: number, viewportHeight: number): OrbitState {
  const turned = motion.orbitYaw === 0 && motion.orbitPitch === 0 ? current
    : orbit(current, motion.orbitYaw * ORBIT_PIXELS_PER_SECOND * seconds, motion.orbitPitch * ORBIT_PIXELS_PER_SECOND * seconds);
  const moved = motion.panX === 0 && motion.panY === 0 ? turned
    : pan(turned, motion.panX * PAN_PIXELS_PER_SECOND * seconds, motion.panY * PAN_PIXELS_PER_SECOND * seconds, viewportHeight);
  return motion.zoom === 0 ? moved : zoom(moved, motion.zoom * ZOOM_WHEEL_PER_SECOND * seconds);
}
