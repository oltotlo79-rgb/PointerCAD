import type { FemPhase } from '@pointercad/fem';
import { useEffect, useRef } from 'react';
import { isCompositionKey } from '../commands/compositionKey.js';
import { t, type MessageKey } from '../i18n/t.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { useAppStore } from '../store/useAppStore.js';
import { beamDisplayNumber } from '../beam/BeamResults.js';
import { plasticBarExpressionField, type PlasticBarFieldName } from '../beam/beamFields.js';
import { PLASTIC_BAR_DRAFT_MAXIMUM_KNOTS, plasticBarDraftIsSaved, plasticBarResultIsCurrent, savedPlasticBarInput,
  type PlasticBarScalarField, type PlasticBarSession, type PlasticBarStatus } from './plasticBarSession.js';
import '../beam/beam.css';

const phaseLabel: Readonly<Record<FemPhase, MessageKey>> = {
  'loading-assets': 'beam.phase.assets', 'loading-runtime': 'beam.phase.runtime',
  'loading-packages': 'beam.phase.packages', solving: 'beam.phase.solving',
};
const statusLabel: Readonly<Record<PlasticBarStatus, MessageKey>> = {
  editing: 'plasticBar.status.editing', running: 'plasticBar.status.running', complete: 'plasticBar.status.complete',
  failed: 'plasticBar.status.failed', cancelled: 'plasticBar.status.cancelled',
};

/** Dedicated elasto-plastic bar panel. Values use the shared expression field (keyboard, IME and parameter rules);
 * every edit discards the previous result. Inputs are saved in the document only with the save button. */
