import { useId, useMemo, useState } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { commandDefinition, type CommandId } from '../commands/commandDefinitions.js';
import { canAssignShortcut, chordBrowserWarning, chordsOf, commandChordLabel, commandsUsingChord, effectiveBindings, shortcutConflicts,
  validateShortcutAssignments, type AssignmentProblem, type CommandChord, type ShortcutAssignments } from '../commands/shortcutAssignments.js';
import { captureShortcutKey, type CapturedShortcut } from '../commands/shortcutKeyCapture.js';
import { adjacentRow, conflictsOfCommand, filterKeyBindingRows, keyBindingRows, restoreCommand, swapWithOther, takeFromOther,
  viewKeyCollisions, type KeyBindingRow } from './inputBindingsDraft.js';
import { viewTriggerLabel } from './inputCapture.js';
import type { ViewAction, ViewControlSettings } from './viewControlSettings.js';
import './shortcutSettings.css';

const VIEW_ACTION_KEYS: Readonly<Record<ViewAction, MessageKey>> = {
  orbit: 'settings.camera.orbit', pan: 'settings.camera.pan', zoom: 'settings.camera.zoom',
};
function commandLabel(id: string): string {
  const definition = commandDefinition(id);
  return definition === null ? t('settings.shortcuts.unknown') : t(definition.labelKey);
}
function scopeText(id: string): string {
  const definition = commandDefinition(id);
  return definition === null ? '' : definition.documentKinds.map(kind => t(`command.document.${kind}`)).join(t('command.document.separator'));
}
function commandName(id: string): string {
  if (commandDefinition(id) === null) return t('settings.shortcuts.unknown');
  return t('settings.shortcuts.scopedCommand').replace('{name}', commandLabel(id)).replace('{scope}', scopeText(id));
}
function problemText(problem: AssignmentProblem): string {
  switch (problem.kind) {
    case 'invalid': return t('settings.shortcuts.invalid');
    case 'unknown-command': return t('settings.shortcuts.unknown');
    case 'fixed-command': return t('settings.shortcuts.fixed');
    case 'reserved': return t('settings.shortcuts.reserved');
    case 'too-many-chords': return t('settings.shortcuts.tooMany');
    case 'conflict': return t('settings.shortcuts.conflict').replace('{first}', commandName(problem.commandId))
      .replace('{second}', commandName(problem.otherCommandId));
  }
}
/** 取り込みで断った理由の文。 */
function refusalText(result: Extract<CapturedShortcut, { status: 'rejected' }>): string {
  const key: MessageKey = result.reason === 'composition' ? 'settings.shortcuts.composition'
    : result.reason === 'reserved' ? 'settings.shortcuts.reserved' : 'settings.shortcuts.invalid';
  return t(key);
}
function labels(id: CommandId, values: ShortcutAssignments): string {
  const definition = commandDefinition(id);
  if (definition === null || values[id] === null) return t('settings.shortcuts.unassigned');
  return [...new Set(effectiveBindings(definition, values).map(binding => binding.display))].join(' / ')
    || t('settings.shortcuts.unassigned');
}
/** 既定のキーのうち、ほかの操作に割り当てたため使っていない物の表示(利用者の割当を優先する)。 */
function unusedDefaults(id: CommandId, values: ShortcutAssignments): string {
  const definition = commandDefinition(id);
  if (definition === null || values[id] !== undefined) return '';
  const used = effectiveBindings(definition, values);
  return [...new Set(definition.shortcuts.filter(binding => !used.includes(binding)).map(binding => binding.display))].join(' / ');
}
/** 1 つ目の組を差し替え、2 つ目は残す(同じ組になる時は 2 つ目を外す)。 */
function withFirst(entry: ShortcutAssignments[CommandId], chord: CommandChord): readonly CommandChord[] {
  const second = chordsOf(entry)[1];
  return second === undefined || commandChordLabel(second) === commandChordLabel(chord) ? [chord] : [chord, second];
}

