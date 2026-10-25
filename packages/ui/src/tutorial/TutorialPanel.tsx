import { useEffect, useRef } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { activeDocumentKind } from '../store/documentKind.js';
import { useAppStore } from '../store/useAppStore.js';
import { advanceTutorial, discardSavedTutorialCheckpoint, openTutorial,
  parameterTutorialEvidence, pauseTutorial, tutorialReady } from './tutorialActions.js';
import type { TutorialCheckpointFailure } from './tutorialCheckpoint.js';
import { PARAMETER_TUTORIAL_DEFAULTS, TUTORIAL_DEFAULTS } from './tutorialInput.js';
import { PARAMETER_TUTORIAL_STEPS, TUTORIAL_STEPS, parameterTutorialStep, tutorialStep,
  type ParameterTutorialStep, type TutorialStep } from './tutorialProgress.js';
import './tutorial.css';

const STEP_TEXT: Readonly<Record<TutorialStep, MessageKey>> = {
  point: 'tutorial.point', outline: 'tutorial.outline', face: 'tutorial.face', extrude: 'tutorial.extrude',
  hole: 'tutorial.hole', save: 'tutorial.save', complete: 'tutorial.complete',
};
const STEP_ACTION: Readonly<Record<TutorialStep, MessageKey>> = {
  point: 'tutorial.action.point', outline: 'tutorial.action.outline', face: 'tutorial.action.face',
  extrude: 'tutorial.action.extrude', hole: 'tutorial.action.hole', save: 'tutorial.action.save', complete: 'tutorial.action.complete',
};
const PARAMETER_STEP_TEXT: Readonly<Record<ParameterTutorialStep, MessageKey>> = {
  pointCoordinates: 'tutorial.parameter.point', thicknessParameter: 'tutorial.parameter.thickness',
  dimensionChange: 'tutorial.parameter.dimension', drawing: 'tutorial.parameter.drawing',
  stepStl: 'tutorial.parameter.export', complete: 'tutorial.parameter.complete',
};
const PARAMETER_STEP_ACTION: Readonly<Record<ParameterTutorialStep, MessageKey>> = {
  pointCoordinates: 'tutorial.action.point', thicknessParameter: 'tutorial.parameter.action.thickness',
  dimensionChange: 'tutorial.parameter.action.dimension', drawing: 'tutorial.parameter.action.drawing',
  stepStl: 'tutorial.parameter.action.export', complete: 'tutorial.action.complete',
};
const CHECKPOINT_FAILURE: Readonly<Record<TutorialCheckpointFailure, MessageKey>> = {
  missing: 'tutorial.checkpoint.missing', storageUnavailable: 'tutorial.checkpoint.storageUnavailable',
  storageQuota: 'tutorial.checkpoint.storageQuota', storageFailure: 'tutorial.checkpoint.storageFailure',
  corrupt: 'tutorial.checkpoint.corrupt', unsupportedVersion: 'tutorial.checkpoint.unsupportedVersion',
  differentDocument: 'tutorial.checkpoint.differentDocument', staleContent: 'tutorial.checkpoint.staleContent',
  staleSource: 'tutorial.checkpoint.staleSource', missingOwner: 'tutorial.checkpoint.missingOwner',
  staleRequest: 'tutorial.checkpoint.staleRequest', storageConflict: 'tutorial.checkpoint.storageConflict',
};

export function TutorialWelcome(): React.JSX.Element | null {
  const show = useAppStore(state => !state.tutorialOpen);
  const plateComplete = useAppStore(state => state.displaySettings.tutorialCompleted);
  const resumeParameter = useAppStore(state => state.tutorialSession?.course === 'parameterToExport');
  if (!show) return null;
  return <div className="pcad-tutorial__actions" data-help-topic="tutorial">
    {!plateComplete ? <button type="button" className="pcad-button pcad-tutorial-welcome"
      title={t('tutorial.startHint')} onClick={() => openTutorial('plate')}>{t('tutorial.start')}</button> : null}
    <button type="button" className="pcad-button pcad-tutorial-welcome"
       title={t('tutorial.parameter.startHint')} onClick={() => openTutorial('parameterToExport')}>{t(resumeParameter
         ? 'tutorial.parameter.resume' : 'tutorial.parameter.start')}</button>
  </div>;
}

