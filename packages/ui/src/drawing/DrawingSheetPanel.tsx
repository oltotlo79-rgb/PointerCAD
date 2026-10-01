import { useId, useMemo, useState } from 'react';
import { DEFAULT_TITLE_BLOCK_FIELDS, PAPER_SIZES, paperSizeOf, type DrawingDocument, type DrawingSheet } from '@pointercad/drawing';
import { exactExpressionValueFromNumber } from '@pointercad/expression';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitDrawingSheet, parseDrawingSheetDraft, saveCurrentDrawingTemplate } from './drawingTemplateActions.js';

type SheetField = NonNullable<DrawingSheet['titleBlockFields']>[number];

function SheetInput({ label, hint, value, error, onChange }: {
  readonly label: MessageKey; readonly hint: MessageKey; readonly value: string; readonly error?: string;
  readonly onChange: (value: string) => void;
}): React.JSX.Element {
  const id = useId();
  return <div className={error === undefined ? undefined : 'pcad-field--error'}>
    <label htmlFor={id} title={t(hint)}>{t(label)}</label>
    <input id={id} title={t(hint)} className="pcad-field__input" type="text" value={value} aria-invalid={error !== undefined}
      aria-describedby={error === undefined ? undefined : `${id}-error`} onChange={(event) => onChange(event.target.value)} />
    {error === undefined ? null : <p id={`${id}-error`} className="pcad-field__message pcad-field__message--error" role="alert">{error}</p>}
  </div>;
}

export function DrawingSheetPanel({ embedded = false }: { readonly embedded?: boolean }): React.JSX.Element | null {
  const drawing = useAppStore((state) => state.drawing);
  if (drawing === null) return null;
  return <SheetForm key={`${drawing.id}:${JSON.stringify(drawing.sheet)}`} drawing={drawing} embedded={embedded} />;
}

