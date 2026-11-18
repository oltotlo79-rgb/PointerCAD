/**
 * 接合チェック(E-09)の店の操作。状態の欄(assemblyJointCheckOpen・assemblyJointCheck・assemblyJointCheckSelectedKey)は `AssemblySlice` に置き、
 * 動作だけをここに置く(フレームの溝への締結の操作と同じ形)。
 *
 * - 開く: 干渉の一覧を閉じて(同じ所に出るため)開き、今の文書と表示で 1 回調べる。
 * - 調べ直す: 一覧を開いている間、文書か表示(配置・ボディ)が替わった時だけ調べる(同じ物なら前の結果のまま。計算は同期で、同時に 1 つ)。
 *   組立の編集・元に戻す・やり直しでは一覧を閉じず、選んだ行だけを捨てる(assemblySlice の片付け。留めた結果をその場で見せる)。
 *   前の結果で自動の確かめを止めていた時(上限・時間を超えた)は、手で起動するまで調べず、結果に「古い」の印を付ける。
 * - 行を選ぶ: その接続の部材を選び、選んだ物に視点を合わせる。
 */
import { frameJointCheckStopped, runFrameJointCheck, type FrameJointCheckView } from '../assembly/frameJointCheckView.js';
import type { AppState } from './appState.js';

type SetState = (patch: Partial<AppState>) => void;

/** 状態の欄と操作。欄の初めの値と片付けは assemblySlice が持つ。 */
export interface FrameJointCheckSlice {
  readonly assemblyJointCheckOpen: boolean;
  readonly assemblyJointCheck: FrameJointCheckView | null;
  readonly assemblyJointCheckSelectedKey: string | null;
  readonly openAssemblyJointCheck: () => boolean;
  readonly refreshAssemblyJointCheck: (force?: boolean) => void;
  readonly selectAssemblyJointCheck: (key: string | null) => void;
  readonly closeAssemblyJointCheck: () => void;
}

type FrameJointCheckFields = 'assemblyJointCheckOpen' | 'assemblyJointCheck' | 'assemblyJointCheckSelectedKey';

/** 時間の計り(ms)。 */
function now(): number {
  return performance.now();
}

export function createFrameJointCheckActions(set: SetState, get: () => AppState): Omit<FrameJointCheckSlice, FrameJointCheckFields> {
  return {
    openAssemblyJointCheck: () => {
      const state = get();
      if (state.assembly === null || state.assemblyView === null || state.assemblyView.sourceDocument !== state.assembly) return false;
      if (state.assemblyInterferenceOpen) state.closeAssemblyInterference();
      set({ assemblyJointCheckOpen: true, assemblyJointCheck: null, assemblyJointCheckSelectedKey: null });
      get().refreshAssemblyJointCheck(false);
      return true;
    },
    refreshAssemblyJointCheck: (force = false) => {
      const state = get();
      const document = state.assembly, view = state.assemblyView, previous = state.assemblyJointCheck;
      if (!state.assemblyJointCheckOpen || document === null || view === null || view.sourceDocument !== document) return;
      if (!force && previous !== null && previous.sourceDocument === document && previous.sourceView === view) return;
      if (!force && previous !== null && frameJointCheckStopped(previous)) {
        if (!previous.stale) set({ assemblyJointCheck: { ...previous, stale: true } });
        return;
      }
      const next = runFrameJointCheck(document, view, force, now);
      const keep = state.assemblyJointCheckSelectedKey;
      const stillThere = keep !== null && next.result.ok && next.result.statuses.some((status) => status.joint.id === keep);
      set({ assemblyJointCheck: next, assemblyJointCheckSelectedKey: stillThere ? keep : null });
    },
    selectAssemblyJointCheck: (key) => {
      const state = get();
      set({ assemblyJointCheckSelectedKey: key });
      const result = state.assemblyJointCheck?.result;
      const joint = key === null || result === undefined || !result.ok ? undefined
        : result.statuses.find((status) => status.joint.id === key)?.joint;
      if (joint === undefined) return;
      const ids = joint.members.map((member) => member.componentId);
      state.setSelection(ids);
      get().viewCameraController?.fit('selection', ids);
    },
    closeAssemblyJointCheck: () => {
      set({ assemblyJointCheckOpen: false, assemblyJointCheck: null, assemblyJointCheckSelectedKey: null });
    },
  };
}
