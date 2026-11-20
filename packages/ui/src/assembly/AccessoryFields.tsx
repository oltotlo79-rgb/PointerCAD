/**
 * 付属の組の欄(A2。選ぶ窓・一括配置・一筆書きで同じ部品)。置く本体に当てはまる組が 1 つも無い時は何も出さない(鋼材・機械要素も、組を
 * 登録すれば同じ欄が出る)。欄は「付属の部品」と、組を選んだ時の「付ける端」(1 本を置く時だけ)・「線の端の意味」・「行」(候補が 2 つ以上の時)・
 * 「枝の向き」(鋼管の端の継手のエルボ・チーズの時。K-28 束 3)。
 * 選んだ値はアプリを閉じるまで覚える(accessoryChoice.ts)。全部の欄に説明(title)を付ける(controlInventory)。
 */
import { useEffect, useState } from 'react';

import { PRODUCT_CATALOG_REGISTRY, steelLength, type AccessoryEnds, type AccessoryEndReference, type AccessorySetId } from '@pointercad/model';

import { t, type MessageKey } from '../i18n/t.js';
import { displayNumber } from '../sketch/numericInputPresentation.js';
import {
  accessoryPreview, effectiveAccessory, effectiveBoltAccessory, rememberAccessory, rememberedAccessory, standardAccessoryFamilies,
  standardAccessoryOptionsFor, type AccessoryOption, type AccessorySelection, type AccessoryTurn,
} from './accessoryChoice.js';
import type { StandardPartCategory } from './standardPartPicker.js';

const ENDS: readonly AccessoryEnds[] = ['both', 'start', 'end'];
const END_REFERENCES: readonly AccessoryEndReference[] = ['overall', 'member'];
const TURNS: readonly AccessoryTurn[] = [0, 1, 2, 3];
const SET_LABEL_KEYS: Readonly<Record<AccessorySetId, MessageKey>> = {
  'frame-end-caps': 'assembly.accessory.setFrameEndCaps', 'bolt-washer-nut': 'assembly.accessory.setBoltWasherNut',
  'bearing-shaft-rings': 'assembly.accessory.setBearingShaftRings', 'bearing-bore-rings': 'assembly.accessory.setBearingBoreRings',
  'pipe-end-fittings': 'assembly.accessory.setPipeEndFittings',
};
const ENDS_KEYS = { both: 'assembly.accessory.endsBoth', start: 'assembly.accessory.endsStart', end: 'assembly.accessory.endsEnd' } as const;

/** 組ごとの「長さの意味」「行」の欄と予告の文(端のキャップと鋼管の端の継手。ほかの組は長さの意味の欄を出さない)。 */
interface SetTexts {
  readonly referenceGuide: MessageKey;
  readonly reference: Readonly<Record<AccessoryEndReference, MessageKey>>;
  readonly item: MessageKey;
  readonly itemGuide: MessageKey;
  readonly preview: MessageKey;
  readonly previewNoLength: MessageKey;
  readonly previewLayout: MessageKey;
}
const CAP_TEXTS: SetTexts = { referenceGuide: 'assembly.accessory.referenceGuide',
  reference: { overall: 'assembly.accessory.referenceOverall', member: 'assembly.accessory.referenceMember' },
  item: 'assembly.accessory.item', itemGuide: 'assembly.accessory.itemGuide', preview: 'assembly.accessory.preview',
  previewNoLength: 'assembly.accessory.previewNoLength', previewLayout: 'assembly.accessory.previewLayout' };
const PIPE_TEXTS: SetTexts = { referenceGuide: 'assembly.accessory.pipeReferenceGuide',
  reference: { overall: 'assembly.accessory.pipeReferenceOverall', member: 'assembly.accessory.pipeReferenceMember' },
  item: 'assembly.accessory.pipeItem', itemGuide: 'assembly.accessory.pipeItemGuide', preview: 'assembly.accessory.pipePreview',
  previewNoLength: 'assembly.accessory.pipePreviewNoLength', previewLayout: 'assembly.accessory.pipePreviewLayout' };
const textsOf = (setId: AccessorySetId): SetTexts => (setId === 'pipe-end-fittings' ? PIPE_TEXTS : CAP_TEXTS);

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
  const texts = textsOf(active.setId);
  const key = !showEnds ? texts.previewLayout : preview.hostLengthMm === null ? texts.previewNoLength : texts.preview;
  return t(key).replace('{length}', preview.hostLengthMm === null ? '' : displayNumber(preview.hostLengthMm).text)
    .replace('{name}', active.candidate.size).replace('{count}', String(preview.count))
    .replace('{thickness}', displayNumber(active.candidate.thicknessMm).text);
}

