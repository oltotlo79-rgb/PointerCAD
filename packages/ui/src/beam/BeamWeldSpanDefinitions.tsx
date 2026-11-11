import { createDocumentElementId } from '@pointercad/model/document-identity';
import type { CadWeldSpanLayer, CadWeldSpanSide } from '@pointercad/model/beam-analysis';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import type { BeamSession } from './beamSession.js';
import { captureBeamSource } from './beamSource.js';
import { selectWeldGroup, updateWeldGroup, weldGroupBeadIds } from './weldGroupAssociations.js';

/** This editor declares saved associations only. The existing strict reader/CAD preparation owns admission. */
export function BeamWeldSpanDefinitions({ session }: { readonly session: BeamSession }): React.JSX.Element {
  const state = useAppStore(), source = captureBeamSource(state), span = session.weldSpanLayers;
  const rows = span?.welds ?? [];
  const mixed = session.weldLayers.length > 0 || session.axialBolts.length > 0 || session.initialStrain !== null;
  const stale = span !== null && source !== null && (span.source.documentId !== source.source.documentId
    || span.source.documentRevision !== source.source.documentRevision || span.source.geometryRevision !== source.source.geometryRevision
    || span.analysisId !== session.analysisId || span.analysisRevision !== session.revision);
  const reason: MessageKey | null = mixed ? 'beam.weldSpanMixed' : source === null || state.beamSession !== session
    || session.ownerId !== state.activeDocumentId ? 'beam.weldSpanCurrent' : stale ? 'beam.weldSpanStale'
    : session.members.length < 2 ? 'beam.weldSpanTwoMembers' : null;
  const beads = state.assembly?.components.filter(c => !c.suppressed && c.source.kind === 'standardPart'
    && c.source.catalog === 'filletWeld') ?? [];
  const edit = (welds: readonly CadWeldSpanLayer[]): void => {
    const current = useAppStore.getState();
    if (current.beamSession !== session || current.activeDocumentId !== session.ownerId) return; // Retained events cannot change a new opening/owner.
    if (welds.length === 0) { current.editBeam({ kind: 'weld-span-layers', value: null }); return; }
    const captured = captureBeamSource(current);
    if (reason !== null || captured === null || source === null || captured.document !== source.document
      || captured.resolved !== source.resolved || captured.source.documentRevision !== source.source.documentRevision
      || captured.source.geometryRevision !== source.source.geometryRevision) return;
    current.editBeam({ kind: 'weld-span-layers', value: span === null ? {
      schema: 'pointercad-cad-weld-layers/2', source: captured.source, analysisId: session.analysisId,
      analysisRevision: session.revision, welds,
    } : { ...span, welds } });
  };
  const update = (id: string, change: (row: CadWeldSpanLayer) => CadWeldSpanLayer): void => {
    if (state.assembly !== null) edit(updateWeldGroup(state.assembly, rows, id, change));
  };
  const setSide = (id: string, side: 'first' | 'second', value: CadWeldSpanSide): void =>
    update(id, row => ({ ...row, [side]: value }));
  return <fieldset data-testid="beam-weld-span-definitions"><legend>{t('beam.weldSpanAuthorTitle')}</legend>
    <p>{t('beam.weldSpanAuthorScope')}</p>
    {reason === null ? null : <p role="status" data-testid="beam-weld-span-blocked">{t(reason)}</p>}
    {rows.map(weld => <fieldset key={weld.id} data-weld-span-definition={weld.id}>
      <legend>{weld.id}</legend>
      <fieldset disabled={reason !== null}>
        <label>{t('beam.weldBead')}<select data-span-field="bead" value={weld.beadComponentId}
          title={t('beam.guide.weldBead')} onChange={event => {
            if (state.assembly === null) return;
            const selected = selectWeldGroup(state.assembly, rows, weld.id, event.target.value, () => createDocumentElementId());
            if (selected !== null) edit(selected);
          }}><option value="" />{beads.map(bead => <option key={bead.id} value={bead.id}
            disabled={state.assembly !== null && selectWeldGroup(state.assembly, rows, weld.id, bead.id, () => 'capacity-probe') === null}>
            {bead.name}</option>)}</select></label>
        {(['first', 'second'] as const).map(side => {
          const value = weld[side], member = session.members.find(m => m.id === value.memberId);
          const other = weld[side === 'first' ? 'second' : 'first'];
          return <fieldset key={side} data-span-side={side}><legend>{t(side === 'first' ? 'beam.weldSpanFirst' : 'beam.weldSpanSecond')}</legend>
            <label>{t('beam.weldSpanSideType')}<select data-span-field="kind" value={value.kind}
              title={t('beam.guide.weldSpanSide')} onChange={event => {
                if (event.target.value === 'member-span') setSide(weld.id, side, { kind: 'member-span', memberId: value.memberId });
                if (event.target.value === 'section-node') setSide(weld.id, side, { kind: 'section-node', memberId: value.memberId, nodeId: '' });
              }}><option value="member-span">{t('beam.weldSpanAlong')}</option>
              <option value="section-node">{t('beam.weldSpanSection')}</option></select></label>
            <label>{t('beam.weldSpanMember')}<select data-span-field="member" value={value.memberId}
              title={t('beam.guide.weldSpanMember')} onChange={event => {
                const chosen = session.members.find(m => m.id === event.target.value);
                if (chosen === undefined || chosen.id === other.memberId) return;
                setSide(weld.id, side, value.kind === 'member-span' ? { kind: 'member-span', memberId: chosen.id }
                  : { kind: 'section-node', memberId: chosen.id, nodeId: '' });
              }}><option value="" />{session.members.map(m => <option key={m.id} value={m.id} disabled={m.id === other.memberId}>
                {m.occurrence.label}</option>)}</select></label>
            {value.kind !== 'section-node' ? null : <label>{t('beam.weldSpanSection')}<select data-span-field="node" value={value.nodeId}
              title={t('beam.guide.weldSpanSection')} onChange={event => {
                if (member !== undefined && [member.startNodeId, member.endNodeId].includes(event.target.value)) {
                  setSide(weld.id, side, { kind: 'section-node', memberId: member.id, nodeId: event.target.value });
                }
              }}><option value="" />{member === undefined ? null : <>
                <option value={member.startNodeId}>{t('beam.start')}</option><option value={member.endNodeId}>{t('beam.end')}</option>
              </>}</select></label>}
          </fieldset>;
        })}
        {(['youngMPa', 'poisson', 'effectiveThroatMm', 'complianceLengthMm'] as const).map(field => <label key={field}>
          {t(field === 'youngMPa' ? 'beam.axialBoltYoung' : field === 'poisson' ? 'beam.weldPoisson'
            : field === 'effectiveThroatMm' ? 'beam.weldThroat' : 'beam.weldCompliance')}
          <input type="number" step="any" data-span-field={field} value={Number.isFinite(weld[field]) ? weld[field] : ''}
            onChange={event => update(weld.id, row => ({ ...row, [field]: event.target.value === '' ? NaN : Number(event.target.value) }))}
            title={t(field === 'youngMPa' ? 'beam.guide.weldYoung' : field === 'poisson' ? 'beam.guide.weldPoisson'
              : field === 'effectiveThroatMm' ? 'beam.guide.weldThroat' : 'beam.guide.weldCompliance')} />
        </label>)}
        {(['reference', 'condition'] as const).map(field => <label key={field}>
          {t(field === 'reference' ? 'beam.axialBoltReference' : 'beam.axialBoltCondition')}
          <input data-span-field={field} value={weld.propertySource[field]} onChange={event => update(weld.id, row => ({ ...row,
            propertySource: { ...row.propertySource, [field]: event.target.value } }))}
            title={t(field === 'reference' ? 'beam.guide.sourceReference' : 'beam.guide.sourceCondition')} />
        </label>)}
      </fieldset>
      <button type="button" data-span-field="remove" disabled={state.beamSession !== session} onClick={() => {
        const ids = state.assembly === null ? new Set([weld.beadComponentId]) : weldGroupBeadIds(state.assembly, weld.beadComponentId);
        edit(rows.filter(row => row.id !== weld.id && !ids.has(row.beadComponentId)));
      }} title={t('beam.guide.weldRemove')}>{t('beam.axialBoltRemove')}</button>
    </fieldset>)}
    <button type="button" data-testid="beam-weld-span-add" disabled={reason !== null || rows.length >= 64}
      title={t(reason ?? (rows.length >= 64 ? 'beam.weldSpanLimit' : 'beam.guide.weldSpanAdd'))} onClick={() => {
        if (reason !== null || rows.length >= 64) return;
        edit([...rows, {
        id: createDocumentElementId(), beadComponentId: '', expectedPartKey: '', expectedPlacementKey: '', expectedMaterialId: '',
        first: { kind: 'member-span', memberId: '' }, second: { kind: 'member-span', memberId: '' },
        youngMPa: NaN, poisson: NaN, effectiveThroatMm: NaN, complianceLengthMm: NaN,
        propertySource: { kind: 'user-supplied', reference: '', condition: '' }, idealization: 'rectangular-effective-elastic-throat',
      }]); }}>{t('beam.weldSpanAdd')}</button>
    {rows.length < 64 ? null : <p role="status">{t('beam.weldSpanLimit')}</p>}
  </fieldset>;
}
