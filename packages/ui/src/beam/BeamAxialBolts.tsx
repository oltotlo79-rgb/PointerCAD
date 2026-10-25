import { partKeyOf } from '@pointercad/model';
import type { CadAxialBolt } from '@pointercad/model/beam-analysis';
import type { BeamBoltContactResult } from '@pointercad/fem';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { beamDisplayNumber } from './BeamResults.js';
import type { BeamSession } from './beamSession.js';

/** Explicit top-level ownership only. A hole, grade name or rigid mate never creates a physical tie. */
export function BeamAxialBoltDefinitions({ session }: { readonly session: BeamSession }): React.JSX.Element {
  const state = useAppStore();
  const components = state.assembly?.components.filter(component => !component.suppressed
    && component.source.kind === 'standardPart' && component.source.catalog === 'hexBolt') ?? [];
  const edit = (bolts: readonly CadAxialBolt[]): void => state.editBeam({ kind: 'axial-bolts', bolts });
  const update = (id: string, change: (bolt: CadAxialBolt) => CadAxialBolt): void =>
    edit(session.axialBolts.map(bolt => bolt.id === id ? change(bolt) : bolt));
  const ends = session.members.flatMap(member => [member.startNodeId, member.endNodeId]
    .map(nodeId => ({ memberId: member.id, nodeId, label: `${member.occurrence.label} / ${nodeId}` })));
  return <fieldset data-testid="beam-axial-bolt-definitions">
    <legend>{t('beam.axialBolts')}</legend><p>{t(session.initialStrain === null ? 'beam.axialBoltScope' : 'beam.initialStrainAxialScope')}</p>
    {session.axialBolts.map(bolt => <fieldset key={bolt.id} data-axial-bolt={bolt.id}>
      <legend>{bolt.id}</legend>
      <label>{t('beam.axialBoltOccurrence')}<select value={bolt.boltComponentId} onChange={event => {
        const component = components.find(row => row.id === event.target.value);
        if (component !== undefined) update(bolt.id, row => ({ ...row, boltComponentId: component.id,
          expectedPartKey: partKeyOf(component.source), expectedMaterialId: component.materialId ?? null }));
      }} title={t('beam.guide.axialBoltOccurrence')}><option value="" />{components.map(component => <option key={component.id} value={component.id}>{component.name}</option>)}</select></label>
      {(['first', 'second'] as const).map(end => <label key={end}>{t(end === 'first' ? 'beam.axialBoltFirst' : 'beam.axialBoltSecond')}
        <select value={ends.findIndex(row => row.memberId === bolt[end].memberId && row.nodeId === bolt[end].nodeId)}
          onChange={event => {
            const selected = ends[Number(event.target.value)];
            if (selected !== undefined) update(bolt.id, row => ({ ...row, [end]: { memberId: selected.memberId, nodeId: selected.nodeId } }));
          }} title={t('beam.guide.axialBoltEnd')}><option value={-1} />{ends.map((row, index) => <option key={`${row.memberId}:${row.nodeId}`} value={index}>{row.label}</option>)}</select>
      </label>)}
      {(['youngMPa', 'effectiveAreaMm2'] as const).map(field => <label key={field}>
        {t(field === 'youngMPa' ? 'beam.axialBoltYoung' : 'beam.axialBoltArea')}
        <input type="number" step="any" value={Number.isFinite(bolt[field]) ? bolt[field] : ''}
          onChange={event => update(bolt.id, row => ({ ...row, [field]: event.target.value === '' ? NaN : Number(event.target.value) }))} title={t(field === 'youngMPa' ? 'beam.guide.axialBoltYoung' : 'beam.guide.axialBoltArea')} />
      </label>)}
      {(['reference', 'condition'] as const).map(field => <label key={field}>
        {t(field === 'reference' ? 'beam.axialBoltReference' : 'beam.axialBoltCondition')}
        <input value={bolt.propertySource[field]} onChange={event => update(bolt.id, row => ({ ...row,
          propertySource: { ...row.propertySource, [field]: event.target.value } }))} title={t(field === 'reference' ? 'beam.guide.sourceReference' : 'beam.guide.sourceCondition')} />
      </label>)}
      <button type="button" onClick={() => edit(session.axialBolts.filter(row => row.id !== bolt.id))} title={t('beam.guide.axialBoltRemove')}>{t('beam.axialBoltRemove')}</button>
    </fieldset>)}
    <button type="button" disabled={session.axialBolts.length >= 64} onClick={() => edit([...session.axialBolts, {
      id: crypto.randomUUID(), boltComponentId: '', expectedPartKey: '', expectedMaterialId: null,
      first: { memberId: '', nodeId: '' }, second: { memberId: '', nodeId: '' }, youngMPa: NaN, effectiveAreaMm2: NaN,
      propertySource: { kind: 'user-supplied', reference: '', condition: '' }, idealization: 'bilateral-uniform-axial-elastic',
    }])} title={t('beam.guide.axialBoltAdd')}>{t('beam.axialBoltAdd')}</button>
  </fieldset>;
}

