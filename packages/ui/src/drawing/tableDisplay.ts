import { balloon, bomTable, createPaperFrame, holeTable, paperSizeOf, resolveStyle, revisionTable,
  type BalloonCircle, type BomColumnId, type DrawingDocument, type DrawingRenderElement,
  type DrawingTable, type InkBounds, type OutlinedText, type TableGeometry } from '@pointercad/drawing';
import { BOM_COLUMN_IDS, resolveDrawingAnnotationTarget, type DrawingSourceResolution } from '@pointercad/model';
import { materialLabel } from '../assembly/BomTable.js';
import { formatBomMass } from '../assembly/bomTableRows.js';
import { t } from '../i18n/t.js';
import { drawingNoteGeometryElement } from './noteDisplay.js';
import { drawingTableRowOwner } from './drawingSelection.js';

export interface DrawingTableDisplay {
  readonly id: string;
  readonly bounds: InkBounds;
  readonly rowHeights: readonly number[];
  readonly rowComponentIds: readonly (readonly string[])[];
}
export interface DrawingTablesDisplay {
  readonly elements: readonly DrawingRenderElement[];
  readonly items: readonly DrawingTableDisplay[];
  readonly unresolved: readonly string[];
}
function isBomColumn(value: string): value is BomColumnId { return BOM_COLUMN_IDS.some((id) => id === value); }
function numericOption(table: DrawingTable, key: string, fallback: number): number {
  const value = table.options[key];
  return value === undefined ? fallback : typeof value === 'number' ? value : NaN;
}
function tableElements(table: DrawingTable, geometry: TableGeometry): readonly DrawingRenderElement[] {
  const elements: DrawingRenderElement[] = [0.5, 0.25].map((width, index) => ({ ownerId: table.id, layerId: table.layerId,
    style: { ...table.style, lineWidth: width }, texts: index === 0 && table.kind !== 'bom' ? geometry.texts : [],
    curves: geometry.lines.filter((line) => line.widthMm === width).map((line) => ({ kind: 'segment', from: line.from, to: line.to })) }));
  if (table.kind === 'bom') {
    // textsは行順。行の境界を一度ずつ進め、長い部品表でも二重走査しない。
    let row = 0, bottom = table.position[1] - (geometry.rowHeights[0] ?? 0);
    for (const text of geometry.texts) {
      while (row + 1 < geometry.rowHeights.length && text.position[1] <= bottom) bottom -= geometry.rowHeights[++row];
      elements.push({ ownerId: drawingTableRowOwner(table.id, row), layerId: table.layerId, style: table.style, texts: [text] });
    }
  }
  return elements;
}

