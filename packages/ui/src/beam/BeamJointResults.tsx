import type { BeamJointContactResult } from '@pointercad/fem';
import { t } from '../i18n/t.js';
import { beamDisplayNumber } from './BeamResults.js';
import { BeamWeldLayerResults } from './BeamWeldLayers.js';
import type { BeamSession } from './beamSession.js';

/** One selected coupled state supplies both connector families and the shared contact/node response. */
export function BeamJointResults({ result, view }: {
  readonly result: BeamJointContactResult; readonly view: BeamSession['contactView'];
}): React.JSX.Element {
  const index = Math.min(Math.max(0, view.state), result.states.length - 1);
  return <section data-testid="beam-joint-results"><h4>{t('beam.jointResults')}</h4><p>{t('beam.jointScope')}</p>
    <table data-testid="beam-joint-bolt-results"><thead><tr><th>{t('beam.axialBolts')}</th>
      <th>{t('beam.axialBoltForce')}</th><th>{t('beam.axialBoltExtension')}</th></tr></thead>
      <tbody>{result.states[index].bolts.map(bolt => <tr key={bolt.id}><th>{bolt.id}</th>
        <td data-unit="N" data-value={bolt.axialForceN}>{beamDisplayNumber(bolt.axialForceN)}</td>
        <td data-unit="m" data-value={bolt.extensionM}>{beamDisplayNumber(bolt.extensionM * 1000)}</td></tr>)}</tbody></table>
    <BeamWeldLayerResults result={result} view={view} />
  </section>;
}
