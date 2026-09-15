import { useId, useState } from 'react';
import { t } from '../i18n/t.js';
import { COMMAND_DEFINITIONS, commandDefinition, type CommandId } from '../commands/commandDefinitions.js';
import { assignedChordLabel, canAssignShortcut, validateShortcutAssignments,
  type AssignmentProblem, type ShortcutAssignments } from '../commands/shortcutAssignments.js';
import { captureShortcutKey } from '../commands/shortcutKeyCapture.js';
import './shortcutSettings.css';

function commandName(id: string): string {
  const definition = commandDefinition(id);
  if (definition === null) return t('settings.shortcuts.unknown');
  const scope = definition.documentKinds.map(kind => t(`command.document.${kind}`)).join(t('command.document.separator'));
  return t('settings.shortcuts.scopedCommand').replace('{name}', t(definition.labelKey)).replace('{scope}', scope);
}
function problemText(problem: AssignmentProblem): string {
  switch (problem.kind) {
    case 'invalid': return t('settings.shortcuts.invalid');
    case 'unknown-command': return t('settings.shortcuts.unknown');
    case 'fixed-command': return t('settings.shortcuts.fixed');
    case 'reserved': return t('settings.shortcuts.reserved');
    case 'conflict': return t('settings.shortcuts.conflict').replace('{first}', commandName(problem.commandId))
      .replace('{second}', commandName(problem.otherCommandId));
  }
}
function labels(id: CommandId, values: ShortcutAssignments): string {
  const assigned = values[id];
  if (assigned === null) return t('settings.shortcuts.unassigned');
  if (assigned !== undefined) return assignedChordLabel(assigned);
  const definition = commandDefinition(id);
  return [...new Set(definition?.shortcuts.map(binding => binding.display) ?? [])].join(' / ')
    || t('settings.shortcuts.unassigned');
}

/** One draft allows a key swap; validation and application always cover the whole map. */
export function ShortcutAssignmentsForm({ current, onApply }: {
  readonly current: ShortcutAssignments;
  readonly onApply: (next: ShortcutAssignments, expected: ShortcutAssignments) => boolean;
}): React.JSX.Element {
  const id = useId();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CommandId>('file.open');
  const [draft, setDraft] = useState<ShortcutAssignments | null>(null);
  const [base, setBase] = useState<ShortcutAssignments | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const values = draft ?? current;
  const choices = COMMAND_DEFINITIONS.filter(definition => commandName(definition.id).includes(query.trim()));
  const command = choices.find(definition => definition.id === selected) ?? choices[0];
  const adjustable = command !== undefined && canAssignShortcut(command.id);
  const validation = validateShortcutAssignments(values);
  const stale = draft !== null && base !== current;
  const change = (next: ShortcutAssignments): void => {
    if (draft === null) setBase(current);
    setDraft(next); setCaptureError(null); setStatus(null);
  };
  const cancel = (): void => { setDraft(null); setBase(null); setCaptureError(null); setStatus(null); };
  return <form className="pcad-settings__group pcad-shortcut-settings" aria-label={t('settings.shortcuts.title')}
    data-help-topic="shortcuts" onSubmit={event => {
      event.preventDefault();
      if (draft === null || base === null || stale || !validation.ok) return;
      if (!onApply(validation.assignments, base)) { setStatus(t('settings.shortcuts.stale')); return; }
      cancel(); setStatus(t('settings.shortcuts.applied'));
    }}>
    <h3>{t('settings.shortcuts.title')}</h3>
    <p>{t('settings.shortcuts.hint')}</p>
    <label htmlFor={`${id}-search`}>{t('settings.shortcuts.search')}</label>
    <input title={t('settings.shortcuts.searchGuide')} id={`${id}-search`} className="pcad-field__input" value={query} onChange={event => setQuery(event.currentTarget.value)} />
    <label htmlFor={`${id}-command`}>{t('settings.shortcuts.command')}</label>
    <select title={t('settings.shortcuts.commandGuide')} id={`${id}-command`} value={command?.id ?? ''} disabled={command === undefined} onChange={event => {
      const next = commandDefinition(event.currentTarget.value);
      if (next !== null) { setSelected(next.id); setCaptureError(null); }
    }}>
      {choices.map(definition => <option key={definition.id} value={definition.id}>{commandName(definition.id)}</option>)}
    </select>
    {command === undefined ? <p role="status">{t('settings.shortcuts.notFound')}</p> : <>
      <p>{t('settings.shortcuts.current')}: <kbd>{labels(command.id, current)}</kbd></p>
      <label htmlFor={`${id}-capture`}>{t('settings.shortcuts.capture')}</label>
      <input title={t(adjustable ? 'settings.shortcuts.captureHint' : 'settings.shortcuts.fixed')} id={`${id}-capture`} className="pcad-field__input" readOnly disabled={!adjustable}
        value={labels(command.id, values)} aria-describedby={`${id}-capture-hint`} onKeyDown={event => {
          const result = captureShortcutKey(event.nativeEvent);
          if (result.status === 'pass-through') return;
          event.preventDefault(); event.stopPropagation();
          if (result.status === 'cancelled') { cancel(); return; }
          if (result.status === 'ignored') return;
          if (result.status === 'captured') change({ ...values, [command.id]: result.chord });
          else setCaptureError(t(result.reason === 'composition' ? 'settings.shortcuts.composition'
            : result.reason === 'reserved' ? 'settings.shortcuts.reserved' : 'settings.shortcuts.invalid'));
        }} />
      <p id={`${id}-capture-hint`}>{t(adjustable ? 'settings.shortcuts.captureHint' : 'settings.shortcuts.fixed')}</p>
      <div className="pcad-shortcut-settings__actions">
        <button type="button" className="pcad-button" title={t('settings.shortcuts.removeGuide')} disabled={!adjustable} onClick={() => change({ ...values, [command.id]: null })}>
          {t('settings.shortcuts.remove')}</button>
        <button type="button" className="pcad-button" title={t('settings.shortcuts.restoreOneGuide')} disabled={!adjustable} onClick={() => {
          const next = { ...values }; delete next[command.id]; change(next);
        }}>{t('settings.shortcuts.restoreOne')}</button>
      </div>
    </>}
    {captureError === null ? null : <p role="alert">{captureError}</p>}
    {validation.ok ? null : <p role="alert">{problemText(validation.problem)}</p>}
    {stale ? <p role="alert">{t('settings.shortcuts.stale')}</p> : null}
    {status === null ? null : <p role="status">{status}</p>}
    <div className="pcad-shortcut-settings__actions">
      <button type="submit" className="pcad-button" title={t('settings.shortcuts.applyGuide')} disabled={draft === null || stale || !validation.ok}>
        {t('settings.shortcuts.apply')}</button>
      <button type="button" className="pcad-button" title={t('settings.shortcuts.cancelGuide')} disabled={draft === null && captureError === null} onClick={cancel}>
        {t('settings.shortcuts.cancel')}</button>
      <button type="button" className="pcad-button" title={t('settings.shortcuts.restoreAllGuide')} onClick={() => change({})}>
        {t('settings.shortcuts.restoreAll')}</button>
    </div>
  </form>;
}
