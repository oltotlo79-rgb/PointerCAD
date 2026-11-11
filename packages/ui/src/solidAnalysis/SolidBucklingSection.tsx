import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import type { CadSolidBucklingFailureCode } from './cadSolidBuckling.js';
import { solidBucklingModeCount, solidBucklingPreview } from './solidBucklingState.js';

const FAILURE_KEYS = {
  'cad-solid-buckling': 'solidAnalysis.bucklingFailed', 'buckling-no-compression': 'solidAnalysis.bucklingNoCompression',
  'buckling-mechanism': 'solidAnalysis.bucklingMechanism', 'buckling-unsupported': 'solidAnalysis.bucklingUnsupported',
  'buckling-stale': 'solidAnalysis.bucklingStale',
} as const satisfies Record<CadSolidBucklingFailureCode, string>;
function validAmplitude(text: string): boolean {
  return text.trim() !== '' && Number.isFinite(Number(text)) && Number(text) >= 0;
}

/**
 * Linear prestress buckling part of the solid analysis panel. The reference load state is the static panel's input
 * (body, restrained and loaded faces, the one surface load, material, meshing tolerances); only the number of requested
 * load factors is its own. When an independently saved buckling input has a different reference, it is shown here and
 * used for the buckling run until the user explicitly adopts the panel's input. The factors multiply the whole
 * reference load set; the limit text is always visible. Selectors return store values or primitives only.
 */
