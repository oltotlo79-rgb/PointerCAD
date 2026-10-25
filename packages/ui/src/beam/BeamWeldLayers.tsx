import type { CadWeldLayer } from '@pointercad/model/beam-analysis';
import type { BeamWeldContactResult } from '@pointercad/fem';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { beamDisplayNumber } from './BeamResults.js';
import type { BeamSession } from './beamSession.js';
import { selectWeldGroup, updateWeldGroup, weldGroupBeadIds } from './weldGroupAssociations.js';

export function BeamWeldLayerDefinitions({ session }: { readonly session: BeamSession }): React.JSX.Element {
  const state = useAppStore();
  const beads = state.assembly?.components.filter(c => !c.suppressed && c.source.kind === 'standardPart'
    && c.source.catalog === 'filletWeld') ?? [];
  const edit = (welds: readonly CadWeldLayer[]): void => state.editBeam({ kind: 'weld-layers', welds });
  const update = (id: string, change: (row: CadWeldLayer) => CadWeldLayer): void =>
    edit(state.assembly === null ? session.weldLayers.map(row => row.id === id ? change(row) : row)
      : updateWeldGroup(state.assembly, session.weldLayers, id, change));
  const ends = session.members.flatMap(member => [member.startNodeId, member.endNodeId]
    .map(nodeId => ({ memberId: member.id, nodeId, label: `${member.occurrence.label} / ${nodeId}` })));
  return <fieldset data-testid="beam-weld-layer-definitions"><legend>{t('beam.weldLayers')}</legend>
    <p>{t('beam.weldLayerScope')}</p>
    {session.weldLayers.map(weld => <fieldset key={weld.id} data-weld-layer={weld.id}>
      <legend>{weld.id}</legend>
      <label>{t('beam.weldBead')}<select value={weld.beadComponentId} onChange={event => {
        if (state.assembly === null) return;
        const rows = selectWeldGroup(state.assembly, session.weldLayers, weld.id, event.target.value, () => crypto.randomUUID());
        if (rows !== null) edit(rows);
      }} title={t('beam.guide.weldBead')}><option value="" />{beads.map(c => <option key={c.id} value={c.id}
        disabled={state.assembly !== null && selectWeldGroup(state.assembly, session.weldLayers, weld.id, c.id, () => 'capacity-probe') === null}>
        {c.name}</option>)}</select></label>
      {(['first', 'second'] as const).map(end => <label key={end}>{t(end === 'first' ? 'beam.axialBoltFirst' : 'beam.axialBoltSecond')}
        <select value={ends.findIndex(row => row.memberId === weld[end].memberId && row.nodeId === weld[end].nodeId)} onChange={event => {
          const choice = ends[Number(event.target.value)];
          if (choice !== undefined) update(weld.id, row => ({ ...row, [end]: { memberId: choice.memberId, nodeId: choice.nodeId } }));
        }} title={t('beam.guide.weldEnd')}><option value={-1} />{ends.map((row, at) => <option key={`${row.memberId}:${row.nodeId}`} value={at}>{row.label}</option>)}</select>
      </label>)}
      {(['youngMPa', 'poisson', 'effectiveThroatMm', 'complianceLengthMm'] as const).map(field => <label key={field}>
        {t(field === 'youngMPa' ? 'beam.axialBoltYoung' : field === 'poisson' ? 'beam.weldPoisson'
          : field === 'effectiveThroatMm' ? 'beam.weldThroat' : 'beam.weldCompliance')}
        <input type="number" step="any" value={Number.isFinite(weld[field]) ? weld[field] : ''}
          onChange={event => update(weld.id, row => ({ ...row, [field]: event.target.value === '' ? NaN : Number(event.target.value) }))} title={t(field === 'youngMPa' ? 'beam.guide.weldYoung' : field === 'poisson' ? 'beam.guide.weldPoisson' : field === 'effectiveThroatMm' ? 'beam.guide.weldThroat' : 'beam.guide.weldCompliance')} />
      </label>)}
      {(['reference', 'condition'] as const).map(field => <label key={field}>
        {t(field === 'reference' ? 'beam.axialBoltReference' : 'beam.axialBoltCondition')}
        <input value={weld.propertySource[field]} onChange={event => update(weld.id, row => ({ ...row,
          propertySource: { ...row.propertySource, [field]: event.target.value } }))} title={t(field === 'reference' ? 'beam.guide.sourceReference' : 'beam.guide.sourceCondition')} />
      </label>)}
      <button type="button" onClick={() => {
        const ids = state.assembly === null ? new Set([weld.beadComponentId]) : weldGroupBeadIds(state.assembly, weld.beadComponentId);
        edit(session.weldLayers.filter(row => row.id !== weld.id && !ids.has(row.beadComponentId)));
      }} title={t('beam.guide.weldRemove')}>{t('beam.axialBoltRemove')}</button>
    </fieldset>)}
    <button type="button" disabled={session.weldLayers.length >= 64}
      onClick={() => edit([...session.weldLayers, { id: crypto.randomUUID(), beadComponentId: '', expectedPartKey: '',
        expectedPlacementKey: '', expectedMaterialId: '', first: { memberId: '', nodeId: '' }, second: { memberId: '', nodeId: '' },
        youngMPa: NaN, poisson: NaN, effectiveThroatMm: NaN, complianceLengthMm: NaN,
        propertySource: { kind: 'user-supplied', reference: '', condition: '' }, idealization: 'rectangular-effective-elastic-throat' }])} title={t('beam.guide.weldAdd')}>
      {t('beam.weldAdd')}</button>
  </fieldset>;
}

