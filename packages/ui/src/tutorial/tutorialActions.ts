import { executeCommand } from '../commands/commandRegistry.js';
import { t } from '../i18n/t.js';
import { applySelectedFace } from '../sketch/commitToStore.js';
import { subShapeElementId } from '../solid/subShapeSelection.js';
import { activeDocumentKind } from '../store/documentKind.js';
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';
import { createDrawingFromCurrentPart } from '../drawing/createDrawingCommands.js';
import { closeDrawingWithConfirmation } from '../drawing/closeDrawing.js';
import { parameterNumericDraft, parameterTutorialInput, PARAMETER_TUTORIAL_DEFAULTS,
  restoreParameterNumericDraft, tutorialInput, TUTORIAL_DEFAULTS } from './tutorialInput.js';
import { discardTutorialCheckpoint, updateTutorialCheckpointDraft, type TutorialDraft } from './tutorialCheckpoint.js';
import { createParameterTutorialSession, createTutorialSession, parameterTutorialEvidence, parameterTutorialStep, tutorialStep,
  parameterCheckpointWriteGuard, type TutorialSession } from './tutorialProgress.js';
export { parameterTutorialEvidence } from './tutorialProgress.js';

export function tutorialReady(state: AppState): boolean {
  return activeDocumentKind(state) === 'part' && tutorialPartReady(state);
}

function tutorialPartReady(state: AppState): boolean {
  return !state.isComputing
    && state.requestedGeneration === state.completedGeneration && state.lastOutcome === 'success'
    && state.partErrors.length === 0 && state.sketchErrors.length === 0;
}

let captureInstalled = false;
let capturing = false;

function persistParameterDraft(state: AppState, draft: TutorialDraft | null): void {
  const session = state.tutorialSession;
  const saved = state.savedDocument;
  if (session?.course !== 'parameterToExport' || saved === null || saved.id !== session.documentId) return;
  const current = () => {
    const latest = useAppStore.getState();
    return latest.tutorialSession === session && latest.document === state.document
      && latest.savedDocument === saved && latest.tutorialDraft === draft;
  };
  const guard = parameterCheckpointWriteGuard(session, state.tutorialCheckpointStorage, current);
  if (!guard.ok) {
    if (current()) useAppStore.getState().setTutorialCheckpointFailure(guard.reason);
    return;
  }
  void updateTutorialCheckpointDraft(draft, saved, state.tutorialCheckpointStorage, guard.isCurrent).then(result => {
    if (current() && !result.ok && result.reason !== 'missing') {
      useAppStore.getState().setTutorialCheckpointFailure(result.reason);
    }
  });
}

function ensureParameterDraftCapture(): void {
  if (captureInstalled) return;
  captureInstalled = true;
  useAppStore.subscribe((next, previous) => {
    if (capturing || next.tutorialSession?.course !== 'parameterToExport'
        || next.numericInput === previous.numericInput) return;
    const input = next.numericInput;
    if (input === null) {
      if (previous.numericInput?.defaultSources !== PARAMETER_TUTORIAL_DEFAULTS) return;
      capturing = true;
      try { next.setTutorialDraft(null); } finally { capturing = false; }
      persistParameterDraft(useAppStore.getState(), null);
      return;
    }
    if (input.defaultSources !== PARAMETER_TUTORIAL_DEFAULTS) return;
    const old = previous.tutorialDraft;
    const returningToSecondCorner = previous.numericInput?.step === 'rectangleCorner1'
      && input.step === 'rectangleCorner2' && old?.kind === 'numeric'
      && old.operation === 'rectangleCorner2';
    const restored = returningToSecondCorner ? restoreParameterNumericDraft(old) : null;
    const finalInput = restored ?? input;
    const observed = parameterNumericDraft(finalInput, previous.numericInput, old);
    if (observed === null) return;
    const draft: TutorialDraft = input.step === 'rectangleCorner1' && old?.kind === 'numeric'
      && old.operation === 'rectangleCorner2' && observed.kind === 'numeric'
      ? { ...old, previousStage: { operation: observed.operation, mode: observed.mode,
        fields: observed.fields, focusedKey: observed.focusedKey } } : observed;
    capturing = true;
    try {
      if (restored !== null) next.updateNumericInput(restored);
      useAppStore.getState().setTutorialDraft(draft);
    } finally { capturing = false; }
    persistParameterDraft(useAppStore.getState(), draft);
  });
}

