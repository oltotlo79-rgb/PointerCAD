import { HOME_ORBIT, type OrbitState } from './cameraMath.js';
import type { QuadViewId } from './quadLayout.js';

export interface QuadCameraState {
  readonly active: QuadViewId;
  readonly orbits: Readonly<Record<QuadViewId, OrbitState>>;
}

const fixedDirections: Readonly<Record<Exclude<QuadViewId, 'isometric'>, Pick<OrbitState, 'azimuth' | 'elevation' | 'up'>>> = {
  top: { azimuth: 0, elevation: Math.PI / 2, up: [0, 1, 0] },
  front: { azimuth: -Math.PI / 2, elevation: 0, up: [0, 0, 1] },
  right: { azimuth: 0, elevation: 0, up: [0, 0, 1] },
};

export function createQuadCameraState(focus: OrbitState): QuadCameraState {
  const common = { target: [...focus.target] as const, distance: focus.distance, zoom: focus.zoom ?? 1 };
  return { active: 'isometric', orbits: {
    top: { ...common, ...fixedDirections.top }, front: { ...common, ...fixedDirections.front },
    right: { ...common, ...fixedDirections.right }, isometric: { ...HOME_ORBIT, ...common },
  } };
}

/** 3正投影は方向を固定し、対象点・距離・倍率だけを更新する。 */
export function updateQuadCamera(state: QuadCameraState, pane: QuadViewId, next: OrbitState): QuadCameraState {
  if (![next.azimuth, next.elevation, next.distance, next.zoom ?? 1, ...next.target, ...(next.up ?? [])].every(Number.isFinite)
    || next.distance <= 0 || (next.zoom ?? 1) <= 0) return state;
  const orbit: OrbitState = { ...next, ...(pane === 'isometric' ? {} : fixedDirections[pane]), target: [...next.target] };
  return { ...state, orbits: { ...state.orbits, [pane]: orbit } };
}

/** 対象の区画だけを既定の向き・倍率へ戻し、他の区画の作業位置は保つ。 */
export function resetQuadCamera(state: QuadCameraState): QuadCameraState {
  const defaults = createQuadCameraState(HOME_ORBIT);
  return updateQuadCamera(state, state.active, defaults.orbits[state.active]);
}
