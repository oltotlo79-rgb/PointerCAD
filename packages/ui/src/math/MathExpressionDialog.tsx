import { prepareDocumentMathProblem } from './prepareDocumentMathProblem.js';
import { unresolvedMathProblemOutput } from './unresolvedMathProblemOutput.js';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { mathScalarExpression, type AngleUnit, type ExpressionValue, type StoredMathExpression } from '@pointercad/expression';
import type { MathGeometryOutcome, PartDocument } from '@pointercad/model';
import { createBrowserMathClient } from './createBrowserMathClient.js';
import { prepareDocumentMathEditor, mathGeometryEditorCandidate, mathGeometryEditorProblem,
  mathGeometryEditorNotices, waitForMathEditorGeometry, type MathGeometryEditorTarget } from './prepareDocumentMathEditor.js';
import { mathGeometryInputsFor } from './mathGeometryResults.js';
import { prepareDocumentFunctionEditor, type FunctionEditorInitial } from './prepareDocumentFunctionEditor.js';
import { sameMathDeclarations, type MathVariableScope } from '@pointercad/expression/math/contracts';
import type { MathEditorOutput } from './mathEditorSession.js';
import { loadStructuredMathField } from './loadStructuredMathField.js';
import { MathEditorController } from './MathEditorController.js';
import { MathEditorPanel } from './MathEditorPanel.js';
import type { MathInsertGroup } from './MathEditorSurface.js';
import { focusAdjacentControl, type StructuredMathField } from './mathFieldHost.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import './mathEditor.css';
import { MATH_INPUT_PALETTE } from './mathPaletteExamples.js';
import type { MathWorkRequest } from '@pointercad/expression/math/client';

interface MathDialogBase {
  readonly document: PartDocument;
  readonly documentVersion: number;
  readonly unitLabel: string;
  readonly isCurrent: () => boolean;
  readonly onClose: () => void;
}
export interface MathExpressionDialogProps extends MathDialogBase {
  readonly kind?: 'scalar';
  readonly initialValue: ExpressionValue;
  readonly initialAngleUnit?: AngleUnit;
  readonly excludedCoefficient?: string;
  /** Only a coefficient's scalar editor may insert measured values. */
  readonly geometry?: MathGeometryEditorTarget;
  readonly onApply: (value: ExpressionValue, prepared: PartDocument, signal: AbortSignal,
    client: ReturnType<typeof createBrowserMathClient>, coefficients: MathWorkRequest['coefficients']) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
}
export interface FunctionExpressionDialogProps extends MathDialogBase {
  readonly kind: 'function';
  readonly initialFunction: FunctionEditorInitial;
  readonly functionScope: MathVariableScope;
  readonly onApply: (value: StoredMathExpression, prepared: PartDocument, signal: AbortSignal,
    client: ReturnType<typeof createBrowserMathClient>, coefficients: MathWorkRequest['coefficients']) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
}
export interface ProblemExpressionDialogProps extends MathDialogBase {
  readonly kind: 'problem';
  readonly initialProblem: StoredMathExpression | undefined;
  readonly onApply: FunctionExpressionDialogProps['onApply'];
}
interface ReadyEditor {
  readonly controller: MathEditorController;
  readonly createField: () => StructuredMathField;
  readonly groups: readonly MathInsertGroup[];
  readonly coefficientProblem: string | null;
  readonly prepared: PartDocument;
  readonly geometry: ReadonlyMap<string, MathGeometryOutcome>;
}

function geometryProblem(document: PartDocument, target: MathGeometryEditorTarget, output: MathEditorOutput): string | null {
  if (output.definition === null) return null;
  return mathGeometryEditorProblem(mathGeometryEditorCandidate(document, target.coefficientName,
    { source: output.definition.source, value: 0, display: '', mathDefinition: output.definition }));
}

function GeometryEditorFeedback({ ready, target }: { readonly ready: ReadyEditor; readonly target: MathGeometryEditorTarget }): React.JSX.Element | null {
  const snapshot = useSyncExternalStore(ready.controller.subscribe, ready.controller.getSnapshot, ready.controller.getSnapshot);
  if (snapshot.state.status !== 'evaluated') return null;
  const output = snapshot.state.output, issue = geometryProblem(ready.prepared, target, output);
  const notices = output.definition === null ? [] : mathGeometryEditorNotices(ready.prepared, target, output.definition, ready.geometry);
  return <>{issue === null ? null : <p role="alert">{issue}</p>}{notices.map(notice => <p role="status" key={notice}>{notice}</p>)}</>;
}