export function openTutorial(course: 'plate' | 'parameterToExport' = 'plate'): void {
  const state = useAppStore.getState();
  if (course === 'parameterToExport') ensureParameterDraftCapture();
  state.setTutorialOpen(true);
  const session = state.tutorialSession;
  if (course === 'parameterToExport' && session?.course === course && state.drawing !== null
      && state.savedDrawing === state.drawing && state.tutorialDrawingProof?.document === state.drawing
      && state.tutorialDrawingProof.sourcePart.id === session.documentId) {
    state.setTutorialSession({ ...session, paused: false });
    return;
  }
  if (session !== null && (session.course ?? 'plate') === course
      && (course === 'plate'
        ? activeDocumentKind(state) === 'part'
          && tutorialStep(session, state.document, state.documentVersion, state.savedDocument) !== 'differentDocument'
        : parameterTutorialStep(session, state.document, state.documentVersion,
          parameterTutorialEvidence(state)) !== 'differentDocument')) {
    state.setTutorialSession({ ...session, paused: false });
    if (course === 'parameterToExport' && state.numericInput === null && state.tutorialDraft?.kind === 'numeric') {
      const draft = state.tutorialDraft;
      const currentStep = parameterTutorialStep(session, state.document, state.documentVersion,
        parameterTutorialEvidence(state));
      const compatible = draft.operation === 'point' ? currentStep === 'pointCoordinates'
        : currentStep === 'thicknessParameter';
      const restored = compatible ? restoreParameterNumericDraft(draft, draft.operation === 'rectangleCorner2') : null;
      if (restored !== null) {
        capturing = true;
        try {
          const step = draft.operation === 'point' ? 'pointCoordinates'
            : draft.operation === 'extrudeDistance' ? 'extrude' : 'outline';
          if (enterParameterTool(step, step === 'extrude' ? session.faceId : undefined)) {
            useAppStore.getState().updateNumericInput(restored);
          }
        } finally { capturing = false; }
      }
    }
    return;
  }
  if (activeDocumentKind(state) !== 'part' || state.numericInput !== null) return;
  state.setTutorialDrawingProof(null); state.setTutorialExports({});
  state.setTutorialSession(course === 'plate' ? createTutorialSession(state.document, state.documentVersion)
    : createParameterTutorialSession(state.document, state.documentVersion));
}

export function pauseTutorial(): void {
  const state = useAppStore.getState();
  if (state.tutorialSession !== null) state.setTutorialSession({ ...state.tutorialSession, paused: true });
  state.setTutorialOpen(false);
  if (state.tutorialSession?.course === 'parameterToExport') {
    const latest = useAppStore.getState();
    persistParameterDraft(latest, latest.tutorialDraft);
  }
}

/** Only the visible discard button calls this; a cancelled input or failed save leaves the record intact. */
export function discardSavedTutorialCheckpoint(): boolean {
  const owner = useAppStore.getState();
  const document = owner.document;
  const activeId = owner.activeDocumentId;
  const version = owner.documentVersion;
  const storage = owner.tutorialCheckpointStorage;
  const current = () => {
    const latest = useAppStore.getState();
    return latest.tutorialOpen && latest.document === document && latest.activeDocumentId === activeId
      && latest.documentVersion === version && latest.tutorialCheckpointStorage === storage;
  };
  const result = discardTutorialCheckpoint(storage, current);
  if (!current()) return false;
  if (!result.ok) { useAppStore.getState().setTutorialCheckpointFailure(result.reason); return false; }
  const latest = useAppStore.getState();
  latest.setTutorialCheckpointFailure(null);
  latest.setTutorialDraft(null);
  latest.setTutorialSession(null);
  latest.setTutorialDrawingProof(null);
  latest.setTutorialExports({});
  return true;
}

/** Select the actual upper planar face, never an assumed OCCT face number. */
function selectHoleTarget(state: AppState, session: TutorialSession): boolean {
  const body = state.bodies.find(item => item.featureId === session.extrudeId);
  const faces = body?.faces.filter(face => face.surfaceKind === 'plane' && face.axis !== null
    && Number.isFinite(face.centroid[2]) && Math.abs(face.axis[2]) > 1 - 1e-8) ?? [];
  const upper = faces.reduce<typeof faces[number] | undefined>((best, face) =>
    best === undefined || face.centroid[2] > best.centroid[2] ? face : best, undefined);
  if (upper === undefined) { state.setShapeError(t('tutorial.error.holeFace')); return false; }
  state.setSelection([subShapeElementId(session.extrudeId, 'face', upper.index), session.pointId]);
  return true;
}

