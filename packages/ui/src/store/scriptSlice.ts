import type { StateCreator } from 'zustand';
import type { ScriptExecutor, ScriptFile, ScriptConsoleLine, ScriptFailure, ScriptPhase } from '@pointercad/model/scripting';
import type { ScriptDraft } from '../scripting/scriptDraft.js';
import type { AppState } from './appState.js';

export interface ScriptRunLog {
  readonly seed: number; readonly timeMs: number; readonly apiVersion: number; readonly sha256: string;
  readonly commandCount: number; readonly initializationMs: number; readonly javascriptMs: number; readonly cadMs: number;
}
export interface ScriptSlice {
  readonly scriptPanelOpen: boolean; readonly scriptDraft: ScriptDraft | null;
  readonly scriptExecutor: ScriptExecutor | null; readonly scriptController: AbortController | null;
  readonly scriptRequestId: string | null; readonly scriptPhase: ScriptPhase | 'idle' | 'succeeded' | 'failed' | 'cancelled';
  readonly scriptError: ScriptFailure | null; readonly scriptConsole: readonly ScriptConsoleLine[];
  readonly scriptRunLog: ScriptRunLog | null; readonly scriptMessage: string | null;
  readonly scriptLibrary: readonly ScriptFile[]; readonly scriptLibraryState: 'unloaded' | 'loading' | 'ready' | 'failed';
  readonly scriptLibraryBusy: boolean; readonly scriptDeletedTool: ScriptFile | null;
  readonly setScriptDraft: (draft: ScriptDraft) => void;
  readonly closeScriptPanel: () => void;
  readonly cancelScript: () => void;
}
export const createScriptSlice: StateCreator<AppState, [], [], ScriptSlice> = (set, get) => ({
  scriptPanelOpen: false, scriptDraft: null, scriptExecutor: null, scriptController: null, scriptRequestId: null,
  scriptPhase: 'idle', scriptError: null, scriptConsole: [], scriptRunLog: null, scriptMessage: null,
  scriptLibrary: [], scriptLibraryState: 'unloaded', scriptLibraryBusy: false, scriptDeletedTool: null,
  setScriptDraft: (scriptDraft) => set({ scriptDraft, scriptMessage: null }),
  closeScriptPanel: () => { get().cancelScript(); set({ scriptPanelOpen: false }); },
  cancelScript: () => {
    const controller = get().scriptController;
    if (controller === null) return;
    controller.abort();
    // The visible cancellation is synchronous; a late kernel result still releases its own owner.
    set({ scriptController: null, scriptRequestId: null, scriptPhase: 'cancelled', scriptError: null });
  },
});
