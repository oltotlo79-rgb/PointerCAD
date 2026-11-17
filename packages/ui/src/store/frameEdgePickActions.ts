/**
 * フレームの一括配置(J-01 包み 4b)の「辺を選ぶ途中」の状態。選ぶ窓で部品の辺を読み込むと始まり、
 * 辺の一覧のチェックと、3D の画面での辺のクリック(`attachAssemblyInteraction`)の両方が、ここの 1 つの並びを入れ替える。
 * 選んだ辺はビューの選択として強調する(包み 4a と同じ)。保存の形は変えない(文書に何も書かない)。
 */
import type { AppState } from './appState.js';

export interface FrameEdgePickSlice {
  /**
   * 辺を選ぶ途中: 読み込んだ部品と、その部品のまっすぐな辺の対象の id(一覧の順)、チェックした辺の id(一覧の順)。
   * 選ぶ途中でなければ null。
   */
  readonly frameEdgePick: { readonly componentId: string; readonly edgeIds: readonly string[]; readonly checked: readonly string[] } | null;
  /** 部品の辺を読み込んで選び始める(チェックは空、選択も空にする)。 */
  readonly beginFrameEdgePick: (componentId: string, edgeIds: readonly string[]) => void;
  /** 辺のチェックを入れ替える。選ぶ途中でない・読み込んだ部品の辺でない時は何もせず false。 */
  readonly toggleFrameEdgePick: (targetId: string) => boolean;
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
  return {
    beginFrameEdgePick: (componentId, edgeIds) => {
      set({ frameEdgePick: { componentId, edgeIds: [...edgeIds], checked: [] }, selection: [] });
    },
    toggleFrameEdgePick: (targetId) => {
      const pick = get().frameEdgePick;
      if (pick === null || !pick.edgeIds.includes(targetId)) return false;
      const checked = toggledFrameEdges(pick, targetId);
      set({ frameEdgePick: { ...pick, checked }, selection: checked });
      return true;
    },
    endFrameEdgePick: () => {
      const pick = get().frameEdgePick;
      if (pick === null) return;
      set({ frameEdgePick: null, selection: get().selection.filter((id) => !pick.edgeIds.includes(id)) });
    },
  };
}
