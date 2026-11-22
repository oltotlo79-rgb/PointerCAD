import type { AxisSpec } from '@pointercad/model';
import { commitExplodeDraft, createExplodeDraft } from '../assembly/explodeCommands.js';
import type { AppState } from './appState.js';

export interface AssemblyExplodeSlice {
  readonly beginAssemblyExplode: () => boolean;
  readonly cancelAssemblyExplode: () => void;
  readonly commitAssemblyExplode: (distanceSource: string, name: string, direction?: AxisSpec) => boolean;
}

export function createAssemblyExplodeActions(set: (patch: Partial<AppState>) => void, get: () => AppState): AssemblyExplodeSlice {
  return {
    beginAssemblyExplode: () => {
      const state = get();
      if (state.assembly === null || state.assemblyPlacement !== null || state.assemblyMateDraft !== null) return false;
      const result = createExplodeDraft(state.assembly, state.selection);
      if (!result.ok) return false;
      set({ assemblyExplodeDraft: result.draft, assemblyExplodeError: null,
        assemblyMotionPlaying: false });
      return true;
    },
    cancelAssemblyExplode: () => {
      set({ assemblyExplodeDraft: null, assemblyExplodeError: null });
    },
    commitAssemblyExplode: (distanceSource, name, direction) => {
      const state = get();
      if (state.assembly === null || state.assemblyExplodeDraft === null) return false;
      const draft = direction === undefined ? state.assemblyExplodeDraft
        : { ...state.assemblyExplodeDraft, direction };
      const result = commitExplodeDraft(state.assembly, draft, distanceSource, name);
      if (!result.ok) {
        set({ assemblyExplodeError: result.reason === 'invalidExpression' ? 'invalidExpression' : 'invalidStep' });
        return false;
      }
      get().applyAssembly(result.document);
      return true;
    },
  };
}
