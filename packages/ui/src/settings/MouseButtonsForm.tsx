import { useId, useState } from 'react';
import { COMMAND_DEFINITIONS, type CommandId } from '../commands/commandDefinitions.js';
import {
  EMPTY_MOUSE_BUTTON_COMMANDS, POINTER_COMMAND_INPUTS, type MouseButtonCommands, type PointerCommandInput,
} from '../commands/pointerCommandGesture.js';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

const INPUT_KEYS: Readonly<Record<PointerCommandInput, MessageKey>> = {
  back: 'settings.mouseButtons.back', forward: 'settings.mouseButtons.forward', middleDouble: 'settings.mouseButtons.middleDouble',
};
const GUIDE_KEYS: Readonly<Record<PointerCommandInput, MessageKey>> = {
  back: 'settings.mouseButtons.backGuide', forward: 'settings.mouseButtons.forwardGuide', middleDouble: 'settings.mouseButtons.middleDoubleGuide',
};

/** 命令の選択肢(名前の順)。キーの表と同じ全ての命令。 */
function commandChoices(): readonly { readonly id: CommandId; readonly label: string }[] {
  return COMMAND_DEFINITIONS.map(item => ({ id: item.id, label: t(item.labelKey) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ja'));
}

/**
 * マウスのボタンの命令(設計 2-4・B-08e、操作の割り当ての窓のタブ「マウスのボタン」)。戻る・進むボタンと中ボタンの
 * ダブルクリックに命令を選ぶ。下書きは適用するまで保存しない(窓を閉じる時の確かめは data-settings-draft で行う)。
 */
export function MouseButtonsForm(): React.JSX.Element {
  const id = useId();
  const saved = useAppStore(state => state.displaySettings);
  const [draft, setDraft] = useState<MouseButtonCommands | null>(null);
  const value = draft ?? saved.mouseButtonCommands ?? EMPTY_MOUSE_BUTTON_COMMANDS;
  const recovered = saved.mouseButtonCommandsRecovered ?? 0;
  const choices = commandChoices();
  const choose = (input: PointerCommandInput, commandId: string): void => {
    const picked = choices.find(item => item.id === commandId)?.id;
    const next: Partial<Record<PointerCommandInput, CommandId>> = { ...value };
    if (picked === undefined) delete next[input]; else next[input] = picked;
    setDraft(Object.freeze(next));
  };
  return <form className="pcad-settings__group pcad-camera-settings" aria-label={t('settings.mouseButtons.title')}
    aria-describedby={`${id}-hint`} data-settings-draft={draft !== null} onSubmit={event => {
      event.preventDefault();
      if (draft === null) return;
      useAppStore.getState().setDisplaySettings({ ...useAppStore.getState().displaySettings, mouseButtonCommands: draft,
        mouseButtonCommandsRecovered: undefined });
      setDraft(null);
    }}>
    <h3>{t('settings.mouseButtons.title')}</h3>
    {recovered > 0 ? <p role="status">{t('settings.mouseButtons.recovered').replace('{count}', String(recovered))}</p> : null}
    {POINTER_COMMAND_INPUTS.map(input => <label key={input}>
      {t(INPUT_KEYS[input])}
      <select value={value[input] ?? ''} title={t(GUIDE_KEYS[input])} onChange={event => { choose(input, event.currentTarget.value); }}>
        <option value="">{t('settings.mouseButtons.none')}</option>
        {choices.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
    </label>)}
    <div className="pcad-camera-settings__actions">
      <button type="submit" className="pcad-button" title={t('settings.mouseButtons.applyGuide')} disabled={draft === null}>
        {t('settings.mouseButtons.apply')}</button>
      <button type="button" className="pcad-button" title={t('settings.mouseButtons.cancelGuide')} disabled={draft === null}
        onClick={() => { setDraft(null); }}>{t('settings.mouseButtons.cancel')}</button>
      <button type="button" className="pcad-button" title={t('settings.mouseButtons.clearGuide')}
        onClick={() => { setDraft(EMPTY_MOUSE_BUTTON_COMMANDS); }}>{t('settings.mouseButtons.clear')}</button>
    </div>
    <p id={`${id}-hint`}>{t('settings.mouseButtons.hint')}</p>
  </form>;
}
