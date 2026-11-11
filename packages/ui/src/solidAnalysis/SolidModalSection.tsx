import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { SolidModePanel } from './SolidModePanel.js';
import { solidModalPreview, solidModalRequestValues } from './solidModalState.js';

/**
 * Modal part of the solid analysis panel (successor of continuation-r1 e6dca954): the physical modal inputs (density,
 * number of modes), run/cancel/save through the existing runner, and the display-only result section. Normally the
 * restrained faces, body, material and meshing tolerances are the static panel's fields. When an independently saved
 * modal input has different shared values, they are shown here and used for the modal run until the user explicitly
 * adopts the panel's values. Selectors return store values or primitives only.
 */
export function SolidModalSection(): React.JSX.Element {
  const runner = useAppStore(state => state.solidAnalysisRunner);
  const modal = useAppStore(state => state.solidModal);
  const shared = useAppStore(state => state.solidModalShared);
  const edit = useAppStore(state => state.editSolidModalInput);
  const cancel = useAppStore(state => state.cancelSolidModal);
  const setView = useAppStore(state => state.setSolidModalView);
  const save = useAppStore(state => state.saveSolidModal);
  const adopt = useAppStore(state => state.adoptPanelForSolidModal);
  const fixedCount = useAppStore(state => state.solidAnalysisSession?.fixedFaces.length ?? 0);
  const documentId = useAppStore(state => state.document.id);
  const generation = useAppStore(state => state.completedGeneration);
  const valid = solidModalRequestValues(modal) !== null;
  // Same identity rule as the viewport (solidModalViewport.ts solidModalCurrentSource).
  const preview = modal.display === null ? null
    : solidModalPreview(modal, { documentId, revision: generation, meshKey: modal.display.source.meshKey });
  // SolidModePanel reports the amplitude text first, then the display; each callback reads the latest other half.
  return <section aria-label={t('solidAnalysis.modalSection')} data-testid="solid-modal-section">
    <h4>{t('solidAnalysis.modalSection')}</h4>
    {shared === null
      ? <p>{`${t('solidAnalysis.modalSupportHelp')} (${t('solidAnalysis.fixed')}: ${String(fixedCount)})`}</p>
      : <div role="note" data-testid="solid-modal-own-inputs">
        <p>{t('solidAnalysis.modalOwnInputs')}</p>
        <dl>
          <dt>{t('solidAnalysis.body')}</dt><dd>{shared.bodyFeatureId}</dd>
          <dt>{t('solidAnalysis.fixed')}</dt><dd>{String(shared.fixedFaces.length)}</dd>
          <dt>{t('solidAnalysis.young')}</dt><dd>{String(shared.youngMPa)}</dd>
          <dt>{t('solidAnalysis.poisson')}</dt><dd>{String(shared.poisson)}</dd>
        </dl>
        <button type="button" className="pcad-button" data-testid="solid-modal-adopt" onClick={adopt} title={t('solidAnalysis.guide.modalAdopt')}>{t('solidAnalysis.modalAdoptPanel')}</button>
      </div>}
    <label>{t('solidAnalysis.modalDensity')}
      <input type="text" inputMode="decimal" data-testid="solid-modal-density" value={modal.densityText} aria-invalid={!valid}
        onChange={event => { edit('density', event.currentTarget.value); }} title={t('solidAnalysis.guide.modalDensity')} /></label>
    <label>{t('solidAnalysis.modalCount')}
      <input type="text" inputMode="numeric" data-testid="solid-modal-count" value={modal.modeCountText} aria-invalid={!valid}
        onChange={event => { edit('modeCount', event.currentTarget.value); }} title={t('solidAnalysis.guide.modalCount')} /></label>
    {valid ? null : <p role="alert">{t('solidAnalysis.modalInputInvalid')}</p>}
    {modal.status === 'running' ? <p role="status">{t('solidAnalysis.modalRunning')}</p> : null}
    {modal.error !== null ? <p role="alert" data-testid="solid-modal-error">{modal.error}</p> : null}
    <button type="button" className="pcad-button pcad-button--primary" data-testid="solid-modal-run"
      disabled={runner?.runModal === undefined || !valid || modal.status === 'running'} onClick={() => { runner?.runModal?.(); }} title={t('solidAnalysis.guide.modalRun')}>
      {t('solidAnalysis.modalRun')}</button>
    <button type="button" className="pcad-button" data-testid="solid-modal-cancel" disabled={modal.status !== 'running'}
      onClick={cancel} title={t('solidAnalysis.guide.modalCancel')}>{t('solidAnalysis.modalCancel')}</button>
    <button type="button" className="pcad-button" data-testid="solid-modal-save" onClick={save} title={t('solidAnalysis.guide.modalSave')}>{t('solidAnalysis.modalSave')}</button>
    <SolidModePanel result={modal.status === 'result' ? modal.display : null} failed={modal.status === 'failed'}
      display={modal.view} amplitudeText={modal.amplitudeText} preview={preview}
      onAmplitudeTextChange={text => { setView(useAppStore.getState().solidModal.view, text); }}
      onDisplayChange={view => { setView(view, useAppStore.getState().solidModal.amplitudeText); }} />
  </section>;
}
