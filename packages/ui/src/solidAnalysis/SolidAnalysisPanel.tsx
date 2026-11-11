import { SolidResultExport } from './SolidResultExport.js';
import { SolidElementProbe } from './SolidElementProbe.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SOLID_LIMITS, summarizeSolidYield, type SolidYieldSummary, type CadSolidStage } from '@pointercad/fem';
import { t, type MessageKey } from '../i18n/t.js';
import type { AnalysisMaterialCapacity } from '@pointercad/model/beam-analysis';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { useAppStore } from '../store/useAppStore.js';
import { solidExpressionField, solidFieldsFor, type SolidAnalysisSession } from './solidAnalysisSession.js';
import { solidFieldCssColor } from './solidFieldLayer.js';
import { solidAnalysisFieldOf } from './solidFieldState.js';
import { solidFieldUnit, SOLID_LINEAR_FIELD_QUANTITIES, SOLID_RESULT_WARNING_KEYS, solidResultWarningsOf,
  type SolidLinearFieldQuantity } from './solidFieldView.js';
import { SolidModalSection } from './SolidModalSection.js';
import { SolidBucklingSection } from './SolidBucklingSection.js';
import { SolidAnalysisMaterialFields } from './SolidAnalysisMaterialFields.js';
import { SolidBoundaryFields } from './SolidBoundaryFields.js';
import { solidBoundarySaved } from './solidBoundaryDraft.js';

const STAGE_LABELS: Readonly<Record<CadSolidStage, MessageKey>> = {
  preparing: 'solidAnalysis.stage.preparing', meshing: 'solidAnalysis.stage.meshing', solving: 'solidAnalysis.stage.solving',
};

const QUANTITY_LABELS = { vonMises: 'solidAnalysis.fieldVonMises', xx: 'solidAnalysis.fieldXx', yy: 'solidAnalysis.fieldYy',
  zz: 'solidAnalysis.fieldZz', yz: 'solidAnalysis.fieldYz', xz: 'solidAnalysis.fieldXz', xy: 'solidAnalysis.fieldXy',
  strainXx: 'solidAnalysis.fieldStrainXx', strainYy: 'solidAnalysis.fieldStrainYy', strainZz: 'solidAnalysis.fieldStrainZz',
  strainYz: 'solidAnalysis.fieldStrainYz', strainXz: 'solidAnalysis.fieldStrainXz', strainXy: 'solidAnalysis.fieldStrainXy',
} as const satisfies Readonly<Record<SolidLinearFieldQuantity, MessageKey>>;
function isQuantity(value: string): value is SolidLinearFieldQuantity {
  return SOLID_LINEAR_FIELD_QUANTITIES.some(quantity => quantity === value);
}
function validScale(text: string): boolean {
  return text.trim() !== '' && Number.isFinite(Number(text)) && Number(text) >= 0;
}