/** 用紙・PDF・SVG・画像・印刷へ同じ表と風船を渡す。集計行は保存文書へ戻さない。 */
export function displayDrawingTables(document: DrawingDocument, source: DrawingSourceResolution | null,
  outline: (text: string, size: number) => OutlinedText): DrawingTablesDisplay {
  const elements: DrawingRenderElement[] = [], items: DrawingTableDisplay[] = [], unresolved: string[] = [];
  const paper = paperSizeOf(document.sheet.paperSizeId);
  if (paper === undefined) return { elements, items, unresolved: document.tables.map((table) => table.id) };
  const bounds = createPaperFrame(paper).inner;
  const measureText = (text: string, size: number) => outline(text, size).metrics;
  for (const table of document.tables) {
    let geometry: TableGeometry | null = null;
    let rowComponentIds: readonly (readonly string[])[] = [];
    const common = { position: table.position, bounds, measureText,
      textHeightMm: numericOption(table, 'textHeight', document.sheet.textHeight ?? 3.5), rowHeightMm: numericOption(table, 'rowHeight', 7) };
    if (table.kind === 'bom' && source?.bomRows !== undefined) {
      const columns = table.columns.filter(isBomColumn);
      const direction = table.options.direction ?? 'bottomToTop', sortBy = table.options.sortBy ?? 'number';
      if (columns.length === table.columns.length && (direction === 'bottomToTop' || direction === 'topToBottom')
        && (sortBy === 'number' || sortBy === 'name' || sortBy === 'quantity' || sortBy === 'mass')) {
        const columnWidths: Partial<Record<BomColumnId, number>> = {};
        for (const id of columns) if (table.options[`width.${id}`] !== undefined) columnWidths[id] = numericOption(table, `width.${id}`, NaN);
        const rows = source.bomRows.map((row) => ({ ...row, materialName: materialLabel(row.materialId, row.materialName) }));
        const bom = bomTable({ ...common, rows, columns, direction, sortBy, columnWidths,
          sortDescending: table.options.sortDescending === true, formatMass: formatBomMass, unknownMassText: '',
          headings: { number: t('assembly.bom.column.number'), name: t('assembly.bom.column.name'),
            quantity: t('assembly.bom.column.quantity'), material: t('assembly.bom.column.material'),
            mass: t('assembly.bom.column.mass'), configuration: t('assembly.bom.column.configuration') } });
        geometry = bom;
        rowComponentIds = bom?.rowKeys.map((key) => source.bomRows?.find((row) => row.rowKey === key)?.componentIds ?? []) ?? [];
      }
    } else if (table.kind === 'revision' && (table.rows ?? []).every((row) => row.length === 4)) {
      geometry = revisionTable({ ...common, rows: (table.rows ?? []).map((row) => ({ revision: row[0], date: row[1], description: row[2], approvedBy: row[3] })),
        headings: { revision: t('drawing.table.revision'), date: t('drawing.table.date'),
          description: t('drawing.table.description'), approvedBy: t('drawing.table.approvedBy') } });
    } else if (table.kind === 'hole') {
      const holes = source?.holeTables?.get(table.id);
      const viewId = table.options.viewId;
      if (holes?.ok === true && source !== null && typeof viewId === 'string') {
        const callouts = holes.rows.map((row, index) => {
          const target = resolveDrawingAnnotationTarget({ kind: 'point', viewId, paperPoint: [0, 0], modelPoint: row.center },
            document, { instances: source.dimensionInstances ?? [], modelCenter: source.center });
          const metrics = measureText(row.symbol, common.textHeightMm);
          if (target === null || metrics === null) return null;
          const width = metrics.inkBounds.right - metrics.inkBounds.left;
          const height = metrics.inkBounds.top - metrics.inkBounds.bottom;
          // 記号は実字体の幅で紙内へ置く。穴の座標は移動させない。
          return { rowId: row.id, target, position: [
            Math.max(bounds.left + 2, Math.min(bounds.right - width - 2, target[0] + 8)),
            Math.max(bounds.bottom + 2, Math.min(bounds.top - height - 2, target[1] + 8 + index * common.textHeightMm * 1.4)),
          ] as const };
        });
        if (callouts.every((item) => item !== null)) {
          const result = holeTable({ ...common, rows: holes.rows, callouts,
            headings: { symbol: t('drawing.table.symbol'), x: 'X', y: 'Y', diameter: t('drawing.table.diameter'), depth: t('drawing.table.depth') },
            throughText: t('drawing.table.through'), formatLength: (value) => String(Number(value.toFixed(3))) });
          geometry = result;
          if (result !== null) for (const callout of result.callouts) {
            elements.push(drawingNoteGeometryElement({ id: table.id, layerId: table.layerId, style: table.style }, callout.geometry));
          }
        }
      }
    }
    if (geometry === null) { unresolved.push(table.id); continue; }
    elements.push(...tableElements(table, geometry));
    items.push({ id: table.id, rowComponentIds, rowHeights: geometry.rowHeights,
      bounds: { left: table.position[0], right: table.position[0] + geometry.widthMm,
        top: table.position[1], bottom: table.position[1] - geometry.heightMm } });
  }
  const occupied: BalloonCircle[] = [];
  for (const item of document.balloons) {
    const matches = source?.bomRows?.filter((row) => item.componentIds.length > 0 && item.componentIds.every((id) => row.componentIds.includes(id))) ?? [];
    const target = item.sourceTarget === undefined ? item.leader[0] : source === null ? null
      : resolveDrawingAnnotationTarget(item.sourceTarget, document, { instances: source.dimensionInstances ?? [], modelCenter: source.center });
    const geometry = matches.length !== 1 || target == null ? null : balloon({ itemNumber: matches[0].number,
      bomNumbers: new Set(source?.bomRows?.map((row) => row.number)), position: item.position, target,
      targetKind: item.targetKind ?? 'edge', heightMm: document.sheet.textHeight ?? 3.5, occupied, measureText });
    if (geometry === null) { unresolved.push(item.id); continue; }
    const { center, radius } = geometry.circle;
    if (center[0] - radius < bounds.left || center[0] + radius > bounds.right
      || center[1] - radius < bounds.bottom || center[1] + radius > bounds.top) { unresolved.push(item.id); continue; }
    if (resolveStyle(item, document.layers)?.visible === true) occupied.push({ center, radius });
    elements.push({ ownerId: item.id, layerId: item.layerId, style: item.style,
      curves: [{ kind: 'arc', ...geometry.circle }, ...geometry.lines.map((line) => ({ kind: 'segment' as const, ...line }))], texts: [geometry.text],
      fills: geometry.arrow === null ? [] : [{ fillRule: 'nonzero', subpaths: [{ commands: [
        { kind: 'M', to: geometry.arrow.points[0] }, { kind: 'L', to: geometry.arrow.points[1] },
        { kind: 'L', to: geometry.arrow.points[2] }, { kind: 'Z' }] }] }] });
    if (geometry.dot !== null) elements.push({ ownerId: item.id, layerId: item.layerId,
      style: { ...item.style, lineWidth: geometry.dot.radius }, curves: [{ kind: 'arc', center: geometry.dot.center,
        radius: geometry.dot.radius / 2, startAngle: 0, endAngle: 2 * Math.PI }] });
    items.push({ id: item.id, bounds: { left: center[0] - radius, right: center[0] + radius,
      top: center[1] + radius, bottom: center[1] - radius }, rowHeights: [], rowComponentIds: [item.componentIds] });
  }
  return { elements, items, unresolved };
}