export function SolidBucklingSection(): React.JSX.Element {
  const runner = useAppStore(state => state.solidAnalysisRunner);
  const buckling = useAppStore(state => state.solidBuckling);
  const reference = useAppStore(state => state.solidBucklingReference);
  const edit = useAppStore(state => state.editSolidBucklingCount);
  const cancel = useAppStore(state => state.cancelSolidBuckling);
  const save = useAppStore(state => state.saveSolidBuckling);
  const adopt = useAppStore(state => state.adoptPanelForSolidBuckling);
  const setView = useAppStore(state => state.setSolidBucklingView);
  const documentId = useAppStore(state => state.document.id);
  const generation = useAppStore(state => state.completedGeneration);
  const valid = solidBucklingModeCount(buckling) !== null;
  const display = buckling.status === 'result' ? buckling.display : null;
  // Same identity rule as the viewport (solidModalViewport.ts solidBucklingCurrentSource).
  const preview = display === null || buckling.input === null ? null
    : solidBucklingPreview(buckling, { documentId, revision: generation, meshKey: buckling.input.reference.source.meshKey });
  const amplitudeValid = validAmplitude(buckling.amplitudeText);
  return <section aria-label={t('solidAnalysis.bucklingSection')} data-testid="solid-buckling-section">
    <h4>{t('solidAnalysis.bucklingSection')}</h4>
    <p>{t('solidAnalysis.bucklingHelp')}</p>
    {reference === null ? null
      : <div role="note" data-testid="solid-buckling-own-inputs">
        <p>{t('solidAnalysis.bucklingOwnInputs')}</p>
        <dl>
          <dt>{t('solidAnalysis.body')}</dt><dd>{reference.bodyFeatureId}</dd>
          <dt>{t('solidAnalysis.fixed')}</dt><dd>{String(reference.fixedFaces.length)}</dd>
          <dt>{t('solidAnalysis.loaded')}</dt><dd>{String(reference.loadedFaces.length)}</dd>
          <dt>{t(reference.schema === 'pointercad-solid-cad-input/2' ? 'solidAnalysis.pressure' : 'solidAnalysis.loadTraction')}</dt>
          <dd>{reference.schema === 'pointercad-solid-cad-input/2' ? String(reference.pressureMPa) : reference.tractionMPa.join(', ')}</dd>
          <dt>{t('solidAnalysis.young')}</dt><dd>{String(reference.youngMPa)}</dd>
          <dt>{t('solidAnalysis.poisson')}</dt><dd>{String(reference.poisson)}</dd>
        </dl>
        <button type="button" className="pcad-button" data-testid="solid-buckling-adopt" onClick={adopt} title={t('solidAnalysis.guide.bucklingAdopt')}>{t('solidAnalysis.bucklingAdoptPanel')}</button>
      </div>}
    <label>{t('solidAnalysis.bucklingCount')}
      <input type="text" inputMode="numeric" data-testid="solid-buckling-count" value={buckling.modeCountText} aria-invalid={!valid}
        onChange={event => { edit(event.currentTarget.value); }} title={t('solidAnalysis.guide.bucklingCount')} /></label>
    {valid ? null : <p role="alert">{t('solidAnalysis.bucklingInputInvalid')}</p>}
    {buckling.status === 'running' ? <p role="status">{t('solidAnalysis.bucklingRunning')}</p> : null}
    {buckling.status === 'failed'
      ? <p role="alert" data-testid="solid-buckling-failed">{t(FAILURE_KEYS[buckling.code ?? 'cad-solid-buckling'])}</p> : null}
    {buckling.error !== null ? <p role="alert" data-testid="solid-buckling-error">{buckling.error}</p> : null}
    <button type="button" className="pcad-button pcad-button--primary" data-testid="solid-buckling-run"
      disabled={runner?.runBuckling === undefined || !valid || buckling.status === 'running'} onClick={() => { runner?.runBuckling?.(); }} title={t('solidAnalysis.guide.bucklingRun')}>
      {t('solidAnalysis.bucklingRun')}</button>
    <button type="button" className="pcad-button" data-testid="solid-buckling-cancel" disabled={buckling.status !== 'running'}
      onClick={cancel} title={t('solidAnalysis.guide.bucklingCancel')}>{t('solidAnalysis.bucklingCancel')}</button>
    <button type="button" className="pcad-button" data-testid="solid-buckling-save" onClick={save} title={t('solidAnalysis.guide.bucklingSave')}>{t('solidAnalysis.bucklingSave')}</button>
    {display === null ? <p data-testid="solid-buckling-empty">{t('solidAnalysis.bucklingEmpty')}</p>
      : <section aria-label={t('solidAnalysis.bucklingResults')} data-testid="solid-buckling-results">
        <h5>{t('solidAnalysis.bucklingResults')}</h5>
        <table>
          <thead><tr>
            <th scope="col">{t('solidAnalysis.bucklingMode')}</th>
            <th scope="col">{t('solidAnalysis.bucklingFactor')}</th>
            <th scope="col">{t('solidAnalysis.bucklingResidual')}</th>
          </tr></thead>
          <tbody>{display.factors.map(factor => <tr key={factor.number} data-testid={`solid-buckling-factor-${String(factor.number)}`}>
            <td>{String(factor.number)}</td><td>{String(factor.loadFactor)}</td><td>{String(factor.normalizedResidual)}</td>
          </tr>)}</tbody>
        </table>
        <dl>
          <dt>{t('solidAnalysis.area')}</dt><dd>{`${String(display.loadedAreaMm2)} mm²`}</dd>
          <dt>{t('solidAnalysis.force')}</dt><dd>{`${display.totalForceN.join(', ')} N`}</dd>
          <dt>{t('solidAnalysis.bucklingFreeDofs')}</dt><dd>{String(display.freeDofs)}</dd>
          <dt>{t('solidAnalysis.bucklingReferenceResidual')}</dt><dd>{String(display.referenceEquilibriumResidual)}</dd>
          <dt>{t('solidAnalysis.bucklingKgError')}</dt><dd>{String(display.maximumElementInitialStressError)}</dd>
        </dl>
        <fieldset data-testid="solid-buckling-view">
          <legend>{t('solidAnalysis.bucklingShapeView')}</legend>
          <p>{t('solidAnalysis.bucklingShapeMeaning')}</p>
          <label><input type="checkbox" title={t('solidAnalysis.guide.bucklingShow')} data-testid="solid-buckling-show" checked={buckling.showShape}
            onChange={event => { setView(buckling.view, buckling.amplitudeText, event.currentTarget.checked); }} />
            {t('solidAnalysis.bucklingShapeShow')}</label>
          <label>{t('solidAnalysis.bucklingShapeMode')}
            <select data-testid="solid-buckling-mode" value={String(buckling.view.modeNumber)}
              onChange={event => { setView({ ...buckling.view, modeNumber: Number(event.currentTarget.value) }, buckling.amplitudeText,
                buckling.showShape); }} title={t('solidAnalysis.guide.bucklingMode')}>
              {display.factors.map(factor => <option key={factor.number} value={String(factor.number)}>{String(factor.number)}</option>)}
            </select></label>
          <label>{t('solidAnalysis.modalAmplitude')}
            <input type="number" min="0" step="any" inputMode="decimal" data-testid="solid-buckling-amplitude"
              value={buckling.amplitudeText} aria-invalid={!amplitudeValid}
              onChange={event => {
                const text = event.currentTarget.value;
                setView(validAmplitude(text) ? { ...buckling.view, amplitudeMm: Number(text) } : buckling.view, text, buckling.showShape);
              }} title={t('solidAnalysis.guide.modeAmplitude')} /></label>
          {amplitudeValid ? null : <p role="alert">{t('solidAnalysis.modalAmplitudeInvalid')}</p>}
          <fieldset>
            <legend>{t('solidAnalysis.modalPhase')}</legend>
            {([1, -1] as const).map(phase => <label key={phase}>
              <input type="radio" name="solid-buckling-phase" data-testid={`solid-buckling-phase-${phase === 1 ? 'positive' : 'negative'}`}
                checked={buckling.view.phase === phase}
                onChange={() => { setView({ ...buckling.view, phase }, buckling.amplitudeText, buckling.showShape); }} title={t(phase === 1 ? 'solidAnalysis.guide.phasePositive' : 'solidAnalysis.guide.phaseNegative')} />
              {t(phase === 1 ? 'solidAnalysis.modalPhasePositive' : 'solidAnalysis.modalPhaseNegative')}</label>)}
          </fieldset>
          {buckling.showShape && (preview === null || preview.kind !== 'preview')
            ? <p role="alert" data-testid="solid-buckling-shape-unavailable">{t('solidAnalysis.bucklingShapeUnavailable')}</p> : null}
        </fieldset>
      </section>}
    <p data-testid="solid-buckling-limit">{t('solidAnalysis.bucklingLimit')}</p>
  </section>;
}
