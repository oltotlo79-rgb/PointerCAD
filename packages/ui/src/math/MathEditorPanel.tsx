import { useMemo, useSyncExternalStore } from 'react';
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
import { useAppStore } from '../store/useAppStore.js';
import { countParameterUsageSites, inspectInputExpression, matchesMathParameterBindings } from './expressionInspectionContext.js';

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
  const analysis = useAppStore(state => state.parameterAnalysis);
  const parameters = useAppStore(state => state.document.parameters);
  const document = useAppStore(state => state.document);
  const description = mathEditorResultText(snapshot);
  const labels = mathEditorLabels();
  const appliedLabels = props.acceptLabel === undefined ? labels
    : { ...labels, apply: props.acceptLabel, hints: { ...labels.hints, apply: props.acceptLabel } };
  const axes = snapshot.state.status === 'evaluated' ? mathResultAxes(snapshot.state.output.evaluation) : null;
  const state = snapshot.state, input = state.input;
  const evaluatedReal = state.status === 'evaluated' && state.output.definition !== null
    && state.output.evaluation.status === 'value' && state.output.evaluation.kind === 'real';
  const candidate = evaluatedReal && input.notation === 'text' && props.controller.isCurrent()
    ? inspectInputExpression(input.source, {
      variables: analysis.variables, exactVariables: analysis.exactVariables,
      nonLengthVariables: analysis.nonLengthVariables,
    }, null, analysis.circular) : null;
  // The Worker accepts a richer grammar and local symbols. Its saved definition is
  // authoritative for whether parser-spelled names really bind to part parameters.
  const inspection = candidate?.inspection.result.ok && state.status === 'evaluated' && state.output.definition !== null
    && matchesMathParameterBindings(candidate, state.output.definition, parameters) ? candidate : null;
  const parameterUnits = useMemo(() => new Map(parameters.map(parameter => [parameter.name, parameter.unit])), [parameters]);
  const inspectionVisible = inspection !== null && (inspection.references.length > 0 || inspection.inspection.units.length > 0);
  const usageCounts = useMemo(() => inspectionVisible ? countParameterUsageSites(document) : undefined,
    [document, inspectionVisible]);
  return <><MathDeclarationEditor controller={props.controller} declarations={snapshot.state.input.declarations ?? []}
    disabled={props.readOnly || !props.controller.isCurrent()}/><MathEditorSurface input={snapshot.state.input} controller={props.controller}
    createField={props.createField} labels={appliedLabels} groups={props.groups} palette={props.palette}
    query={snapshot.query} onQuery={props.controller.setQuery} resultMessage={description.message}
    resultActions={axes === null ? null : <MathResultComponentPicker
      key={snapshot.state.input.identity.inputRevision} axes={axes}
      disabled={props.readOnly || !props.controller.isCurrent()}
      onChoose={indices => props.controller.chooseResultComponent(snapshot.state.input, indices)}/>}
    resultDetail={description.detail} hasError={description.hasError} busy={description.busy}
    inspection={inspection} parameterUnits={parameterUnits} usageCounts={usageCounts}
    canApply={snapshot.state.status === 'evaluated' && snapshot.state.canApply}
    canChangeNotation={props.controller.isCurrent()} readOnly={props.readOnly}
    onHelp={props.onHelp} maximumSourceLength={MATH_INPUT_LIMITS.sourceCodeUnits}/></>;
}