/** Native modal ownership prevents keyboard actions from also confirming the underlying CAD workflow. */
export function MathExpressionDialog(props: MathExpressionDialogProps | FunctionExpressionDialogProps | ProblemExpressionDialogProps): React.JSX.Element {
  const owner = useRef(props).current, dialog = useRef<HTMLDialogElement>(null), id = useId();
  const [ready, setReady] = useState<ReadyEditor | null>(null), [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0);
  const [geometryPending, setGeometryPending] = useState(() => mathGeometryInputsFor(useAppStore.getState(), owner.document) === null);
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement;
    element?.showModal();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const abort = new AbortController(), client = createBrowserMathClient();
    let controller: MathEditorController | undefined, applying = false;
    let geometry: ReadonlyMap<string, MathGeometryOutcome> | undefined, prepared = owner.document;
    const geometryTarget = owner.kind === 'function' || owner.kind === 'problem' ? undefined : owner.geometry;
    const isCurrent = () => !abort.signal.aborted && owner.isCurrent()
      && (geometry === undefined || mathGeometryInputsFor(useAppStore.getState(), owner.document) === geometry);
    const unsubscribe = useAppStore.subscribe(() => {
      if (!owner.isCurrent()) { abort.abort(); controller?.dispose(); owner.onClose(); }
      else if (geometry !== undefined && !isCurrent()) {
        abort.abort(); controller?.dispose(); client.dispose(); setReady(null); setBusy(false);
        setProblem(t('mathGeometry.editor.pending'));
      }
    });
    const initialDefinition = owner.kind === 'function' ? owner.initialFunction.definition : owner.kind === 'problem' ? owner.initialProblem : owner.initialValue.mathDefinition;
    const canApply = (output: MathEditorOutput) => isCurrent() && (owner.kind === 'function'
      ? output.definition !== null && output.evaluation.status === 'value' && output.evaluation.kind === 'function'
      : owner.kind === 'problem' ? unresolvedMathProblemOutput(output) !== null : mathScalarExpression(output).ok
        && (geometryTarget === undefined || geometryProblem(prepared, geometryTarget, output) === null));
    const apply = async (output: MathEditorOutput, prepared: PartDocument, coefficients: MathWorkRequest['coefficients']) => {
      if (!isCurrent() || applying || !canApply(output)) return;
      applying = true; setBusy(true); setProblem(null);
      try {
        const commit = () => {
          if (owner.kind === 'function' || owner.kind === 'problem') {
            if (output.definition === null) throw new Error(t('math.invalidSource'));
            return owner.onApply(output.definition, prepared, abort.signal, client, coefficients);
          }
          const scalar = mathScalarExpression(output);
          if (!scalar.ok) throw new Error(scalar.message);
          return owner.onApply(scalar.value, prepared, abort.signal, client, coefficients);
        };
        const result = await commit();
        if (abort.signal.aborted) return;
        if (result.ok) { controller?.dispose(); owner.onClose(); }
        else { setProblem(result.message); setBusy(false); }
      } catch (error) {
        if (!abort.signal.aborted) { setProblem(error instanceof Error ? error.message : t('math.workerFailed')); setBusy(false); }
      } finally { applying = false; }
    };
    const start = async () => {
      try {
        geometry = await waitForMathEditorGeometry(owner.document, abort.signal, () => owner.isCurrent(), () => setGeometryPending(true));
        if (!isCurrent()) return;
        setGeometryPending(false);
        const context = { client, identity: { documentId: owner.document.id, documentVersion: owner.documentVersion },
          signal: abort.signal, isCurrent, geometry };
        const [createField, input] = await Promise.all([
          loadStructuredMathField(), owner.kind === 'function'
            ? prepareDocumentFunctionEditor(owner.document, owner.initialFunction, owner.functionScope,
              context)
            : owner.kind === 'problem'
              ? prepareDocumentMathProblem(owner.document, owner.initialProblem,
                context)
            : prepareDocumentMathEditor(owner.document, owner.initialValue,
              context, geometryTarget?.coefficientName ?? owner.excludedCoefficient, geometryTarget !== undefined),
        ]);
        if (!isCurrent()) return;
        prepared = input.prepared;
        controller = new MathEditorController({ client,
          initial: { identity: { documentId: owner.document.id, documentVersion: owner.documentVersion, editorId: id, inputRevision: 0 },
            source: input.source, notation: input.notation,
            ...(initialDefinition?.declarations === undefined ? {} : { declarations: initialDefinition.declarations }),
            angleUnit: owner.kind === 'function' || owner.kind === 'problem' ? input.angleUnit : owner.initialAngleUnit ?? input.angleUnit },
          requestFor: value => ({ identity: value.identity, source: value.source, notation: value.notation,
             angleUnit: value.angleUnit, coefficients: input.coefficients,
             ...(value.declarations === undefined ? {} : { declarations: value.declarations }),
             ...(input.purpose === 'function' ? { functionScope: input.functionScope } : {}),
             ...(initialDefinition !== undefined && value.source === initialDefinition.source
               && value.notation === initialDefinition.inputNotation && value.angleUnit === initialDefinition.angleUnit
               && sameMathDeclarations(value.declarations, initialDefinition.declarations)
               ? { definition: initialDefinition } : {}) }),
          isCurrentDocument: isCurrent,
          canApply,
          onApply: output => { void apply(output, input.prepared, input.coefficients); },
          onCancel: owner.onClose,
          onMoveOut: direction => {
            // At the field's edge, Tab, Shift+Tab and the arrow keys go on to the neighbouring control, as from the text input.
            const element = dialog.current, focused = document.activeElement;
            if (element !== null && focused !== null) focusAdjacentControl(element, focused, direction);
          },
        });
        setReady({ controller, createField, groups: input.groups, coefficientProblem: input.coefficientProblem, prepared, geometry });
      } catch (error) {
        if (isCurrent()) setProblem(error instanceof Error ? error.message : t('math.loadFailed'));
      }
    };
    void start();
    return () => { unsubscribe(); abort.abort(); controller?.dispose(); client.dispose(); };
  }, [owner, id, attempt]);
  return <dialog ref={dialog} className="pcad-math-dialog" aria-labelledby={`${id}-title`} data-help-topic="math-input"
    onCancel={event => { event.preventDefault(); owner.onClose(); }} onKeyDown={event => event.stopPropagation()}>
    <h2 id={`${id}-title`}>{t('math.title')}</h2>
    <p>{t(owner.kind === 'function' ? 'math.functionOutput' : owner.kind === 'problem' ? 'math.problem.hint' : 'math.valueUnit')} {owner.unitLabel}</p>
    {owner.kind === 'function' ? <p>{t('math.functionRangeHint')}</p> : null}
    {problem === null ? null : <p role="alert">{problem}</p>}
    {ready === null ? <div><p role="status">{problem === null ? t(geometryPending ? 'mathGeometry.editor.pending' : 'math.loading') : t('math.loadFailed')}</p>
      {problem === null ? null : <button type="button" className="pcad-button" title={t('math.guide.retry')} onClick={() => { setProblem(null); setAttempt(value => value + 1); }}>{t('math.retry')}</button>}
      <button type="button" className="pcad-button" title={t('math.guide.cancel')} onClick={owner.onClose}>{t('math.cancel')}</button>
    </div> : <>
      {ready.coefficientProblem === null ? null : <p role="status">{t('math.coefficientsUnavailable')} {ready.coefficientProblem}</p>}
      {owner.kind !== 'function' && owner.kind !== 'problem' && owner.geometry !== undefined
        ? <GeometryEditorFeedback ready={ready} target={owner.geometry} /> : null}
      <MathEditorPanel {...ready} acceptLabel={owner.kind === 'problem' ? t('math.problem.apply') : undefined} palette={MATH_INPUT_PALETTE} readOnly={busy} onHelp={() => useAppStore.getState().openHelpTopic('math-input')} />
    </>}
  </dialog>;
}
