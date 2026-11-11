import { createNumericInput, reduceNumericInput, toggleNumericInput, type NumericInputState } from '../sketch/numericInput.js';
import type { NumericDefaultSources } from '../sketch/numericDefaultSources.js';
import type { TutorialDraft, TutorialNumericStageDraft } from './tutorialCheckpoint.js';
import type { TutorialStep } from './tutorialProgress.js';

/** Explicit millimetres keep the example identical even when the user's display unit is inches. */
export const TUTORIAL_DEFAULTS: NumericDefaultSources = Object.freeze({
  'point/absolute/x': '0mm', 'point/absolute/y': '0mm', 'point/absolute/z': '0mm',
  'rectangleCorner1/absolute/x': '-30mm', 'rectangleCorner1/absolute/y': '-20mm', 'rectangleCorner1/absolute/z': '0mm',
  'rectangleCorner2/relative/dx': '60mm', 'rectangleCorner2/relative/dy': '40mm', 'rectangleCorner2/relative/dz': '0mm',
  'rectangleCorner2/absolute/x': '30mm', 'rectangleCorner2/absolute/y': '20mm', 'rectangleCorner2/absolute/z': '0mm',
  'extrudeDistance/absolute/distance': '8mm',
  'holeSize/absolute/diameter': '10mm', 'holeSize/absolute/depth': '8mm',
});

/** A second course uses the same ordinary tools and a named 3 mm thickness parameter. */
export const PARAMETER_TUTORIAL_DEFAULTS: NumericDefaultSources = Object.freeze({
  'point/absolute/x': '0mm', 'point/absolute/y': '0mm', 'point/absolute/z': '0mm',
  'rectangleCorner1/absolute/x': '-30mm', 'rectangleCorner1/absolute/y': '-20mm', 'rectangleCorner1/absolute/z': '0mm',
  'rectangleCorner2/relative/dx': '60mm', 'rectangleCorner2/relative/dy': '40mm', 'rectangleCorner2/relative/dz': '0mm',
  'extrudeDistance/absolute/distance': '板厚',
});

export function parameterTutorialInput(step: 'pointCoordinates' | 'outline' | 'extrude'): NumericInputState {
  const options = { defaultSources: PARAMETER_TUTORIAL_DEFAULTS, repeatAfterCommit: false };
  if (step === 'pointCoordinates') return createNumericInput('point', 'point', 'absolute', options);
  if (step === 'outline') return createNumericInput('rectangle', 'rectangleCorner1', 'absolute', options);
  return createNumericInput('extrude', 'extrudeDistance', 'absolute', options);
}

function numericStageDraft(input: NumericInputState): TutorialNumericStageDraft | null {
  if (input.step !== 'point' && input.step !== 'rectangleCorner1'
      && input.step !== 'rectangleCorner2' && input.step !== 'extrudeDistance') return null;
  const focus = input.fields[input.focusedIndex]?.key ?? input.fields[0]?.key;
  if (focus === undefined) return null;
  return { operation: input.step, mode: input.mode,
    fields: input.fields.map(field => ({ key: field.key, source: field.source })), focusedKey: focus };
}

/** Capture original expressions and focus before a normal two-stage transition discards the first input. */
export function parameterNumericDraft(input: NumericInputState, prior: NumericInputState | null = null,
  oldDraft: TutorialDraft | null = null): TutorialDraft | null {
  if (input.defaultSources !== PARAMETER_TUTORIAL_DEFAULTS) return null;
  const stage = numericStageDraft(input);
  if (stage === null) return null;
  const priorStage = input.step === 'rectangleCorner2' && prior?.step === 'rectangleCorner1'
    ? numericStageDraft(prior) : null;
  const previousStage = priorStage ?? (oldDraft?.kind === 'numeric' && oldDraft.operation === 'rectangleCorner2'
    ? oldDraft.previousStage ?? null : null);
  return { kind: 'numeric', ...stage,
    ...(input.step === 'rectangleCorner2' && previousStage?.operation === 'rectangleCorner1'
      ? { previousStage } : {}) };
}

/** Reopen only fields and focus; this never commits a sketch feature or an evaluated number. */
export function restoreParameterNumericDraft(draft: Extract<TutorialDraft, { kind: 'numeric' }>,
  firstCorner = false): NumericInputState | null {
  const stage = firstCorner ? draft.previousStage : draft;
  if (stage === undefined) return null;
  const tool = stage.operation === 'point' ? 'point' : stage.operation === 'extrudeDistance' ? 'extrude' : 'rectangle';
  let input = createNumericInput(tool, stage.operation, stage.mode,
    { defaultSources: PARAMETER_TUTORIAL_DEFAULTS, repeatAfterCommit: false });
  if (input.fields.length !== stage.fields.length || input.fields.some((field, index) => field.key !== stage.fields[index]?.key)) return null;
  stage.fields.forEach((field, index) => { input = reduceNumericInput(input, { type: 'edit', index, source: field.source }); });
  const index = input.fields.findIndex(field => field.key === stage.focusedKey);
  return index < 0 ? null : reduceNumericInput(input, { type: 'focus', index });
}

export function tutorialInput(step: TutorialStep): NumericInputState | null {
  const options = { defaultSources: TUTORIAL_DEFAULTS, repeatAfterCommit: false };
  switch (step) {
    case 'point': return createNumericInput('point', 'point', 'absolute', options);
    case 'outline': return createNumericInput('rectangle', 'rectangleCorner1', 'absolute', options);
    case 'extrude': return createNumericInput('extrude', 'extrudeDistance', 'absolute', options);
    case 'hole': return toggleNumericInput(createNumericInput('hole', 'holeSize', 'absolute', options), 'through');
    default: return null;
  }
}
