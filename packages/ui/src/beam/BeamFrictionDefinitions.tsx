import { useEffect, useRef } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { ExpressionField } from '../sketch/ExpressionField.js';
import { useAppStore } from '../store/useAppStore.js';
import { beamExpressionField, contactExpressionField, type BeamFieldName } from './beamFields.js';
import { beamContactNodes, type BeamSession } from './beamSession.js';

/** Session-owned absolute loads, not factors of the member endpoint loads. No separate local draft. */
export function BeamFrictionDefinitions({ session }: { readonly session: BeamSession }): React.JSX.Element {
  const parameters = useAppStore(state => state.assembly?.parameters ?? state.document.parameters);
  const edit = useAppStore(state => state.editBeam);
  const addStep = useRef<HTMLButtonElement>(null);
  const addLoad = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<'step' | 'load' | null>(null);
  const draft = session.friction;
  const nodes = beamContactNodes(session);
  const scalar = (key: string, labelKey: MessageKey, source: string, integer: boolean,
    change: (source: string) => void): React.JSX.Element => {
    const value = contactExpressionField('loadFactor', key, source, parameters);
    const number = value.result.value?.value;
    const invalid = number !== undefined && (integer ? !Number.isSafeInteger(number) || number <= 0 : number < 0);
    return <div data-friction-field={key}><ExpressionField {...value}
      field={{ ...value.field, labelKey }} result={invalid
        ? { key, value: null, error: { code: 'outOfRange', position: -1, message: t('beam.error.range') } } : value.result}
      focused={session.focusedField === key} onFocus={() => edit({ kind: 'focus', field: key })} onChange={change} /></div>;
  };
  const axes = [0, 1, 2] as const;
  const fields: Readonly<Record<'force' | 'moment', readonly BeamFieldName[]>> = {
    force: ['endFx', 'endFy', 'endFz'], moment: ['endMx', 'endMy', 'endMz'],
  };
  const firstLoads = draft.steps[0]?.loads ?? [];
  // At the 32-stage limit the add button is still disabled inside the delete handler.
  // Restore focus after React commits its enabled state; never keep another input draft here.
  useEffect(() => {
    const target = pendingFocus.current;
    pendingFocus.current = null;
    if (target === 'step') addStep.current?.focus();
    if (target === 'load') addLoad.current?.focus();
  }, [draft.steps.length, firstLoads.length]);
  const nextLoadId = (): string => {
    let index = 1;
    while (firstLoads.some(load => load.id === `friction-load-${index}`)) index += 1;
    return `friction-load-${index}`;
  };
  return <fieldset data-testid="beam-friction-definitions">
    <legend>{t('beam.frictionDefinitions')}</legend>
    <p>{t('beam.frictionLoadsHelp')}</p>
    {session.contact.rows.map(row => <fieldset key={row.id}><legend>{row.id}</legend>
      {scalar(`friction:coefficient:${row.id}`, 'beam.frictionCoefficient', draft.coefficients[row.id] ?? '', false,
        source => edit({ kind: 'friction-coefficient', contactId: row.id, source }))}</fieldset>)}
    <label>{t('beam.frictionSolver')}<select data-testid="beam-friction-solver" value={draft.solver}
      title={t('beam.guide.frictionSolver')} onChange={event => {
        const value = event.target.value;
        if (value === 'newton' || value === 'nsgs') edit({ kind: 'friction-solver', value });
      }}>
      <option value="newton">{t('beam.frictionNewton')}</option>
      <option value="nsgs">{t('beam.frictionNsgs')}</option>
    </select></label>
    {scalar('friction:iterationLimit', 'beam.frictionIterationLimit', draft.iterationLimit, true,
      source => edit({ kind: 'friction-iteration-limit', source }))}
    <fieldset><legend>{t('beam.frictionLoadNodes')}</legend>
      <p>{t('beam.frictionLoadNodesHelp')}</p>
      {firstLoads.map((load, index) => <div key={load.id} data-friction-load-node-row={load.id}>
        <label>{load.id}<select value={load.nodeId} data-friction-load-node={load.id}
          aria-invalid={!nodes.some(node => node.nodeId === load.nodeId) || undefined}
          title={t('beam.guide.contactNode')}
          onChange={event => edit({ kind: 'friction-load-node', index, nodeId: event.target.value })}>
          {!nodes.some(node => node.nodeId === load.nodeId) ? <option value={load.nodeId}>{t('beam.contactMissingNode')}: {load.nodeId}</option> : null}
          {nodes.map(node => <option key={node.nodeId} value={node.nodeId}>{node.label}: {t(node.end === 'start' ? 'beam.start' : 'beam.end')}</option>)}
        </select></label>
        <button type="button" className="pcad-button" data-friction-load-remove={index} disabled={firstLoads.length <= 1}
          title={t('beam.frictionRemoveLoad')}
          onClick={() => { pendingFocus.current = 'load'; edit({ kind: 'friction-load-remove', index }); }}>{t('beam.frictionRemoveLoad')}</button>
      </div>)}
      <button ref={addLoad} type="button" className="pcad-button" data-testid="beam-friction-load-add"
        disabled={nodes.length === 0 || firstLoads.length >= 1024} title={t('beam.frictionAddLoad')}
        onClick={() => {
          const node = nodes[0];
          if (node !== undefined) edit({ kind: 'friction-load-add', id: nextLoadId(), nodeId: node.nodeId });
        }}>{t('beam.frictionAddLoad')}</button>
    </fieldset>
    {draft.steps.map((step, stepIndex) => <fieldset key={stepIndex} data-friction-input-step={stepIndex}>
      <legend>{t('beam.frictionStep')} {stepIndex + 1}</legend>
      {step.loads.map((load, loadIndex) => <fieldset key={load.id} data-friction-step-load={load.id}>
        <legend>{load.id}: {load.nodeId}</legend>
        {(['force', 'moment'] as const).map(quantity => <div key={quantity} className="pcad-beam__numbers">
          {axes.map(axis => {
            const name = fields[quantity][axis];
            const key = `friction:step:${stepIndex}:load:${loadIndex}:${quantity}:${axis}`;
            const value = beamExpressionField(name, load[quantity][axis], parameters);
            return <div key={key} data-friction-field={key}><ExpressionField {...value}
              field={{ ...value.field, key }} result={{ ...value.result, key }}
              focused={session.focusedField === key} onFocus={() => edit({ kind: 'focus', field: key })}
              onChange={source => edit({ kind: 'friction-load-value', step: stepIndex, load: loadIndex, field: quantity, axis, source })} /></div>;
          })}
        </div>)}
      </fieldset>)}
      <button type="button" className="pcad-button" data-friction-step-remove={stepIndex}
        disabled={draft.steps.length <= 1} title={t('beam.frictionRemoveStep')}
        onClick={() => { pendingFocus.current = 'step'; edit({ kind: 'friction-step-remove', index: stepIndex }); }}>{t('beam.frictionRemoveStep')}</button>
    </fieldset>)}
    <button ref={addStep} type="button" className="pcad-button" data-testid="beam-friction-step-add"
      disabled={draft.steps.length >= 32} title={t('beam.frictionAddStep')}
      onClick={() => edit({ kind: 'friction-step-add' })}>{t('beam.frictionAddStep')}</button>
  </fieldset>;
}
