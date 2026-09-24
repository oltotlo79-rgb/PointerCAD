import { useEffect, useId, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { DEFAULT_MATH_GEOMETRY_TOLERANCE, type PartDocument } from '@pointercad/model';
import { t, type MessageKey } from '../i18n/t.js';
import { initialDraftVersionState, reconcileDraftVersion } from '../shell/fieldDraft.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  changeMathGeometryAngleUnit, changeMathGeometryTolerance, createMathGeometryFromSelection,
  defaultMathGeometryName, removeMathGeometry, reselectMathGeometry, runMathGeometryRename,
  type MathGeometryCommandResult,
} from './mathGeometryCommands.js';
import { createParameterFromMathGeometryCommand } from './mathGeometryParameterCommands.js';
import {
  mathGeometryAddReadiness, mathGeometryCandidateRows, mathGeometryPanelGuideText,
  mathGeometryPanelVisible, mathGeometryRows, type MathGeometryReadiness,
} from './mathGeometryRows.js';
import {
  mathGeometryToleranceFields, resolveMathGeometryTolerance, type MathGeometryToleranceFields,
} from './mathGeometryTolerance.js';

/** Drafts and notices are presentation only; document replacement/Undo clears them without remounting fields. */
function usePanelDraft<T>(version: number): readonly [T | null, (draft: T | null) => void] {
  const [state, setState] = useState(() => initialDraftVersionState<T>(version));
  const current = reconcileDraftVersion(state, version);
  if (current !== state) setState(current);
  return [current.draft, draft => setState({ seenVersion: version, draft })];
}

function controlTitle(key: MessageKey, readiness: MathGeometryReadiness): string {
  return [t(key), readiness.reasonText].filter(Boolean).join('\n');
}

interface ToleranceEditorProps {
  readonly owner: PartDocument;
  readonly id: string;
  readonly version: number;
  readonly onResult: (result: MathGeometryCommandResult) => void;
}

/**
 * GR-19c fixes: (1) confirming an edit to one margin field must not drift the other away from its
 * exact stored number (`resolveMathGeometryTolerance` keeps whichever field is absent from `draft`
 * verbatim instead of re-parsing its rounded display text); (2) each field's error text lives outside
 * its `<label>`, tied to the input by `aria-describedby` like every other field's error display
 * (`sketch/ExpressionField.tsx`), so the input's accessible name stays the bare heading instead of
 * growing the error sentence onto the end of it.
 */
export function ToleranceEditor({ owner, id, version, onResult }: ToleranceEditorProps): React.JSX.Element {
  const [draft, setDraft] = usePanelDraft<Partial<MathGeometryToleranceFields>>(version);
  const inputId = useId();
  const tolerance = owner.mathGeometry?.find(item => item.id === id)?.tolerance ?? DEFAULT_MATH_GEOMETRY_TOLERANCE;
  const fields: MathGeometryToleranceFields = { ...mathGeometryToleranceFields(tolerance), ...draft };
  const resolved = resolveMathGeometryTolerance(tolerance, draft ?? {});
  return <details>
    <summary title={t('mathGeometry.toleranceNote')}>{t('mathGeometry.tolerance.edit')}</summary>
    {(['linear', 'angular'] as const).map(field => {
      const error = resolved.ok ? null : resolved.errors[field];
      const fieldId = `${inputId}-${field}`, messageId = `${fieldId}-message`;
      const tooltip = t(field === 'linear' ? 'controlGuide.mathGeometry.toleranceLinear' : 'controlGuide.mathGeometry.toleranceAngular');
      return <div className={error === null ? 'pcad-field' : 'pcad-field pcad-field--error'} key={field}>
        <label className="pcad-field__label" htmlFor={fieldId} title={tooltip}>
          {t(`mathGeometry.tolerance.${field}Label`)}
        </label>
        <input type="text" id={fieldId} className="pcad-field__input" title={tooltip}
          value={fields[field]} aria-invalid={error !== null} aria-describedby={messageId}
          onChange={event => setDraft({ ...(draft ?? {}), [field]: event.target.value })} />
        <p id={messageId} className={error === null ? 'pcad-field__message' : 'pcad-field__message pcad-field__message--error'}>
          {error === null ? '' : t(error)}
        </p>
      </div>;
    })}
    <button type="button" className="pcad-button" title={t('controlGuide.mathGeometry.toleranceApply')}
      disabled={draft === null || !resolved.ok} onClick={() => {
        if (draft === null || !resolved.ok) return;
        const result = changeMathGeometryTolerance(useAppStore.getState(), owner, id, resolved.tolerance);
        onResult(result);
        if (result.ok) setDraft(null);
      }}>{t('mathGeometry.tolerance.apply')}</button>
    <button type="button" className="pcad-button" title={t('controlGuide.mathGeometry.toleranceReset')}
      onClick={() => {
        const result = changeMathGeometryTolerance(useAppStore.getState(), owner, id, DEFAULT_MATH_GEOMETRY_TOLERANCE);
        onResult(result);
        if (result.ok) setDraft(null);
      }}>{t('mathGeometry.tolerance.reset')}</button>
  </details>;
}