export function SolidAnalysisPanel({ session }: { readonly session: SolidAnalysisSession }): React.JSX.Element {
  const activeOwner = useAppStore(state => state.activeDocumentId);
  const documentId = useAppStore(state => state.document.id);
  const openSolidFatigue = useAppStore(state => state.openSolidFatigue);
  const parameters = useAppStore(state => state.document.parameters);
  const runner = useAppStore(state => state.solidAnalysisRunner);
  const edit = useAppStore(state => state.editSolidAnalysis);
  const setLoadMode = useAppStore(state => state.setSolidAnalysisLoadMode);
  const setMaterial = useAppStore(state => state.setSolidAnalysisMaterial);
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
  const dimensionless = solidFieldUnit(session.fieldView.quantity) === 'dimensionless';
  const fieldUnit = dimensionless ? t('solidAnalysis.dimensionless') : 'MPa';
  const composing = useRef(false);
  const result = session.result;
  // This count comes from the validated tet4 input; native success checks fixed/free numbering is bijective.
  const dofInput = session.status === 'complete' && session.ownerId === activeOwner
    && result?.prepared.input.source.documentId === documentId && result.prepared.input.schema === 'pointercad-solid-tet4/1'
    ? result.prepared.input : null;
  const dofNodes = dofInput?.nodes.length;
  const fixedDof = dofInput?.constraints.reduce((sum, item) => sum + item.fixed.filter(Boolean).length, 0);
  let boundaryValid = true;
  try { solidBoundarySaved(session, parameters); } catch { boundaryValid = false; }
  const maximumDisplacement = result?.result.displacementMm.reduce((maximum, vector) => Math.max(maximum, Math.hypot(...vector)), 0);
  const maximumVonMises = result?.result.elements.reduce((maximum, element) => {
    const [x, y, z, yz, xz, xy] = element.stressMPa;
    return Math.max(maximum, Math.hypot((x - y) / Math.SQRT2, (y - z) / Math.SQRT2,
      (z - x) / Math.SQRT2, Math.sqrt(3) * xy, Math.sqrt(3) * yz, Math.sqrt(3) * xz));
  }, 0);
  const warnings = result === null ? null : solidResultWarningsOf(result);
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
    <SolidAnalysisMaterialFields value={session.capacity ?? null} onChange={setMaterial}
      selectionKey={JSON.stringify([activeOwner, documentId, session.materialSelectionKey ?? session.ownerId])} />
    <button type="button" className="pcad-button" data-testid="solid-fixed" onClick={() => runner?.captureFaces('fixed')} title={t('solidAnalysis.guide.fixed')}>
      {t('solidAnalysis.fixed')} ({session.fixedFaces.length})</button>
    <button type="button" className="pcad-button" data-testid="solid-loaded" onClick={() => runner?.captureFaces('loaded')} title={t('solidAnalysis.guide.loaded')}>
      {t('solidAnalysis.loaded')} ({session.loadedFaces.length})</button>
    <SolidBoundaryFields session={session} />
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
    {session.status === 'running' ? <p role="status" data-testid="solid-analysis-progress" data-stage={session.stage ?? undefined}>
      {t(session.stage == null ? 'solidAnalysis.running' : STAGE_LABELS[session.stage])}</p> : null}
    <button type="button" className="pcad-button pcad-button--primary" data-testid="solid-run" onClick={() => { if (!composing.current && session.materialInputValid !== false && boundaryValid) runner?.run(); }}
      disabled={runner === null || session.status === 'running' || session.materialInputValid === false || !boundaryValid} title={t('solidAnalysis.guide.run')}>{t('solidAnalysis.run')}</button>
    <button type="button" className="pcad-button" onClick={cancel} disabled={session.status !== 'running'} title={t('solidAnalysis.guide.cancel')}>{t('solidAnalysis.cancel')}</button>
    <button type="button" className="pcad-button" data-testid="solid-save" onClick={() => { if (session.materialInputValid !== false && boundaryValid) save(); }}
      disabled={session.materialInputValid === false || !boundaryValid} title={t('solidAnalysis.guide.save')}>{t('solidAnalysis.save')}</button>
    <button type="button" className="pcad-button" onClick={close} title={t('solidAnalysis.guide.close')}>{t('solidAnalysis.close')}</button>
    {result === null ? null : <section aria-label={t('solidAnalysis.results')} data-testid="solid-results"
      data-solid-nodes={dofNodes} data-solid-node-limit={dofInput === null ? undefined : SOLID_LIMITS.nodes} data-solid-dof-total={dofNodes === undefined ? undefined : dofNodes * 3}
      data-solid-dof-fixed={fixedDof} data-solid-dof-free={dofNodes === undefined || fixedDof === undefined ? undefined : dofNodes * 3 - fixedDof}>
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
      {warnings === null || warnings.warnings.length === 0 ? null
        : <ul aria-label={t('solidAnalysis.warningsTitle')} data-testid="solid-result-warnings">
          {warnings.warnings.map(kind => <li key={kind} data-warning={kind}>{t(SOLID_RESULT_WARNING_KEYS[kind])}</li>)}</ul>}
      <SolidResultExport session={session} />
      <SolidElementProbe session={session} ownerId={activeOwner} documentId={documentId} />
      {session.status === 'complete' && session.ownerId === activeOwner && result.prepared.input.source.documentId === documentId
        ? <SolidYieldResults input={result.prepared.input} result={result.result}
          owner={JSON.stringify([session.ownerId, session.revision, activeOwner])} /> : null}
      <fieldset data-testid="solid-field-view">
        <legend>{t('solidAnalysis.linearFieldView')}</legend>
        <label>{t('solidAnalysis.fieldQuantity')}
          <select data-testid="solid-field-quantity" value={session.fieldView.quantity}
            onChange={event => { if (isQuantity(event.target.value)) setFieldView({ quantity: event.target.value }); }} title={t('solidAnalysis.guide.linearFieldQuantity')}>
            {SOLID_LINEAR_FIELD_QUANTITIES.map(quantity => <option key={quantity} value={quantity}>{t(QUANTITY_LABELS[quantity])}</option>)}
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
          : <dl aria-label={t(dimensionless ? 'solidAnalysis.legendDimensionless' : 'solidAnalysis.legend')} data-testid="solid-field-legend">
            <dt>{t('solidAnalysis.legendMinimum')}</dt><dd>{`${field.legend.minimum} ${fieldUnit}`}</dd>
            <dt>{t('solidAnalysis.legendMaximum')}</dt><dd>{`${field.legend.maximum} ${fieldUnit}`}</dd>
            <dd data-testid="solid-field-ramp" role="img"
              aria-label={`${t(dimensionless ? 'solidAnalysis.legendRampDimensionless' : 'solidAnalysis.legendRamp')} ${field.legend.minimum} ${fieldUnit} - ${field.legend.maximum} ${fieldUnit}`}>
              <span aria-hidden="true" data-testid="solid-field-ramp-low" style={{ display: 'inline-block', width: '1em', height: '1em',
                backgroundColor: solidFieldCssColor(field.legend.constant ? 0.5 : 0) }} />
              <span aria-hidden="true" style={{ display: 'inline-block', width: '6em', height: '1em',
                background: `linear-gradient(to right, ${solidFieldCssColor(field.legend.constant ? 0.5 : 0)}, ${solidFieldCssColor(field.legend.constant ? 0.5 : 1)})` }} />
              <span aria-hidden="true" data-testid="solid-field-ramp-high" style={{ display: 'inline-block', width: '1em', height: '1em',
                backgroundColor: solidFieldCssColor(field.legend.constant ? 0.5 : 1) }} />
            </dd>
            {field.legend.constant ? <dd>{t('solidAnalysis.legendConstant')}</dd> : null}
          </dl>}
        <p>{t('solidAnalysis.linearFieldElementNote')}</p>
      </fieldset>
    </section>}
    {result === null ? <p data-testid="solid-field-empty">{t('solidAnalysis.linearFieldEmpty')}</p> : null}
    {result === null ? null : <button type="button" className="pcad-button" data-testid="solid-fatigue-open"
      onClick={openSolidFatigue} title={t('solidAnalysis.guide.fatigueOpen')}>{t('fatigue.inputModeSolid')}</button>}
    <SolidModalSection />
    <SolidBucklingSection />
  </form>;
}

