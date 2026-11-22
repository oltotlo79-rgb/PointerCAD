/**
 * 面の移動の矢印のつまみ(M-05 4-2a)を引く。
 *
 * 責務: 入力欄の距離の数だけ。引いている間は、つまみの軸(面の重心を通る外向きの法線)の上でポインタの光線に
 * 一番近い点の距離を、打鍵と同じ口(`reduceNumericInput` の `edit` とストアの `updateNumericInput`)で欄へ入れる。
 * 文書・履歴・計算部への依頼は 1 つも変えない(面の移動の計算は、今までどおり確定の時だけ)。
 * 断面のつまみ(`sectionHandleDrag.ts`)と同じ形で、掴む所(矢印の根もとの 18px)・軸への写し方
 * (`closestParameterToRay`)・掴んだ所との差(`delta`)を同じにしてある。ポインタの捕捉は呼び出し側が持つ。
 *
 * 掴みは、掴んだ時の入力欄に結ぶ。打ち直し・閉じる・開き直しで欄が替わったら(通し番号
 * `numericInputRevision` が自分の書いた後の値と違えば)、もう書かない(打った数が優先)。
 */
import { toDisplayLength, type Vec3 } from '@pointercad/model';

import { faceOffsetHandleOf } from '../solid/faceOffsetHandle.js';
import { reduceNumericInput, type NumericInputState } from '../sketch/numericInput.js';
import type { ProjectToScreen } from '../sketch/snapMath.js';
import { closestParameterToRay } from '../sketch/trackMath.js';
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';
import type { ViewportScene } from './createViewportScene.js';
import { HANDLE_PICK_RADIUS_PIXELS } from './sectionHandleDrag.js';

/** 面の移動の段の距離の欄の位置(`numericInput.ts` の FACE_OFFSET_DISTANCE_FIELDS の 1 つ目)。 */
const DISTANCE_FIELD_INDEX = 0;

/**
 * 引いた距離を欄へ書く桁(表示の単位で小数 3 桁)。断面表示の欄が、つまみで動いた値を出す桁
 * (`ViewportCanvas.tsx` の SECTION_OFFSET_DIGITS)と同じ決め方。
 */
const DRAG_DISTANCE_DIGITS = 3;

export interface FaceOffsetHandleDrag {
  readonly active: () => boolean;
  /** 掴んだ入力欄のままか(打ち直し・閉じる・開き直しで替わったら false。自分が書いている最中は true)。 */
  readonly ownsInput: (state: Pick<AppState, 'numericInputRevision'>) => boolean;
  /** ポインタの下の矢印の根もとを掴む。false なら押下はほかの入力へ渡す。 */
  readonly begin: (pointer: readonly [number, number]) => boolean;
  /** 軸の上でポインタの光線に一番近い点の距離を欄へ入れる。 */
  readonly move: (pointer: readonly [number, number]) => void;
  /** 掴みを忘れる。欄へ入れた数はそのまま残す。 */
  readonly end: () => void;
  /** 掴む前の入力欄へ戻してから掴みを忘れる(掴んでいる間の Esc・OS の取消)。窓は閉じない。 */
  readonly cancel: () => void;
}

export function createFaceOffsetHandleDrag(
  scene: Pick<ViewportScene, 'pointerRay'>,
  project: ProjectToScreen,
): FaceOffsetHandleDrag {
  /**
   * 掴んだ時の軸(面の重心と外向きの法線)。`delta` は掴んだ点とつまみの根もとの距離の差(押した所でつまみが
   * 跳ねないため)、`before` は掴む前の入力欄(Esc で丸ごと戻す。打ったかどうかの印や数式の値もそのまま)。
   */
  let grab: { readonly base: Vec3; readonly normal: Vec3; readonly delta: number; readonly before: NumericInputState } | null = null;
  /** 自分が最後に見た(書いた後の)入力欄の通し番号。 */
  let grabRevision = 0;
  /** 自分が欄へ書いている最中(ストアの購読が同じ呼び出しの中で動くので、その間は自分の掴みのままとみなす)。 */
  let writing = false;

  function ownsInput(state: Pick<AppState, 'numericInputRevision'>): boolean {
    return grab !== null && (writing || state.numericInputRevision === grabRevision);
  }

  /** 距離(mm)を表示の単位の文字にして欄へ入れる。同じ文字なら何もしない(ストアを動かさない)。 */
  function writeDistance(distanceMm: number): void {
    const state = useAppStore.getState();
    const input = state.numericInput;
    if (input === null) return;
    const source = String(Number(toDisplayLength(distanceMm, state.displaySettings.lengthUnit).toFixed(DRAG_DISTANCE_DIGITS)));
    if (input.fields[DISTANCE_FIELD_INDEX]?.source === source) return;
    writing = true;
    try {
      state.updateNumericInput(reduceNumericInput(input, { type: 'edit', index: DISTANCE_FIELD_INDEX, source }));
    } finally {
      writing = false;
    }
    grabRevision = useAppStore.getState().numericInputRevision;
  }

  return {
    active: () => grab !== null,
    ownsInput,
    begin: (pointer) => {
      const state = useAppStore.getState();
      const handle = faceOffsetHandleOf(state);
      if (handle === null || state.numericInput === null) return false;
      const screen = project(handle.origin);
      if (screen === null || Math.hypot(screen[0] - pointer[0], screen[1] - pointer[1]) > HANDLE_PICK_RADIUS_PIXELS) {
        return false;
      }
      const ray = scene.pointerRay(pointer[0], pointer[1]);
      const grabbed = ray === null ? null : closestParameterToRay({ origin: handle.base, direction: handle.normal }, ray);
      grab = {
        base: handle.base,
        normal: handle.normal,
        // 光線が無い(まだ何も描いていない)時は差なしで掴む(断面のつまみと同じ)。
        delta: grabbed === null ? 0 : handle.distanceMm - grabbed,
        before: state.numericInput,
      };
      grabRevision = state.numericInputRevision;
      return true;
    },
    /**
     * 法線は単位ベクトルなので、軸の上の位置の値がそのまま距離(mm)になる。視線が法線と平行な時は
     * 位置が決まらないので動かさない(断面のつまみと同じ)。
     */
    move: (pointer) => {
      const current = grab;
      if (current === null || !ownsInput(useAppStore.getState())) return;
      const ray = scene.pointerRay(pointer[0], pointer[1]);
      const parameter = ray === null ? null : closestParameterToRay({ origin: current.base, direction: current.normal }, ray);
      if (parameter === null) return;
      writeDistance(parameter + current.delta);
    },
    end: () => {
      grab = null;
    },
    cancel: () => {
      const current = grab;
      // 先に忘れてから戻す(戻した更新でストアの購読が動いても、もう掴んでいない)。
      grab = null;
      if (current === null) return;
      const state = useAppStore.getState();
      if (state.numericInput !== null && state.numericInputRevision === grabRevision) {
        state.updateNumericInput(current.before);
      }
    },
  };
}
