/**
 * 付属の組の欄(A2。選ぶ窓・一括配置・一筆書きで同じ部品)。置く本体に当てはまる組が 1 つも無い時は何も出さない(鋼材・機械要素も、組を
 * 登録すれば同じ欄が出る)。欄は「付属の部品」と、組を選んだ時の「付ける端」(1 本を置く時だけ)・「線の端の意味」・「行」(候補が 2 つ以上の時)。
 * 選んだ値はアプリを閉じるまで覚える(accessoryChoice.ts)。全部の欄に説明(title)を付ける(controlInventory)。
 */
import { useState } from 'react';

import type { AccessoryEnds, AccessoryEndReference, AccessorySetId } from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { displayNumber } from '../sketch/numericInputPresentation.js';
import {
  accessoryPreview, effectiveAccessory, rememberAccessory, rememberedAccessory, type AccessoryOption, type AccessorySelection,
} from './accessoryChoice.js';

const ENDS: readonly AccessoryEnds[] = ['both', 'start', 'end'];
const END_REFERENCES: readonly AccessoryEndReference[] = ['overall', 'member'];
const SET_LABEL_KEYS: Readonly<Record<AccessorySetId, MessageKey>> = {
  'frame-end-caps': 'assembly.accessory.setFrameEndCaps', 'bolt-washer-nut': 'assembly.accessory.setBoltWasherNut',
};
const ENDS_KEYS = { both: 'assembly.accessory.endsBoth', start: 'assembly.accessory.endsStart', end: 'assembly.accessory.endsEnd' } as const;
const REFERENCE_KEYS = { overall: 'assembly.accessory.referenceOverall', member: 'assembly.accessory.referenceMember' } as const;

interface AccessoryFieldsProps {
  readonly options: readonly AccessoryOption[];
  /** 本体の長さ(mm。予告の本体の長さに使う)。一括配置は線ごとに違うので null。 */
  readonly lengthMm: number | null;
  /** 付ける端の欄を出すか(1 本を置く時だけ。一括配置・一筆書きは端ごとに自動で決める)。 */
  readonly showEnds: boolean;
}

function previewText(options: readonly AccessoryOption[], selection: AccessorySelection, lengthMm: number | null, showEnds: boolean): string | null {
  const active = effectiveAccessory(options, selection);
  if (active === null) return null;
  const preview = accessoryPreview(lengthMm, active.candidate.thicknessMm, active.ends, active.endReference);
  const key = !showEnds ? 'assembly.accessory.previewLayout' : preview.hostLengthMm === null ? 'assembly.accessory.previewNoLength'
    : 'assembly.accessory.preview';
  return t(key).replace('{length}', preview.hostLengthMm === null ? '' : displayNumber(preview.hostLengthMm).text)
    .replace('{name}', active.candidate.size).replace('{count}', String(preview.count))
    .replace('{thickness}', displayNumber(active.candidate.thicknessMm).text);
}

export function AccessoryFields({ options, lengthMm, showEnds }: AccessoryFieldsProps): React.JSX.Element | null {
  const [selection, setSelection] = useState<AccessorySelection>(rememberedAccessory);
  if (options.length === 0) return null;
  const change = (patch: Partial<AccessorySelection>): void => {
    const next = { ...selection, ...patch };
    rememberAccessory(next);
    setSelection(next);
  };
  const active = effectiveAccessory(options, selection);
  const candidates = options.find((item) => item.setId === active?.setId)?.candidates ?? [];
  const preview = previewText(options, selection, lengthMm, showEnds);
  return (<fieldset className="pcad-popover__fields pcad-accessory">
    <label className="pcad-field">
      <span className="pcad-field__label">{t('assembly.accessory.set')}</span>
      <select title={t('assembly.accessory.setGuide')} className="pcad-field__input" value={active?.setId ?? ''}
        onChange={(event) => { const value = options.find((item) => item.setId === event.currentTarget.value)?.setId ?? null; change({ setId: value }); }}>
        <option value="">{t('assembly.accessory.none')}</option>
        {options.map((item) => <option key={item.setId} value={item.setId}>{t(SET_LABEL_KEYS[item.setId])}</option>)}
      </select>
    </label>
    {active === null ? null : <>
      {showEnds ? <label className="pcad-field">
        <span className="pcad-field__label">{t('assembly.accessory.ends')}</span>
        <select title={t('assembly.accessory.endsGuide')} className="pcad-field__input" value={active.ends}
          onChange={(event) => { const value = ENDS.find((item) => item === event.currentTarget.value); if (value !== undefined) change({ ends: value }); }}>
          {ENDS.map((item) => <option key={item} value={item}>{t(ENDS_KEYS[item])}</option>)}
        </select>
      </label> : null}
      <label className="pcad-field">
        <span className="pcad-field__label">{t('assembly.accessory.reference')}</span>
        <select title={t('assembly.accessory.referenceGuide')} className="pcad-field__input" value={active.endReference}
          onChange={(event) => {
            const value = END_REFERENCES.find((item) => item === event.currentTarget.value);
            if (value !== undefined) change({ endReference: value });
          }}>
          {END_REFERENCES.map((item) => <option key={item} value={item}>{t(REFERENCE_KEYS[item])}</option>)}
        </select>
      </label>
      {candidates.length < 2 ? null : <label className="pcad-field">
        <span className="pcad-field__label">{t('assembly.accessory.item')}</span>
        <select title={t('assembly.accessory.itemGuide')} className="pcad-field__input" value={active.candidate.itemKey}
          onChange={(event) => { change({ itemKey: event.currentTarget.value }); }}>
          {candidates.map((item) => <option key={item.itemKey} value={item.itemKey}>{item.size}</option>)}
        </select>
      </label>}
    </>}
    {preview === null ? null : <p className="pcad-popover__hint" role="status">{preview}</p>}
  </fieldset>);
}
