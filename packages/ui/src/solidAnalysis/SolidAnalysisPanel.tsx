import { useRef, useState } from 'react';
import { t } from '../i18n/t.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { useAppStore } from '../store/useAppStore.js';
import { solidExpressionField, solidFieldsFor, type SolidAnalysisSession } from './solidAnalysisSession.js';
import { solidFieldCssColor } from './solidFieldLayer.js';
import { solidAnalysisFieldOf } from './solidFieldState.js';
import { SOLID_FIELD_QUANTITIES, type SolidFieldQuantity } from './solidFieldView.js';
import { SolidModalSection } from './SolidModalSection.js';
import { SolidBucklingSection } from './SolidBucklingSection.js';

const QUANTITY_LABELS = { vonMises: 'solidAnalysis.fieldVonMises', xx: 'solidAnalysis.fieldXx', yy: 'solidAnalysis.fieldYy',
  zz: 'solidAnalysis.fieldZz', yz: 'solidAnalysis.fieldYz', xz: 'solidAnalysis.fieldXz', xy: 'solidAnalysis.fieldXy' } as const;
function isQuantity(value: string): value is SolidFieldQuantity {
  return SOLID_FIELD_QUANTITIES.some(quantity => quantity === value);
}
function validScale(text: string): boolean {
  return text.trim() !== '' && Number.isFinite(Number(text)) && Number(text) >= 0;
}

