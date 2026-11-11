import { useEffect } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { BOLT_AUTHOR_NUMBERS, BOLT_AUTHOR_EVIDENCE, boltAuthorTemplates, type BoltAuthorForm } from '../store/beamSlice.js';
import { beamOccurrences, captureBeamSource } from './beamSource.js';
import type { BoltDraftNumber, BoltDraftSource } from './boltPreloadDraft.js';
import type { PropertySource } from '@pointercad/model/beam-analysis';

const draftNumbers: readonly BoltDraftNumber[] = ['preloadN', 'threadCompliance', 'headCompliance', 'bearingCompliance', 'memberCompliance'];
const draftSources: readonly BoltDraftSource[] = [...draftNumbers, 'modelSource', 'shankSource', 'shorteningSource', 'loadSource'];
function sourceLabel(source: PropertySource): string { return `${source.reference} / ${source.condition}`; }
function Evidence({ label, value, onChange }: { readonly label: string; readonly value: PropertySource; readonly onChange: (value: PropertySource) => void }): React.JSX.Element {
  return <fieldset><legend>{label}</legend>
    <label>{t('beam.preload.evidenceKind')}<select value={value.kind} title={t('beam.preload.evidenceHelp')}
      onChange={event => { const kind = event.target.value; if (kind === 'user-supplied' || kind === 'measured' || kind === 'published') onChange({ ...value, kind }); }}>
      <option value="user-supplied">{t('beam.preload.userSupplied')}</option><option value="measured">{t('beam.preload.measured')}</option><option value="published">{t('beam.preload.published')}</option>
    </select></label>
    <label>{t('beam.preload.reference')}<input value={value.reference} title={t('beam.preload.evidenceHelp')} onChange={event => onChange({ ...value, reference: event.target.value })} /></label>
    <label>{t('beam.preload.condition')}<input value={value.condition} title={t('beam.preload.evidenceHelp')} onChange={event => onChange({ ...value, condition: event.target.value })} /></label>
  </fieldset>;
}
function previousNumbers(form: BoltAuthorForm): Readonly<Record<string, number | undefined>> {
  const cad = form.previous?.saved.cadDefinition ?? form.template, d = form.previous?.saved.input.declaration;
  const material = (i: number) => cad.materials.find(row => row.id === cad.members[i]?.materialId);
  const section = (i: number) => cad.sections.find(row => row.id === cad.members[i]?.sectionId);
  return { young0: material(0)?.youngModulus, shear0: material(0)?.shearModulus, density0: material(0)?.densityKgM3,
    area0: section(0)?.area, iy0: section(0)?.iy, iz0: section(0)?.iz, torsion0: section(0)?.torsionConstant, factor0: section(0)?.shearFactor,
    young1: material(1)?.youngModulus, shear1: material(1)?.shearModulus, density1: material(1)?.densityKgM3,
    area1: section(1)?.area, iy1: section(1)?.iy, iz1: section(1)?.iz, torsion1: section(1)?.torsionConstant, factor1: section(1)?.shearFactor,
    boltYoung: cad.axialBolts?.bolts[0]?.youngMPa, boltArea: cad.axialBolts?.bolts[0]?.effectiveAreaMm2,
    preloadN: d?.preloadN.value, threadCompliance: d?.threadCompliance.value, headCompliance: d?.headCompliance.value,
    bearingCompliance: d?.bearingCompliance.value, memberCompliance: d?.memberCompliance.value };
}
export function BoltPreloadAssociation({ form }: { readonly form: BoltAuthorForm }): React.JSX.Element {
  const state = useAppStore(), old = form.previous?.saved, before = previousNumbers(form);
  const choices = beamOccurrences(form.source.document, form.source.resolved);
  const buttonsDisabled = state.boltPreloadStatus === 'running';
  return <div data-testid="bolt-preload-author">
    <p>{t(form.previous === null ? 'beam.preload.newScope' : 'beam.preload.reassociateScope')}</p>
    <p>{t('beam.preload.oldSource')}: {form.template.source.documentId} / {form.template.source.documentRevision} / {form.template.source.geometryRevision}</p>
    <p>{t('beam.preload.newSource')}: {form.source.source.documentId} / {form.source.source.documentRevision} / {form.source.source.geometryRevision}</p>
    <label>{t('beam.preload.analysisId')}<input data-testid="preload-analysis-id" value={form.analysisId} readOnly={form.previous !== null}
      title={t('beam.preload.identityHelp')} onChange={event => state.editBoltPreloadAuthor({ kind: 'identity', id: event.target.value })} /></label>
    {([0, 1] as const).map(index => <label key={index}>{t(index === 0 ? 'beam.preload.member0' : 'beam.preload.member1')}
      <select data-testid={`preload-member-${index}`} value={form.members[index]} title={t('beam.preload.selectionHelp')}
        onChange={event => state.editBoltPreloadAuthor({ kind: 'member', index, path: event.target.value })}>
        <option value="">{t('beam.preload.select')}</option>{choices.map(row => <option key={JSON.stringify(row.path)} value={JSON.stringify(row.path)}>{row.label}</option>)}
      </select><span>{t('beam.preload.previous')}: {old?.cadDefinition.members[index]?.occurrencePath.join(' / ') ?? form.template.members[index]?.occurrencePath.join(' / ')}</span>
    </label>)}
    <label>{t('beam.preload.bolt')}<select data-testid="preload-bolt" value={form.boltComponentId} title={t('beam.preload.selectionHelp')}
      onChange={event => state.editBoltPreloadAuthor({ kind: 'bolt', id: event.target.value })}>
      <option value="">{t('beam.preload.select')}</option>{form.source.document.components.filter(row => !row.suppressed && row.source.kind === 'standardPart' && row.source.catalog === 'hexBolt').map(row => <option key={row.id} value={row.id}>{row.name}</option>)}
    </select><span>{t('beam.preload.previous')}: {old?.input.boltComponentId ?? form.template.axialBolts?.bolts[0]?.boltComponentId}</span></label>
    <label>{t('beam.preload.contact')}<select data-testid="preload-contact" value={form.contactId} title={t('beam.preload.selectionHelp')}
      onChange={event => state.editBoltPreloadAuthor({ kind: 'contact', id: event.target.value })}>
      <option value="">{t('beam.preload.select')}</option>{form.template.contact.contacts.map(row => <option key={row.id} value={row.id}>{row.id}</option>)}
    </select><span>{t('beam.preload.previous')}: {old?.input.contactId ?? form.template.contact.contacts[0]?.id}</span></label>
    {BOLT_AUTHOR_NUMBERS.map(field => <label key={field}>{t(`beam.preload.${field}`)}
      <input data-preload-number={field} inputMode="decimal" value={form.values[field]} title={t('beam.preload.numberHelp')}
        onChange={event => state.editBoltPreloadAuthor({ kind: 'number', field, text: event.target.value })} />
      <span>{t('beam.preload.previous')}: {before[field] ?? t('beam.preload.notProvided')}</span>
    </label>)}
    {BOLT_AUTHOR_EVIDENCE.map(field => <div key={field}>
      <Evidence label={t(`beam.preload.${field}`)} value={form.evidence[field]} onChange={value => state.editBoltPreloadAuthor({ kind: 'evidence', field, value })} />
      <p>{t('beam.preload.previous')}: {old === undefined ? t('beam.preload.templateEvidence') : sourceLabel(field === 'material0' || field === 'material1'
        ? old.cadDefinition.materials.find(row => row.id === old.cadDefinition.members[field === 'material0' ? 0 : 1].materialId)?.source ?? old.input.declaration.modelSource
        : field === 'section0' || field === 'section1' ? old.cadDefinition.sections.find(row => row.id === old.cadDefinition.members[field === 'section0' ? 0 : 1].sectionId)?.source ?? old.input.declaration.modelSource
          : field === 'preloadN' || field === 'threadCompliance' || field === 'headCompliance' || field === 'bearingCompliance' || field === 'memberCompliance' ? old.input.declaration[field].source : old.input.declaration[field])}</p>
    </div>)}
    <label>{t('beam.preload.loads')}<textarea data-testid="preload-author-loads" value={form.loads} title={t('beam.preload.loadsHelp')}
      onChange={event => state.editBoltPreloadAuthor({ kind: 'loads', text: event.target.value })} /></label>
    <p>{t('beam.preload.previous')}: {(old?.input.declaration.externalLoadsN ?? form.template.contact.loadFactors).join(' → ')}</p>
    <details><summary>{t('beam.preload.geometryDetails')}</summary>
      {form.template.members.map(row => <p key={row.id}>{row.id}: {row.startNodeId} → {row.endNodeId}; {row.sectionFrame.centroidMm.join(', ')} mm; {row.sectionFrame.principalY.join(', ')}</p>)}
      {form.template.supports.map(row => <p key={row.nodeId}>{row.nodeId}: {row.restrained.map(value => value ? t('beam.preload.fixed') : t('beam.preload.free')).join(', ')}</p>)}
      {form.template.referenceLoads.map(row => <p key={row.id}>{row.nodeId}: {row.force.join(', ')} N; {row.moment.join(', ')} N·mm</p>)}
      {form.template.contact.contacts.map(row => <p key={row.id}>{row.id}: {row.normal.join(', ')}; {row.gapMm} mm</p>)}
    </details>
    <label><input type="checkbox" data-testid="preload-geometry-confirm" checked={form.geometryConfirmed} title={t('beam.preload.geometryHelp')}
      onChange={event => state.editBoltPreloadAuthor({ kind: 'geometry', confirmed: event.target.checked })} />{t('beam.preload.geometryHelp')}</label>
    <button type="button" data-testid="preload-preview" disabled={buttonsDisabled} title={t('beam.preload.previewHelp')} onClick={() => { void state.previewBoltPreloadAuthor(); }}>{t('beam.preload.preview')}</button>
    {form.proposal === null ? null : <div role="status"><p>{t('beam.preload.proposalReady')}</p>
      <button type="button" data-testid="preload-adopt" title={t('beam.preload.adoptHelp')} onClick={state.acceptBoltPreloadAuthor}>{t('beam.preload.adopt')}</button></div>}
    <button type="button" data-testid="preload-author-cancel" title={t('beam.preload.cancelHelp')} onClick={state.cancelBoltPreloadAuthor}>{t('beam.cancel')}</button>
  </div>;
}
const statusKeys: Readonly<Record<ReturnType<typeof useAppStore.getState>['boltPreloadStatus'], MessageKey>> = {
  editing: 'beam.preload.editing', reviewing: 'beam.preload.reviewing', running: 'beam.preload.running',
  complete: 'beam.preload.complete', cancelled: 'beam.cancelled', failed: 'beam.preload.failed',
};
export function BoltPreloadPanel(): React.JSX.Element | null {
  const state = useAppStore(), strength = state.strengthSession, draft = state.boltPreloadDraft, form = state.boltPreloadAuthor;
  useEffect(() => () => { const current = useAppStore.getState(); if (strength !== null && current.boltPreloadOwner === strength) current.closeBoltPreload(); }, [strength]);
  if (strength === null || state.assembly === null) return null;
  const running = state.boltPreloadStatus === 'running', source = captureBeamSource(state);
  return <section className="pcad-panel__body pcad-beam" aria-label={t('beam.preload.title')} data-testid="bolt-preload-panel">
    <h3>{t('beam.preload.title')}</h3><p>{t('beam.preload.scope')}</p>
    {draft !== null || form !== null ? <button type="button" data-testid="preload-close" title={t('beam.preload.closeHelp')} onClick={state.closeBoltPreload}>{t('beam.close')}</button> : <>
      {(state.assembly.beamAnalysisInputs?.analyses ?? []).map(row => row.kind === 'native-bolt-preload' ? <button type="button" key={row.definition.id}
        title={t('beam.preload.openHelp')} data-preload-open={row.definition.id} onClick={() => state.openBoltPreload(row.definition.id)}>{t('beam.preload.open')} {row.definition.id}</button> : null)}
      {boltAuthorTemplates(state).map(row => <button type="button" key={row.key} data-preload-new={row.key} disabled={source === null}
        title={t('beam.preload.newHelp')} onClick={() => state.beginBoltPreloadAuthor(row.key, false)}>{t('beam.preload.new')} {row.definition.id}</button>)}
      <p>{t('beam.preload.templateHelp')}</p>
    </>}
    {form !== null ? <BoltPreloadAssociation form={form} /> : draft === null ? null : <>
      <p>{t('beam.preload.savedSource')}: {draft.saved.source.documentId} / {draft.saved.source.documentRevision} / {draft.saved.source.geometryRevision}</p>
      <button type="button" data-testid="preload-reassociate" disabled={source === null || running} title={t('beam.preload.reassociateScope')}
        onClick={() => state.beginBoltPreloadAuthor(`saved:${draft.saved.id}`, true)}>{t('beam.preload.reassociate')}</button>
      {draftNumbers.map(field => <label key={field}>{t(`beam.preload.${field}`)}<input data-preload-draft-number={field} value={draft.values[field]} inputMode="decimal" title={t('beam.preload.numberHelp')}
        onChange={event => state.editBoltPreload({ kind: 'number', field, text: event.target.value })} /></label>)}
      {draftSources.map(field => <Evidence key={field} label={t(`beam.preload.${field}`)} value={draft.sources[field]} onChange={value => state.editBoltPreload({ kind: 'source', field, value })} />)}
      <label>{t('beam.preload.loads')}<textarea data-testid="preload-loads" value={draft.loadsN.join('\n')} title={t('beam.preload.loadsHelp')}
        onChange={event => state.editBoltPreload({ kind: 'loads', valuesN: event.target.value.split(/\r?\n/u) })} /></label>
      <label><input type="checkbox" data-testid="preload-confirm" checked={draft.confirmed} title={t('beam.preload.confirmHelp')}
        onChange={event => state.confirmBoltPreload(event.target.checked)} />{t('beam.preload.confirmHelp')}</label>
      <button type="button" data-testid="preload-review" disabled={running || !draft.confirmed || source === null} title={t('beam.preload.reviewHelp')} onClick={() => { void state.reviewBoltPreload(); }}>{t('beam.review')}</button>
      <button type="button" data-testid="preload-run" disabled={running || draft.reviewed === null || !draft.confirmed} title={t('beam.preload.runHelp')} onClick={state.runBoltPreload}>{t('beam.run')}</button>
      <button type="button" data-testid="preload-cancel" disabled={!running} title={t('beam.preload.cancelHelp')} onClick={state.cancelBoltPreload}>{t('beam.cancel')}</button>
      <button type="button" data-testid="preload-save" disabled={running || draft.reviewed === null} title={t('beam.preload.saveHelp')} onClick={state.applyBoltPreloadInputs}>{t('beam.apply')}</button>
      {draft.result === null || draft.reviewed === null ? null : <table data-testid="preload-result"><caption>{t('beam.preload.resultScope')}</caption><thead><tr>
        <th>{t('beam.preload.externalN')}</th><th>{t('beam.preload.tensionN')}</th><th>{t('beam.preload.compressionN')}</th><th>{t('beam.preload.gapM')}</th>
      </tr></thead><tbody>{draft.result.states.map((row, index) => <tr key={index}><td>{row.externalLoadN}</td><td>{row.boltTensionN}</td><td>{row.memberCompressionN}</td><td>{row.gapM}</td></tr>)}</tbody></table>}
    </>}
    <p role="status" data-testid="preload-status">{t(statusKeys[state.boltPreloadStatus])}</p>
    {state.boltPreloadError === null ? null : <p role="alert">{t('beam.preload.error')}</p>}
  </section>;
}
