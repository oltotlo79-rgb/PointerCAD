import { createNumericInput, toggleNumericInput, type NumericInputState } from '../sketch/numericInput.js';
import type { NumericDefaultSources } from '../sketch/numericDefaultSources.js';
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
