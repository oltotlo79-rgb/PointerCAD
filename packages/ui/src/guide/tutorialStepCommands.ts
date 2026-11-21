import type { ToolbarCommandId } from '../commands/toolbarCommandCatalog.js';
import type { ParameterTutorialStep, TutorialStep } from '../tutorial/tutorialProgress.js';

type StepCommands<Step extends string> = Readonly<Record<Step, ToolbarCommandId | null>>;

/** One primary toolbar target per stage. Completion has no toolbar target. */
export const TUTORIAL_STEP_COMMANDS = {
  plate: {
    point: 'toolbar.sketch.point',
    outline: 'toolbar.shape.rectangle',
    face: 'toolbar.sketch.face',
    extrude: 'toolbar.solidCreate.extrude',
    hole: 'toolbar.solidMachining.hole',
    save: 'file.save',
    complete: null,
  },
  parameterToExport: {
    pointCoordinates: 'toolbar.sketch.point',
    thicknessParameter: 'toolbar.shape.rectangle',
    dimensionChange: 'file.save',
    drawing: 'toolbar.fileMenu.newDrawingFromPart',
    stepStl: 'toolbar.fileMenu.exportShape',
    complete: null,
  },
} as const satisfies {
  readonly plate: StepCommands<TutorialStep>;
  readonly parameterToExport: StepCommands<ParameterTutorialStep>;
};