/** GR-19b: render GR-19a's decisions and send edits through GR-16/GR-31 only. */
export function MathGeometryPanel(): React.JSX.Element | null {
  const visible = useAppStore(mathGeometryPanelVisible);
  return visible ? <MathGeometryPanelContent /> : null;
}

function MathGeometryPanelContent(): React.JSX.Element {
  // Select stable source fields, never freshly allocated rows/guide objects (Zustand 5).
  const state = useAppStore(useShallow(state => ({
    document: state.document, documentVersion: state.documentVersion, assembly: state.assembly, drawing: state.drawing,
    activeTool: state.activeTool, selection: state.selection, sketch: state.sketch, resolvedSketch: state.resolvedSketch,
    bodies: state.bodies, displaySettings: state.displaySettings, timelineIndex: state.timelineIndex,
    recomputeCancelled: state.recomputeCancelled, mathGeometryResult: state.mathGeometryResult,
    requestedGeneration: state.requestedGeneration, completedGeneration: state.completedGeneration,
    lastOutcome: state.lastOutcome, partErrors: state.partErrors, errorMessage: state.errorMessage,
  })));
  const guide = useAppStore(mathGeometryPanelGuideText);
  const owner = state.document, version = state.documentVersion;
  const rows = mathGeometryRows(state), candidates = mathGeometryCandidateRows(state);
  const add = mathGeometryAddReadiness(state);
  const [chosenKey, setChosenKey] = usePanelDraft<string>(version);
  const chosen = candidates.find(item => item.kindKey === chosenKey) ?? candidates[0];
  const [nameDraft, setNameDraft] = usePanelDraft<{ readonly id: string; readonly text: string }>(version);
  const [notice, setNotice] = usePanelDraft<string>(version);
  const [renameBusy, setRenameBusy] = usePanelDraft<true>(version);
  const pendingRename = useRef<AbortController | null>(null);
  useEffect(() => () => { pendingRename.current?.abort(); pendingRename.current = null; }, [version]);

  const showResult = (result: MathGeometryCommandResult): void => setNotice(result.ok ? null : result.message);
  const rename = (id: string, name: string, text: string): void => {
    if (pendingRename.current !== null) return;
    if (name === text) { setNameDraft(null); return; }
    const controller = new AbortController();
    pendingRename.current = controller;
    setRenameBusy(true);
    setNotice(null);
    setNameDraft(null);
    void runMathGeometryRename(id, text, { owner, signal: controller.signal }).then(result => {
      if (pendingRename.current !== controller) return;
      pendingRename.current = null;
      setRenameBusy(null);
      const latest = useAppStore.getState();
      if (latest.documentVersion !== version) return;
      if (!result.ok && latest.document === owner) {
        setNameDraft({ id, text });
        setNotice(result.message);
      }
    });
  };

  return <section className="pcad-section pcad-parameters" data-help-topic="math-input"
    aria-label={t('mathGeometry.title')}>
    <h3 className="pcad-section__title">{t('mathGeometry.title')}</h3>
    <p className="pcad-panel__note">{guide}</p>
    <p className="pcad-panel__note">{t('mathGeometry.hint.vsMeasure')}</p>
    <p className="pcad-panel__note" role="status" aria-live="polite">
      {renameBusy ? t('mathGeometry.rename.busy') : notice}
    </p>
    {renameBusy ? <button type="button" className="pcad-button" title={t('controlGuide.mathGeometry.stopRename')}
      onClick={() => pendingRename.current?.abort()}>{t('mathGeometry.rename.cancel')}</button> : null}
    <fieldset className="pcad-parameters__fields" disabled={renameBusy === true}>
      <label className="pcad-field pcad-parameters__quantity-field">
        <span className="pcad-field__label">{t('mathGeometry.quantityLabel')}</span>
        <select className="pcad-field__input" title={controlTitle('controlGuide.mathGeometry.quantity', add)}
          value={chosen?.kindKey ?? ''} disabled={!add.ready}
          onChange={event => setChosenKey(event.target.value)}>
          {candidates.map(candidate => <option key={candidate.kindKey} value={candidate.kindKey}>{candidate.kindLabel}</option>)}
        </select>
      </label>
      {chosen === undefined ? null : <p className="pcad-panel__note">{chosen.targetsSummary}</p>}
      <button type="button" className="pcad-button" title={controlTitle('controlGuide.mathGeometry.add', add)}
        disabled={!add.ready} onClick={() => {
          if (chosen === undefined || !mathGeometryAddReadiness(useAppStore.getState()).ready) return;
          const name = defaultMathGeometryName(owner, chosen.quantity);
          const result = createMathGeometryFromSelection(useAppStore.getState(), owner, chosen.quantity, name);
          setNotice(result.ok ? t('mathGeometry.guide.added').replace('{name}', () => name) : result.message);
        }}>{t('mathGeometry.add')}</button>
      {add.reasonText === null ? null : <p className="pcad-panel__note">{add.reasonText}</p>}
      {rows.length === 0 ? <p className="pcad-panel__empty-text">{t('mathGeometry.empty')}</p> : null}
      <ol className="pcad-parameters__list">
        {rows.map(row => <li key={row.id} data-math-geometry-id={row.id}
          className={row.circular ? 'pcad-parameter pcad-parameter--circular' : 'pcad-parameter'}>
          <div className="pcad-parameter__head">
            <span className="pcad-parameter__mark" title={row.usageNames.join('\n')}>{row.usageText}</span>
            {row.cycleText === null ? null : <span className="pcad-parameter__mark pcad-parameter__mark--circular"
              title={row.cycleMessage ?? undefined}>{row.cycleText}</span>}
          </div>
          <label className="pcad-field">
            <span className="pcad-field__label">{t('mathGeometry.nameLabel')}</span>
            <input type="text" className="pcad-field__input" title={t('controlGuide.mathGeometry.name')}
              value={nameDraft?.id === row.id ? nameDraft.text : row.name}
              onChange={event => setNameDraft({ id: row.id, text: event.target.value })}
              onBlur={event => rename(row.id, row.name, event.currentTarget.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  rename(row.id, row.name, event.currentTarget.value);
                }
              }} />
          </label>
          <dl className="pcad-properties pcad-parameter__properties">
            <dt className="pcad-properties__key">{t('mathGeometry.quantityLabel')}</dt>
            <dd className="pcad-properties__value">{row.kindLabel}</dd>
            <dt className="pcad-properties__key">{t('mathGeometry.targetsLabel')}</dt>
            <dd className="pcad-properties__value">{row.targetsSummary}</dd>
            <dt className="pcad-properties__key">{t('mathGeometry.valueLabel')}</dt>
            <dd className="pcad-properties__value">{row.valueText ?? row.statusText}</dd>
            <dt className="pcad-properties__key">{t('mathGeometry.toleranceLabel')}</dt>
            <dd className="pcad-properties__value">{row.toleranceText}</dd>
          </dl>
          <p className="pcad-panel__note">{row.toleranceNote}</p>
          {row.cycleMessage === null ? null : <p className="pcad-panel__error">{row.cycleMessage}</p>}
          <button type="button" className="pcad-button" title={controlTitle('controlGuide.mathGeometry.reselect', row.reselect)}
            disabled={!row.reselect.ready} onClick={() => {
              if (row.reselect.quantity !== null) showResult(reselectMathGeometry(useAppStore.getState(), owner, row.id, row.reselect.quantity));
            }}>{t('mathGeometry.reselect')}</button>
          {row.reselect.ready ? null : <p className="pcad-panel__note">{t('mathGeometry.reselectHint')} {row.reselect.reasonText}</p>}
          {row.angleUnit === null ? null : <div className="pcad-segmented">
            {(['degree', 'radian'] as const).map(unit => <button key={unit} type="button" className="pcad-button"
              title={t('controlGuide.mathGeometry.angleUnit')} aria-pressed={row.angleUnit === unit}
              onClick={() => showResult(changeMathGeometryAngleUnit(useAppStore.getState(), owner, row.id, unit))}>
              {t(`mathGeometry.unit.${unit}`)}</button>)}
          </div>}
          <ToleranceEditor owner={owner} id={row.id} version={version} onResult={showResult} />
          <button type="button" className="pcad-button" title={controlTitle('controlGuide.mathGeometry.delete', row.remove)}
            disabled={!row.remove.ready}
            onClick={() => showResult(removeMathGeometry(useAppStore.getState(), owner, row.id))}>{t('mathGeometry.delete')}</button>
          {row.remove.reasonText === null ? null : <p className="pcad-panel__note">{row.remove.reasonText}</p>}
          <button type="button" className="pcad-button" title={controlTitle('controlGuide.mathGeometry.createParameter', row.createParameter)}
            disabled={!row.createParameter.ready} onClick={() => {
              const result = createParameterFromMathGeometryCommand(useAppStore.getState(), owner, row.id);
              setNotice(result.message);
            }}>{t('mathGeometry.createParameter')}</button>
          {row.createParameter.reasonText === null ? null : <p className="pcad-panel__note">{row.createParameter.reasonText}</p>}
        </li>)}
      </ol>
    </fieldset>
    <button type="button" className="pcad-button" title={t('controlGuide.mathGeometry.closeTool')} onClick={() => {
      pendingRename.current?.abort();
      useAppStore.getState().setActiveTool('select');
      useAppStore.getState().requestViewportFocus();
    }}>{t('mathGeometry.closeTool')}</button>
  </section>;
}
