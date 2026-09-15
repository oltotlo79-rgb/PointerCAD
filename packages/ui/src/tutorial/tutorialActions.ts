import { executeCommand } from '../commands/commandRegistry.js';
import { t } from '../i18n/t.js';
import { applySelectedFace } from '../sketch/commitToStore.js';
import { subShapeElementId } from '../solid/subShapeSelection.js';
import { activeDocumentKind } from '../store/documentKind.js';
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';
import { tutorialInput, TUTORIAL_DEFAULTS } from './tutorialInput.js';
import { createTutorialSession, tutorialStep, type TutorialSession } from './tutorialProgress.js';

export function tutorialReady(state: AppState): boolean {
  return activeDocumentKind(state) === 'part' && !state.isComputing
    && state.requestedGeneration === state.completedGeneration && state.lastOutcome === 'success'
    && state.partErrors.length === 0 && state.sketchErrors.length === 0;
}

export function openTutorial(): void {
  const state = useAppStore.getState();
  state.setTutorialOpen(true);
  const session = state.tutorialSession;
  if (session !== null && activeDocumentKind(state) === 'part'
      && tutorialStep(session, state.document, state.documentVersion, state.savedDocument) !== 'differentDocument') {
    state.setTutorialSession({ ...session, paused: false }); return;
  }
  if (activeDocumentKind(state) !== 'part' || state.numericInput !== null) return;
  state.setTutorialSession(createTutorialSession(state.document, state.documentVersion));
}

export function pauseTutorial(): void {
  const state = useAppStore.getState();
  if (state.tutorialSession !== null) state.setTutorialSession({ ...state.tutorialSession, paused: true });
  state.setTutorialOpen(false);
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
  if (session === null || session.paused || !tutorialReady(state)) return false;
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
