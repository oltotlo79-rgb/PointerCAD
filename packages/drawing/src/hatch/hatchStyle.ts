export interface HatchStyle {
  readonly angleRad: number;
  readonly pitchMm: number;
}

/** 隣り合う部品は角度を反転し、同方向を再使用するときは間隔を25%ずつ広げる。 */
export function hatchStyle(index: number): HatchStyle {
  const safeIndex = Math.max(0, Math.floor(index));
  return {
    angleRad: ((safeIndex % 2 === 0 ? 45 : 135) * Math.PI) / 180,
    pitchMm: 3 * (1 + 0.25 * Math.floor(safeIndex / 2)),
  };
}