export function SolidAnalysisPanel({ session }: { readonly session: SolidAnalysisSession }): React.JSX.Element {
  const openSolidFatigue = useAppStore(state => state.openSolidFatigue);
  const parameters = useAppStore(state => state.document.parameters);
  const runner = useAppStore(state => state.solidAnalysisRunner);
  const edit = useAppStore(state => state.editSolidAnalysis);
  const setLoadMode = useAppStore(state => state.setSolidAnalysisLoadMode);
  const focus = useAppStore(state => state.focusSolidAnalysis);
  const close = useAppStore(state => state.closeSolidAnalysis);
  const cancel = useAppStore(state => state.cancelSolidAnalysis);
  const save = useAppStore(state => state.saveSolidAnalysis);
  const setFieldView = useAppStore(state => state.setSolidAnalysisFieldView);
  // An unfinished (invalid) scale entry belongs to the fieldView it was typed against: another session or any view
  // change shows the actual drawn scale again; focus or other unrelated session updates keep the same fieldView.
  const [scaleDraft, setScaleDraft] = useState<{ readonly view: SolidAnalysisSession['fieldView']; readonly text: string } | null>(null);
  const scaleText = scaleDraft !== null && scaleDraft.view === session.fieldView ? scaleDraft.text
    : String(session.fieldView.deformationScale);
  const field = solidAnalysisFieldOf(session);
  const composing = useRef(false);
  const result = session.result;
  const maximumDisplacement = result?.result.displacementMm.reduce((maximum, vector) => Math.max(maximum, Math.hypot(...vector)), 0);
  const maximumVonMises = result?.result.elements.reduce((maximum, element) => {
    const [x, y, z, yz, xz, xy] = element.stressMPa;
    return Math.max(maximum, Math.hypot((x - y) / Math.SQRT2, (y - z) / Math.SQRT2,
      (z - x) / Math.SQRT2, Math.sqrt(3) * xy, Math.sqrt(3) * yz, Math.sqrt(3) * xz));
  }, 0);
  const reaction = result?.result.reactionN.reduce((sum, vector) => [sum[0] + vector[0], sum[1] + vector[1], sum[2] + vector[2]], [0, 0, 0]);
  return <form className="pcad-panel__body pcad-strength" aria-label={t('solidAnalysis.title')} data-testid="solid-analysis-panel"
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={event => {
      if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    }} onSubmit={event => { event.preventDefault(); }}>
    <h3>{t('solidAnalysis.title')}</h3>
    <p>{t('solidAnalysis.assumptions')}</p>
    <p>{t('solidAnalysis.selectionHelp')}</p>
    <p>{t('solidAnalysis.body')}: {session.bodyFeatureId ?? t('solidAnalysis.none')}</p>
    <button type="button" className="pcad-button" data-testid="solid-fixed" onClick={() => runner?.captureFaces('fixed')} title={t('solidAnalysis.guide.fixed')}>
      {t('solidAnalysis.fixed')} ({session.fixedFaces.length})</button>
    <button type="button" className="pcad-button" data-testid="solid-loaded" onClick={() => runner?.captureFaces('loaded')} title={t('solidAnalysis.guide.loaded')}>
      {t('solidAnalysis.loaded')} ({session.loadedFaces.length})</button>
    <fieldset data-testid="solid-load-mode">
      <legend>{t('solidAnalysis.loadMode')}</legend>
      {(['traction', 'pressure'] as const).map(mode => <label key={mode}>
        <input type="radio" name="solid-load-mode" value={mode} data-testid={`solid-load-${mode}`}
          checked={session.loadMode === mode} onChange={() => setLoadMode(mode)} title={t(mode === 'traction' ? 'solidAnalysis.guide.loadTraction' : 'solidAnalysis.guide.loadPressure')} />
        {t(mode === 'traction' ? 'solidAnalysis.loadTraction' : 'solidAnalysis.loadPressure')}</label>)}
    </fieldset>
    {session.loadMode === 'pressure' ? <p>{t('solidAnalysis.pressureHelp')}</p> : null}
    {solidFieldsFor(session.loadMode).map(name => <ExpressionField key={name} {...solidExpressionField(name, session.values[name], parameters)}
      focused={session.focused === name} onFocus={() => focus(name)} onChange={value => edit(name, value)} />)}
    <p>{t('solidAnalysis.accuracyHelp')}</p>
    {session.error === null ? null : <p role="alert">{session.error}</p>}
    {session.status === 'running' ? <p role="status">{t('solidAnalysis.running')}</p> : null}
    <button type="button" className="pcad-button pcad-button--primary" data-testid="solid-run" onClick={() => { if (!composing.current) runner?.run(); }}
      disabled={runner === null || session.status === 'running'} title={t('solidAnalysis.guide.run')}>{t('solidAnalysis.run')}</button>
    <button type="button" className="pcad-button" onClick={cancel} disabled={session.status !== 'running'} title={t('solidAnalysis.guide.cancel')}>{t('solidAnalysis.cancel')}</button>
    <button type="button" className="pcad-button" data-testid="solid-save" onClick={save} title={t('solidAnalysis.guide.save')}>{t('solidAnalysis.save')}</button>
    <button type="button" className="pcad-button" onClick={close} title={t('solidAnalysis.guide.close')}>{t('solidAnalysis.close')}</button>
    {result === null ? null : <section aria-label={t('solidAnalysis.results')} data-testid="solid-results">
      <h4>{t('solidAnalysis.results')}</h4>
      <dl>
        <dt>{t('solidAnalysis.displacement')}</dt><dd>{maximumDisplacement} mm</dd>
        <dt>{t('solidAnalysis.stress')}</dt><dd>{maximumVonMises} MPa</dd>
        <dt>{t('solidAnalysis.area')}</dt><dd>{result.prepared.loadedAreaMm2} mm²</dd>
        <dt>{t('solidAnalysis.force')}</dt><dd>{result.prepared.totalForceN.join(', ')} N</dd>
        <dt>{t('solidAnalysis.reaction')}</dt><dd>{reaction?.join(', ')} N</dd>
        <dt>{t('solidAnalysis.energy')}</dt><dd>{result.result.strainEnergyNmm} N·mm</dd>
        <dt>{t('solidAnalysis.residual')}</dt><dd>{result.result.maximumRelativeEquilibriumResidual}</dd>
      </dl>
      <p>{t('solidAnalysis.resultLimit')}</p>
      <fieldset data-testid="solid-field-view">
        <legend>{t('solidAnalysis.fieldView')}</legend>
        <label>{t('solidAnalysis.fieldQuantity')}
          <select data-testid="solid-field-quantity" value={session.fieldView.quantity}
            onChange={event => { if (isQuantity(event.target.value)) setFieldView({ quantity: event.target.value }); }} title={t('solidAnalysis.guide.fieldQuantity')}>
            {SOLID_FIELD_QUANTITIES.map(quantity => <option key={quantity} value={quantity}>{t(QUANTITY_LABELS[quantity])}</option>)}
          </select></label>
        <label>{t('solidAnalysis.deformationScale')}
          <input type="number" min="0" step="any" inputMode="decimal" data-testid="solid-field-scale" value={scaleText}
            aria-invalid={!validScale(scaleText)}
            onChange={event => {
              const text = event.target.value;
              if (validScale(text)) { setScaleDraft(null); setFieldView({ deformationScale: Number(text) }); }
              else setScaleDraft({ view: session.fieldView, text });
            }} title={t('solidAnalysis.guide.deformationScale')} /></label>
        {validScale(scaleText) ? null : <p role="alert">{t('solidAnalysis.deformationScaleInvalid')}</p>}
        {field === null ? <p role="alert" data-testid="solid-field-unavailable">{t('solidAnalysis.fieldUnavailable')}</p>
          : <dl aria-label={t('solidAnalysis.legend')} data-testid="solid-field-legend">
            <dt>{t('solidAnalysis.legendMinimum')}</dt><dd>{`${field.legend.minimumMPa} MPa`}</dd>
            <dt>{t('solidAnalysis.legendMaximum')}</dt><dd>{`${field.legend.maximumMPa} MPa`}</dd>
            <dd data-testid="solid-field-ramp" role="img"
              aria-label={`${t('solidAnalysis.legendRamp')} ${field.legend.minimumMPa} MPa - ${field.legend.maximumMPa} MPa`}>
              <span aria-hidden="true" data-testid="solid-field-ramp-low" style={{ display: 'inline-block', width: '1em', height: '1em',
                backgroundColor: solidFieldCssColor(field.legend.constant ? 0.5 : 0) }} />
              <span aria-hidden="true" style={{ display: 'inline-block', width: '6em', height: '1em',
                background: `linear-gradient(to right, ${solidFieldCssColor(field.legend.constant ? 0.5 : 0)}, ${solidFieldCssColor(field.legend.constant ? 0.5 : 1)})` }} />
              <span aria-hidden="true" data-testid="solid-field-ramp-high" style={{ display: 'inline-block', width: '1em', height: '1em',
                backgroundColor: solidFieldCssColor(field.legend.constant ? 0.5 : 1) }} />
            </dd>
            {field.legend.constant ? <dd>{t('solidAnalysis.legendConstant')}</dd> : null}
          </dl>}
        <p>{t('solidAnalysis.fieldElementNote')}</p>
      </fieldset>
    </section>}
    {result === null ? <p data-testid="solid-field-empty">{t('solidAnalysis.fieldEmpty')}</p> : null}
    {result === null ? null : <button type="button" className="pcad-button" data-testid="solid-fatigue-open"
      onClick={openSolidFatigue} title={t('solidAnalysis.guide.fatigueOpen')}>{t('fatigue.inputModeSolid')}</button>}
    <SolidModalSection />
    <SolidBucklingSection />
  </form>;
}
