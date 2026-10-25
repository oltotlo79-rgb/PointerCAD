import { MAX_BEAM_CONTACTS, MAX_CONTACT_LOAD_FACTORS } from '@pointercad/fem';
import { useRef } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { useAppStore } from '../store/useAppStore.js';
import { contactExpressionField, type ContactFieldName } from './beamFields.js';
import { beamContactNodes, type BeamSession, type ContactRowDraft, type ContactValueField } from './beamSession.js';

const normalFields: readonly (ContactValueField & ContactFieldName)[] = ['normalX', 'normalY', 'normalZ'];

/** Contact editor. Nodes are chosen only from the selected members' end nodes; every number uses the shared
 * expression field (keyboard, IME and parameter rules); edits go through editBeam, and saving goes through the
 * existing assembly Undo history like every other beam input. */
export function BeamContactDefinitions({ session }: { readonly session: BeamSession }): React.JSX.Element {
  const parameters = useAppStore(state => state.assembly?.parameters ?? state.document.parameters);
  const edit = useAppStore(state => state.editBeam);
  const draft = session.contact;
  const nodes = beamContactNodes(session);
  // A remove button disappears with its own row; keep the keyboard position on the persistent add buttons
  // instead of letting focus fall to the document body.
  const addContact = useRef<HTMLButtonElement>(null);
  const addFactor = useRef<HTMLButtonElement>(null);
  const field = (name: ContactFieldName, key: string, source: string, change: (source: string) => void): React.JSX.Element =>
    <div key={key} data-beam-contact-field={key}>
      <ExpressionField {...contactExpressionField(name, key, source, parameters)} lengthUnit="mm"
        focused={session.focusedField === key} onFocus={() => edit({ kind: 'focus', field: key })} onChange={change} />
    </div>;
  const nodeSelect = (index: number, row: ContactRowDraft, end: 'a' | 'b', label: MessageKey): React.JSX.Element => {
    const value = end === 'a' ? row.nodeIdA : row.nodeIdB;
    // A node of a removed or reconnected member stays visible as missing, so the refusal on review is explainable.
    const missing = value !== '' && !nodes.some(node => node.nodeId === value);
    return <label>{t(label)}<select value={value} data-beam-contact-node={`${row.id}:${end}`}
      aria-invalid={missing || undefined}
      onChange={event => edit({ kind: 'contact-node', index, end, nodeId: event.target.value })} title={t('beam.guide.contactNode')}>
      <option value="">{t('beam.contactChooseNode')}</option>
      {missing ? <option value={value}>{`${t('beam.contactMissingNode')}: ${value}`}</option> : null}
      {nodes.map(node => <option key={node.nodeId} value={node.nodeId}>
        {`${node.label}: ${t(node.end === 'start' ? 'beam.start' : 'beam.end')}`}</option>)}
    </select></label>;
  };
  return <fieldset className="pcad-beam__contact" data-testid="beam-contact-definitions">
    <legend>{t('beam.contactDefinitions')}</legend>
    <p>{t('beam.contactDefinitionsHelp')}</p>
    {draft.rows.map((row, index) => <fieldset key={row.id} data-beam-contact={row.id}>
      <legend>{row.id}</legend>
      <label>{t('beam.contactKind')}<select value={row.kind} data-beam-contact-kind={row.id}
        onChange={event => {
          const value = event.target.value;
          if (value === 'node-plane' || value === 'node-pair') edit({ kind: 'contact-kind', index, value });
        }} title={t('beam.guide.contactKind')}>
        <option value="node-plane">{t('beam.contactNodePlane')}</option>
        <option value="node-pair">{t('beam.contactNodePair')}</option>
      </select></label>
      {nodeSelect(index, row, 'a', row.kind === 'node-plane' ? 'beam.contactNode' : 'beam.contactNodeA')}
      {row.kind === 'node-pair' ? nodeSelect(index, row, 'b', 'beam.contactNodeB') : null}
      <p>{t(row.kind === 'node-plane' ? 'beam.contactPlaneDirection' : 'beam.contactPairDirection')}</p>
      <div className="pcad-beam__numbers">
        {normalFields.map((name, axis) => field(name, `contact:${row.id}:${name}`, row.normal[axis],
          source => edit({ kind: 'contact-value', index, field: name, source })))}
        {field('gap', `contact:${row.id}:gap`, row.gap, source => edit({ kind: 'contact-value', index, field: 'gap', source }))}
      </div>
      <button type="button" className="pcad-button" data-beam-contact-remove={row.id}
        onClick={() => { edit({ kind: 'contact-remove', index }); addContact.current?.focus(); }} title={t('beam.guide.contactRemove')}>
        {t('beam.contactRemove')}</button>
    </fieldset>)}
    <button ref={addContact} type="button" className="pcad-button" data-testid="beam-contact-add"
      disabled={draft.rows.length >= MAX_BEAM_CONTACTS}
      onClick={() => edit({ kind: 'contact-add' })} title={t('beam.guide.contactAdd')}>{t('beam.contactAdd')}</button>
    <fieldset data-testid="beam-contact-factors">
      <legend>{t('beam.contactLoadFactors')}</legend>
      <p>{t('beam.contactLoadFactorsHelp')}</p>
      {draft.loadFactors.map((source, index) => <div key={index} data-beam-contact-factor={index}>
        {field('loadFactor', `contact:factor:${index}`, source, value => edit({ kind: 'contact-factor', index, source: value }))}
        <button type="button" className="pcad-button" data-beam-contact-factor-remove={index} disabled={draft.loadFactors.length <= 1}
          onClick={() => { edit({ kind: 'contact-factor-remove', index }); addFactor.current?.focus(); }} title={t('beam.guide.contactRemoveFactor')}>
          {t('beam.contactRemoveFactor')}</button>
      </div>)}
      <button ref={addFactor} type="button" className="pcad-button" data-testid="beam-contact-factor-add"
        disabled={draft.loadFactors.length >= MAX_CONTACT_LOAD_FACTORS}
        onClick={() => edit({ kind: 'contact-factor-add' })} title={t('beam.guide.contactAddFactor')}>{t('beam.contactAddFactor')}</button>
    </fieldset>
  </fieldset>;
}
