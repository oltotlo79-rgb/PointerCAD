/**
 * フレームの一括配置(J-01 包み 4b・B-10)の「辺を選ぶ途中」の状態。選ぶ窓で線の決め方を「辺から」にすると空で始まり、部品の辺を読み込むと
 * その部品の辺の一覧で始め直す。辺の一覧のチェックと、3D の画面での辺のクリック(`attachAssemblyInteraction`)の両方が、ここの 1 つの並びを
 * 入れ替える。B-10: 読み込んでいない部品のまっすぐな辺を 3D の画面で押すと、その部品のまっすぐな辺を一覧に足してから、押した辺にチェックを
 * 入れる(どの部品の辺でもよい)。まっすぐでない辺を押した時は理由の印を立てる。選んだ辺はビューの選択として強調する(包み 4a と同じ)。
 * 保存の形は変えない(文書に何も書かない)。
 */
import { frameEdgeChoices, type FrameEdgeChoice } from '../assembly/frameEdgeChoices.js';
import type { AppState } from './appState.js';

export interface FrameEdgePickSlice {
  /**
   * 辺を選ぶ途中: 読み込んだ部品(読み込まずに始めた時は null)と、一覧の辺の対象の id(一覧の順)、チェックした辺の id(一覧の順)、
   * 3D の画面で押して足した辺の一覧の行(B-10)、まっすぐでない辺を押した理由の印。選ぶ途中でなければ null。
   */
  readonly frameEdgePick: {
    readonly componentId: string | null;
    readonly edgeIds: readonly string[];
    readonly checked: readonly string[];
    readonly added: readonly FrameEdgeChoice[];
    readonly notice: 'notStraight' | null;
  } | null;
  /** 部品の辺を読み込んで選び始める(チェックは空、選択も空にする)。読み込まずに始める時は null と空の並びで、選択は残す。 */
  readonly beginFrameEdgePick: (componentId: string | null, edgeIds: readonly string[]) => void;
  /**
   * 辺のチェックを入れ替える。一覧に無い辺は、部品の id を渡した時だけ、その部品のまっすぐな辺を一覧に足してからチェックを入れる(B-10)。
   * 選ぶ途中でない・まっすぐな辺でない時は何もせず false(まっすぐでない時は理由の印を立てる)。
   */
  readonly toggleFrameEdgePick: (targetId: string, componentId?: string) => boolean;
  /** 選ぶのをやめる(選択に残した辺の強調も消す)。 */
  readonly endFrameEdgePick: () => void;
}

type FrameEdgePick = NonNullable<FrameEdgePickSlice['frameEdgePick']>;

/** チェックを入れ替えた後の並び(一覧の順に揃える)。 */
function toggledFrameEdges(pick: FrameEdgePick, targetId: string): readonly string[] {
  const checked = pick.checked.includes(targetId) ? pick.checked.filter((id) => id !== targetId) : [...pick.checked, targetId];
  return pick.edgeIds.filter((id) => checked.includes(id));
}

export function createFrameEdgePickActions(set: (patch: Partial<AppState>) => void, get: () => AppState):
Omit<FrameEdgePickSlice, 'frameEdgePick'> {
  /** 押した辺の部品のまっすぐな辺を一覧に足した状態。押した辺がまっすぐでなければ 'notStraight'、部品の辺が読めなければ null。 */
  const withComponentEdges = (pick: FrameEdgePick, targetId: string, componentId: string): FrameEdgePick | 'notStraight' | null => {
    const state = get();
    const choices = state.assembly === null || state.assemblyView === null ? null
      : frameEdgeChoices(state.assembly, state.assemblyView, componentId);
    if (choices === null) return null;
    if (!choices.some((choice) => choice.targetId === targetId)) return 'notStraight';
    const fresh = choices.filter((choice) => !pick.edgeIds.includes(choice.targetId));
    return { ...pick, edgeIds: [...pick.edgeIds, ...fresh.map((choice) => choice.targetId)], added: [...pick.added, ...fresh], notice: null };
  };
  return {
    beginFrameEdgePick: (componentId, edgeIds) => {
      const frameEdgePick = { componentId, edgeIds: [...edgeIds], checked: [], added: [], notice: null };
      // 読み込まずに空で始める時は、選んである部品を残す(続けて、その部品の辺を読み込めるように)。
      set(componentId === null ? { frameEdgePick } : { frameEdgePick, selection: [] });
    },
    toggleFrameEdgePick: (targetId, componentId) => {
      const pick = get().frameEdgePick;
      if (pick === null) return false;
      let current: FrameEdgePick = pick;
      if (!pick.edgeIds.includes(targetId)) {
        const grown = componentId === undefined ? null : withComponentEdges(pick, targetId, componentId);
        if (grown === 'notStraight') { set({ frameEdgePick: { ...pick, notice: 'notStraight' } }); return false; }
        if (grown === null) return false;
        current = grown;
      }
      const checked = toggledFrameEdges(current, targetId);
      set({ frameEdgePick: { ...current, checked, notice: null }, selection: checked });
      return true;
    },
    endFrameEdgePick: () => {
      const pick = get().frameEdgePick;
      if (pick === null) return;
      set({ frameEdgePick: null, selection: get().selection.filter((id) => !pick.edgeIds.includes(id)) });
    },
  };
}
