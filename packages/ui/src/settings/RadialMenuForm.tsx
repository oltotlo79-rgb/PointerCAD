import { useId, useState } from 'react';
import { COMMAND_DEFINITIONS, type CommandDocumentKind, type CommandId } from '../commands/commandDefinitions.js';
import { defaultRadialCommandIds } from '../commands/radialCommandItems.js';
import {
  checkedRadialCommands, EMPTY_RADIAL_COMMANDS, RADIAL_DOCUMENT_KINDS, RADIAL_SLOT_COUNT, radialCommandFits, type EightCommands,
  type RadialCommands,
} from '../commands/radialCommandSettings.js';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

const KIND_KEYS: Readonly<Record<CommandDocumentKind, MessageKey>> = {
  part: 'settings.radial.kind.part', assembly: 'settings.radial.kind.assembly', drawing: 'settings.radial.kind.drawing',
};
/** 8 つの方向(上・右上・右・右下・下・左下・左・左上。放射メニューの並びと同じ)。 */
const SLOT_KEYS = [
  'settings.radial.slot.up', 'settings.radial.slot.upRight', 'settings.radial.slot.right', 'settings.radial.slot.downRight',
  'settings.radial.slot.down', 'settings.radial.slot.downLeft', 'settings.radial.slot.left', 'settings.radial.slot.upLeft',
] as const satisfies readonly MessageKey[];

/** 下書き: 種類ごとの 8 つ(重なりのある並びも、見せて断るために持つ)。欄の無い種類は既定。 */
type RadialDraft = Readonly<Partial<Record<CommandDocumentKind, readonly CommandId[]>>>;

/** その種類で置ける命令(名前の順)。 */
function choicesFor(kind: CommandDocumentKind): readonly { readonly id: CommandId; readonly label: string }[] {
  return COMMAND_DEFINITIONS.filter(item => radialCommandFits(item.id, kind)).map(item => ({ id: item.id, label: t(item.labelKey) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ja'));
}

/** 下書きの種類 kind の並びを list に替える(null は既定へ戻す=欄を除く)。ほかの種類はそのまま。 */
function replaceKind(value: RadialDraft, kind: CommandDocumentKind, list: readonly CommandId[] | null): RadialDraft {
  const next: Partial<Record<CommandDocumentKind, readonly CommandId[]>> = {};
  for (const item of RADIAL_DOCUMENT_KINDS) {
    const current = item === kind ? list : value[item];
    if (current !== undefined && current !== null) next[item] = current;
  }
  return Object.freeze(next);
}

/** 下書きを保存の形へ。どれかの種類の並びが検査を通らなければ null(適用しない)。 */
function draftCommands(draft: RadialDraft): RadialCommands | null {
  const commands: Partial<Record<CommandDocumentKind, EightCommands>> = {};
  for (const kind of RADIAL_DOCUMENT_KINDS) {
    const list = draft[kind];
    if (list === undefined) continue;
    const checked = checkedRadialCommands(list, kind);
    if (checked === null) return null;
    commands[kind] = checked;
  }
  return Object.freeze(commands);
}

/**
 * 放射メニュー(右クリックの道具一覧)の中身(設計 2-4・B-08f、操作の割り当ての窓のタブ「放射メニュー」)。文書の種類を選び、
 * 8 つの方向に命令を選ぶ。同じ命令を 2 か所に置く下書きは適用を断る。下書きは適用するまで保存しない。
 */
export function RadialMenuForm(): React.JSX.Element {
  const id = useId();
  const saved = useAppStore(state => state.displaySettings);
  const [kind, setKind] = useState<CommandDocumentKind>('part');
  const [draft, setDraft] = useState<RadialDraft | null>(null);
  const value: RadialDraft = draft ?? saved.radialCommands ?? EMPTY_RADIAL_COMMANDS;
  const slots: readonly CommandId[] = value[kind] ?? defaultRadialCommandIds(kind);
  const duplicated = new Set(slots).size !== RADIAL_SLOT_COUNT;
  const choices = choicesFor(kind);
  const recovered = saved.radialCommandsRecovered ?? 0;
  const choose = (index: number, commandId: string): void => {
    const picked = choices.find(item => item.id === commandId)?.id;
    if (picked !== undefined) setDraft(replaceKind(value, kind, slots.map((current, slot) => slot === index ? picked : current)));
  };
  return <form className="pcad-settings__group pcad-camera-settings" aria-label={t('settings.radial.title')} aria-describedby={`${id}-hint`}
    data-settings-draft={draft !== null} onSubmit={event => {
      event.preventDefault();
      const commands = draft === null ? null : draftCommands(draft);
      if (commands === null) return;
      useAppStore.getState().setDisplaySettings({ ...useAppStore.getState().displaySettings, radialCommands: commands,
        radialCommandsRecovered: undefined });
      setDraft(null);
    }}>
    <h3>{t('settings.radial.title')}</h3>
    {recovered > 0 ? <p role="status">{t('settings.radial.recovered').replace('{count}', String(recovered))}</p> : null}
    <label>
      {t('settings.radial.kind')}
      <select value={kind} aria-label={t('settings.radial.kind')} title={t('settings.radial.kindGuide')} onChange={event => {
        const next = RADIAL_DOCUMENT_KINDS.find(item => item === event.currentTarget.value);
        if (next !== undefined) setKind(next);
      }}>
        {RADIAL_DOCUMENT_KINDS.map(item => <option key={item} value={item}>{t(KIND_KEYS[item])}</option>)}
      </select>
    </label>
    {SLOT_KEYS.map((slotKey, index) => <label key={slotKey}>
      {t(slotKey)}
      <select value={slots[index]} aria-label={t(slotKey)} title={t('settings.radial.slotGuide').replace('{direction}', t(slotKey))}
        aria-invalid={slots.filter(item => item === slots[index]).length > 1}
        onChange={event => { choose(index, event.currentTarget.value); }}>
        {choices.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
    </label>)}
    {duplicated ? <p role="alert">{t('settings.radial.duplicate')}</p> : null}
    <div className="pcad-camera-settings__actions">
      <button type="submit" className="pcad-button" title={t('settings.radial.applyGuide')} disabled={draft === null || duplicated}>
        {t('settings.radial.apply')}</button>
      <button type="button" className="pcad-button" title={t('settings.radial.cancelGuide')} disabled={draft === null}
        onClick={() => { setDraft(null); }}>{t('settings.radial.cancel')}</button>
      <button type="button" className="pcad-button" title={t('settings.radial.defaultsGuide')}
        onClick={() => { setDraft(replaceKind(value, kind, null)); }}>{t('settings.radial.defaults')}</button>
    </div>
    <p id={`${id}-hint`}>{t('settings.radial.hint')}</p>
  </form>;
}