export function PlasticBarPanel({ session }: { readonly session: PlasticBarSession }): React.JSX.Element {
  const parameters = useAppStore(state => state.assembly?.parameters ?? state.document.parameters);
  const saved = useAppStore(state => savedPlasticBarInput(state.assembly ?? state.document));
  const save = useAppStore(state => state.savePlasticBar);
  const edit = useAppStore(state => state.editPlasticBar);
  const run = useAppStore(state => state.runPlasticBar);
  const cancel = useAppStore(state => state.cancelPlasticBar);
  const close = useAppStore(state => state.closePlasticBar);
  const runner = useAppStore(state => state.plasticBarRunner);
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => () => {
    const current = useAppStore.getState();
    if (current.plasticBarSession?.ownerId === session.ownerId && current.plasticBarSession.status === 'running') {
      current.cancelPlasticBar();
    }
  }, [session.ownerId]);
  const running = session.status === 'running';
  const field = (name: PlasticBarFieldName, key: string, source: string, change: (source: string) => void): React.JSX.Element =>
    <div key={key} data-plastic-bar-field={key}>
      <ExpressionField {...plasticBarExpressionField(name, key, source, parameters)} lengthUnit="mm"
        focused={session.focusedField === key} onFocus={() => edit({ kind: 'focus', field: key })} onChange={change} />
    </div>;
  const scalar = (name: PlasticBarScalarField): React.JSX.Element =>
    field(name, name, session.draft.values[name], source => edit({ kind: 'value', field: name, source }));
  const result = plasticBarResultIsCurrent(session) ? session.result : null;
  return <form className="pcad-panel__body pcad-beam" aria-label={t('plasticBar.title')} data-testid="plastic-bar-panel"
    onSubmit={event => { event.preventDefault(); }}
    onKeyDown={event => {
      if (isCompositionKey(event.nativeEvent)) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
    <h3 className="pcad-section__title">{t('plasticBar.title')}</h3>
    <p data-testid="plastic-bar-scope">{t('plasticBar.scope')}</p>
    <p>{t('plasticBar.notCertified')}</p>
    <fieldset>
      <legend>{t('plasticBar.material')}</legend>
      <p>{t('plasticBar.materialHelp')}</p>
      <div className="pcad-beam__numbers">
        {scalar('young')}{scalar('poisson')}{scalar('yieldStress')}{scalar('hardening')}
      </div>
      <label>{t('plasticBar.source')}
        <input type="text" data-testid="plastic-bar-source" maxLength={500} value={session.draft.reference}
          aria-describedby="plastic-bar-source-help"
          onFocus={() => edit({ kind: 'focus', field: 'reference' })}
          onChange={event => edit({ kind: 'reference', source: event.target.value })} title={t('plasticBar.guide.source')} /></label>
      <p id="plastic-bar-source-help">{t('plasticBar.sourceHelp')}</p>
    </fieldset>
    <fieldset>
      <legend>{t('plasticBar.member')}</legend>
      <div className="pcad-beam__numbers">{scalar('length')}{scalar('area')}</div>
    </fieldset>
    <fieldset data-testid="plastic-bar-loading">
      <legend>{t('plasticBar.loading')}</legend>
      <p>{t('plasticBar.loadingHelp')}</p>
      <p>{t('plasticBar.firstKnot')}</p>
      <table>
        <tbody>{session.draft.knots.map((knot, index) => <tr key={index} data-plastic-bar-knot={index}>
          <th scope="row">{`${t('plasticBar.knotRow')} ${index + 2}`}</th>
          <td>{field('knot', `knot:${index}`, knot, source => edit({ kind: 'knot', index, source }))}</td>
          <td><button type="button" className="pcad-button" data-plastic-bar-remove={index}
            disabled={session.draft.knots.length <= 1}
            onClick={() => { edit({ kind: 'knot-remove', index }); addButton.current?.focus(); }} title={t('plasticBar.guide.removeKnot')}>
            {t('plasticBar.removeKnot')}</button></td>
        </tr>)}</tbody>
      </table>
      <button ref={addButton} type="button" className="pcad-button" data-testid="plastic-bar-add-knot"
        disabled={session.draft.knots.length >= PLASTIC_BAR_DRAFT_MAXIMUM_KNOTS}
        onClick={() => edit({ kind: 'knot-add' })} title={t('plasticBar.guide.addKnot')}>{t('plasticBar.addKnot')}</button>
      <div className="pcad-beam__numbers">{scalar('stepsPerSegment')}</div>
    </fieldset>
    <div className="pcad-beam__actions">
      <button type="button" className="pcad-button pcad-button--primary" data-testid="plastic-bar-run"
        disabled={running || runner === null} onClick={run} title={t('plasticBar.guide.run')}>{t('plasticBar.run')}</button>
      <button type="button" className="pcad-button" data-testid="plastic-bar-cancel" disabled={!running}
        onClick={cancel} title={t('plasticBar.guide.cancel')}>{t('plasticBar.cancel')}</button>
      <button type="button" className="pcad-button" data-testid="plastic-bar-save" disabled={running}
        title={t('plasticBar.saveHelp')} onClick={save}>{t('plasticBar.save')}</button>
      <button type="button" className="pcad-button" data-testid="plastic-bar-close" onClick={close} title={t('plasticBar.guide.close')}>{t('plasticBar.close')}</button>
    </div>
    <p data-testid="plastic-bar-saved" data-saved={String(plasticBarDraftIsSaved(session, parameters, saved))}>
      {t(plasticBarDraftIsSaved(session, parameters, saved) ? 'plasticBar.saved'
        : saved === null ? 'plasticBar.notSaved' : 'plasticBar.changedSinceSave')}</p>
    <p role="status" data-testid="plastic-bar-status" data-status={session.status} data-phase={session.phase ?? ''}>
      {running ? t(session.phase === null ? 'plasticBar.status.running' : phaseLabel[session.phase])
        : t(statusLabel[result === null && session.status === 'complete' ? 'editing' : session.status])}
    </p>
    {session.errorKey === null ? null : <p role="alert">{t(session.errorKey)}</p>}
    {session.diagnostic === null ? null : <details><summary>{t('plasticBar.details')}</summary><p>{session.diagnostic}</p></details>}
    {result === null ? null : <section data-testid="plastic-bar-results">
      <h4>{t('plasticBar.results')}</h4>
      <p>{t('plasticBar.resultScope')}</p>
      <p data-testid="plastic-bar-yielded" data-yielded={String(result.yielded)}>
        {t(result.yielded ? 'plasticBar.yielded' : 'plasticBar.notYielded')}</p>
      <p>{t('plasticBar.equilibrium')}: {beamDisplayNumber(result.maximumEquilibriumMismatch)}</p>
      <p>{t('plasticBar.referenceDeviation')}: {beamDisplayNumber(result.referenceDeviation.stress)}</p>
      <table data-testid="plastic-bar-samples">
        <thead><tr><th>{t('plasticBar.step')}</th><th>{t('plasticBar.target')}</th><th>{t('plasticBar.stress')}</th>
          <th>{t('plasticBar.plasticStrain')}</th><th>{t('plasticBar.force')}</th></tr></thead>
        <tbody>{result.samples.map(sample => <tr key={sample.step} data-plastic-bar-step={sample.step}>
          <td>{sample.step}</td><td>{beamDisplayNumber(sample.targetDisplacementM * 1000)}</td>
          <td>{beamDisplayNumber(sample.stressPa / 1_000_000)}</td><td>{beamDisplayNumber(sample.plasticStrain)}</td>
          <td>{beamDisplayNumber(sample.axialForceN)}</td>
        </tr>)}</tbody>
      </table>
    </section>}
  </form>;
}
