import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { expressionValueFromNumber } from '@pointercad/expression';
import type { PartDocument, SketchFunctionCurveFeature, FunctionSurfaceFeature, ResolvedSpline, SolidBody } from '@pointercad/model';
import { MathExpressionDialog } from '../math/MathExpressionDialog.js';
import { createBrowserMathClient } from '../math/createBrowserMathClient.js';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import { editFunctionField, evaluateFunctionPlotDraft, functionPlotDraft, functionDraftScope, FUNCTION_AXES,
  activeFunctionOutputs, functionParameters, type FunctionPlotDraft, type FunctionScalarField } from './functionPlotDraft.js';
import { FunctionCurvePreview } from './FunctionCurvePreview.js';
import { FunctionSurfacePreview } from './FunctionSurfacePreview.js';
import { prepareFunctionPlot } from './prepareFunctionPlot.js';
import { applyFunctionPreset, FUNCTION_PRESETS } from './functionPresets.js';
import './functionPlot.css';

type EditorTarget = { readonly kind: 'scalar'; readonly key: FunctionScalarField }
  | { readonly kind: 'function'; readonly axis: typeof FUNCTION_AXES[number] } | {readonly kind:'equation'};
type ValidatedPreview = { readonly draft: FunctionPlotDraft; readonly document: PartDocument } & (
  { readonly kind: 'curve'; readonly feature: SketchFunctionCurveFeature; readonly curves: readonly ResolvedSpline[] }
  | { readonly kind: 'surface'; readonly feature: FunctionSurfaceFeature; readonly body: SolidBody });

