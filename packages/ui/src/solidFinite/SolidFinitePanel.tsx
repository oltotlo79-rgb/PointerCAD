import { useEffect, useRef, useState } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { beamExpressionField } from '../beam/beamFields.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { solidExpressionField } from '../solidAnalysis/solidAnalysisSession.js';
import { useAppStore } from '../store/useAppStore.js';
import { solidFieldCssColor } from '../solidAnalysis/solidFieldLayer.js';
import { SOLID_FIELD_QUANTITIES, type SolidFieldQuantity } from '../solidAnalysis/solidFieldView.js';
import { solidFiniteFieldOf } from './solidFiniteFieldState.js';
import { SolidFiniteBoundaryFields } from './SolidFiniteBoundaryFields.js';
import { solidFiniteSavedInput, type SolidFiniteField, type SolidFiniteSession } from './solidFiniteSession.js';

const FIELDS = [
  ['young', 'young', 'solidFinite.young'], ['poisson', 'poisson', 'solidFinite.poisson'],
  ['yield', 'young', 'solidFinite.yield'], ['hardening', 'tx', 'solidFinite.hardening'],
  ['tx', 'tx', 'solidFinite.tx'], ['ty', 'ty', 'solidFinite.ty'], ['tz', 'tz', 'solidFinite.tz'],
  ['linear', 'linear', 'solidFinite.linear'], ['angular', 'angular', 'solidFinite.angular'],
  ['chord', 'chord', 'solidFinite.chord'], ['volume', 'volume', 'solidFinite.volume'],
] as const satisfies readonly (readonly [SolidFiniteField, Parameters<typeof solidExpressionField>[0], MessageKey])[];

const QUANTITY_LABELS = { vonMises: 'solidAnalysis.fieldVonMises', xx: 'solidAnalysis.fieldXx', yy: 'solidAnalysis.fieldYy',
  zz: 'solidAnalysis.fieldZz', yz: 'solidAnalysis.fieldYz', xz: 'solidAnalysis.fieldXz', xy: 'solidAnalysis.fieldXy' } as const;
function isQuantity(value: string): value is SolidFieldQuantity {
  return SOLID_FIELD_QUANTITIES.some(quantity => quantity === value);
}
function validScale(value: string): boolean {
  return value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
}

/** Cauchy stress is row-major; this is not the Kirchhoff q recorded by the material model. */
export function cauchyVonMises(sigma: readonly number[]): number {
  const [xx, xy, xz, , yy, yz, , , zz] = sigma;
  return Math.hypot((xx - yy) / Math.SQRT2, (yy - zz) / Math.SQRT2, (zz - xx) / Math.SQRT2,
    Math.sqrt(3) * xy, Math.sqrt(3) * yz, Math.sqrt(3) * xz);
}