export function BeamWeldLayerResults({ result, view }: {
  readonly result: Pick<BeamWeldContactResult, 'states' | 'contact'>; readonly view: BeamSession['contactView'];
}): React.JSX.Element {
  const edit = useAppStore(state => state.editBeam);
  const index = Math.min(Math.max(0, view.state), result.states.length - 1);
  const selected = result.states[index], contact = result.contact.states[index];
  return <section data-testid="beam-weld-layer-results"><h4>{t('beam.weldLayers')}</h4><p>{t('beam.weldLayerScope')}</p>
    <label>{t('beam.contactState')}<select value={index} onChange={event => edit({ kind: 'contact-view', state: Number(event.target.value) })} title={t('beam.guide.contactState')}>
      {result.states.map((row, at) => <option key={at} value={at}>{beamDisplayNumber(row.loadFactor)}</option>)}
    </select></label>
    <table><thead><tr><th>{t('beam.contactId')}</th><th>{t('beam.transientQuantity')}</th><th>X</th><th>Y</th><th>Z</th></tr></thead>
      <tbody>{selected.welds.flatMap(weld => (['forceOnAN', 'forceOnBN', 'momentOnANm', 'momentOnBNm'] as const).map(key =>
        <tr key={`${weld.id}-${key}`}><th>{weld.id}</th><td>{t(key === 'forceOnAN' ? 'beam.weldForceA' : key === 'forceOnBN'
          ? 'beam.weldForceB' : key === 'momentOnANm' ? 'beam.weldMomentA' : 'beam.weldMomentB')}</td>
          {weld[key].map((value, axis) => <td key={axis} data-quantity={key} data-unit={key.startsWith('force') ? 'N' : 'N m'}
            data-value={value}>{beamDisplayNumber(value)}</td>)}</tr>))}</tbody></table>
    {selected.welds.map(weld => <p key={weld.id} data-unit="J" data-value={weld.elasticEnergyJ}>
      {weld.id}: {t('beam.weldEnergy')} {beamDisplayNumber(weld.elasticEnergyJ)}</p>)}
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
    <p>{t('beam.contactChecks')}: {[contact.equilibriumResidual, contact.penetration, contact.tension, contact.complementarity].map(beamDisplayNumber).join(' / ')}</p>
  </section>;
}
