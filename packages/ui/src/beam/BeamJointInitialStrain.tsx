import type { CadJointInitialStrain, CadShankShortening } from '@pointercad/model/beam-analysis';
import type { BeamJointInitialStrainResult } from '@pointercad/fem';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { beamDisplayNumber } from './BeamResults.js';
import { BeamWeldLayerResults } from './BeamWeldLayers.js';
import type { BeamSession } from './beamSession.js';

export function BeamJointInitialStrainDefinitions({ session }: { readonly session: BeamSession }): React.JSX.Element {
  const edit = useAppStore(state => state.editBeam), value = session.initialStrain;
  const change = (value: CadJointInitialStrain | null): void => edit({ kind: 'initial-strain', value });
  const update = (boltId: string, patch: (row: CadShankShortening) => CadShankShortening): void => {
    if (value !== null) change({ ...value, shortenings: value.shortenings.map(row => row.boltId === boltId ? patch(row) : row) });
  };
  return <fieldset data-testid="beam-initial-strain-definitions"><legend>{t('beam.initialStrain')}</legend>
    <p>{t('beam.initialStrainScope')}</p>
    <label><input type="checkbox" data-testid="beam-initial-strain-enabled" checked={value !== null}
      disabled={value === null && (session.axialBolts.length === 0 || session.weldLayers.length === 0)}
      onChange={event => change(event.target.checked ? { schema: 'pointercad-cad-joint-initial-strain/1',
        shortenings: session.axialBolts.map(bolt => ({ boltId: bolt.id, shorteningMm: NaN,
          source: { kind: 'user-supplied', reference: '', condition: '' } })) } : null)} title={t('beam.guide.initialStrainEnable')} />{t('beam.initialStrainEnable')}</label>
    {value?.shortenings.map(row => <fieldset key={row.boltId} data-initial-strain-bolt={row.boltId}>
      <legend>{row.boltId}</legend>
      <label>{t('beam.initialStrainShortening')}<input type="number" step="any"
        value={Number.isFinite(row.shorteningMm) ? row.shorteningMm : ''}
        onChange={event => update(row.boltId, current => ({ ...current,
          shorteningMm: event.target.value === '' ? NaN : Number(event.target.value) }))} title={t('beam.guide.initialStrainShortening')} /></label>
      {(['reference', 'condition'] as const).map(field => <label key={field}>
        {t(field === 'reference' ? 'beam.reference' : 'beam.condition')}
        <input value={row.source[field]} onChange={event => update(row.boltId, current => ({ ...current,
          source: { ...current.source, [field]: event.target.value } }))} title={t(field === 'reference' ? 'beam.guide.sourceReference' : 'beam.guide.sourceCondition')} />
      </label>)}
    </fieldset>)}
  </fieldset>;
}

/** The geometric extension and elastic extension differ by the prescribed stress-free shortening. */
export function BeamJointInitialStrainResults({ result, view }: {
  readonly result: BeamJointInitialStrainResult; readonly view: BeamSession['contactView'];
}): React.JSX.Element {
  const index = Math.min(Math.max(0, view.state), result.states.length-1);
  return <section data-testid="beam-initial-strain-results"><h4>{t('beam.initialStrainResults')}</h4><p>{t('beam.initialStrainScope')}</p>
    <table data-testid="beam-initial-strain-bolt-results"><thead><tr><th>{t('beam.axialBolts')}</th>
      <th>{t('beam.axialBoltForce')}</th><th>{t('beam.axialBoltExtension')}</th>
      <th>{t('beam.initialStrainElasticExtension')}</th><th>{t('beam.initialStrainEnergy')}</th></tr></thead>
      <tbody>{result.states[index].bolts.map(bolt => <tr key={bolt.id}><th>{bolt.id}</th>
        <td data-unit="N" data-value={bolt.axialForceN}>{beamDisplayNumber(bolt.axialForceN)}</td>
        <td data-quantity="extension" data-unit="m" data-value={bolt.extensionM}>{beamDisplayNumber(bolt.extensionM*1000)}</td>
        <td data-quantity="elastic-extension" data-unit="m" data-value={bolt.elasticExtensionM}>{beamDisplayNumber(bolt.elasticExtensionM*1000)}</td>
        <td data-unit="J" data-value={bolt.elasticEnergyJ}>{beamDisplayNumber(bolt.elasticEnergyJ)}</td></tr>)}</tbody></table>
    <BeamWeldLayerResults result={result} view={view} />
  </section>;
}
