import { useState } from 'react';
import { BOM_COLUMN_IDS, type BomColumnId } from '@pointercad/model';
import { createPaperFrame, paperSizeOf, type DrawingTable } from '@pointercad/drawing';
import { t, type MessageKey } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitDrawingTable, deleteDrawingTables, startDrawingBalloon } from './tableCommands.js';

const columnsLabels: Readonly<Record<BomColumnId, MessageKey>> = { number: 'assembly.bom.column.number', name: 'assembly.bom.column.name',
  quantity: 'assembly.bom.column.quantity', material: 'assembly.bom.column.material', mass: 'assembly.bom.column.mass', configuration: 'assembly.bom.column.configuration' };
const kindLabels: Readonly<Record<DrawingTable['kind'], MessageKey>> = { bom: 'drawing.table.bom', hole: 'drawing.table.hole', revision: 'drawing.table.revisionTable' };
const revisionLabels: readonly MessageKey[] = ['drawing.table.revision', 'drawing.table.date', 'drawing.table.description', 'drawing.table.approvedBy'];
function isColumn(value: string): value is BomColumnId { return BOM_COLUMN_IDS.some((id) => value === id); }

function TableEditor({ table, initialKind }: { readonly table: DrawingTable | undefined; readonly initialKind: DrawingTable['kind'] | undefined }): React.JSX.Element {
  const drawing = useAppStore((state) => state.drawing);
  const busy = useAppStore((state) => state.drawingBusy);
  const paper = drawing === null ? undefined : paperSizeOf(drawing.sheet.paperSizeId);
  const [kind, setKind] = useState<DrawingTable['kind']>(table?.kind ?? initialKind ?? (drawing?.source.sourceKind === 'assembly' ? 'bom' : 'hole'));
  const [x, setX] = useState(String(table?.position[0] ?? 20));
  const [y, setY] = useState(String(table?.position[1] ?? (paper === undefined ? 270 : createPaperFrame(paper).inner.top - 10)));
  const [rowHeight, setRowHeight] = useState(String(table?.options.rowHeight ?? 7));
  const [textHeight, setTextHeight] = useState(String(table?.options.textHeight ?? drawing?.sheet.textHeight ?? 3.5));
  const [columns, setColumns] = useState<readonly BomColumnId[]>(table?.columns.filter(isColumn) ?? ['number', 'name', 'quantity', 'material', 'mass']);
  const [widths, setWidths] = useState<Partial<Record<BomColumnId, string>>>(() => Object.fromEntries(columns.map((id) => [id, String(table?.options[`width.${id}`] ?? '')])));
  const [direction, setDirection] = useState(String(table?.options.direction ?? 'bottomToTop'));
  const [sortBy, setSortBy] = useState(String(table?.options.sortBy ?? 'number'));
  const [sortDescending, setSortDescending] = useState(table?.options.sortDescending === true);
  const [viewId, setViewId] = useState(String(table?.options.viewId ?? drawing?.views[0]?.id ?? ''));
  const [datum, setDatum] = useState([String(table?.options.datumX ?? 0), String(table?.options.datumY ?? 0), String(table?.options.datumZ ?? 0)]);
  const [rows, setRows] = useState<readonly (readonly string[])[]>(table?.rows ?? [['', '', '', '']]);
  if (drawing === null) return <></>;
  const datumLabel = t(drawing.source.flatSheet === undefined ? 'drawing.table.datum' : 'drawing.table.flatDatum');
  const submit = (): void => {
    const options: Record<string, string | number | boolean> = { ...table?.options, rowHeight: Number(rowHeight), textHeight: Number(textHeight) };
    if (kind === 'bom') {
      options.direction = direction;
      options.sortBy = sortBy; options.sortDescending = sortDescending;
      for (const id of BOM_COLUMN_IDS) {
        delete options[`width.${id}`];
        const width = widths[id]?.trim();
        if (width !== undefined && width !== '') options[`width.${id}`] = Number(width);
      }
    }
    if (kind === 'hole') { options.viewId = viewId; options.datumX = Number(datum[0]); options.datumY = Number(datum[1]); options.datumZ = Number(datum[2]); }
    commitDrawingTable({ kind, position: [Number(x), Number(y)], options,
      columns: kind === 'bom' ? columns : kind === 'hole' ? ['symbol', 'x', 'y', 'diameter', 'depth'] : ['revision', 'date', 'description', 'approvedBy'],
      ...(kind === 'revision' ? { rows: rows.filter((row) => row.some((value) => value.trim() !== '')) } : {}) }, table?.id);
  };
  return <div className="pcad-drawing-table-editor pcad-drawing-settings" data-help-topic={kind === 'bom' ? 'drawing-bom' : kind === 'hole' && drawing.source.flatSheet !== undefined ? 'sheet-metal-flat' : 'drawing-table'}>
    <label>{t('drawing.table.title')}<select className="pcad-field__input" aria-label={t('drawing.table.title')} value={kind} disabled={table !== undefined} onChange={(event) => {
      const value = event.target.value; if (value === 'bom' || value === 'hole' || value === 'revision') setKind(value);
    }}>{(['bom', 'hole', 'revision'] as const).map((value) => <option key={value} value={value}
      disabled={value === 'bom' ? drawing.source.sourceKind !== 'assembly' : value === 'hole' && drawing.source.sourceKind !== 'part'}>{t(kindLabels[value])}</option>)}</select></label>
    <label>{t('drawing.table.positionX')}<input className="pcad-field__input" aria-label={t('drawing.table.positionX')} inputMode="decimal" value={x} onChange={(event) => setX(event.target.value)} /></label>
    <label>{t('drawing.table.positionY')}<input className="pcad-field__input" aria-label={t('drawing.table.positionY')} inputMode="decimal" value={y} onChange={(event) => setY(event.target.value)} /></label>
    <label>{t('drawing.table.rowHeight')}<input className="pcad-field__input" aria-label={t('drawing.table.rowHeight')} inputMode="decimal" value={rowHeight} onChange={(event) => setRowHeight(event.target.value)} /></label>
    <label>{t('drawing.table.textHeight')}<input className="pcad-field__input" aria-label={t('drawing.table.textHeight')} inputMode="decimal" value={textHeight} onChange={(event) => setTextHeight(event.target.value)} /></label>
    {kind === 'bom' ? <>
      <fieldset><legend>{t('drawing.table.columns')}</legend>{BOM_COLUMN_IDS.map((id) => <label key={id}>
        <input type="checkbox" checked={columns.includes(id)} onChange={(event) => setColumns(event.target.checked ? [...columns, id] : columns.filter((entry) => entry !== id))} />{t(columnsLabels[id])}
      </label>)}
        {columns.map((id, index) => <div key={id} className="pcad-drawing-table-column">
          <label>{t(columnsLabels[id])} {t('drawing.table.width')}<input className="pcad-field__input" aria-label={`${t(columnsLabels[id])} ${t('drawing.table.width')}`} inputMode="decimal"
            value={widths[id] ?? ''} onChange={(event) => setWidths({ ...widths, [id]: event.target.value })} /></label>
          <button type="button" title={t('drawing.table.moveLeft')} aria-label={`${t(columnsLabels[id])} ${t('drawing.table.moveLeft')}`} disabled={index === 0}
            onClick={() => { const next = [...columns]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; setColumns(next); }}>←</button>
          <button type="button" title={t('drawing.table.moveRight')} aria-label={`${t(columnsLabels[id])} ${t('drawing.table.moveRight')}`} disabled={index === columns.length - 1}
            onClick={() => { const next = [...columns]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; setColumns(next); }}>→</button>
        </div>)}
      </fieldset>
      <label>{t('drawing.table.direction')}<select className="pcad-field__input" aria-label={t('drawing.table.direction')} value={direction} onChange={(event) => setDirection(event.target.value)}>
        <option value="bottomToTop">{t('drawing.table.bottomToTop')}</option><option value="topToBottom">{t('drawing.table.topToBottom')}</option>
      </select></label>
      <label>{t('drawing.table.sortBy')}<select className="pcad-field__input" aria-label={t('drawing.table.sortBy')} value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
        {(['number', 'name', 'quantity', 'mass'] as const).map((id) => <option key={id} value={id}>{t(columnsLabels[id])}</option>)}
      </select></label>
      <label><input type="checkbox" checked={sortDescending} onChange={(event) => setSortDescending(event.target.checked)} />{t('drawing.table.sortDescending')}</label>
    </> : null}
    {kind === 'hole' ? <>
      <label>{t('drawing.table.view')}<select className="pcad-field__input" aria-label={t('drawing.table.view')} value={viewId} onChange={(event) => setViewId(event.target.value)}>
        {drawing.views.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
      </select></label>
      <fieldset><legend>{datumLabel}</legend>{['X', 'Y', 'Z'].map((axis, index) => <label key={axis}>{axis}
        <input className="pcad-field__input" aria-label={`${datumLabel} ${axis}`} inputMode="decimal" value={datum[index]}
          onChange={(event) => setDatum(datum.map((value, at) => at === index ? event.target.value : value))} /></label>)}</fieldset>
    </> : null}
    {kind === 'revision' ? <fieldset><legend>{t('drawing.table.rows')}</legend>
      {rows.map((row, rowIndex) => <fieldset key={`revision-row:${rowIndex}`} className="pcad-drawing-revision-row">
        <legend>{t('drawing.table.rowNumber').replace('{number}', String(rowIndex + 1))}</legend>
        {revisionLabels.map((key, column) => <label key={key}>{t(key)}<input className="pcad-field__input"
          aria-label={`${rowIndex + 1} ${t(key)}`} value={row[column] ?? ''} onChange={(event) => setRows(rows.map((item, index) =>
            index === rowIndex ? revisionLabels.map((_, at) => at === column ? event.target.value : item[at] ?? '') : item))} /></label>)}
        <button type="button" className="pcad-button" title={t('drawing.table.removeRow')}
          onClick={() => setRows(rows.filter((_, index) => index !== rowIndex))}>{t('drawing.table.removeRow')}</button>
      </fieldset>)}
      <button type="button" className="pcad-button" title={t('drawing.table.addRow')}
        onClick={() => setRows([...rows, ['', '', '', '']])}>{t('drawing.table.addRow')}</button>
    </fieldset> : null}
    <button type="button" className="pcad-button" title={t(table === undefined ? 'drawing.table.add' : 'drawing.table.update')} disabled={busy} onClick={submit}>
      {t(table === undefined ? 'drawing.table.add' : 'drawing.table.update')}</button>
  </div>;
}

export function DrawingTablePanel({ embedded = false }: { readonly embedded?: boolean }): React.JSX.Element {
  const drawing = useAppStore((state) => state.drawing);
  const selected = useAppStore((state) => state.drawingSelectedIds);
  const documentId = useAppStore((state) => state.activeDocumentId);
  const editor = useAppStore((state) => state.drawingEditor);
  const busy = useAppStore((state) => state.drawingBusy);
  if (drawing === null) return <></>;
  const table = drawing.tables.find((item) => selected.includes(item.id));
  const initialKind = editor?.kind === 'table' ? editor.tableKind : undefined;
  return <section className="pcad-section">{embedded ? null : <h3 className="pcad-section__title">{t('drawing.table.title')}</h3>}
    <TableEditor key={`${documentId}:${JSON.stringify(table ?? null)}:${initialKind ?? ''}`} table={table} initialKind={initialKind} />
    <button type="button" className="pcad-button" title={t('drawing.table.balloon')} disabled={busy || drawing.source.sourceKind !== 'assembly'} onClick={startDrawingBalloon}>{t('drawing.table.balloon')}</button>
    <button type="button" className="pcad-button" title={t('drawing.table.delete')} disabled={!drawing.tables.some((item) => selected.includes(item.id)) && !drawing.balloons.some((item) => selected.includes(item.id))}
      onClick={deleteDrawingTables}>{t('drawing.table.delete')}</button>
  </section>;
}
