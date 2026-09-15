import { useEffect, useId, useRef, useState } from 'react';
import { mathScalarExpression, type AngleUnit, type ExpressionValue, type StoredMathExpression } from '@pointercad/expression';
import type { PartDocument } from '@pointercad/model';
import { createBrowserMathClient } from './createBrowserMathClient.js';
import { prepareDocumentMathEditor } from './prepareDocumentMathEditor.js';
import { prepareDocumentFunctionEditor, type FunctionEditorInitial } from './prepareDocumentFunctionEditor.js';
import type { MathVariableScope } from '@pointercad/expression/math/contracts';
import type { MathEditorOutput } from './mathEditorSession.js';
import { loadStructuredMathField } from './loadStructuredMathField.js';
import { MathEditorController } from './MathEditorController.js';
import { MathEditorPanel } from './MathEditorPanel.js';
import type { MathInsertGroup } from './MathEditorSurface.js';
import type { StructuredMathField } from './mathFieldHost.js';
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
interface ReadyEditor {
  readonly controller: MathEditorController;
  readonly createField: () => StructuredMathField;
  readonly groups: readonly MathInsertGroup[];
  readonly coefficientProblem: string | null;
}

/** Native modal ownership prevents keyboard actions from also confirming the underlying CAD workflow. */
export function MathExpressionDialog(props: MathExpressionDialogProps | FunctionExpressionDialogProps): React.JSX.Element {
  const owner = useRef(props).current, dialog = useRef<HTMLDialogElement>(null), id = useId();
  const [ready, setReady] = useState<ReadyEditor | null>(null), [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const element = dialog.current, previous = document.activeElement;
    element?.showModal();
    return () => { element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const abort = new AbortController(), client = createBrowserMathClient();
    let controller: MathEditorController | undefined, applying = false;
    const isCurrent = () => !abort.signal.aborted && owner.isCurrent();
    const unsubscribe = useAppStore.subscribe(() => { if (!owner.isCurrent()) { abort.abort(); controller?.dispose(); owner.onClose(); } });
    const initialDefinition = owner.kind === 'function' ? owner.initialFunction.definition : owner.initialValue.mathDefinition;
    const canApply = (output: MathEditorOutput) => owner.kind === 'function'
      ? output.definition !== null && output.evaluation.status === 'value' && output.evaluation.kind === 'function'
      : mathScalarExpression(output).ok;
    const apply = async (output: MathEditorOutput, prepared: PartDocument, coefficients: MathWorkRequest['coefficients']) => {
      if (!isCurrent() || applying || !canApply(output)) return;
      applying = true; setBusy(true); setProblem(null);
      try {
        const commit = () => {
          if (owner.kind === 'function') {
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
        const [createField, input] = await Promise.all([
          loadStructuredMathField(), owner.kind === 'function'
            ? prepareDocumentFunctionEditor(owner.document, owner.initialFunction, owner.functionScope,
              { client, identity: { documentId: owner.document.id, documentVersion: owner.documentVersion }, signal: abort.signal, isCurrent })
            : prepareDocumentMathEditor(owner.document, owner.initialValue,
              { client, identity: { documentId: owner.document.id, documentVersion: owner.documentVersion }, signal: abort.signal, isCurrent }, owner.excludedCoefficient),
        ]);
        if (!isCurrent()) return;
        controller = new MathEditorController({ client,
          initial: { identity: { documentId: owner.document.id, documentVersion: owner.documentVersion, editorId: id, inputRevision: 0 },
            source: input.source, notation: input.notation,
            angleUnit: owner.kind === 'function' ? input.angleUnit : owner.initialAngleUnit ?? input.angleUnit },
          requestFor: value => ({ identity: value.identity, source: value.source, notation: value.notation,
             angleUnit: value.angleUnit, coefficients: input.coefficients,
             ...(input.purpose === 'function' ? { functionScope: input.functionScope } : {}),
             ...(initialDefinition !== undefined && value.source === initialDefinition.source
               && value.notation === initialDefinition.inputNotation && value.angleUnit === initialDefinition.angleUnit
               ? { definition: initialDefinition } : {}) }),
          isCurrentDocument: isCurrent,
          canApply,
          onApply: output => { void apply(output, input.prepared, input.coefficients); },
          onCancel: owner.onClose,
          onMoveOut: direction => {
            const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select, textarea, input') ?? []);
            (direction === 'forward' ? controls.at(-1) : controls[0])?.focus();
          },
        });
        setReady({ controller, createField, groups: input.groups, coefficientProblem: input.coefficientProblem });
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
    <p>{t(owner.kind === 'function' ? 'math.functionOutput' : 'math.valueUnit')} {owner.unitLabel}</p>
    {owner.kind === 'function' ? <p>{t('math.functionRangeHint')}</p> : null}
    {problem === null ? null : <p role="alert">{problem}</p>}
    {ready === null ? <div><p role="status">{problem === null ? t('math.loading') : t('math.loadFailed')}</p>
      {problem === null ? null : <button type="button" className="pcad-button" title={t('math.guide.retry')} onClick={() => { setProblem(null); setAttempt(value => value + 1); }}>{t('math.retry')}</button>}
      <button type="button" className="pcad-button" title={t('math.guide.cancel')} onClick={owner.onClose}>{t('math.cancel')}</button>
    </div> : <>
      {ready.coefficientProblem === null ? null : <p role="status">{t('math.coefficientsUnavailable')} {ready.coefficientProblem}</p>}
      <MathEditorPanel {...ready} palette={MATH_INPUT_PALETTE} readOnly={busy} onHelp={() => useAppStore.getState().openHelpTopic('math-input')} />
    </>}
  </dialog>;
}
