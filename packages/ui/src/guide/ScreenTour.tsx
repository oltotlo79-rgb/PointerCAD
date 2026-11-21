import { useCallback, useId, useLayoutEffect, useRef } from 'react';
import { isCompositionKey } from '../commands/compositionKey.js';
import { t, type MessageKey } from '../i18n/t.js';
import { rememberDialogOpener } from '../shell/dialogFocus.js';
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';
import { openTutorial } from '../tutorial/tutorialActions.js';
import { CoachMark } from './CoachMark.js';
import type { ScreenTourState } from './screenTourState.js';

type Visit = Extract<ScreenTourState, { kind: 'step' }>['step'];
const descriptions: Readonly<Record<Visit['id'], MessageKey>> = {
  'file.new': 'guide.toolbar', 'toolbar.sketch.point': 'guide.point',
  history: 'guide.history', properties: 'guide.properties', statusBar: 'guide.statusBar',
};

export function useScreenTourActive(): boolean {
  return useAppStore(state => state.screenTour.state !== null);
}

// The visit lives in the one application store (rules/04); `owner` tells the coexisting buttons apart.
const send: AppState['sendScreenTour'] = (owner, event) => useAppStore.getState().sendScreenTour(owner, event);

interface TourProps {
  readonly replay?: boolean;
  readonly onTutorial?: () => void;
}

export function ScreenTour({ replay = false, onTutorial = openTutorial }: TourProps): React.JSX.Element {
  const owner = useId();
  const state = useAppStore(app => app.screenTour.owner === owner ? app.screenTour.state : null);
  const controlsRef = useRef<HTMLSpanElement>(null);
  const open = state !== null;
  const step = state?.kind === 'step' ? state.step : null;
  const onTargetChange = useCallback((found: boolean) => {
    if (step) send(owner, { type: 'targetChanged', step, found });
  }, [owner, step]);
  const escape = useCallback((event: KeyboardEvent | React.KeyboardEvent): void => {
    const key = 'nativeEvent' in event ? event.nativeEvent : event;
    if (event.key !== 'Escape' || event.defaultPrevented || isCompositionKey(key)) return;
    event.preventDefault();
    event.stopPropagation();
    send(owner, { type: 'dismiss' });
  }, [owner]);
  useLayoutEffect(() => {
    if (!open) return;
    const restore = rememberDialogOpener(controlsRef.current);
    const unsubscribe = useAppStore.subscribe((after, before) => {
      if (after.activeDocumentId !== before.activeDocumentId || after.tutorialOpen !== before.tutorialOpen) {
        send(owner, { type: 'documentChanged' });
      }
    });
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('keydown', escape);
      unsubscribe();
      send(owner, { type: 'documentChanged' });
      restore();
    };
  }, [open, owner, escape]);
  return <span className="pcad-screen-tour" onKeyDown={open ? escape : undefined}>
    <button type="button" className={replay ? 'pcad-button' : 'pcad-button pcad-tutorial-welcome'}
      aria-expanded={open} title={t('guide.startHint')} onClick={() => send(owner, { type: 'start' })}>{t(replay ? 'guide.replay' : 'guide.start')}</button>
    {state && <span ref={controlsRef} className="pcad-screen-tour" role="group" aria-label={t('guide.start')}>
      {step && <CoachMark anchor={step} message={descriptions[step.id]} onTargetChange={onTargetChange} />}
      <button type="button" className="pcad-button" title={t(state.kind === 'tutorialOffer' ? 'tutorial.startHint' : 'guide.next')}
        onClick={() => {
          send(owner, { type: 'next' });
          if (state.kind === 'tutorialOffer') onTutorial();
        }}>{t(state.kind === 'tutorialOffer' ? 'tutorial.start' : 'guide.next')}</button>
      <button type="button" className="pcad-button" title={t('guide.previous')} aria-disabled={step?.id === 'file.new'}
        onClick={() => send(owner, { type: 'previous' })}>{t('guide.previous')}</button>
      <button type="button" className="pcad-button" title={t('guide.dismiss')}
        onClick={() => send(owner, { type: 'dismiss' })}>{t('guide.dismiss')}</button>
    </span>}
  </span>;
}