const YIELD_EVIDENCE_LABELS: Readonly<Record<AnalysisMaterialCapacity['evidence'], MessageKey>> = {
  'supplier-excerpt': 'solidAnalysis.yieldEvidenceSupplier', 'manufacturer-reference': 'solidAnalysis.yieldEvidenceManufacturer',
  'measured-reference': 'solidAnalysis.yieldEvidenceMeasured', 'standard-draft': 'solidAnalysis.yieldEvidenceDraft',
};
const YIELD_BASIS_LABELS: Readonly<Record<AnalysisMaterialCapacity['basis'], MessageKey>> = {
  minimum: 'solidAnalysis.yieldBasisMinimum', reference: 'solidAnalysis.yieldBasisReference',
};
export function solidYieldEvidenceLabel(value: AnalysisMaterialCapacity['evidence']): string { return t(YIELD_EVIDENCE_LABELS[value]); }
export function solidYieldBasisLabel(value: AnalysisMaterialCapacity['basis']): string { return t(YIELD_BASIS_LABELS[value]); }

interface SolidYieldRequest {
  readonly input: Parameters<typeof summarizeSolidYield>[0];
  readonly result: unknown;
  readonly owner: string;
}
interface SolidYieldCompletion extends SolidYieldRequest { readonly summary: SolidYieldSummary | null }
export function startSolidYieldSummary(request: SolidYieldRequest, publish: (value: SolidYieldCompletion) => void,
  recover = summarizeSolidYield): () => void {
  let active = true;
  void recover(request.input, request.result).then(summary => { if (active) publish({ ...request, summary }); },
    () => { if (active) publish({ ...request, summary: null }); });
  return () => { active = false; };
}
export function currentSolidYieldSummary(value: SolidYieldCompletion | null, request: SolidYieldRequest): SolidYieldCompletion | null {
  return value?.input === request.input && value.result === request.result && value.owner === request.owner ? value : null;
}
export function SolidYieldSummaryView({ completion, request }: {
  readonly completion: SolidYieldCompletion | null; readonly request: SolidYieldRequest;
}): React.JSX.Element {
  const current = currentSolidYieldSummary(completion, request);
  if (current === null) return <p role="status">{t('solidAnalysis.yieldPending')}</p>;
  if (current.summary === null) return <p role="alert">{t('solidAnalysis.changed')}</p>;
  const summary = current.summary;
  return <section data-testid="solid-yield-summary" data-input-sha256={summary.inputSha256} data-structural-certification="false">
    <h5>{t('solidAnalysis.yieldTitle')}</h5><p>{t('solidAnalysis.yieldScope')}</p>
    <p>{t('solidAnalysis.yieldRatio')}: <span data-testid="solid-yield-minimum" data-unit="1" data-value={summary.minimumYieldRatio ?? undefined}>
      {summary.minimumYieldRatio === null ? t('solidAnalysis.yieldUnavailable') : summary.minimumYieldRatio}</span></p>
    {summary.missingMaterialIds.length === 0 ? null : <p>{t('solidAnalysis.yieldMissing')} {summary.missingMaterialIds.join(', ')}</p>}
    <details><summary>{t('solidAnalysis.yieldSource')}</summary>
      <table><caption>{t('solidAnalysis.yieldTitle')}</caption><thead><tr>
        <th>{t('solidAnalysis.yieldElement')}</th><th>{t('solidAnalysis.yieldMaterial')}</th>
        <th>{t('solidAnalysis.stress')}</th><th>{t('solidAnalysis.yieldValue')}</th>
        <th>{t('solidAnalysis.yieldRatio')}</th><th>{t('solidAnalysis.yieldSource')}</th><th>{t('solidAnalysis.yieldBasis')}</th>
      </tr></thead><tbody>{summary.elements.map(row => <tr key={row.elementIndex} data-element={row.elementIndex}>
        <td>{row.elementIndex + 1}</td><td>{row.materialId}</td><td data-unit="MPa" data-value={row.vonMisesMPa}>{row.vonMisesMPa}</td>
        <td data-unit="MPa" data-value={row.capacity?.yieldMPa}>{row.capacity?.yieldMPa ?? t('solidAnalysis.yieldUnavailable')}</td>
        <td data-unit="1" data-value={row.yieldRatio ?? undefined}>{row.zeroStress ? t('solidAnalysis.yieldZero')
          : row.yieldRatio ?? t('solidAnalysis.yieldUnavailable')}</td>
        <td>{row.capacity === null ? t('solidAnalysis.yieldUnavailable')
          : `${row.capacity.sourceId} / ${row.capacity.materialConditionId} / ${row.capacity.condition} / ${row.capacity.thicknessMm === null ? '—' : `${row.capacity.thicknessMm} mm`}`}</td>
        <td>{row.capacity === null ? t('solidAnalysis.yieldUnavailable') : `${solidYieldEvidenceLabel(row.capacity.evidence)} / ${solidYieldBasisLabel(row.capacity.basis)}`}</td>
      </tr>)}</tbody></table>
    </details>
  </section>;
}
function SolidYieldResults(request: SolidYieldRequest): React.JSX.Element {
  const { input, result, owner } = request;
  const stable = useMemo(() => ({ input, result, owner }), [input, result, owner]);
  const [completion, setCompletion] = useState<SolidYieldCompletion | null>(null);
  useEffect(() => startSolidYieldSummary(stable, setCompletion), [stable]);
  return <SolidYieldSummaryView completion={completion} request={stable} />;
}
