import type { StateCreator } from 'zustand';
import { advanceScreenTour, type ScreenTourState } from '../guide/screenTourState.js';
import { helpTopic } from '../help/helpLibrary.js';
import type { AppState } from './appState.js';

/** The welcome and settings buttons can coexist. Only the button that started this visit (owner) hosts its controls. */
interface ScreenTourSession {
  readonly owner: string | null;
  readonly state: ScreenTourState;
}

export interface HelpSlice {
  readonly helpTopicId: string | null;
  readonly openHelpTopic: (id: string) => boolean;
  readonly closeHelp: () => void;
  readonly screenTour: ScreenTourSession;
  /** Advances the visit owned by `owner`; a finished or dismissed visit records that the tour was seen. */
  readonly sendScreenTour: (owner: string, event: Parameters<typeof advanceScreenTour>[1]) => void;
}
export type HelpInitialState = Pick<HelpSlice, 'helpTopicId'>;
export const createHelpSlice: StateCreator<AppState, [], [], Omit<HelpSlice, keyof HelpInitialState>> = (set, get) => ({
  openHelpTopic: (id) => {
    if (helpTopic(id) === undefined) return false;
    set({ helpTopicId: id }); return true;
  },
  closeHelp: () => set({ helpTopicId: null }),
  screenTour: { owner: null, state: null },
  sendScreenTour: (owner, event) => {
    const session = get().screenTour;
    if (event.type !== 'start' && session.owner !== owner) return;
    const transition = advanceScreenTour(session.owner === owner ? session.state : null, event);
    if (session.owner === owner && transition.state === session.state) return;
    set({ screenTour: { owner: transition.state ? owner : null, state: transition.state } });
    if (transition.seen) get().setDisplaySettings({ ...get().displaySettings, screenTourSeen: true });
  },
});