/** All rows are the coupled response. Signed force is retained; neither compression nor opening is hidden. */
export function BeamAxialBoltResults({ result, view }: {
  readonly result: BeamBoltContactResult; readonly view: BeamSession['contactView'];
}): React.JSX.Element {
  const edit = useAppStore(state => state.editBeam);
  const index = Math.min(Math.max(0, view.state), result.states.length - 1);
  const selected = result.states[index], contact = result.contact.states[index];
  return <section data-testid="beam-axial-bolt-results">
    <h4>{t('beam.axialBolts')}</h4><p>{t('beam.axialBoltScope')}</p>
    <label>{t('beam.contactState')}<select value={index} onChange={event => edit({ kind: 'contact-view', state: Number(event.target.value) })} title={t('beam.guide.contactState')}>
      {result.states.map((row, at) => <option key={at} value={at}>{beamDisplayNumber(row.loadFactor)}</option>)}
    </select></label>
    <table><thead><tr><th>{t('beam.contactId')}</th><th>{t('beam.axialBoltForce')}</th><th>{t('beam.axialBoltExtension')}</th></tr></thead>
      <tbody>{selected.bolts.map(bolt => <tr key={bolt.id}><th>{bolt.id}</th>
        <td data-unit="N" data-value={bolt.axialForceN}>{beamDisplayNumber(bolt.axialForceN)}</td>
        <td data-unit="m" data-value={bolt.extensionM}>{beamDisplayNumber(bolt.extensionM * 1000)}</td></tr>)}</tbody></table>
    <table><thead><tr><th>{t('beam.contactId')}</th><th>{t('beam.contactForce')}</th><th>{t('beam.contactGapResult')}</th></tr></thead>
      <tbody>{contact.contacts.map(row => <tr key={row.id} data-state={row.state}><th>{row.id}</th>
        <td data-value={row.normalReactionN}>{beamDisplayNumber(row.normalReactionN)}</td>
        <td data-value={row.gapM}>{beamDisplayNumber(row.gapM * 1000)}</td></tr>)}</tbody></table>
    <table><thead><tr><th>{t('beam.solverNode')}</th><th>{t('beam.transientQuantity')}</th><th>X</th><th>Y</th><th>Z</th></tr></thead>
      <tbody>{contact.nodes.flatMap(node => [
        <tr key={`${node.number}-u`}><th>{node.number}</th><td>{t('beam.displacement')}</td>
          {node.displacementM.map((value, axis) => <td key={axis} data-unit="m" data-value={value}>{beamDisplayNumber(value * 1000)}</td>)}</tr>,
        <tr key={`${node.number}-r`}><th>{node.number}</th><td>{t('beam.rotation')}</td>
          {node.rotationRad.map((value, axis) => <td key={axis} data-unit="rad" data-value={value}>{beamDisplayNumber(value)}</td>)}</tr>,
      ])}</tbody></table>
    <p>{t('beam.contactChecks')}: {[contact.equilibriumResidual, contact.penetration, contact.tension, contact.complementarity]
      .map(beamDisplayNumber).join(' / ')}</p>
  </section>;
}
