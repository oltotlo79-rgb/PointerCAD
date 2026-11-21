const SCREEN_TOUR_STEPS = [
  { kind: 'command', id: 'file.new' },
  { kind: 'command', id: 'toolbar.sketch.point' },
  { kind: 'region', id: 'history' },
  { kind: 'region', id: 'properties' },
  { kind: 'region', id: 'statusBar' },
] as const;
const FIRST_STEP_INDEX = 0;

type ScreenTourStep = typeof SCREEN_TOUR_STEPS[number];
type TargetStatus = 'pending' | 'found' | 'missing';

export type ScreenTourState =
  | { readonly kind: 'step'; readonly step: ScreenTourStep; readonly targetStatus: TargetStatus }
  | { readonly kind: 'tutorialOffer' }
  | null;

type ScreenTourEvent =
  | { readonly type: 'start' | 'next' | 'previous' | 'dismiss' | 'documentChanged' }
  | { readonly type: 'targetChanged'; readonly step: ScreenTourStep; readonly found: boolean };

interface ScreenTourTransition {
  readonly state: ScreenTourState;
  readonly seen: boolean;
}

function showStep(index: number): ScreenTourTransition {
  const step = SCREEN_TOUR_STEPS[index];
  return step === undefined
    ? { state: { kind: 'tutorialOffer' }, seen: false }
    : { state: { kind: 'step', step: { ...step }, targetStatus: 'pending' }, seen: false };
}

/** The screen persists seen and opens the optional tutorial after handling the transition. */
export function advanceScreenTour(state: ScreenTourState, event: ScreenTourEvent): ScreenTourTransition {
  if (state === null) {
    return event.type === 'start' ? showStep(FIRST_STEP_INDEX) : { state, seen: false };
  }
  switch (event.type) {
    case 'dismiss': return { state: null, seen: true };
    case 'documentChanged': return { state: null, seen: false };
    case 'next':
      if (state.kind === 'tutorialOffer') return { state: null, seen: true };
      return showStep(SCREEN_TOUR_STEPS.findIndex(step => step.id === state.step.id) + 1);
    case 'previous': {
      const index = state.kind === 'tutorialOffer' ? SCREEN_TOUR_STEPS.length
        : SCREEN_TOUR_STEPS.findIndex(step => step.id === state.step.id);
      return index > FIRST_STEP_INDEX ? showStep(index - 1) : { state, seen: false };
    }
    case 'targetChanged': {
      // Keep one step reference per visit so callbacks from an earlier visit are ignored.
      if (state.kind !== 'step' || event.step !== state.step) return { state, seen: false };
      const targetStatus = event.found ? 'found' : 'missing';
      return { state: state.targetStatus === targetStatus ? state : { ...state, targetStatus }, seen: false };
    }
    case 'start': return { state, seen: false };
  }
}
