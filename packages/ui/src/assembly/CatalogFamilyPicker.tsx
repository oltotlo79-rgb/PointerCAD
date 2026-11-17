/**
 * 選ぶ窓の族の分類(「機械要素」「アルミフレーム」。登録口の族)の中身: 分類 → 種類 → 材質(行の材質が 2 つ以上ある族だけ) → 呼び →
 * 長さなどの指定 → 置く(設計 §5.6 の最小の所)。族の表はこの分類を選んだ時にその分類の分だけ登録口が読み込み(`useCatalogFamilies`)、
 * 読み込みの状態の 1 行をここに出す。
 * 長さを持つ族(フレームなど)は、置いた部品の切断の一覧の表(`CatalogStockTable`)も出す。
 * 置いた後も窓と選択を残し、Enter でもう 1 個置ける(今の規格部品の窓と同じ。NFR-UX-4)。
 */
import { PRODUCT_CATALOG_REGISTRY, type CatalogRegistry } from '@pointercad/model';
import { useRef, useState, type RefObject } from 'react';

import { t } from '../i18n/t.js';
import { DraggableWindowTitle } from '../sketch/DraggableWindowTitle.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  catalogFamilyEntries, catalogRowLabel, FAMILY_KIND_FIELD_KEYS, familyHintKey, familyKindKey, familyMaterials, messageKeyOr,
  optionDefault, type FamilyPickerCategory,
} from './catalogFamilyChoices.js';
import type { CatalogLoadState } from './catalogFamilyLoading.js';
import { CatalogLoadStatus } from './CatalogLoadStatus.js';
import { CatalogStockTable } from './CatalogStockTable.js';
import { FrameLayoutDetails } from './FrameLayoutDetails.js';
import { pickerFormProps } from './pickerFormHandlers.js';

type LoadedFamily = NonNullable<ReturnType<CatalogRegistry['loaded']>>;

export interface CatalogFamilyPickerProps {
  /** 族の分類(機械要素・アルミフレーム)。種類の一覧をこの分類の族で絞る。 */
  readonly group: FamilyPickerCategory;
  /** 分類の欄(窓を開いた時に焦点を置く)。 */
  readonly firstRef: RefObject<HTMLSelectElement | null>;
  readonly catalogState: CatalogLoadState;
  /** 分類を変えた時(今の規格部品の分類へ戻る)。 */
  readonly onCategory: (value: string) => void;
  /** 分類の欄の選択肢(今の窓と同じ物)。 */
  readonly categoryOptions: readonly React.JSX.Element[];
}

/**
 * 族の長さなどの指定の欄(式の欄は入力、選択肢の欄は選ぶ欄)。入れていない欄は選んだ行の既定の値を出す。
 * 任意の欄(フレームの留め)は一括配置だけが書くので、ここには出さない。
 */
function optionFields(family: LoadedFamily, row: LoadedFamily['rows'][number] | undefined, values: Readonly<Record<string, string>>,
  invalid: boolean, change: (key: string, value: string) => void): React.JSX.Element[] {
  return family.options.filter((spec) => spec.optional !== true).map((spec) => <label key={spec.key}
    className={'pcad-field' + (invalid ? ' pcad-field--error' : '')}>
    <span className="pcad-field__label">{t(messageKeyOr(spec.labelKey, 'catalog.mechanical.length'))}</span>
    {spec.kind === 'choice' ? <select title={t('catalog.mechanical.optionGuide')} className="pcad-field__input"
      value={values[spec.key] ?? optionDefault(spec, row)} onChange={(event) => { change(spec.key, event.currentTarget.value); }}>
      {(spec.choices ?? []).map((choice) => <option key={choice} value={choice}>{choice}</option>)}
    </select> : <input title={t('catalog.mechanical.optionGuide')} className="pcad-field__input"
      value={values[spec.key] ?? optionDefault(spec, row)} aria-invalid={invalid ? true : undefined}
      onChange={(event) => { change(spec.key, event.currentTarget.value); }} />}
    {spec.kind === 'lengthExpression' ? <span className="pcad-field__unit">mm</span> : null}
  </label>);
}