export function advanceTutorial(): boolean {
  const state = useAppStore.getState(), session = state.tutorialSession;
  if (session === null || session.paused) return false;
  if (session.course === 'parameterToExport') return advanceParameterTutorial(state, session);
  if (!tutorialReady(state)) return false;
  const step = tutorialStep(session, state.document, state.documentVersion, state.savedDocument);
  if (step === 'differentDocument') return false;
  if (step === 'complete') {
    state.setDisplaySettings({ ...state.displaySettings, tutorialCompleted: true });
    state.setTutorialSession(null); state.setTutorialOpen(false); return true;
  }
  if (state.numericInput !== null) {
    // A paused input stays exactly as typed. Reopening the guide must not reset it.
    if (state.numericInput.defaultSources === TUTORIAL_DEFAULTS) return true;
    state.setShapeError(t('tutorial.error.finishInput')); return false;
  }
  if (step === 'save') return executeCommand('file.save').status === 'executed';
  state.setWorkPlane('xy');
  if (step === 'face') {
    state.setActiveTool('face'); state.setSelection([session.outlineId]);
    return applySelectedFace();
  }
  const input = tutorialInput(step);
  if (input === null) return false;
  // Changing a tool can clear selection; establish it afterwards, just as ordinary picking does.
  state.setActiveTool('select');
  state.setSelectionKind(step === 'hole' ? 'face' : 'body');
  if (step === 'extrude') state.setSelection([session.faceId]);
  if (step === 'hole' && !selectHoleTarget(useAppStore.getState(), session)) return false;
  const command = step === 'point' ? 'toolbar.sketch.point' : step === 'outline' ? 'toolbar.shape.rectangle'
    : step === 'extrude' ? 'toolbar.solidCreate.extrude' : 'toolbar.solidMachining.hole';
  // The command checks the same readiness and enters the same normal tool as the toolbar.
  const result = executeCommand(command);
  if (result.status !== 'executed' || useAppStore.getState().numericInput === null) return false;
  state.updateNumericInput(input);
  return true;
}

function advanceParameterTutorial(state: AppState, session: TutorialSession): boolean {
  const coldProof = state.tutorialDrawingProof;
  if (state.drawing !== null && state.savedDrawing === state.drawing
      && coldProof?.document === state.drawing && coldProof.sourcePart.id === session.documentId
      && state.document !== coldProof.sourcePart) {
    void closeDrawingWithConfirmation(undefined, { resumeGuidePart: true });
    return true;
  }
  const step = parameterTutorialStep(session, state.document, state.documentVersion,
    parameterTutorialEvidence(state));
  if (step === 'differentDocument') {
    const proof = state.tutorialDrawingProof;
    if (state.drawing === null || state.savedDrawing !== state.drawing || proof?.document !== state.drawing
        || proof.sourcePart.id !== session.documentId) return false;
    void closeDrawingWithConfirmation(undefined, { resumeGuidePart: true });
    return true;
  }
  if (step === 'complete') { state.setTutorialSession(null); state.setTutorialOpen(false); return true; }
  if (state.numericInput !== null) {
    if (state.numericInput.defaultSources === PARAMETER_TUTORIAL_DEFAULTS) return true;
    state.setShapeError(t('tutorial.error.finishInput')); return false;
  }
  if (step === 'stepStl') {
    if (state.drawing !== null) { void closeDrawingWithConfirmation(undefined, { resumeGuidePart: true }); return true; }
    if (!tutorialReady(state)) return false;
    state.setUtilityPanelOpen('export', true); return true;
  }
  if (step === 'drawing') {
    if (state.drawing !== null) return executeCommand('file.save').status === 'executed';
    if (!tutorialReady(state)) return false;
    void createDrawingFromCurrentPart(); return true;
  }
  if (!tutorialReady(state)) return false;
  if (step === 'dimensionChange') {
    const parameter = state.document.parameters.find(item => item.name === session.parameterName);
    return parameter?.value.value === 6 && executeCommand('file.save').status === 'executed';
  }
  if (step === 'thicknessParameter') {
    if (!state.document.parameters.some(item => item.name === session.parameterName)) return false;
    const sketch = state.document.sketches.find(item => item.id === session.sketchId);
    if (sketch === undefined) return false;
    if (!sketch.features.some(item => item.id === session.outlineId && item.kind === 'rectangle')) return enterParameterTool('outline');
    if (!sketch.features.some(item => item.id === session.faceId && item.kind === 'face')) {
      state.setActiveTool('face'); state.setSelection([session.outlineId]); return applySelectedFace();
    }
    if (state.document.solids.some(item => item.id === session.extrudeId)) return false;
    return enterParameterTool('extrude', session.faceId);
  }
  return enterParameterTool('pointCoordinates');
}

function enterParameterTool(step: 'pointCoordinates' | 'outline' | 'extrude', selectedFaceId?: string): boolean {
  const state = useAppStore.getState();
  state.setWorkPlane('xy');
  state.setActiveTool('select');
  state.setSelectionKind('body');
  if (selectedFaceId !== undefined) state.setSelection([selectedFaceId]);
  const command = step === 'pointCoordinates' ? 'toolbar.sketch.point'
    : step === 'outline' ? 'toolbar.shape.rectangle' : 'toolbar.solidCreate.extrude';
  if (executeCommand(command).status !== 'executed' || useAppStore.getState().numericInput === null) return false;
  state.updateNumericInput(parameterTutorialInput(step));
  return true;
}
