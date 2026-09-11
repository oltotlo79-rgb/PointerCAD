import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

export function sheetCheckbox(label: string, checked: boolean, change: (next: boolean) => void, key: string) {
  return <label key={key} className="pcad-sheet-metal__check"><input type="checkbox" checked={checked} onChange={(event) => {
    useAppStore.getState().clearSheetMetalPreview(); change(event.target.checked);
  }} />{label}</label>;
}

export function sheetSelect(label: MessageKey, value: string, change: (value: string) => void, options: readonly { key: string; name: string }[]) {
  return <label className="pcad-field"><span>{t(label)}</span><select value={value} onChange={(event) => {
    useAppStore.getState().clearSheetMetalPreview(); change(event.target.value);
  }}>
    {options.some((option) => option.key === value) ? null : <option value={value} disabled>{t('sheetMetal.chooseReference')}</option>}
    {options.map((option) => <option key={option.key} value={option.key}>{option.name}</option>)}
  </select></label>;
}
