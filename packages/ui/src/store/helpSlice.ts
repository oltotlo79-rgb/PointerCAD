import type { StateCreator } from 'zustand';
import { helpTopic } from '../help/helpLibrary.js';
import type { AppState } from './appState.js';

export interface HelpSlice {
  readonly helpTopicId: string | null;
  readonly openHelpTopic: (id: string) => boolean;
  readonly closeHelp: () => void;
}
export type HelpInitialState = Pick<HelpSlice, 'helpTopicId'>;
export const createHelpSlice: StateCreator<AppState, [], [], Omit<HelpSlice, keyof HelpInitialState>> = (set) => ({
  openHelpTopic: (id) => {
    if (helpTopic(id) === undefined) return false;
    set({ helpTopicId: id }); return true;
  },
  closeHelp: () => set({ helpTopicId: null }),
});