export function SolidFinitePanel({ session }: { readonly session: SolidFiniteSession }): React.JSX.Element {
  const parameters = useAppStore(state => state.document.parameters);
  const documentId = useAppStore(state => state.document.id);
  const activeOwner = useAppStore(state => state.activeDocumentId);
  const generation = useAppStore(state => state.completedGeneration);
  const isPart = useAppStore(state => state.assembly === null && state.drawing === null);
  const runner = useAppStore(state => state.solidFiniteRunner);
  const setFieldView = useAppStore(state => state.setSolidFiniteFieldView);
  const [scaleDraft, setScaleDraft] = useState<{ readonly view: SolidFiniteSession['fieldView']; readonly text: string } | null>(null);
  const scaleText = scaleDraft !== null && scaleDraft.view === session.fieldView ? scaleDraft.text : String(session.fieldView.deformationScale);
  const field = session.ownerId === activeOwner && isPart && session.result?.input.source.documentId === documentId
    && session.result.input.source.revision === generation ? solidFiniteFieldOf(session) : null;
  useEffect(() => {
    const records = session.status === 'complete' ? session.result?.result.records : undefined;
    if (records?.length && !records.some(record => record.step === session.fieldView.step)) setFieldView({ step: records[0].step });
  }, [session.status, session.result, session.fieldView.step, setFieldView]);
  const edit = useAppStore(state => state.editSolidFinite);
  const focus = useAppStore(state => state.focusSolidFinite);
  const close = useAppStore(state => state.closeSolidFinite);
  const cancel = useAppStore(state => state.cancelSolidFinite);
  const save = useAppStore(state => state.saveSolidFinite);
  const composing = useRef(false);
  const outcome = session.result;
  let factors: ReturnType<typeof solidFiniteSavedInput> | null = null;
  if (session.result !== null) {
    try { factors = solidFiniteSavedInput(session, documentId, parameters); } catch { factors = null; }
  }
  const history = { forceFactors: session.values.forceFactors.split(','), prescribedFactors: session.values.prescribedFactors.split(',') };
  const rowCount = Math.max(history.forceFactors.length, history.prescribedFactors.length);
  const editHistory = (field: 'forceFactors' | 'prescribedFactors', index: number, value: string): void => {
    const values = [...history[field]];
    while (values.length <= index) values.push('');
    values[index] = value;
    edit({ kind: 'field', field, value: values.join(',') });
  };
  const referenceForce = beamExpressionField('startFx', session.values.referenceForce, parameters);
  const text = (name: SolidFiniteField, label: MessageKey, guide: MessageKey) => <label key={name}>{t(label)}
    <input title={t(guide)} data-testid={`solid-finite-${name}`} value={session.values[name]} onFocus={() => focus(name)}
      onChange={event => edit({ kind: 'field', field: name, value: event.currentTarget.value })} /></label>;
  return <form className="pcad-panel__body pcad-strength" aria-label={t('solidFinite.title')} data-testid="solid-finite-panel"
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={event => {
      if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    }} onSubmit={event => { event.preventDefault(); }}>
    <h3>{t('solidFinite.title')}</h3><p>{t('solidFinite.assumptions')}</p><p>{t('solidFinite.selectionHelp')}</p>
    <p>{t('solidFinite.body')}: {session.bodyFeatureId ?? t('solidFinite.none')}</p>
    <button type="button" title={t('solidFinite.guide.fixed')} className="pcad-button" data-testid="solid-finite-fixed" disabled={runner === null}
      onClick={() => runner?.captureFaces('fixed')}>{t('solidFinite.fixed')} ({session.fixedFaces.length})</button>
    <button type="button" title={t('solidFinite.guide.loaded')} className="pcad-button" data-testid="solid-finite-loaded" disabled={runner === null}
      onClick={() => runner?.captureFaces('loaded')}>{t('solidFinite.loaded')} ({session.loadedFaces.length})</button>
    <SolidFiniteBoundaryFields session={session} />
    {FIELDS.map(([name, kind, labelKey]) => {
      const field = solidExpressionField(kind, session.values[name], parameters);
      return <ExpressionField key={name} {...field} field={{ ...field.field, key: name, labelKey }}
        result={{ ...field.result, key: name }} focused={session.focused === name}
        onFocus={() => focus(name)} onChange={value => edit({ kind: 'field', field: name, value })} />;
    })}
    {text('reference', 'solidFinite.reference', 'solidFinite.guide.reference')}<p>{t('solidFinite.referenceHelp')}</p>
    <fieldset><legend>{t('solidFinite.history')}</legend><p>{t('solidFinite.historyHelp')}</p>
      <table><thead><tr><th>{t('solidFinite.step')}</th><th>{t('solidFinite.forceFactors')}</th>
        <th>{t('solidFinite.prescribedFactors')}</th><th>{t('solidFinite.removeStep')}</th></tr></thead>
        <tbody>{Array.from({ length: rowCount }, (_, index) => <tr key={index}>
          <th scope="row">{index + 1}</th>
          {(['forceFactors', 'prescribedFactors'] as const).map(field => <td key={field}>
            <input title={t(field === 'forceFactors' ? 'solidFinite.guide.forceFactors' : 'solidFinite.guide.prescribedFactors')}
              aria-label={`${t(field === 'forceFactors' ? 'solidFinite.forceFactors' : 'solidFinite.prescribedFactors')} ${index + 1}`}
              data-testid={`solid-finite-${field}-${index}`} value={history[field][index] ?? ''}
              onFocus={() => focus(field)} onChange={event => editHistory(field, index, event.currentTarget.value)} />
          </td>)}
          <td><button type="button" title={t('solidFinite.guide.removeStep')} className="pcad-button" disabled={rowCount <= 1} onClick={() => {
            for (const field of ['forceFactors', 'prescribedFactors'] as const) {
              const values = Array.from({ length: rowCount }, (_, i) => history[field][i] ?? '');
              values.splice(index, 1); edit({ kind: 'field', field, value: values.join(',') });
            }
          }}>{t('solidFinite.removeStep')}</button></td>
        </tr>)}</tbody></table>
      <button type="button" title={t('solidFinite.guide.addStep')} className="pcad-button" disabled={rowCount >= 200} onClick={() => {
        for (const field of ['forceFactors', 'prescribedFactors'] as const) {
          const values = Array.from({ length: rowCount }, (_, i) => history[field][i] ?? '');
          values.push(''); edit({ kind: 'field', field, value: values.join(',') });
        }
      }}>{t('solidFinite.addStep')}</button>
    </fieldset>
    <ExpressionField {...referenceForce} field={{ ...referenceForce.field, key: 'referenceForce', labelKey: 'solidFinite.referenceForce' }}
      result={session.values.referenceForce.trim() === '' ? { key: 'referenceForce', value: null, error: null } : referenceForce.result}
      focused={session.focused === 'referenceForce'} onFocus={() => focus('referenceForce')}
      onChange={value => edit({ kind: 'field', field: 'referenceForce', value })} />
    <p>{t('solidFinite.referenceForceHelp')}</p>
    {session.error === null ? null : <p role="alert">{session.error}</p>}
    {session.status === 'running' ? <p role="status">{t('solidFinite.running')}</p> : null}
    {session.status === 'cancelled' ? <p role="status">{t('solidFinite.cancelled')}</p> : null}
    <button type="button" title={t('solidFinite.guide.run')} className="pcad-button pcad-button--primary" data-testid="solid-finite-run"
      onClick={() => { if (!composing.current) runner?.run(); }} disabled={runner === null || session.status === 'running'}>{t('solidFinite.run')}</button>
    <button type="button" title={t('solidFinite.guide.cancel')} className="pcad-button" onClick={cancel} disabled={session.status !== 'running'}>{t('solidFinite.cancel')}</button>
    <button type="button" title={t('solidFinite.guide.save')} className="pcad-button" data-testid="solid-finite-save" onClick={save}>{t('solidFinite.save')}</button>
    <button type="button" title={t('solidFinite.guide.close')} className="pcad-button" onClick={close}>{t('solidFinite.close')}</button>
    {outcome === null || factors === null ? null : <section aria-label={t('solidFinite.results')} data-testid="solid-finite-results">
      <h4>{t('solidFinite.results')}</h4>
      <fieldset data-testid="solid-finite-field-view"><legend>{t('solidAnalysis.fieldView')}</legend>
        <label>{t('solidFinite.fieldStep')}<select title={t('solidFinite.guide.fieldStep')} data-testid="solid-finite-field-step"
          value={outcome.result.records.some(record => record.step === session.fieldView.step) ? session.fieldView.step : outcome.result.records[0]?.step}
          onChange={event => setFieldView({ step: Number(event.currentTarget.value) })}>
          {outcome.result.records.map(record => <option key={record.step} value={record.step}>{record.step}</option>)}
        </select></label>
        <label>{t('solidAnalysis.fieldQuantity')}<select data-testid="solid-finite-field-quantity" value={session.fieldView.quantity}
          onChange={event => { if (isQuantity(event.currentTarget.value)) setFieldView({ quantity: event.currentTarget.value }); }}
          title={t('solidAnalysis.guide.fieldQuantity')}>
          {SOLID_FIELD_QUANTITIES.map(quantity => <option key={quantity} value={quantity}>{t(QUANTITY_LABELS[quantity])}</option>)}
        </select></label>
        <label>{t('solidAnalysis.deformationScale')}<input type="number" min="0" step="any" inputMode="decimal"
          data-testid="solid-finite-field-scale" value={scaleText} aria-invalid={!validScale(scaleText)}
          onChange={event => {
            const text = event.currentTarget.value;
            if (validScale(text)) { setScaleDraft(null); setFieldView({ deformationScale: Number(text) }); }
            else setScaleDraft({ view: session.fieldView, text });
          }} title={t('solidAnalysis.guide.deformationScale')} /></label>
        {validScale(scaleText) ? null : <p role="alert">{t('solidAnalysis.deformationScaleInvalid')}</p>}
        {field === null ? <p role="alert" data-testid="solid-finite-field-unavailable">{t('solidAnalysis.fieldUnavailable')}</p>
          : <dl aria-label={t('solidAnalysis.legend')} data-testid="solid-finite-field-legend">
            <dt>{t('solidAnalysis.legendMinimum')}</dt><dd>{`${field.legend.minimum} MPa`}</dd>
            <dt>{t('solidAnalysis.legendMaximum')}</dt><dd>{`${field.legend.maximum} MPa`}</dd>
            <dd role="img" aria-label={`${t('solidAnalysis.legendRamp')} ${field.legend.minimum} MPa - ${field.legend.maximum} MPa`}>
              <span aria-hidden="true" style={{ display: 'inline-block', width: '1em', height: '1em',
                backgroundColor: solidFieldCssColor(field.legend.constant ? 0.5 : 0) }} />
              <span aria-hidden="true" style={{ display: 'inline-block', width: '6em', height: '1em',
                background: `linear-gradient(to right, ${solidFieldCssColor(field.legend.constant ? 0.5 : 0)}, ${solidFieldCssColor(field.legend.constant ? 0.5 : 1)})` }} />
              <span aria-hidden="true" style={{ display: 'inline-block', width: '1em', height: '1em',
                backgroundColor: solidFieldCssColor(field.legend.constant ? 0.5 : 1) }} />
            </dd>{field.legend.constant ? <dd>{t('solidAnalysis.legendConstant')}</dd> : null}
          </dl>}
        <p>{t('solidAnalysis.fieldElementNote')}</p><p>{t('solidFinite.fieldLimit')}</p>
      </fieldset>
      <table><thead><tr>
        <th>{t('solidFinite.step')}</th><th>{t('solidFinite.forceFactors')}</th><th>{t('solidFinite.prescribedFactors')}</th>
        <th>{t('solidFinite.displacement')}</th><th>{t('solidFinite.stress')}</th><th>{t('solidFinite.alpha')}</th>
        <th>{t('solidFinite.j')}</th><th>{t('solidFinite.residual')}</th><th>{t('solidFinite.reaction')}</th>
      </tr></thead><tbody>{outcome.result.records.map(record => {
        const reaction = [0, 0, 0];
        for (const boundary of outcome.input.plan.prescribedMm) {
          const axis = boundary.dof === 'x' ? 0 : boundary.dof === 'y' ? 1 : 2;
          reaction[axis] += record.internalN[boundary.node][axis] - record.externalN[boundary.node][axis];
        }
        return <tr key={record.step}>
          <td>{record.step}</td><td>{factors?.forceFactors[record.step - 1]}</td><td>{factors?.prescribedDisplacementFactors[record.step - 1]}</td>
          <td>{record.displacementMm.reduce((max, vector) => Math.max(max, Math.hypot(...vector)), 0)}</td>
          <td>{record.elements.reduce((max, element) => Math.max(max, cauchyVonMises(element.sigma)), 0)}</td>
          <td>{record.elements.reduce((max, element) => Math.max(max, element.alpha), 0)}</td>
          <td>{Math.min(...record.elements.map(element => element.J))}</td><td>{record.freeResidualRatio}</td><td>{reaction.join(', ')}</td>
        </tr>;
      })}</tbody></table><p>{t('solidFinite.resultLimit')}</p>
    </section>}
  </form>;
}