export function TutorialPanel(): React.JSX.Element | null {
  const open = useAppStore(state => state.tutorialOpen);
  const session = useAppStore(state => state.tutorialSession);
  const step = useAppStore(state => state.tutorialSession === null || activeDocumentKind(state) !== 'part'
    ? 'differentDocument' : tutorialStep(state.tutorialSession, state.document, state.documentVersion, state.savedDocument));
  const parameterStep = useAppStore(state => state.tutorialSession?.course !== 'parameterToExport'
    ? 'differentDocument' : parameterTutorialStep(state.tutorialSession, state.document,
      state.documentVersion, parameterTutorialEvidence(state)));
  const parameterReady = useAppStore(state => state.tutorialSession?.course === 'parameterToExport'
    && parameterTutorialStep(state.tutorialSession, state.document, state.documentVersion,
      parameterTutorialEvidence(state)) !== 'differentDocument'
    && (state.drawing === null ? tutorialReady(state) : !state.drawingBusy));
  const coldDrawing = useAppStore(state => state.tutorialSession?.course === 'parameterToExport'
    && state.drawing !== null && state.savedDrawing === state.drawing
    && state.tutorialDrawingProof?.document === state.drawing
    && state.tutorialDrawingProof.sourcePart.id === state.tutorialSession.documentId
    && state.document !== state.tutorialDrawingProof.sourcePart);
  const ready = useAppStore(tutorialReady);
  const input = useAppStore(state => state.numericInput);
  const helpOpen = useAppStore(state => state.helpTopicId !== null);
  const checkpointFailure = useAppStore(state => state.tutorialCheckpointFailure);
  const nextRef = useRef<HTMLButtonElement>(null);
  const previousStep = useRef<string | null>(null);
  const activeStep = session?.course === 'parameterToExport' ? parameterStep : step;
  const activeReady = session?.course === 'parameterToExport' ? parameterReady : ready;
  useEffect(() => {
    if (!open) { previousStep.current = null; return; }
    if (helpOpen) return;
    if (input !== null) {
      if ((input.defaultSources === TUTORIAL_DEFAULTS || input.defaultSources === PARAMETER_TUTORIAL_DEFAULTS)
          && document.activeElement === document.body) {
        document.querySelector<HTMLInputElement>('.pcad-popover input.pcad-field__input')?.focus();
      }
      return;
    }
    if (!activeReady) return;
    if (previousStep.current !== activeStep) { previousStep.current = activeStep; nextRef.current?.focus(); }
  }, [open, helpOpen, input, activeReady, activeStep]);
  if (!open) return null;
  const active = session !== null && (activeStep !== 'differentDocument' || coldDrawing);
  const parameterCourse = session?.course === 'parameterToExport';
  return <section className="pcad-tutorial" aria-label={t('tutorial.title')} data-help-topic="tutorial"
    data-tutorial-step={activeStep}>
    <h2>{t('tutorial.title')}</h2>
    {session?.course !== 'plate' && checkpointFailure !== null
      ? <p role="alert">{t(CHECKPOINT_FAILURE[checkpointFailure])}</p> : null}
    {coldDrawing ? <>
      <p role="status">{t('tutorial.parameter.drawing')}</p>
      <button type="button" className="pcad-button" onClick={() => { advanceTutorial(); }}
        title={t('tutorial.parameter.action.confirmDrawing')}>{t('tutorial.parameter.action.confirmDrawing')}</button>
    </> : active ? <>
      <p role="status">{t('tutorial.progress').replace('{current}', String(parameterCourse
        ? Math.min(PARAMETER_TUTORIAL_STEPS.indexOf(parameterStep as ParameterTutorialStep) + 1,
          PARAMETER_TUTORIAL_STEPS.length - 1) : TUTORIAL_STEPS.indexOf(step as TutorialStep) + 1))
        .replace('{total}', String(parameterCourse ? PARAMETER_TUTORIAL_STEPS.length - 1 : TUTORIAL_STEPS.length))}</p>
      <p>{t(parameterCourse ? PARAMETER_STEP_TEXT[parameterStep as ParameterTutorialStep] : STEP_TEXT[step as TutorialStep])}</p>
      <p>{t(input === null ? 'tutorial.nextHint' : 'tutorial.inputHint')}</p>
      <button ref={nextRef} type="button" className="pcad-button" disabled={!activeReady || input !== null}
        title={t(parameterCourse ? PARAMETER_STEP_TEXT[parameterStep as ParameterTutorialStep] : STEP_TEXT[step as TutorialStep])}
        onClick={() => { advanceTutorial(); }}>{t(parameterCourse
          ? PARAMETER_STEP_ACTION[parameterStep as ParameterTutorialStep] : STEP_ACTION[step as TutorialStep])}</button>
      {!activeReady ? <p role="status">{t('tutorial.wait')}</p> : null}
    </> : <p role="status">{t('tutorial.existingDocument')}</p>}
    <div className="pcad-tutorial__actions">
      {session?.course !== 'plate' && checkpointFailure !== null ? <button type="button" className="pcad-button"
        title={t('tutorial.checkpoint.discard')} onClick={discardSavedTutorialCheckpoint}>
        {t('tutorial.checkpoint.discard')}</button> : null}
      <button type="button" className="pcad-button" title={t('tutorial.pauseHint')} onClick={pauseTutorial}>{t('tutorial.pause')}</button>
      <button type="button" className="pcad-button" title={t('tutorial.helpHint')} onClick={() => useAppStore.getState().openHelpTopic('tutorial')}>{t('tutorial.help')}</button>
    </div>
  </section>;
}