/** 操作の表(設計 §6.2「操作名｜使う場所｜今のキー」)。行を押すと選ぶ。↑↓ で前後の行へ移り、Enter で新しいキーの欄へ移る。 */
function KeyBindingsTable({ rows, selected, onSelect, onActivate }: {
  readonly rows: readonly KeyBindingRow[];
  readonly selected: CommandId | undefined;
  readonly onSelect: (id: CommandId) => void;
  readonly onActivate: () => void;
}): React.JSX.Element {
  const onRowKey = (event: React.KeyboardEvent<HTMLButtonElement>, id: CommandId): void => {
    if (event.key === 'Enter') { event.preventDefault(); onSelect(id); onActivate(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const next = adjacentRow(rows, id, event.key === 'ArrowDown' ? 1 : -1);
    if (next === null) return;
    onSelect(next);
    event.currentTarget.closest('tbody')?.querySelector<HTMLButtonElement>(`button[data-command-id="${next}"]`)?.focus();
  };
  return <div className="pcad-shortcut-settings__table-scroll">
    <table className="pcad-shortcut-settings__table" aria-label={t('settings.shortcuts.command')}>
      <thead><tr>
        <th scope="col">{t('settings.shortcuts.column.name')}</th><th scope="col">{t('settings.shortcuts.column.scope')}</th>
        <th scope="col">{t('settings.shortcuts.column.keys')}</th><th scope="col">{t('settings.shortcuts.column.state')}</th>
      </tr></thead>
      <tbody>{rows.map(row => <tr key={row.id} aria-selected={row.id === selected}>
        <td><button type="button" className="pcad-shortcut-settings__row-button" data-command-id={row.id} aria-pressed={row.id === selected}
          title={t('settings.shortcuts.commandGuide')} onClick={() => { onSelect(row.id); }}
          onKeyDown={event => { onRowKey(event, row.id); }}>{commandLabel(row.id)}</button></td>
        <td>{scopeText(row.id)}</td>
        <td>{row.keys.length === 0 ? t('settings.shortcuts.unassigned') : row.keys.join(' / ')}</td>
        <td>{row.fixed ? t('settings.shortcuts.fixedBadge') : row.conflict ? t('settings.shortcuts.conflictBadge') : ''}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

type KeySearch = { readonly status: 'idle' } | { readonly status: 'waiting' }
  | { readonly status: 'active'; readonly label: string; readonly ids: readonly CommandId[] };

/** 名前で探す・キーで探す・衝突と未割当だけ表示。 */
function KeyFilters({ id, query, onQuery, search, onSearch, problemsOnly, onProblemsOnly, values }: {
  readonly id: string;
  readonly query: string;
  readonly onQuery: (query: string) => void;
  readonly search: KeySearch;
  readonly onSearch: (search: KeySearch) => void;
  readonly problemsOnly: boolean;
  readonly onProblemsOnly: (value: boolean) => void;
  readonly values: ShortcutAssignments;
}): React.JSX.Element {
  return <>
    <label htmlFor={`${id}-search`}>{t('settings.shortcuts.search')}</label>
    <input title={t('settings.shortcuts.searchGuide')} id={`${id}-search`} className="pcad-field__input" value={query} onChange={event => { onQuery(event.currentTarget.value); }} />
    <div className="pcad-shortcut-settings__filters">
      <button type="button" className="pcad-button" title={t('settings.shortcuts.keySearchGuide')} aria-pressed={search.status === 'waiting'}
        onClick={() => { onSearch({ status: 'waiting' }); }} onKeyDown={event => {
          if (search.status !== 'waiting') return;
          const result = captureShortcutKey(event.nativeEvent);
          if (result.status === 'pass-through' || result.status === 'ignored') return;
          event.preventDefault(); event.stopPropagation();
          if (result.status === 'captured') onSearch({ status: 'active', label: commandChordLabel(result.chord), ids: commandsUsingChord(result.chord, values) });
          else onSearch({ status: 'idle' });
        }}>{search.status === 'waiting' ? t('settings.shortcuts.keySearchWaiting') : t('settings.shortcuts.keySearch')}</button>
      {search.status === 'active' ? <button type="button" className="pcad-button" title={t('settings.shortcuts.keySearchClearGuide')}
        onClick={() => { onSearch({ status: 'idle' }); }}>{t('settings.shortcuts.keySearchClear')}</button> : null}
      <label><input type="checkbox" checked={problemsOnly} title={t('settings.shortcuts.problemsOnlyGuide')}
        onChange={event => { onProblemsOnly(event.currentTarget.checked); }} />{t('settings.shortcuts.problemsOnly')}</label>
    </div>
    {search.status === 'active' ? <p role="status">{t('settings.shortcuts.keySearchActive').replace('{key}', search.label)}</p> : null}
  </>;
}

/** 選んだ操作の衝突と「入れ替える」「あちらを外して使う」(設計 §5)。 */
function ConflictActions({ conflicts, onSwap, onTake }: {
  readonly conflicts: readonly { readonly other: CommandId; readonly chord: string }[];
  readonly onSwap: (other: CommandId) => void;
  readonly onTake: (other: CommandId) => void;
}): React.JSX.Element | null {
  if (conflicts.length === 0) return null;
  return <>{conflicts.map(conflict => <div key={conflict.other} className="pcad-shortcut-settings__conflict">
    <p>{t('settings.shortcuts.conflictWith').replace('{key}', conflict.chord).replace('{other}', commandName(conflict.other))}</p>
    <button type="button" className="pcad-button" title={t('settings.shortcuts.swapGuide')} disabled={!canAssignShortcut(conflict.other)}
      onClick={() => { onSwap(conflict.other); }}>{t('settings.shortcuts.swap')}</button>
    <button type="button" className="pcad-button" title={t('settings.shortcuts.takeGuide')} disabled={!canAssignShortcut(conflict.other)}
      onClick={() => { onTake(conflict.other); }}>{t('settings.shortcuts.take')}</button>
  </div>)}</>;
}

/** One draft allows a key swap; validation and application always cover the whole map. */
export function ShortcutAssignmentsForm({ current, onApply, recovered = 0, viewControls }: {
  readonly current: ShortcutAssignments;
  readonly onApply: (next: ShortcutAssignments, expected: ShortcutAssignments) => boolean;
  /** 起動時に読めなかったため外した割当の件数(0 は知らせない)。 */
  readonly recovered?: number;
  /** 適用済みの視点の操作。視点のキーと同じ押し方の命令のキーは適用しない(B-08)。 */
  readonly viewControls?: ViewControlSettings;
}): React.JSX.Element {
  const id = useId();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<KeySearch>({ status: 'idle' });
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [selected, setSelected] = useState<CommandId>('file.open');
  const [draft, setDraft] = useState<ShortcutAssignments | null>(null);
  const [base, setBase] = useState<ShortcutAssignments | null>(null);
  /** 選んだ操作へ新しいキーを入れる前の下書き(「入れ替える」で相手へ前のキーを渡すため)。 */
  const [beforeChange, setBeforeChange] = useState<{ readonly id: CommandId; readonly values: ShortcutAssignments } | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const values = draft ?? current;
  const conflicts = useMemo(() => shortcutConflicts(values, current), [values, current]);
  const allRows = useMemo(() => keyBindingRows(values, conflicts), [values, conflicts]);
  const rows = filterKeyBindingRows(allRows, { name: commandName, query, usingKey: search.status === 'active' ? search.ids : null, problemsOnly });
  const command = commandDefinition(selected) ?? undefined;
  const adjustable = command !== undefined && canAssignShortcut(command.id);
  const validation = validateShortcutAssignments(values, current);
  const viewCollision = viewControls === undefined ? null : viewKeyCollisions(viewControls, values)[0] ?? null;
  const chords = command === undefined ? [] : chordsOf(values[command.id]);
  const unused = command === undefined ? '' : unusedDefaults(command.id, values);
  const stale = draft !== null && base !== current;
  const change = (next: ShortcutAssignments): void => {
    if (draft === null) setBase(current);
    setDraft(next); setCaptureError(null); setStatus(null);
  };
  const capture = (target: CommandId, next: ShortcutAssignments): void => {
    if (beforeChange?.id !== target) setBeforeChange({ id: target, values });
    change(next);
  };
  const cancel = (): void => { setDraft(null); setBase(null); setBeforeChange(null); setCaptureError(null); setStatus(null); };
  const conflictChord = (other: CommandId): CommandChord | undefined => conflicts.find(item =>
    (item.commandId === selected && item.otherCommandId === other) || (item.commandId === other && item.otherCommandId === selected))?.chord;
  return <form className="pcad-settings__group pcad-shortcut-settings" aria-label={t('settings.shortcuts.title')}
    data-help-topic="shortcuts" data-settings-draft={draft !== null} onSubmit={event => {
      event.preventDefault();
      if (draft === null || base === null || stale || !validation.ok || viewCollision !== null) return;
      if (!onApply(validation.assignments, base)) { setStatus(t('settings.shortcuts.stale')); return; }
      cancel(); setStatus(t('settings.shortcuts.applied'));
    }}>
    <h3>{t('settings.shortcuts.title')}</h3>
    <p>{t('settings.shortcuts.hint')}</p>
    <KeyFilters id={id} query={query} onQuery={setQuery} search={search} onSearch={setSearch} problemsOnly={problemsOnly}
      onProblemsOnly={setProblemsOnly} values={values} />
    <p>{t('settings.shortcuts.count').replace('{total}', String(allRows.length)).replace('{shown}', String(rows.length))
      .replace('{conflicts}', String(allRows.filter(row => row.conflict).length))}</p>
    {rows.length === 0 ? <p role="status">{t('settings.shortcuts.notFound')}</p>
      : <KeyBindingsTable rows={rows} selected={command?.id} onSelect={next => { setSelected(next); setCaptureError(null); }}
        onActivate={() => { document.getElementById(`${id}-capture`)?.focus(); }} />}
    {command === undefined ? null : <>
      <p>{t('settings.shortcuts.selected').replace('{name}', commandName(command.id))}</p>
      <p>{t('settings.shortcuts.current')}: <kbd>{labels(command.id, current)}</kbd></p>
      <label htmlFor={`${id}-capture`}>{t('settings.shortcuts.capture')}</label>
      <input title={t(adjustable ? 'settings.shortcuts.captureHint' : 'settings.shortcuts.fixed')} id={`${id}-capture`} className="pcad-field__input" readOnly disabled={!adjustable}
        value={chords[0] === undefined ? labels(command.id, values) : commandChordLabel(chords[0])} aria-describedby={`${id}-capture-hint`} onKeyDown={event => {
          const result = captureShortcutKey(event.nativeEvent);
          if (result.status === 'pass-through') return;
          event.preventDefault(); event.stopPropagation();
          if (result.status === 'cancelled') { cancel(); return; }
          if (result.status === 'ignored') return;
          if (result.status === 'captured') capture(command.id, { ...values, [command.id]: withFirst(values[command.id], result.chord) });
          else setCaptureError(refusalText(result));
        }} />
      <p id={`${id}-capture-hint`}>{t(adjustable ? 'settings.shortcuts.captureHint' : 'settings.shortcuts.fixed')}</p>
      <div className="pcad-shortcut-settings__second">
        <label htmlFor={`${id}-capture-second`}>{t('settings.shortcuts.captureSecond')}</label>
        <input title={t('settings.shortcuts.captureSecondGuide')} id={`${id}-capture-second`} className="pcad-field__input" readOnly
          disabled={!adjustable || chords.length === 0} value={chords[1] === undefined ? '' : commandChordLabel(chords[1])} onKeyDown={event => {
            const result = captureShortcutKey(event.nativeEvent);
            if (result.status === 'pass-through') return;
            event.preventDefault(); event.stopPropagation();
            if (result.status === 'cancelled') { cancel(); return; }
            if (result.status === 'ignored') return;
            if (result.status !== 'captured') { setCaptureError(refusalText(result)); return; }
            if (chords[0] !== undefined && commandChordLabel(chords[0]) !== commandChordLabel(result.chord)) {
              capture(command.id, { ...values, [command.id]: [chords[0], result.chord] });
            }
          }} />
        <button type="button" className="pcad-button" title={t('settings.shortcuts.removeSecondGuide')} disabled={!adjustable || chords.length < 2}
          onClick={() => { if (chords[0] !== undefined) change({ ...values, [command.id]: [chords[0]] }); }}>
          {t('settings.shortcuts.removeSecond')}</button>
      </div>
      {chords.some(chordBrowserWarning) ? <p role="status">{t('settings.shortcuts.browserWarning')}</p> : null}
      {unused === '' ? null : <p role="status">{t('settings.shortcuts.unusedDefault').replace('{keys}', unused)}</p>}
      <ConflictActions conflicts={conflictsOfCommand(conflicts, command.id)}
        onSwap={other => {
          const chord = conflictChord(other);
          if (chord !== undefined) change(swapWithOther(values, beforeChange?.id === command.id ? beforeChange.values : values, command.id, other, chord));
        }}
        onTake={other => { const chord = conflictChord(other); if (chord !== undefined) change(takeFromOther(values, other, chord)); }} />
      <div className="pcad-shortcut-settings__actions">
        <button type="button" className="pcad-button" title={t('settings.shortcuts.removeGuide')} disabled={!adjustable} onClick={() => { change({ ...values, [command.id]: null }); }}>
          {t('settings.shortcuts.remove')}</button>
        <button type="button" className="pcad-button" title={t('settings.shortcuts.restoreOneGuide')} disabled={!adjustable}
          onClick={() => { change(restoreCommand(values, command.id)); }}>{t('settings.shortcuts.restoreOne')}</button>
      </div>
    </>}
    {recovered > 0 && draft === null ? <p role="status">{t('settings.shortcuts.recovered').replace('{count}', String(recovered))}</p> : null}
    {captureError === null ? null : <p role="alert">{captureError}</p>}
    {validation.ok ? null : <p role="alert">{problemText(validation.problem)}</p>}
    {viewCollision === null ? null : <p role="alert">{t('settings.shortcuts.viewKeyCollision')
      .replace('{command}', commandLabel(viewCollision.commandId)).replace('{action}', t(VIEW_ACTION_KEYS[viewCollision.action]))
      .replace('{keys}', viewTriggerLabel(viewCollision.trigger))}</p>}
    {stale ? <p role="alert">{t('settings.shortcuts.stale')}</p> : null}
    {status === null ? null : <p role="status">{status}</p>}
    <div className="pcad-shortcut-settings__actions">
      <button type="submit" className="pcad-button" title={t('settings.shortcuts.applyGuide')} disabled={draft === null || stale || !validation.ok || viewCollision !== null}>
        {t('settings.shortcuts.apply')}</button>
      <button type="button" className="pcad-button" title={t('settings.shortcuts.cancelGuide')} disabled={draft === null && captureError === null} onClick={cancel}>
        {t('settings.shortcuts.cancel')}</button>
      <button type="button" className="pcad-button" title={t('settings.shortcuts.restoreAllGuide')} onClick={() => { change({}); }}>
        {t('settings.shortcuts.restoreAll')}</button>
    </div>
  </form>;
}
