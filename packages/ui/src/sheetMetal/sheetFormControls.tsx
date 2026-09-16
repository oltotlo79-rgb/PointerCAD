import type { JSX } from 'react';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

export const SHEET_SELECT_HINTS = {
  'sheetMetal.profile': 'sheetMetal.guide.profile',
  'sheetMetal.flangeProfile': 'sheetMetal.guide.flangeProfile',
  'sheetMetal.target': 'sheetMetal.guide.target',
  'sheetMetal.panel': 'sheetMetal.guide.panel',
  'sheetMetal.bendLine': 'sheetMetal.guide.bendLine',
  'sheetMetal.fixedSide': 'sheetMetal.guide.fixedSide',
  'sheetMetal.reliefEdge': 'sheetMetal.guide.reliefEdge',
  'sheetMetal.reliefShape': 'sheetMetal.guide.reliefShape',
  'sheetMetal.profileMode': 'sheetMetal.guide.profileMode',
  'sheetMetal.lengthBasis': 'sheetMetal.guide.lengthBasis',
  'sheetMetal.baseline': 'sheetMetal.guide.baseline',
} as const satisfies Partial<Record<MessageKey, MessageKey>>;

export function sheetCheckbox(label: string, checked: boolean, change: (next: boolean) => void, key: string, hint: MessageKey): JSX.Element {
  return <label key={key} className="pcad-sheet-metal__check"><input title={t(hint)} type="checkbox" checked={checked} onChange={(event) => {
    useAppStore.getState().clearSheetMetalPreview(); change(event.target.checked);
  }} />{label}</label>;
}

export function sheetSelect(label: keyof typeof SHEET_SELECT_HINTS, value: string, change: (value: string) => void, options: readonly { key: string; name: string }[]): JSX.Element {
  return <label className="pcad-field"><span>{t(label)}</span><select title={t(SHEET_SELECT_HINTS[label])} value={value} onChange={(event) => {
    useAppStore.getState().clearSheetMetalPreview(); change(event.target.value);
  }}>
    {options.some((option) => option.key === value) ? null : <option value={value} disabled>{t('sheetMetal.chooseReference')}</option>}
    {options.map((option) => <option key={option.key} value={option.key}>{option.name}</option>)}
  </select></label>;
}
