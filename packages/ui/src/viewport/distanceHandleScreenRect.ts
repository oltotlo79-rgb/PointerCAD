/**
 * 距離のつまみ(押し出し M-05 4-2b・面の移動 4-2a)が画面に写る外形の箱。
 *
 * 入力の窓は、面を画面で選んだ時だけ面の外形を避けて開く(M-10 ①。`NumericInputPopover.tsx` の `placePopover`)。
 * 押し出しを木から開いた時は避ける箱が無く、窓は画面の中央に出て、背の高い窓が収まるよう上へずれ、
 * 中央に写る面の上のつまみを覆う事があった(掴めない)。そこで、避ける箱が無い時は、つまみの根もとから先端まで
 * の線を、掴める半径(`HANDLE_PICK_RADIUS_PIXELS`)だけ広げた箱を避けさせる。three.js にも DOM にも触れない。
 */
import type { ScreenRect } from '../solid/faceScreenRect.js';
import type { DistanceHandle } from '../solid/faceOffsetHandle.js';
import type { ProjectToScreen } from '../sketch/snapMath.js';
import { HANDLE_PICK_RADIUS_PIXELS } from './sectionHandleDrag.js';

/** 根もとと先端を写して囲み、掴める半径だけ広げる。どちらかが写せない(カメラの後ろ)時は null。 */
export function distanceHandleScreenRect(handle: Pick<DistanceHandle, 'base' | 'origin'>, project: ProjectToScreen): ScreenRect | null {
  const base = project(handle.base), tip = project(handle.origin);
  if (base === null || tip === null) return null;
  return {
    left: Math.min(base[0], tip[0]) - HANDLE_PICK_RADIUS_PIXELS,
    top: Math.min(base[1], tip[1]) - HANDLE_PICK_RADIUS_PIXELS,
    right: Math.max(base[0], tip[0]) + HANDLE_PICK_RADIUS_PIXELS,
    bottom: Math.max(base[1], tip[1]) + HANDLE_PICK_RADIUS_PIXELS,
  };
}