/** ボルトの座金とナットの組(A4)の欄: 締め付ける厚さ(空なら既定)・ばね座金の有無と予告。 */
function BoltAccessoryFields({ options, selection, change }: { readonly options: readonly AccessoryOption[];
  readonly selection: AccessorySelection; readonly change: (patch: Partial<AccessorySelection>) => void }): React.JSX.Element | null {
  const bolt = effectiveBoltAccessory(options, selection);
  const springAvailable = (options.find((item) => item.setId === 'bolt-washer-nut')?.defaultGripMm?.spring ?? null) !== null;
  if (bolt === null) return null;
  return (<>
    <label className="pcad-field">
      <span className="pcad-field__label">{t('assembly.accessory.grip')}</span>
      <input title={t('assembly.accessory.gripGuide')} className="pcad-field__input" value={selection.gripText ?? ''}
        placeholder={displayNumber(bolt.gripMm).text} onChange={(event) => { change({ gripText: event.currentTarget.value }); }} />
      <span className="pcad-field__unit">mm</span>
    </label>
    {springAvailable ? <label className="pcad-field" title={t('assembly.accessory.springGuide')}>
      <input type="checkbox" checked={bolt.springWasher} onChange={(event) => { change({ springWasher: event.currentTarget.checked }); }} />
      <span className="pcad-field__label">{t('assembly.accessory.spring')}</span>
    </label> : null}
    <p className="pcad-popover__hint" role="status">{t(bolt.springWasher ? 'assembly.accessory.previewBoltSpring' : 'assembly.accessory.previewBolt')
      .replace('{grip}', displayNumber(bolt.gripMm).text)}</p>
  </>);
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
      <select title={t('assembly.accessory.setGuide')} className="pcad-field__input"
        value={effectiveBoltAccessory(options, selection) === null ? active?.setId ?? '' : 'bolt-washer-nut'}
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
      {active.setId !== 'frame-end-caps' && active.setId !== 'pipe-end-fittings' ? null : <label className="pcad-field">
        <span className="pcad-field__label">{t('assembly.accessory.reference')}</span>
        <select title={t(textsOf(active.setId).referenceGuide)} className="pcad-field__input" value={active.endReference}
          onChange={(event) => {
            const value = END_REFERENCES.find((item) => item === event.currentTarget.value);
            if (value !== undefined) change({ endReference: value });
          }}>
          {END_REFERENCES.map((item) => <option key={item} value={item}>{t(textsOf(active.setId).reference[item])}</option>)}
        </select>
      </label>}
      {candidates.length < 2 ? null : <label className="pcad-field">
        <span className="pcad-field__label">{t(textsOf(active.setId).item)}</span>
        <select title={t(textsOf(active.setId).itemGuide)} className="pcad-field__input" value={active.candidate.itemKey}
          onChange={(event) => { change({ itemKey: event.currentTarget.value }); }}>
          {candidates.map((item) => <option key={item.itemKey} value={item.itemKey}>{item.size}</option>)}
        </select>
      </label>}
      {active.candidate.turnable !== true ? null : <label className="pcad-field">
        <span className="pcad-field__label">{t('assembly.accessory.turn')}</span>
        <select title={t('assembly.accessory.turnGuide')} className="pcad-field__input" value={String(active.turn)}
          onChange={(event) => { const value = TURNS.find((item) => String(item) === event.currentTarget.value); if (value !== undefined) change({ turn: value }); }}>
          {TURNS.map((item) => <option key={item} value={String(item)}>{`${String(item * 90)}°`}</option>)}
        </select>
      </label>}
    </>}
    {preview === null ? null : <p className="pcad-popover__hint" role="status">{preview}</p>}
    <BoltAccessoryFields options={options} selection={selection} change={change} />
  </fieldset>);
}

/**
 * 8 分類の窓の付属の組の欄(A4・A6・K-28 束 3)。深溝玉軸受は止め輪の族を読み込んでから組を出す(読み込みが済むと描き直す)。
 * 予告の管の長さは鋼材だけ、長さの欄の値を置く時と同じ判定(steelLength)で読む。ボルト・軸受は本体の長さを予告に使わない。
 */
export function StandardAccessoryFields({ choice }: { readonly choice: {
  readonly category: StandardPartCategory; readonly key: string; readonly lengthSource: string;
  readonly dimensionSeries: 'annexJA' | 'main'; readonly threadSeries: 'coarse' | 'fine' } }): React.JSX.Element | null {
  const [, setLoaded] = useState(0);
  const { category } = choice;
  useEffect(() => {
    const ids = standardAccessoryFamilies(category);
    if (ids.every((id) => PRODUCT_CATALOG_REGISTRY.loaded(id) !== undefined)) return undefined;
    let live = true;
    void PRODUCT_CATALOG_REGISTRY.ensure(ids).then(() => { if (live) setLoaded((count) => count + 1); }, () => {});
    return () => { live = false; };
  }, [category]);
  const lengthMm = category === 'structuralSection' ? steelLength(choice.lengthSource)?.value ?? null : null;
  return <AccessoryFields options={standardAccessoryOptionsFor(category, choice.key, choice.lengthSource, choice.dimensionSeries, choice.threadSeries)}
    lengthMm={lengthMm} showEnds />;
}