export function FunctionPlotDialog({ featureId, onClose }: {
  readonly featureId?: string; readonly onClose: () => void;
}): React.JSX.Element {
  const owner = useRef(useAppStore.getState()).current, close = useRef(onClose).current;
  const original = featureId === undefined ? undefined : owner.document.solids.find(item => item.id === featureId)
    ?? owner.document.sketches.flatMap(sketch => sketch.features).find(item => item.id === featureId);
  const feature = original?.kind === 'functionCurve' || original?.kind === 'functionSurface' ? original : undefined;
  const sketch = feature?.kind === 'functionCurve' ? owner.document.sketches.find(item => item.features.includes(feature)) : owner.sketch;
  const [draft, setDraft] = useState(() => functionPlotDraft(feature)), [prepared, setPrepared] = useState(owner.document);
  const surface = draft.geometry === 'surface';
  const equationLabel=t(surface?'functionPlot.implicitEquation':'functionPlot.implicitCurveEquation');
  const [editor, setEditor] = useState<EditorTarget | null>(null), [preview, setPreview] = useState<ValidatedPreview | null>(null);
  const [displayed, setDisplayed] = useState(false);
  const display = useCallback((visible: boolean) => { setDisplayed(visible);
    if (!visible) setIssues(new Map([['form', t('functionPlot.previewFailed')]])); }, []);
  const [issues, setIssues] = useState<ReadonlyMap<string, string>>(new Map()), [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), running = useRef<AbortController | null>(null), mounted = useRef(true), id = useId();
  const isCurrent = () => mounted.current && useAppStore.getState().document === owner.document
    && useAppStore.getState().documentVersion === owner.documentVersion;
  useEffect(() => {
    mounted.current = true;
    const element = dialog.current, previous = document.activeElement;
    element?.showModal();
    const unsubscribe = useAppStore.subscribe(state => {
      if (state.document !== owner.document || state.documentVersion !== owner.documentVersion) { running.current?.abort(); close(); }
    });
    return () => { mounted.current = false; running.current?.abort(); unsubscribe(); element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [owner, close]);
  const change = (next: FunctionPlotDraft) => { running.current?.abort(); setBusy(false); setPreview(null); setDisplayed(false); setIssues(new Map()); setDraft(next); };
  const calculate = async () => {
    if (!isCurrent() || busy || sketch === undefined) return;
    if (featureId !== undefined && feature === undefined) { setIssues(new Map([['form', t('functionPlot.missingCurve')]])); return; }
    const abort = new AbortController(), client = createBrowserMathClient(); running.current = abort;
    const current = () => isCurrent() && !abort.signal.aborted && running.current === abort;
    setBusy(true); setPreview(null); setDisplayed(false); setIssues(new Map());
    try {
      const result = await evaluateFunctionPlotDraft(prepared, owner.documentVersion, draft, client, abort.signal, current);
      if (!current()) return;
      if (!result.ok) { setIssues(result.fields); return; }
      const candidate = prepareFunctionPlot(result.prepared, draft.geometry, result.definition, sketch.id, feature);
      if (candidate.feature.kind === 'functionSurface') {
        const computer = useAppStore.getState().functionSurfacePlotComputer;
        if (computer === null) throw new Error(t('functionPlot.unavailable'));
        const geometry = await computer(candidate.document, candidate.feature.id, () => !current());
        if (!current() || geometry.status === 'cancelled') return;
        if (geometry.status === 'failed') throw new Error(geometry.message);
        setPreview({ ...candidate, feature: candidate.feature, draft, kind: 'surface', body: geometry.body });
      } else {
        const computer = useAppStore.getState().functionPlotComputer;
        if (computer === null) throw new Error(t('functionPlot.unavailable'));
        const geometry = await computer(candidate.document, candidate.feature.id, () => !current());
        if (!current() || geometry.status === 'cancelled') return;
        if (geometry.status === 'failed') throw new Error(geometry.message);
        setPreview({ ...candidate, feature: candidate.feature, draft, kind: 'curve', curves: geometry.curves }); setDisplayed(true);
      }
    } catch (error) { if (current()) setIssues(new Map([['form', error instanceof Error ? error.message : t('math.workerFailed')]])); }
    finally { client.dispose(); if (running.current === abort) { running.current = null; if (mounted.current) setBusy(false); } }
  };
  const scalarField = (key: FunctionScalarField, label: string) => <div className="pcad-function-field" key={key}>
    <input aria-label={label} aria-invalid={issues.has(key) || issues.has(`${key.split('.')[0]}.range`)} required value={draft.scalars[key].source}
      onChange={event => change({ ...draft, scalars: { ...draft.scalars, [key]: editFunctionField(draft.scalars[key], event.target.value) } })} />
    <button type="button" title={`${label}: ${t('math.open')}`} aria-label={`${label}: ${t('math.open')}`}
      onClick={() => setEditor({ kind: 'scalar', key })}>ƒ</button>
  </div>;
  const inputEditor = () => {
    if (editor === null) return null;
    const common = { document: prepared, documentVersion: owner.documentVersion, isCurrent, onClose: () => setEditor(null) };
    if (editor.kind === 'scalar') {
      const input = draft.scalars[editor.key];
      return <MathExpressionDialog {...common} unitLabel={/^[TUV]\./.test(editor.key) ? t('functionPlot.parameterUnit') : 'mm'}
        initialAngleUnit={input.angleUnit}
        initialValue={input.accepted ?? { ...expressionValueFromNumber(0), source: input.source }}
        onApply={(value, document, signal) => {
          if (!isCurrent() || signal.aborted) return Promise.resolve({ ok: false, message: t('math.operation.cancelled') });
          setPrepared(document); change({ ...draft, scalars: { ...draft.scalars, [editor.key]: {
            source: value.source, angleUnit: value.mathDefinition?.angleUnit ?? input.angleUnit, accepted: value } } });
          return Promise.resolve({ ok: true });
        }} />;
    }
    const input = editor.kind === 'equation' ? draft.equation : draft.outputs[editor.axis];
    return <MathExpressionDialog {...common} kind="function" unitLabel={editor.kind === 'equation' ? equationLabel : `${editor.axis} (${t('functionPlot.outputUnit')})`}
      functionScope={functionDraftScope(draft)} initialFunction={{ source: input.source,
        notation: input.accepted?.inputNotation ?? 'text', angleUnit: input.angleUnit, definition: input.accepted }}
      onApply={(value, document, signal) => {
        if (!isCurrent() || signal.aborted) return Promise.resolve({ ok: false, message: t('math.operation.cancelled') });
        const accepted={source:value.source,angleUnit:value.angleUnit,accepted:value};
        setPrepared(document); change(editor.kind === 'equation' ? {...draft,equation:accepted}
          : { ...draft, outputs: { ...draft.outputs, [editor.axis]: accepted } });
        return Promise.resolve({ ok: true });
      }} />;
  };
  const fieldLabel = (field: string) => {
    if (field === 'form') return t('functionPlot.formula');
    if (field === 'equation') return equationLabel;
    if (field === 'fixedCoordinate') return `${draft.fixedAxis} ${t('functionPlot.fixedCoordinate')}`;
    if (field === 'tolerance') return t(surface ? 'functionPlot.surfaceTolerance' : 'functionPlot.tolerance');
    const [axis, endpoint] = field.split('.');
    return endpoint === 'min' ? `${axis} ${t('functionPlot.minimum')}`
      : endpoint === 'max' ? `${axis} ${t('functionPlot.maximum')}` : axis;
  };
  return <>
    <dialog ref={dialog} className="pcad-function-dialog" aria-labelledby={`${id}-title`} data-help-topic={surface ? 'function-surface' : 'function-curve'} onCancel={event => { event.preventDefault(); close(); }}
      onKeyDown={event => event.stopPropagation()}>
      <h2 id={`${id}-title`}>{t(surface ? 'functionPlot.surfaceTitle' : 'functionPlot.curveTitle')}</h2>
      <p>{t('functionPlot.scopeHint')}</p>
      <form onSubmit={event => { event.preventDefault(); void calculate(); }}>
        <label>{t('functionPlot.geometry')} <select disabled={busy || featureId !== undefined} value={draft.geometry}
          onChange={event => { const geometry = event.target.value; if (geometry === 'curve' || geometry === 'surface') change({ ...draft, geometry }); }}>
          <option value="curve">{t('functionPlot.curveTitle')}</option><option value="surface">{t('functionPlot.surfaceTitle')}</option>
        </select></label>
        <fieldset disabled={busy}>
          <legend>{t('functionPlot.formula')}</legend>
          <label className="pcad-function-presets">{t('functionPlot.presets')} <select value="" onChange={event => {
            const preset = FUNCTION_PRESETS.find(item => item.id === event.target.value && item.geometry === draft.geometry);
            if (preset) change(applyFunctionPreset(draft,preset));
          }}><option value="">{t('functionPlot.choosePreset')}</option>
            {FUNCTION_PRESETS.filter(item => item.geometry === draft.geometry).map(item => <option key={item.id} value={item.id}>{t(item.labelKey)}</option>)}
          </select></label>
          <label>{t('functionPlot.form')} <select value={draft.form} onChange={event => {
            const form = event.target.value; if (form === 'coordinate' || form === 'parametric' || form === 'implicit') change({ ...draft, form });
          }}><option value="coordinate">{t('functionPlot.coordinate')}</option><option value="parametric">{t(surface ? 'functionPlot.surfaceParametric' : 'functionPlot.parametric')}</option>
            <option value="implicit">{t(surface?'functionPlot.implicitSurface':'functionPlot.implicitCurve')}</option></select></label>
          {draft.form === 'coordinate' ? <label>{t(surface ? 'functionPlot.dependent' : 'functionPlot.independent')} <select value={surface ? draft.dependent : draft.independent} onChange={event => {
            const axis = event.target.value; if (axis === 'X' || axis === 'Y' || axis === 'Z') change({ ...draft, ...(surface ? { dependent: axis } : { independent: axis }) });
          }}>{FUNCTION_AXES.map(axis => <option key={axis}>{axis}</option>)}</select></label> : null}
          {activeFunctionOutputs(draft).map(axis => <div key={axis} className="pcad-function-equation"
            role="group" aria-label={`${axis} ${t('functionPlot.formula')}`}>
            <span>{axis} = </span><input aria-label={`${axis} ${t('functionPlot.formula')}`} required value={draft.outputs[axis].source}
              aria-invalid={issues.has(axis)} onChange={event => change({ ...draft, outputs: { ...draft.outputs, [axis]: editFunctionField(draft.outputs[axis], event.target.value) } })} />
            <button type="button" aria-label={`${axis}: ${t('math.open')}`} onClick={() => setEditor({ kind: 'function', axis })}>{t('math.open')}</button>
            <small>{t('math.angleUnit')}: {t(draft.outputs[axis].angleUnit === 'degree' ? 'math.degree' : 'math.radian')}</small>
          </div>)}
          {draft.form === 'implicit' ? <>
            {!surface ? <div role="group" aria-label={t('functionPlot.fixedPlane')}>
              <label>{t('functionPlot.fixedAxis')} <select value={draft.fixedAxis} onChange={event=>{
                const fixedAxis=event.target.value;if(fixedAxis==='X' || fixedAxis==='Y' || fixedAxis==='Z') change({...draft,fixedAxis});
              }}>{FUNCTION_AXES.map(axis=><option key={axis}>{axis}</option>)}</select></label>
              <p>{draft.fixedAxis} ({t('functionPlot.fixedCoordinate')}, mm)</p>
              {scalarField('fixedCoordinate',`${draft.fixedAxis} ${t('functionPlot.fixedCoordinate')}`)}
            </div> : null}
            <p>{t(surface?'functionPlot.implicitHint':'functionPlot.implicitCurveHint')}</p>
            {!surface ? <p>{t('functionPlot.equationAxes')}: {functionDraftScope(draft).axes.join(t('display.listSeparator'))}</p> : null}
            <div className="pcad-function-equation" role="group" aria-label={equationLabel}>
              <span>F = </span><input aria-label={equationLabel} required value={draft.equation.source} aria-invalid={issues.has('equation')}
                onChange={event=>change({...draft,equation:editFunctionField(draft.equation,event.target.value)})} />
              <button type="button" aria-label={`${equationLabel}: ${t('math.open')}`} onClick={()=>setEditor({kind:'equation'})}>{t('math.open')}</button>
              <small>{t('math.angleUnit')}: {t(draft.equation.angleUnit === 'degree' ? 'math.degree' : 'math.radian')}</small>
            </div>
          </> : null}
          <p>{t(surface ? 'functionPlot.surfaceApproximation' : 'functionPlot.approximation')}</p>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>{t('functionPlot.boundsTitle')}</legend>
          <p>{t('math.functionRangeHint')}</p>
          <table><thead><tr><th>{t('functionPlot.axis')}</th><th>{t('functionPlot.minimum')}</th><th>{t('functionPlot.maximum')}</th></tr></thead>
            <tbody>{FUNCTION_AXES.map(axis => <tr key={axis}><th scope="row">{axis} (mm)</th>
              <td>{scalarField(`${axis}.min`, `${axis} ${t('functionPlot.minimum')}`)}</td><td>{scalarField(`${axis}.max`, `${axis} ${t('functionPlot.maximum')}`)}</td></tr>)}</tbody></table>
          {draft.form === 'parametric' ? <table aria-label={t(surface ? 'functionPlot.surfaceParameterRange' : 'functionPlot.parameterRange')}>
            <caption>{t(surface ? 'functionPlot.surfaceParameterRange' : 'functionPlot.parameterRange')}</caption>
            <thead><tr><th>{t('functionPlot.parameter')}</th><th>{t('functionPlot.minimum')}</th><th>{t('functionPlot.maximum')}</th></tr></thead>
            <tbody>{functionParameters(draft).map(parameter => <tr key={parameter}><th scope="row">{parameter}</th>
              <td>{scalarField(`${parameter}.min`, `${parameter} ${t('functionPlot.minimum')}`)}</td>
              <td>{scalarField(`${parameter}.max`, `${parameter} ${t('functionPlot.maximum')}`)}</td></tr>)}</tbody></table> : null}
          <label>{t(surface ? 'functionPlot.surfaceTolerance' : 'functionPlot.tolerance')}{scalarField('tolerance', t(surface ? 'functionPlot.surfaceTolerance' : 'functionPlot.tolerance'))}</label>
        </fieldset>
        {issues.size === 0 ? null : <ul role="alert">{[...issues].map(([field, message]) => <li key={field}>{fieldLabel(field)}: {message}</li>)}</ul>}
        {busy ? <p role="status">{t(surface ? 'functionPlot.surfaceCalculating' : 'functionPlot.calculating')}</p> : null}
        {preview === null ? null : preview.kind === 'surface'
          ? <FunctionSurfacePreview definition={preview.feature.definition} body={preview.body} onDisplay={display} />
          : <FunctionCurvePreview definition={preview.feature.definition} curves={preview.curves} />}
        <div className="pcad-function-actions">
          <button type="button" onClick={() => useAppStore.getState().openHelpTopic(surface ? 'function-surface' : 'function-curve')}>{t(surface ? 'functionPlot.surfaceHelp' : 'functionPlot.help')}</button>
          <button type="button" onClick={close}>{t('math.cancel')}</button>
          {busy ? <button type="button" onClick={() => { running.current?.abort(); setBusy(false); }}>{t('functionPlot.stop')}</button>
            : <button type="submit">{t('functionPlot.preview')}</button>}
          <button type="button" disabled={busy || !displayed || preview === null || preview.draft !== draft} onClick={() => {
            if (!displayed || preview === null || preview.draft !== draft || !isCurrent()) return;
            useAppStore.getState().applyDocument(preview.document); close();
          }}>{t(surface ? 'functionPlot.surfaceApply' : 'functionPlot.apply')}</button>
        </div>
      </form>
    </dialog>
    {inputEditor()}
  </>;
}
