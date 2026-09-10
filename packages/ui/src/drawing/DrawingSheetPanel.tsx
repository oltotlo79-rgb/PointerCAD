import { useState } from 'react';
import { DEFAULT_TITLE_BLOCK_FIELDS, PAPER_SIZES, paperSizeOf, type DrawingDocument, type TitleBlockFieldDefinition } from '@pointercad/drawing';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitDrawingSheet, saveCurrentDrawingTemplate } from './drawingTemplateActions.js';

export function DrawingSheetPanel({ embedded = false }: { readonly embedded?: boolean }): React.JSX.Element | null {
  const drawing = useAppStore((state) => state.drawing);
  if (drawing === null) return null;
  return <SheetForm key={`${drawing.id}:${JSON.stringify(drawing.sheet)}`} drawing={drawing} embedded={embedded} />;
}

function SheetForm({ drawing, embedded }: { readonly drawing: DrawingDocument; readonly embedded: boolean }): React.JSX.Element {
  const [paperId, setPaperId] = useState(drawing.sheet.paperSizeId);
  const [scale, setScale] = useState(String(drawing.sheet.scale));
  const [scaleOptions, setScaleOptions] = useState((drawing.sheet.scaleOptions ?? [0.1, 0.2, 0.5, 1, 2, 5]).join(', '));
  const [textHeight, setTextHeight] = useState(String(drawing.sheet.textHeight ?? 3.5));
  const [tolerance, setTolerance] = useState(drawing.sheet.generalTolerance ?? '');
  const [frame, setFrame] = useState(drawing.sheet.frame.visible);
  const [title, setTitle] = useState(drawing.sheet.titleBlock);
  const [fields, setFields] = useState<readonly TitleBlockFieldDefinition[]>(drawing.sheet.titleBlockFields ?? DEFAULT_TITLE_BLOCK_FIELDS);
  const [templateName, setTemplateName] = useState(drawing.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const busy = useAppStore((state) => state.drawingBusy);
  const updateField = (index: number, change: Partial<TitleBlockFieldDefinition>): void => {
    setFields((previous) => previous.map((field, row) => row === index ? { ...field, ...change } : field));
  };
  const apply = (): boolean => {
    const paper = paperSizeOf(paperId);
    if (paper === undefined) return false;
    const values = scaleOptions.split(',').map((value) => value.trim());
    const ok = commitDrawingSheet({ ...drawing.sheet, paperSizeId: paper.id, orientation: paper.orientation,
      scale: Number(scale), scaleOptions: values.map((value) => value === '' ? NaN : Number(value)),
      textHeight: Number(textHeight), generalTolerance: tolerance, frame: { visible: frame }, titleBlock: title,
      titleBlockFields: fields.map(({ fixedText, ...field }) => fixedText === undefined || fixedText === '' ? field : { ...field, fixedText }) });
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
      <label>{t('drawing.sheet.paper')}<select className="pcad-field__input" aria-label={t('drawing.sheet.paper')} value={paperId} onChange={(event) => setPaperId(event.target.value)}>
        {PAPER_SIZES.map((paper) => <option key={paper.id} value={paper.id}>{paper.label}</option>)}
      </select></label>
      <label>{t('drawing.sheet.scale')}<input className="pcad-field__input" value={scale} inputMode="decimal" onChange={(event) => setScale(event.target.value)} /></label>
      <label>{t('drawing.sheet.scales')}<input className="pcad-field__input" value={scaleOptions} onChange={(event) => setScaleOptions(event.target.value)} /></label>
      <label>{t('drawing.table.textHeight')}<input className="pcad-field__input" value={textHeight} inputMode="decimal" onChange={(event) => setTextHeight(event.target.value)} /></label>
      <label>{t('drawing.sheet.tolerance')}<input className="pcad-field__input" value={tolerance} maxLength={40} onChange={(event) => setTolerance(event.target.value)} /></label>
      <label><input type="checkbox" checked={frame} onChange={(event) => setFrame(event.target.checked)} />{t('drawing.sheet.frame')}</label>
      {titleKeys.map(({ key, label }) => <label key={key}>{t(label)}<input className="pcad-field__input" value={title[key]} maxLength={240}
        onChange={(event) => setTitle((previous) => ({ ...previous, [key]: event.target.value }))} /></label>)}
      <details>
        <summary>{t('drawing.sheet.fields')}</summary>
        {fields.map((field, index) => <div key={`field:${field.key}`} className="pcad-drawing-settings__field">
          <label>{t('drawing.sheet.fieldLabel')}<input className="pcad-field__input" value={field.label} onChange={(event) => updateField(index, { label: event.target.value })} /></label>
          <label>{t('drawing.sheet.fixedText')}<input className="pcad-field__input" value={field.fixedText ?? ''} onChange={(event) => updateField(index, { fixedText: event.target.value })} /></label>
          <label>{t('drawing.sheet.fieldWidth')}<input className="pcad-field__input" type="number" min="0.1" step="0.1" value={field.widthWeight ?? 1}
            onChange={(event) => updateField(index, { widthWeight: Number(event.target.value) })} /></label>
          <button type="button" className="pcad-button" disabled={index === 0} aria-label={`${field.label}: ${t('drawing.sheet.moveUp')}`}
            onClick={() => setFields((previous) => { const next = [...previous]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}>{t('drawing.sheet.moveUp')}</button>
          <button type="button" className="pcad-button" disabled={fields.length === 1} aria-label={`${field.label}: ${t('drawing.table.removeRow')}`}
            onClick={() => setFields((previous) => previous.filter((_, row) => row !== index))}>{t('drawing.table.removeRow')}</button>
        </div>)}
        <button type="button" className="pcad-button" onClick={() => {
          let index = 1; while (fields.some((field) => field.key === `custom-${index}`)) index++;
          setFields((previous) => [...previous, { key: `custom-${index}`, label: t('drawing.sheet.newField'), fixedText: '' }]);
        }}>{t('drawing.sheet.addField')}</button>
      </details>
      {error ? <p role="alert">{t('drawing.template.invalid')}</p> : null}
      <button type="submit" className="pcad-button" disabled={busy || saving}>{t('drawing.sheet.apply')}</button>
    </form>
    <label>{t('drawing.template.name')}<input className="pcad-field__input" value={templateName} maxLength={120} onChange={(event) => setTemplateName(event.target.value)} /></label>
    <button type="button" className="pcad-button" disabled={busy || saving} onClick={() => {
      // 未確定の欄も同じ検証・Undoを経由して保存する。
      if (!apply()) return;
      setSaving(true);
      void saveCurrentDrawingTemplate(templateName).finally(() => setSaving(false));
    }}>{t('drawing.template.save')}</button>
  </section>;
}
