/**
 * 一筆書きの配置(E-08)の「点を打つ」状態。窓で線の決め方を「3D の画面で点を打つ」にすると始まり、打っている間(active)は
 * 3D の画面の押下(`attachAssemblyInteraction`)が点を足し、窓のボタンと点の文字の欄が直す。保存の形は変えない(文書に何も書かない)。
 * 置く時は窓が点の文字にして今の一括配置の道(`placeFrameMembers`)へ渡すので、元に戻す 1 回で全部戻る。
 */
import type { FrameUp } from '../assembly/frameLayoutInput.js';
import {
  appendFrameStrokePoint, nextFrameStrokePoint, removeLastFrameStrokePoint, type FrameStroke, type FrameStrokeChange, type FrameStrokeHit,
} from '../assembly/frameStroke.js';
import type { AppState } from './appState.js';

/**
 * 点の列と、当たらない時に次の点を置く面を決める上の軸(窓の「断面の上」)と、3D の押下で点を足すか(active。
 * 打つのをやめても点の列は残し、窓の欄に見せ続ける)。
 */
export interface FrameStrokeDraft extends FrameStroke {
  readonly up: FrameUp;
  readonly active: boolean;
  /** 誰の点か(フレームの一括配置の欄か、安全柵の欄か。E-12 第 2 段)。欄はほかの持ち主の点を読まず、直さない。 */
  readonly owner: FrameStrokeOwner;
}

export type FrameStrokeOwner = 'layout' | 'fence';

export interface FrameStrokeSlice {
  /** 線の決め方が「3D の画面で点を打つ」の間の状態。それ以外は null。 */
  readonly frameStroke: FrameStrokeDraft | null;
  /** 点を打ち始める(窓の点の文字から読んだ点の列を引き継ぐ)。 */
  readonly beginFrameStroke: (stroke: FrameStroke, up: FrameUp, owner?: FrameStrokeOwner) => void;
  /** 窓の欄の変更(点の文字を直した・閉じる・上の軸・打ち直す・打ち始める)を入れる。状態が無ければ何もしない。 */
  readonly updateFrameStroke: (patch: Partial<Omit<FrameStrokeDraft, 'owner'>>, owner?: FrameStrokeOwner) => void;
  /**
   * 3D の画面で押した所から点を足す(Shift の時は lockAxis)。打っていない・閉じた後・前の点と同じ時は 'unchanged'。
   * 頂点に当たらない時の面の上の点は、押す側が `frameStrokeLevelPlane` の面で求めて渡す(面と視線が平行なら押す側で足さない)。
   */
  readonly addFrameStrokeHit: (hit: FrameStrokeHit, lockAxis: boolean) => FrameStrokeChange;
  /** 最後に打った物を消す(閉じていれば閉じるのをやめる)。 */
  readonly undoFrameStrokePoint: () => void;
  /** 打つのをやめる(点の列は残る。3D の押下は普通の選択に戻る)。 */
  readonly pauseFrameStroke: () => void;
  /** 状態を捨てる(窓を閉じた・線の決め方を替えた時)。 */
  readonly endFrameStroke: (owner?: FrameStrokeOwner) => void;
}

export function createFrameStrokeActions(set: (patch: Partial<AppState>) => void, get: () => AppState):
Omit<FrameStrokeSlice, 'frameStroke'> {
  // 欄の直しは、その欄が持ち主の時だけ(既定は一括配置の欄)。
  const update = (patch: Partial<Omit<FrameStrokeDraft, 'owner'>>, owner: FrameStrokeOwner = 'layout'): void => {
    const current = get().frameStroke;
    if (current !== null && current.owner === owner) set({ frameStroke: { ...current, ...patch } });
  };
  return {
    beginFrameStroke: (stroke, up, owner = 'layout') => {
      set({ frameStroke: { points: [...stroke.points], closed: stroke.closed, up, active: true, owner } });
    },
    updateFrameStroke: update,
    addFrameStrokeHit: (hit, lockAxis) => {
      const current = get().frameStroke;
      if (current === null || !current.active) return 'unchanged';
      const appended = appendFrameStrokePoint(current, nextFrameStrokePoint(current, hit, current.up, lockAxis));
      if (appended.change !== 'unchanged') set({ frameStroke: { ...current, ...appended.stroke } });
      return appended.change;
    },
    undoFrameStrokePoint: () => {
      const current = get().frameStroke;
      if (current !== null) set({ frameStroke: { ...current, ...removeLastFrameStrokePoint(current) } });
    },
    pauseFrameStroke: () => {
      const current = get().frameStroke;
      if (current !== null) set({ frameStroke: { ...current, active: false } });
    },
    endFrameStroke: (owner = 'layout') => { if (get().frameStroke?.owner === owner) set({ frameStroke: null }); },
  };
}