function SheetForm({ drawing, embedded }: { readonly drawing: DrawingDocument; readonly embedded: boolean }): React.JSX.Element {
  const [paperId, setPaperId] = useState(drawing.sheet.paperSizeId);
  const [scale, setScale] = useState(drawing.sheet.scaleExpression ?? exactExpressionValueFromNumber(drawing.sheet.scale).source);
  const [scaleOptions, setScaleOptions] = useState((drawing.sheet.scaleOptionExpressions
    ?? (drawing.sheet.scaleOptions ?? [0.1, 0.2, 0.5, 1, 2, 5]).map((value) => exactExpressionValueFromNumber(value).source)).join(', '));
  const [textHeight, setTextHeight] = useState(drawing.sheet.textHeightExpression ?? exactExpressionValueFromNumber(drawing.sheet.textHeight ?? 3.5).source);
  const [tolerance, setTolerance] = useState(drawing.sheet.generalTolerance ?? '');
  const [frame, setFrame] = useState(drawing.sheet.frame.visible);
  const [title, setTitle] = useState(drawing.sheet.titleBlock);
  const [fields, setFields] = useState<readonly SheetField[]>(drawing.sheet.titleBlockFields ?? DEFAULT_TITLE_BLOCK_FIELDS);
  const [templateName, setTemplateName] = useState(drawing.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const busy = useAppStore((state) => state.drawingBusy);
  const parsed = useMemo(() => parseDrawingSheetDraft(drawing.sheet, { scale, scaleOptions, textHeight, fields }),
    [drawing.sheet, scale, scaleOptions, textHeight, fields]);
  const errors = parsed.ok ? undefined : parsed.errors;
  const updateField = (index: number, change: Partial<SheetField>): void => {
    setFields((previous) => previous.map((field, row) => row === index ? { ...field, ...change } : field));
  };
  const apply = (): boolean => {
    const paper = paperSizeOf(paperId);
    if (paper === undefined) return false;
    if (!parsed.ok) { setError(false); return false; }
    const ok = commitDrawingSheet({ ...parsed.sheet, paperSizeId: paper.id, orientation: paper.orientation,
      generalTolerance: tolerance, frame: { visible: frame }, titleBlock: title });
    setError(!ok); return ok;
  };
  const titleKeys: readonly { readonly key: keyof typeof title; readonly label: MessageKey }[] = [
    { key: 'title', label: 'drawing.sheet.title' }, { key: 'drawingNumber', label: 'drawing.sheet.number' },
    { key: 'revision', label: 'drawing.sheet.revision' }, { key: 'author', label: 'drawing.sheet.author' },
    { key: 'date', label: 'drawing.sheet.date' }, { key: 'material', label: 'drawing.sheet.material' },
  ];
  return <section className="pcad-section pcad-drawing-settings">
    {embedded ? null : <h3 className="pcad-section__title">{t('drawing.property.sheet')}</h3>}
    <form onSubmit={(event) => { event.preventDefault(); apply(); }}>
      <label title={t('drawing.sheet.paper.controlHint')}>{t('drawing.sheet.paper')}<select className="pcad-field__input" aria-label={t('drawing.sheet.paper')} value={paperId} onChange={(event) => setPaperId(event.target.value)}>
        {PAPER_SIZES.map((paper) => <option key={paper.id} value={paper.id}>{paper.label}</option>)}
      </select></label>
      <SheetInput label="drawing.sheet.scale" hint="drawing.sheet.scale.controlHint" value={scale} error={errors?.scale} onChange={setScale} />
      <SheetInput label="drawing.sheet.scales" hint="drawing.sheet.scales.controlHint" value={scaleOptions} error={errors?.scaleOptions} onChange={setScaleOptions} />
      <SheetInput label="drawing.table.textHeight" hint="drawing.sheet.textHeight.controlHint" value={textHeight} error={errors?.textHeight} onChange={setTextHeight} />
      <label title={t('drawing.sheet.tolerance.controlHint')}>{t('drawing.sheet.tolerance')}<input className="pcad-field__input" value={tolerance} maxLength={40} onChange={(event) => setTolerance(event.target.value)} /></label>
      <label><input title={t('drawing.controlHint.paperFrame')} type="checkbox" checked={frame} onChange={(event) => setFrame(event.target.checked)} />{t('drawing.sheet.frame')}</label>
      {titleKeys.map(({ key, label }) => <label key={key}>{t(label)}<input title={t('drawing.controlHint.titleField')} className="pcad-field__input" value={title[key]} maxLength={240}
        onChange={(event) => setTitle((previous) => ({ ...previous, [key]: event.target.value }))} /></label>)}
      <details open={errors?.fields.some((field) => field.label !== undefined || field.width !== undefined) ? true : undefined}>
        <summary>{t('drawing.sheet.fields')}</summary>
        {fields.map((field, index) => <div key={`field:${field.key}`} className="pcad-drawing-settings__field">
          <SheetInput label="drawing.sheet.fieldLabel" hint="drawing.sheet.fieldLabel.controlHint" value={field.label} error={errors?.fields[index].label}
            onChange={(label) => updateField(index, { label })} />
          <label title={t('drawing.sheet.fixedText.controlHint')}>{t('drawing.sheet.fixedText')}<input className="pcad-field__input" value={field.fixedText ?? ''} onChange={(event) => updateField(index, { fixedText: event.target.value })} /></label>
          <SheetInput label="drawing.sheet.fieldWidth" hint="drawing.sheet.fieldWidth.controlHint"
            value={field.widthExpression ?? exactExpressionValueFromNumber(field.widthWeight ?? 1).source} error={errors?.fields[index].width}
            onChange={(widthExpression) => updateField(index, { widthExpression })} />
          <button title={t('drawing.controlHint.titleFieldUp')} type="button" className="pcad-button" disabled={index === 0} aria-label={`${field.label}: ${t('drawing.sheet.moveUp')}`}
            onClick={() => setFields((previous) => { const next = [...previous]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}>{t('drawing.sheet.moveUp')}</button>
          <button title={t('drawing.controlHint.removeTitleField')} type="button" className="pcad-button" disabled={fields.length === 1} aria-label={`${field.label}: ${t('drawing.table.removeRow')}`}
            onClick={() => setFields((previous) => previous.filter((_, row) => row !== index))}>{t('drawing.table.removeRow')}</button>
        </div>)}
        <button title={t('drawing.controlHint.addTitleField')} type="button" className="pcad-button" onClick={() => {
          let index = 1; while (fields.some((field) => field.key === `custom-${index}`)) index++;
          setFields((previous) => [...previous, { key: `custom-${index}`, label: t('drawing.sheet.newField'), fixedText: '' }]);
        }}>{t('drawing.sheet.addField')}</button>
      </details>
      {error ? <p role="alert">{t('drawing.template.invalid')}</p> : null}
      <button title={t('drawing.controlHint.applySheet')} type="submit" className="pcad-button" disabled={busy || saving}>{t('drawing.sheet.apply')}</button>
    </form>
    <label title={t('drawing.template.name.controlHint')}>{t('drawing.template.name')}<input className="pcad-field__input" value={templateName} maxLength={120} onChange={(event) => setTemplateName(event.target.value)} /></label>
    <button title={t('drawing.controlHint.saveTemplate')} type="button" className="pcad-button" disabled={busy || saving} onClick={() => {
      // 未確定の欄も同じ検証・Undoを経由して保存する。
      if (!apply()) return;
      setSaving(true);
      void saveCurrentDrawingTemplate(templateName).finally(() => setSaving(false));
    }}>{t('drawing.template.save')}</button>
  </section>;
}
