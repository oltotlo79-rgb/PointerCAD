import { MAX_BEAM_CONTACTS } from '@pointercad/fem';
import { useRef } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { useAppStore } from '../store/useAppStore.js';
import { contactExpressionField, transientExpressionField, type ContactFieldName } from './beamFields.js';
import { beamContactNodes, type BeamSession, type ContactRowDraft, type ContactValueField } from './beamSession.js';

const normalFields: readonly (ContactValueField & ContactFieldName)[] = ['normalX', 'normalY', 'normalZ'];
const velocityLabels: readonly MessageKey[] = ['beam.impactVelocityX', 'beam.impactVelocityY', 'beam.impactVelocityZ'];
const historyFields = ['timeStep', 'stepCount', 'outputEvery'] as const;
const outlineKinds = ['none', 'rectangle', 'circle', 'tube'] as const;
const outlineKindLabel: Readonly<Record<typeof outlineKinds[number], MessageKey>> = {
  none: 'beam.impactFibreNone', rectangle: 'beam.impactFibreRectangle', circle: 'beam.impactFibreCircle', tube: 'beam.impactFibreTube',
};

/** Impact editor (elastic, frictionless, fixed planes). Fixed planes are the node-plane contact rows with their
 * original direction and gap in mm; velocities are m/s and stiffness N/m, parsed by the same scalar rules as the
 * impact draft; the history uses the transient time fields (s or ms). Edits go through editBeam like every beam input. */
