import type { BeamContactAnalysisResult } from '@pointercad/fem';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { beamDisplayNumber } from './BeamResults.js';
import type { BeamSession } from './beamSession.js';

/** The solver reports metres; inputs and this view use mm like the other beam results. data-value keeps the SI value. */
const millimetres = (metres: number): string => beamDisplayNumber(metres * 1000);

/** Plain-language view of one validated contact result. The chosen load state lives in the session (store), not here. */
export function BeamContactResults({ result, view }: {
  readonly result: BeamContactAnalysisResult; readonly view: BeamSession['contactView'];
}): React.JSX.Element {
  const edit = useAppStore(state => state.editBeam);
  const index = Math.min(Math.max(0, view.state), result.states.length - 1);
  const state = result.states[index];
  return <section className="pcad-beam__results" data-testid="beam-contact-results" aria-label={t('beam.contactResults')}>
    <h4>{t('beam.contactResults')}</h4>
    <p>{t('beam.contactResultScope')}</p>
    <p>{t('beam.contactMethod')}</p>
    <label>{t('beam.contactState')}<select data-testid="beam-contact-state" value={index}
      onChange={event => edit({ kind: 'contact-view', state: Number(event.target.value) })} title={t('beam.guide.contactState')}>
      {result.states.map((row, position) => <option key={position} value={position}>
        {`${t('beam.contactLoadFactor')} ${beamDisplayNumber(row.loadFactor)}`}</option>)}
    </select></label>
    <p data-testid="beam-contact-load-factor" data-value={state.loadFactor}>
      {t('beam.contactLoadFactorAt')}: {beamDisplayNumber(state.loadFactor)}</p>
    <table data-testid="beam-contact-table">
      <thead><tr><th>{t('beam.contactId')}</th><th>{t('beam.contactStatus')}</th>
        <th>{t('beam.contactForce')}</th><th>{t('beam.contactGapResult')}</th></tr></thead>
      <tbody>{state.contacts.map(contact => <tr key={contact.id} data-beam-contact-result={contact.id} data-state={contact.state}>
        <th>{contact.id}</th>
        <td>{t(contact.state === 'closed' ? 'beam.contactClosed' : 'beam.contactOpen')}</td>
        <td data-quantity="force" data-unit="N" data-value={contact.normalReactionN}>{beamDisplayNumber(contact.normalReactionN)}</td>
        <td data-quantity="gap" data-unit="m" data-value={contact.gapM}>{millimetres(contact.gapM)}</td>
      </tr>)}</tbody>
    </table>
    <table data-testid="beam-contact-nodes">
      <thead><tr><th>{t('beam.node')}</th><th>{t('beam.transientQuantity')}</th><th>X</th><th>Y</th><th>Z</th></tr></thead>
      <tbody>{state.nodes.flatMap((node, position) => [
        <tr key={`${node.number}-displacement`} data-beam-contact-node-result={result.nodeIds[position]} data-quantity="displacement">
          <th>{result.nodeIds[position]}</th><td>{t('beam.displacement')}</td>
          {node.displacementM.map((value, axis) => <td key={axis} data-component={axis} data-unit="m" data-value={value}>
            {millimetres(value)}</td>)}
        </tr>,
        <tr key={`${node.number}-rotation`} data-beam-contact-node-result={result.nodeIds[position]} data-quantity="rotation">
          <th>{result.nodeIds[position]}</th><td>{t('beam.rotation')}</td>
          {node.rotationRad.map((value, axis) => <td key={axis} data-component={axis} data-unit="rad" data-value={value}>
            {beamDisplayNumber(value)}</td>)}
        </tr>,
      ])}</tbody>
    </table>
    <dl>
      <dt>{t('beam.contactChecks')}</dt>
      <dd data-testid="beam-contact-checks">{[state.equilibriumResidual, state.penetration, state.tension, state.complementarity]
        .map(value => beamDisplayNumber(value)).join(' / ')}</dd>
      <dt>{t('beam.contactPivots')}</dt><dd>{state.pivots}</dd>
      <dt>{t('beam.meshSize')}</dt><dd>{result.meshNodes} / {result.meshElements}</dd>
    </dl>
  </section>;
}
