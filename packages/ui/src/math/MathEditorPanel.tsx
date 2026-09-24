import { useSyncExternalStore } from 'react';
import { MATH_INPUT_LIMITS } from '@pointercad/expression/math/contracts';
import { MathEditorSurface, type MathInsertGroup } from './MathEditorSurface.js';
import type { MathEditorController } from './MathEditorController.js';
import type { MathPaletteItem } from './mathPalette.js';
import type { StructuredMathField } from './mathFieldHost.js';
import { mathEditorLabels } from './mathEditorLabels.js';
import { mathResultAxes } from './mathResultComponent.js';
import { MathResultComponentPicker } from './MathResultComponentPicker.js';
import { mathEditorResultText } from './mathEditorResult.js';
import { MathDeclarationEditor } from './MathDeclarationEditor.js';

export interface MathEditorPanelProps {
  readonly controller: MathEditorController;
  /** Factory is loaded and fonts checked by the containing dialog before enabling structured input. */
  readonly createField: () => StructuredMathField;
  readonly groups: readonly MathInsertGroup[];
  readonly palette: readonly MathPaletteItem[];
  readonly readOnly: boolean;
  readonly acceptLabel?: string;
  readonly onHelp: () => void;
}

/** Shared coordinate/coefficient/function view. It never owns another copy of the input or accepted value. */
export function MathEditorPanel(props: MathEditorPanelProps): React.JSX.Element {
  const snapshot = useSyncExternalStore(props.controller.subscribe, props.controller.getSnapshot, props.controller.getSnapshot);
  const description = mathEditorResultText(snapshot);
  const labels = mathEditorLabels();
  const appliedLabels = props.acceptLabel === undefined ? labels
    : { ...labels, apply: props.acceptLabel, hints: { ...labels.hints, apply: props.acceptLabel } };
  const axes = snapshot.state.status === 'evaluated' ? mathResultAxes(snapshot.state.output.evaluation) : null;
  return <><MathDeclarationEditor controller={props.controller} declarations={snapshot.state.input.declarations ?? []}
    disabled={props.readOnly || !props.controller.isCurrent()}/><MathEditorSurface input={snapshot.state.input} controller={props.controller}
    createField={props.createField} labels={appliedLabels} groups={props.groups} palette={props.palette}
    query={snapshot.query} onQuery={props.controller.setQuery} resultMessage={description.message}
    resultActions={axes === null ? null : <MathResultComponentPicker
      key={snapshot.state.input.identity.inputRevision} axes={axes}
      disabled={props.readOnly || !props.controller.isCurrent()}
      onChoose={indices => props.controller.chooseResultComponent(snapshot.state.input, indices)}/>}
    resultDetail={description.detail} hasError={description.hasError} busy={description.busy}
    canApply={snapshot.state.status === 'evaluated' && snapshot.state.canApply}
    canChangeNotation={props.controller.isCurrent()} readOnly={props.readOnly}
    onHelp={props.onHelp} maximumSourceLength={MATH_INPUT_LIMITS.sourceCodeUnits}/></>;
}