export function BeamImpactDefinitions({ session }: { readonly session: BeamSession }): React.JSX.Element {
  const parameters = useAppStore(state => state.assembly?.parameters ?? state.document.parameters);
  const edit = useAppStore(state => state.editBeam);
  const draft = session.impact;
  const nodes = beamContactNodes(session);
  const addPlane = useRef<HTMLButtonElement>(null);
  const focus = (key: string) => ({ focused: session.focusedField === key, onFocus: () => edit({ kind: 'focus', field: key }) });
  // Same scalar rules as the impact draft parser (normalX reader); only the label and the shown unit differ.
  const scalar = (key: string, source: string, label: MessageKey, unitLabel: string, change: (source: string) => void) => {
    const base = contactExpressionField('normalX', key, source, parameters);
    return <div key={key} data-beam-impact-field={key}>
      <ExpressionField {...base} field={{ ...base.field, labelKey: label }} unitLabel={unitLabel} lengthUnit="mm"
        {...focus(key)} onChange={change} />
    </div>;
  };
  const planeField = (name: ContactFieldName, key: string, source: string, change: (source: string) => void) =>
    <div key={key} data-beam-contact-field={key}>
      <ExpressionField {...contactExpressionField(name, key, source, parameters)} lengthUnit="mm" {...focus(key)} onChange={change} />
    </div>;
  const nodeChoice = (index: number, row: ContactRowDraft): React.JSX.Element => {
    const missing = row.nodeIdA !== '' && !nodes.some(node => node.nodeId === row.nodeIdA);
    return <label>{t('beam.contactNode')}<select value={row.nodeIdA} data-beam-contact-node={`${row.id}:a`}
      aria-invalid={missing || undefined}
      onChange={event => edit({ kind: 'contact-node', index, end: 'a', nodeId: event.target.value })} title={t('beam.guide.impactNode')}>
      <option value="">{t('beam.contactChooseNode')}</option>
      {missing ? <option value={row.nodeIdA}>{`${t('beam.contactMissingNode')}: ${row.nodeIdA}`}</option> : null}
      {nodes.map(node => <option key={node.nodeId} value={node.nodeId}>
        {`${node.label}: ${t(node.end === 'start' ? 'beam.start' : 'beam.end')}`}</option>)}
    </select></label>;
  };
  return <fieldset className="pcad-beam__contact" data-testid="beam-impact-definitions">
    <legend>{t('beam.impactDefinitions')}</legend>
    <p>{t('beam.impactDefinitionsHelp')}</p>
    <fieldset data-testid="beam-impact-velocities">
      <legend>{t('beam.impactVelocities')}</legend>
      <p>{t('beam.impactVelocitiesHelp')}</p>
      {nodes.map(node => {
        const row = draft.velocities.find(entry => entry.nodeId === node.nodeId);
        return <fieldset key={node.nodeId} data-beam-impact-velocity={node.nodeId}>
          <legend>{`${node.label}: ${t(node.end === 'start' ? 'beam.start' : 'beam.end')}`}</legend>
          <div className="pcad-beam__numbers">
            {([0, 1, 2] as const).map(axis => scalar(`impact:velocity:${node.nodeId}:${axis}`, row?.velocity[axis] ?? '0',
              velocityLabels[axis], 'm/s', source => edit({ kind: 'impact-velocity', nodeId: node.nodeId, axis, source })))}
          </div>
          {row === undefined ? null : <button type="button" className="pcad-button" data-beam-impact-velocity-remove={node.nodeId}
            onClick={() => edit({ kind: 'impact-velocity-remove', nodeId: node.nodeId })} title={t('beam.guide.impactVelocityRemove')}>{t('beam.impactVelocityRemove')}</button>}
        </fieldset>;
      })}
      {draft.velocities.filter(row => !nodes.some(node => node.nodeId === row.nodeId)).map(row =>
        <p key={row.nodeId} role="alert" data-beam-impact-velocity-missing={row.nodeId}>
          {`${t('beam.contactMissingNode')}: ${row.nodeId}`}
          <button type="button" className="pcad-button" data-beam-impact-velocity-remove={row.nodeId}
            onClick={() => edit({ kind: 'impact-velocity-remove', nodeId: row.nodeId })} title={t('beam.guide.impactVelocityRemove')}>{t('beam.impactVelocityRemove')}</button>
        </p>)}
    </fieldset>
    <fieldset data-testid="beam-impact-planes">
      <legend>{t('beam.impactPlanes')}</legend>
      <p>{t('beam.impactPlanesHelp')}</p>
      {session.contact.rows.map((row, index) => <fieldset key={row.id} data-beam-contact={row.id}>
        <legend>{row.id}</legend>
        {/* Rows left over from the contact analysis may be node pairs; they are shown as unsupported, never dropped. */}
        {row.kind === 'node-pair' ? <p role="alert" data-beam-impact-pair={row.id}>{t('beam.error.impactPairUnsupported')}</p> : null}
        {nodeChoice(index, row)}
        {/* Impact contract: gap = gapMm/1000 - unit(direction) . u, so the direction points from the node towards the plane. */}
        <p>{t('beam.impactPlaneDirection')}</p>
        <div className="pcad-beam__numbers">
          {normalFields.map((name, axis) => planeField(name, `contact:${row.id}:${name}`, row.normal[axis],
            source => edit({ kind: 'contact-value', index, field: name, source })))}
          {planeField('gap', `contact:${row.id}:gap`, row.gap, source => edit({ kind: 'contact-value', index, field: 'gap', source }))}
        </div>
        <button type="button" className="pcad-button" data-beam-contact-remove={row.id}
          onClick={() => { edit({ kind: 'contact-remove', index }); addPlane.current?.focus(); }} title={t('beam.guide.impactPlaneRemove')}>{t('beam.contactRemove')}</button>
      </fieldset>)}
      <button ref={addPlane} type="button" className="pcad-button" data-testid="beam-impact-plane-add"
        disabled={session.contact.rows.length >= MAX_BEAM_CONTACTS}
        onClick={() => edit({ kind: 'contact-add' })} title={t('beam.guide.impactPlaneAdd')}>{t('beam.impactPlaneAdd')}</button>
    </fieldset>
    <fieldset data-testid="beam-impact-settings">
      <legend>{t('beam.impactSettings')}</legend>
      {scalar('impact:contactStiffness', draft.contactStiffness, 'beam.impactStiffness', 'N/m',
        source => edit({ kind: 'impact-value', field: 'contactStiffness', source }))}
      {historyFields.map(name => <div key={name} data-beam-impact-field={`impact:${name}`}>
        <ExpressionField {...transientExpressionField(name, `impact:${name}`, draft[name], parameters)} lengthUnit="mm"
          {...focus(`impact:${name}`)} onChange={source => edit({ kind: 'impact-value', field: name, source })} />
      </div>)}
      <p>{t('beam.impactBounds')}</p>
    </fieldset>
    <fieldset data-testid="beam-impact-fibre">
      <legend>{t('beam.impactFibre')}</legend>
      <p>{t('beam.impactFibreHelp')}</p>
      {session.members.map(member => {
        const rows = draft.fibreSections;
        const row = rows !== undefined && Object.hasOwn(rows, member.id) ? rows[member.id] : undefined;
        const kind = row?.kind ?? 'none';
        const size = (field: 'first' | 'second', label: MessageKey) => {
          const key = `impact:fibre:${member.id}:${field}`;
          const base = contactExpressionField('gap', key, row?.[field] ?? '', parameters);
          return <div key={key} data-beam-impact-fibre-field={key}>
            <ExpressionField {...base} field={{ ...base.field, labelKey: label }} lengthUnit="mm" {...focus(key)}
              onChange={source => edit({ kind: 'impact-fibre', memberId: member.id, field, source })} />
          </div>;
        };
        return <fieldset key={member.id} data-beam-impact-fibre={member.id}>
          <legend>{member.occurrence.label}</legend>
          <label>{t('beam.impactFibreKind')}<select value={kind} data-beam-impact-fibre-kind={member.id}
            onChange={event => edit({ kind: 'impact-fibre', memberId: member.id, field: 'kind', source: event.target.value })} title={t('beam.guide.impactFibreKind')}>
            {outlineKinds.map(option => <option key={option} value={option}>{t(outlineKindLabel[option])}</option>)}
          </select></label>
          <div className="pcad-beam__numbers">
            {kind === 'rectangle' ? [size('first', 'beam.impactFibreWidthY'), size('second', 'beam.impactFibreDepthZ')]
              : kind === 'circle' ? [size('first', 'beam.impactFibreDiameter')]
              : kind === 'tube' ? [size('first', 'beam.impactFibreOutsideDiameter'), size('second', 'beam.impactFibreWall')] : null}
          </div>
        </fieldset>;
      })}
    </fieldset>
  </fieldset>;
}
