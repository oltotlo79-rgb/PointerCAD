import { useSyncExternalStore } from 'react';
import { MATH_INPUT_LIMITS } from '@pointercad/expression/math/contracts';
import { MathEditorSurface, type MathInsertGroup } from './MathEditorSurface.js';
import type { MathEditorController } from './MathEditorController.js';
import type { MathPaletteItem } from './mathPalette.js';
import type { StructuredMathField } from './mathFieldHost.js';
import { mathEditorLabels } from './mathEditorLabels.js';
import { mathEditorResultText } from './mathEditorResult.js';

export interface MathEditorPanelProps {
  readonly controller: MathEditorController;
  /** Factory is loaded and fonts checked by the containing dialog before enabling structured input. */
  readonly createField: () => StructuredMathField;
  readonly groups: readonly MathInsertGroup[];
  readonly palette: readonly MathPaletteItem[];
  readonly readOnly: boolean;
  readonly onHelp: () => void;
}

/** Shared coordinate/coefficient/function view. It never owns another copy of the input or accepted value. */
export function MathEditorPanel(props: MathEditorPanelProps): React.JSX.Element {
  const snapshot = useSyncExternalStore(props.controller.subscribe, props.controller.getSnapshot, props.controller.getSnapshot);
  const description = mathEditorResultText(snapshot);
  return <MathEditorSurface input={snapshot.state.input} controller={props.controller}
    createField={props.createField} labels={mathEditorLabels()} groups={props.groups} palette={props.palette}
    query={snapshot.query} onQuery={props.controller.setQuery} resultMessage={description.message}
    resultDetail={description.detail} hasError={description.hasError} busy={description.busy}
    canApply={snapshot.state.status === 'evaluated' && snapshot.state.canApply}
    canChangeNotation={props.controller.isCurrent()} readOnly={props.readOnly}
    onHelp={props.onHelp} maximumSourceLength={MATH_INPUT_LIMITS.sourceCodeUnits}/>;
}