export function CatalogFamilyPicker({ group, firstRef, catalogState, onCategory, categoryOptions }: CatalogFamilyPickerProps):
React.JSX.Element {
  const entries = catalogFamilyEntries(group);
  const [familyId, setFamilyId] = useState(entries[0]?.id ?? '');
  const [material, setMaterial] = useState('');
  const [itemKey, setItemKey] = useState('');
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [error, setError] = useState<'unknownChoice' | 'invalidOption' | null>(null);
  const composing = useRef(false);
  const compositionKey = useRef(false);
  const entry = entries.find((candidate) => candidate.id === familyId) ?? entries[0];
  const family = entry === undefined ? undefined : PRODUCT_CATALOG_REGISTRY.loaded(entry.id);
  const materials = family === undefined ? [] : familyMaterials(family);
  const activeMaterial = materials.includes(material) ? material : materials[0];
  const rows = family?.rows.filter((candidate) => materials.length < 2 || candidate.materialLabel === activeMaterial) ?? [];
  const row = rows.find((candidate) => candidate.key === itemKey) ?? rows[0];
  const hintKey = family === undefined ? null : familyHintKey(family);
  const submit = (): void => {
    if (family === undefined || row === undefined) { setError('unknownChoice'); return; }
    const placed = useAppStore.getState().placeCatalogItem(family.id, row.key, values);
    setError(placed ? null : family.options.length > 0 ? 'invalidOption' : 'unknownChoice');
  };
  const choose = (setter: (value: string) => void, value: string): void => { setter(value); setItemKey(''); setError(null); };
  return (
    <form className="pcad-popover pcad-popover--standard-part" role="dialog"
      aria-label={t('assembly.standardPart.title')} {...pickerFormProps({ composing, compositionKey }, submit)}>
      <DraggableWindowTitle className="pcad-popover__title">{t('assembly.standardPart.title')}</DraggableWindowTitle>
      <CatalogLoadStatus state={catalogState} />
      <div className="pcad-popover__fields">
        <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.standardPart.category')}</span>
          <select title={t('assembly.guide.standardCategory')} ref={firstRef} className="pcad-field__input"
            value={group} onChange={(event) => { onCategory(event.currentTarget.value); }}>
            {categoryOptions}
          </select>
        </label>
        <label className="pcad-field">
          <span className="pcad-field__label">{t(FAMILY_KIND_FIELD_KEYS[group].label)}</span>
          <select title={t(FAMILY_KIND_FIELD_KEYS[group].guide)} className="pcad-field__input" value={entry?.id ?? ''}
            onChange={(event) => {
              if (!entries.some((candidate) => candidate.id === event.currentTarget.value)) return;
              choose(setFamilyId, event.currentTarget.value); setMaterial(''); setValues({});
            }}>
            {entries.map((candidate) => <option key={candidate.id} value={candidate.id}>{t(familyKindKey(candidate.kindKey))}</option>)}
          </select>
        </label>
        {materials.length < 2 ? null : <label className="pcad-field">
          <span className="pcad-field__label">{t('catalog.mechanical.material')}</span>
          <select title={t('catalog.mechanical.materialGuide')} className="pcad-field__input" value={activeMaterial}
            onChange={(event) => { if (materials.includes(event.currentTarget.value)) choose(setMaterial, event.currentTarget.value); }}>
            {materials.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>}
        {family === undefined || row === undefined ? <p className="pcad-popover__hint" role="status">
          {t('catalog.mechanical.notLoaded')}</p> : <label className="pcad-field">
          <span className="pcad-field__label">{t('assembly.standardPart.size')}</span>
          <select title={t('catalog.mechanical.sizeGuide')} className="pcad-field__input" value={row.key}
            onChange={(event) => {
              if (!rows.some((candidate) => candidate.key === event.currentTarget.value)) return;
              setItemKey(event.currentTarget.value); setError(null);
            }}>
            {rows.map((candidate) => <option key={candidate.key} value={candidate.key}>
              {catalogRowLabel(family, candidate)}</option>)}
          </select>
        </label>}
        {family === undefined ? null : optionFields(family, row, values, error === 'invalidOption', (key, value) => {
          setValues({ ...values, [key]: value }); setError(null);
        })}
      </div>
      {hintKey === null ? null : <p className="pcad-popover__hint">{t(hintKey)}</p>}
      <p className="pcad-popover__hint">{t('catalog.mechanical.simplified')}</p>
      {family?.stock === 'linear' ? <CatalogStockTable /> : null}
      {family?.sectionBounds === undefined || row === undefined ? null
        : <FrameLayoutDetails member={{ kind: 'catalogItem', familyId: family.id, itemKey: row.key, values }} />}
      {error === null ? null : <p className="pcad-field__message" role="alert">
        {t(error === 'invalidOption' ? 'catalog.mechanical.invalidOption' : 'assembly.standardPart.unknownChoice')}</p>}
      <p className="pcad-popover__hint">{t('assembly.standardPart.hint')}</p>
      <div className="pcad-popover__actions">
        <button type="submit" className="pcad-button pcad-button--action" disabled={row === undefined}
          title={t('catalog.mechanical.placeGuide')}>{t('assembly.standardPart.place')}</button>
        <button type="button" className="pcad-button" title={t('assembly.guide.standardCancel')}
          onClick={() => { useAppStore.getState().closeStandardPartPicker(); }}>{t('assembly.standardPart.close')}</button>
      </div>
    </form>
  );
}
