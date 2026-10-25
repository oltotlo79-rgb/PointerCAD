import type { PropertySource } from '@pointercad/model/beam-analysis';
import { t, type MessageKey } from '../i18n/t.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { useAppStore } from '../store/useAppStore.js';
import { beamExpressionField, type BeamFieldName } from './beamFields.js';
import type { BeamMemberDraft, BeamProvenance, BeamSession } from './beamSession.js';
import { BeamBucklingSupports } from './BeamBucklingSupports.js';

function SourceFields({ member, property }: { readonly member: BeamMemberDraft; readonly property: BeamProvenance }): React.JSX.Element {
  const edit = useAppStore(state => state.editBeam);
  const value = member[property];
  const change = (source: PropertySource): void => edit({ kind: 'source', id: member.id, property, source });
  return <fieldset className="pcad-beam__source" data-beam-source={property}>
    <legend>{t('beam.provenance')}</legend>
    <label>{t('beam.sourceKind')}<select value={value.kind} onChange={event => {
      const kind = event.target.value;
      if (kind === 'user-supplied' || kind === 'measured' || kind === 'published') change({ ...value, kind });
    }} title={t('beam.guide.sourceKind')}>
      <option value="user-supplied">{t('beam.source.user')}</option>
      <option value="measured">{t('beam.source.measured')}</option>
      <option value="published">{t('beam.source.published')}</option>
    </select></label>
    <label>{t('beam.reference')}<input className="pcad-field__input" value={value.reference} maxLength={1024}
      data-beam-reference={property} onChange={event => change({ ...value, reference: event.target.value })} title={t('beam.guide.sourceReference')} /></label>
    <label>{t('beam.condition')}<textarea className="pcad-field__input" value={value.condition} maxLength={1024}
      data-beam-condition={property} onChange={event => change({ ...value, condition: event.target.value })} title={t('beam.guide.sourceCondition')} /></label>
  </fieldset>;
}

export function BeamMemberFields({ member, session }: {
  readonly member: BeamMemberDraft; readonly session: BeamSession;
}): React.JSX.Element {
  const parameters = useAppStore(state => state.assembly?.parameters ?? state.document.parameters);
  const edit = useAppStore(state => state.editBeam);
  const numeric = (name: BeamFieldName): React.JSX.Element => <div key={name} data-beam-field={name}>
    <ExpressionField {...beamExpressionField(name, member.values[name], parameters)} lengthUnit="mm"
      focused={session.focusedField === `${member.id}:${name}`}
      onFocus={() => edit({ kind: 'focus', field: `${member.id}:${name}` })}
      onChange={source => edit({ kind: 'value', id: member.id, field: name, source })} />
  </div>;
  const nodeOptions = new Map<string, string>();
  for (const item of session.members) {
    nodeOptions.set(item.startNodeId, `${item.occurrence.label}: ${t('beam.start')}`);
    nodeOptions.set(item.endNodeId, `${item.occurrence.label}: ${t('beam.end')}`);
  }
  const endpoint = (end: 'start' | 'end'): React.JSX.Element => {
    const ownNode = `${member.id}-${end}`;
    const nodeId = end === 'start' ? member.startNodeId : member.endNodeId;
    const fixed = end === 'start' ? member.fixedStart : member.fixedEnd;
    const options = new Map(nodeOptions);
    options.set(ownNode, t('beam.independentEndpoint'));
    const names: readonly BeamFieldName[] = end === 'start'
      ? ['startFx', 'startFy', 'startFz', 'startMx', 'startMy', 'startMz']
      : ['endFx', 'endFy', 'endFz', 'endMx', 'endMy', 'endMz'];
    return <fieldset data-beam-end={end}>
      <legend>{t(end === 'start' ? 'beam.start' : 'beam.end')}</legend>
      {session.analysisType === 'buckling' || session.analysisType === 'transient' || session.analysisType === 'contact'
        || session.analysisType === 'impact'
        ? <BeamBucklingSupports member={member} end={end} />
        : <label><input type="checkbox" checked={fixed} data-beam-fixed={end}
          onChange={event => edit({ kind: 'fixed', id: member.id, end, fixed: event.target.checked })} title={t('beam.guide.fixedEnd')} />{t('beam.fixed')}</label>}
      <label>{t('beam.connect')}<select value={nodeId} data-beam-connect={end}
        onChange={event => edit({ kind: 'connection', id: member.id, end, nodeId: event.target.value })} title={t('beam.guide.connect')}>
        {[...options].map(([id, label]) => <option value={id} key={id}>{label}</option>)}
      </select></label>
      {session.analysisType === 'buckling' ? <p>{t('beam.referenceLoads')}</p>
        : session.analysisType === 'transient' ? <p>{t('beam.transientReferenceLoads')}</p>
        : session.analysisType === 'contact' ? <p>{t('beam.contactReferenceLoads')}</p>
        : session.analysisType === 'impact' ? <p>{t('beam.impactNoLoads')}</p> : null}
      <p>{t('beam.globalLoads')}</p>
      <div className="pcad-beam__numbers">{names.map(numeric)}</div>
    </fieldset>;
  };
  const groups: readonly { readonly property: BeamProvenance; readonly label: MessageKey; readonly names: readonly BeamFieldName[] }[] = [
    { property: 'material', label: 'beam.material', names: ['young', 'shear', 'density'] },
    { property: 'section', label: 'beam.section', names: ['area', 'iy', 'iz', 'torsion', 'shearFactor'] },
    { property: 'frame', label: 'beam.frame', names: ['cx', 'cy', 'principalAngle'] },
  ];
  return <article className="pcad-beam__member" data-beam-member={member.id}>
    <h4>{member.occurrence.label}</h4>
    <button type="button" className="pcad-button" onClick={() => edit({ kind: 'select', occurrence: member.occurrence, selected: false })} title={t('beam.guide.removeMember')}>
      {t('beam.remove')}</button>
    {groups.map(group => <details key={group.property} open>
      <summary>{t(group.label)}</summary>
      {group.property === 'frame' ? <p>{t('beam.frameHelp')}</p> : null}
      {group.property === 'section' ? <p>{t('beam.sectionHelp')}</p> : null}
      <div className="pcad-beam__numbers">{group.names.map(numeric)}</div>
      <SourceFields member={member} property={group.property} />
    </details>)}
    <label className="pcad-beam__confirmation"><input type="checkbox" checked={member.confirmed} data-beam-confirm
      onChange={event => edit({ kind: 'confirmed', id: member.id, confirmed: event.target.checked })} title={t('beam.guide.confirmFrame')} />{t('beam.confirmFrame')}</label>
    {endpoint('start')}{endpoint('end')}
  </article>;
}
