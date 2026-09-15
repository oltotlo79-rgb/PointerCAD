import { useEffect, useRef } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { activeDocumentKind } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { advanceTutorial, openTutorial, pauseTutorial, tutorialReady } from './tutorialActions.js';
import { TUTORIAL_DEFAULTS } from './tutorialInput.js';
import { TUTORIAL_STEPS, tutorialStep, type TutorialStep } from './tutorialProgress.js';
import './tutorial.css';

const STEP_TEXT: Readonly<Record<TutorialStep, MessageKey>> = {
  point: 'tutorial.point', outline: 'tutorial.outline', face: 'tutorial.face', extrude: 'tutorial.extrude',
  hole: 'tutorial.hole', save: 'tutorial.save', complete: 'tutorial.complete',
};
const STEP_ACTION: Readonly<Record<TutorialStep, MessageKey>> = {
  point: 'tutorial.action.point', outline: 'tutorial.action.outline', face: 'tutorial.action.face',
  extrude: 'tutorial.action.extrude', hole: 'tutorial.action.hole', save: 'tutorial.action.save', complete: 'tutorial.action.complete',
};

export function TutorialWelcome(): React.JSX.Element | null {
  const show = useAppStore(state => !state.displaySettings.tutorialCompleted && !state.tutorialOpen);
  if (!show) return null;
  return <button type="button" className="pcad-button pcad-tutorial-welcome" data-help-topic="tutorial"
    title={t('tutorial.startHint')} onClick={openTutorial}>{t('tutorial.start')}</button>;
}

export function TutorialPanel(): React.JSX.Element | null {
  const open = useAppStore(state => state.tutorialOpen);
  const session = useAppStore(state => state.tutorialSession);
  const step = useAppStore(state => state.tutorialSession === null || activeDocumentKind(state) !== 'part'
    ? 'differentDocument' : tutorialStep(state.tutorialSession, state.document, state.documentVersion, state.savedDocument));
  const ready = useAppStore(tutorialReady);
  const input = useAppStore(state => state.numericInput);
  const helpOpen = useAppStore(state => state.helpTopicId !== null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const previousStep = useRef<string | null>(null);
  useEffect(() => {
    if (!open) { previousStep.current = null; return; }
    if (helpOpen) return;
    if (input !== null) {
      if (input.defaultSources === TUTORIAL_DEFAULTS && document.activeElement === document.body) {
        document.querySelector<HTMLInputElement>('.pcad-popover input.pcad-field__input')?.focus();
      }
      return;
    }
    if (!ready) return;
    if (previousStep.current !== step) { previousStep.current = step; nextRef.current?.focus(); }
  }, [open, helpOpen, input, ready, step]);
  if (!open) return null;
  const active = session !== null && step !== 'differentDocument';
  return <section className="pcad-tutorial" aria-label={t('tutorial.title')} data-help-topic="tutorial"
    data-tutorial-step={step}>
    <h2>{t('tutorial.title')}</h2>
    {active ? <>
      <p role="status">{t('tutorial.progress').replace('{current}', String(TUTORIAL_STEPS.indexOf(step) + 1)).replace('{total}', String(TUTORIAL_STEPS.length))}</p>
      <p>{t(STEP_TEXT[step])}</p>
      <p>{t(input === null ? 'tutorial.nextHint' : 'tutorial.inputHint')}</p>
      <button ref={nextRef} type="button" className="pcad-button" disabled={!ready || input !== null} title={t(STEP_TEXT[step])}
        onClick={() => { advanceTutorial(); }}>{t(STEP_ACTION[step])}</button>
      {!ready ? <p role="status">{t('tutorial.wait')}</p> : null}
    </> : <p role="status">{t('tutorial.existingDocument')}</p>}
    <div className="pcad-tutorial__actions">
      <button type="button" className="pcad-button" title={t('tutorial.pauseHint')} onClick={pauseTutorial}>{t('tutorial.pause')}</button>
      <button type="button" className="pcad-button" title={t('tutorial.helpHint')} onClick={() => useAppStore.getState().openHelpTopic('tutorial')}>{t('tutorial.help')}</button>
    </div>
  </section>;
}
