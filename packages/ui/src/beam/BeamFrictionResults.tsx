import type { FrictionContactResult } from '@pointercad/fem';
import { t, type MessageKey } from '../i18n/t.js';
import { beamDisplayNumber } from './BeamResults.js';

/** Display-only history of the accepted result. SI data are retained; length is converted to mm once. */
export function BeamFrictionResults({ result }: { readonly result: FrictionContactResult }): React.JSX.Element {
  const vector = (values: readonly number[], unit: 'N' | 'm'): React.JSX.Element[] => values.map((value, axis) =>
    <td key={axis} data-component={axis} data-unit={unit} data-value={value}>
      {beamDisplayNumber(unit === 'm' ? value * 1000 : value)}</td>);
  const status: Readonly<Record<'open' | 'closed' | 'stick' | 'slip', MessageKey>> = {
    open: 'beam.contactOpen', closed: 'beam.contactClosed', stick: 'beam.frictionStick', slip: 'beam.frictionSlip',
  };
  return <section className="pcad-beam__results" data-testid="beam-friction-results" aria-label={t('beam.frictionResults')}>
    <h4>{t('beam.frictionResults')}</h4>
    <p>{t('beam.frictionScope')}</p>
    {result.states.map(state => <details key={state.step} open data-friction-step={state.step}>
      <summary>{`${t('beam.frictionStep')} ${state.step + 1}`}</summary>
      {state.contacts.map(contact => <table key={contact.id} data-friction-contact={contact.id}>
        <caption>{contact.id}: <span data-friction-state={contact.state}>{t(status[contact.state])}</span></caption>
        <thead><tr><th>{t('beam.transientQuantity')}</th><th>X</th><th>Y</th><th>Z</th></tr></thead>
        <tbody>
          <tr data-quantity="normalReaction"><th>{t('beam.contactForce')}</th>
            <td colSpan={3} data-unit="N" data-value={contact.normalReactionN}>{beamDisplayNumber(contact.normalReactionN)}</td></tr>
          <tr data-quantity="frictionForce"><th>{t('beam.frictionForce')}</th>{vector(contact.frictionForceN, 'N')}</tr>
          <tr data-quantity="gap"><th>{t('beam.contactGapResult')}</th>
            <td colSpan={3} data-unit="m" data-value={contact.gapM}>{beamDisplayNumber(contact.gapM * 1000)}</td></tr>
          <tr data-quantity="slipIncrement"><th>{t('beam.frictionSlipIncrement')}</th>{vector(contact.slipIncrementM, 'm')}</tr>
          <tr data-quantity="accumulatedSlip"><th>{t('beam.frictionAccumulatedSlip')}</th>{vector(contact.accumulatedSlipM, 'm')}</tr>
          <tr data-quantity="slipPathLength"><th>{t('beam.frictionSlipPath')}</th>
            <td colSpan={3} data-unit="m" data-value={contact.slipPathLengthM}>{beamDisplayNumber(contact.slipPathLengthM * 1000)}</td></tr>
          <tr data-quantity="dissipatedWork"><th>{t('beam.frictionWork')}</th>
            <td colSpan={3} data-unit="J" data-value={contact.dissipatedWorkJ}>{beamDisplayNumber(contact.dissipatedWorkJ)}</td></tr>
        </tbody>
      </table>)}
      <table data-testid="beam-friction-nodes">
        <caption>{t('beam.displacement')}</caption>
        <thead><tr><th>{t('beam.node')}</th><th>X (mm)</th><th>Y (mm)</th><th>Z (mm)</th></tr></thead>
        <tbody>{state.nodes.map((node, index) => <tr key={node.number} data-friction-node={result.nodeIds[index]}>
          <th>{result.nodeIds[index]}</th>{vector(node.displacementM, 'm')}
        </tr>)}</tbody>
      </table>
    </details>)}
  </section>;
}
