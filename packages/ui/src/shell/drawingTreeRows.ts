import type { DrawingDocument } from '@pointercad/drawing';
import type { DrawingGdtResolution, DrawingRefreshResult, ResolvedWeldSymbol } from '@pointercad/model';

export type DrawingTreeGroupId = 'views' | 'dimensions' | 'annotations' | 'tables' | 'layers';
export type DrawingTreeRowKind = 'view' | 'dimension' | 'annotation' | 'balloon' | 'table' | 'layer' | 'datum' | 'gdt' | 'weld';
export interface DrawingTreeRow {
  readonly key: string;
  readonly id: string;
  readonly kind: DrawingTreeRowKind;
  readonly label: string;
  readonly unresolved: boolean;
}
export interface DrawingTreeGroup {
  readonly key: string;
  readonly id: DrawingTreeGroupId;
  readonly rows: readonly DrawingTreeRow[];
}
export interface DrawingTreeLabels {
  readonly dimension: (dimension: DrawingDocument['dimensions'][number], index: number) => string;
  readonly annotation: (kind: DrawingDocument['annotations'][number]['kind'], index: number) => string;
  readonly table: (kind: DrawingDocument['tables'][number]['kind'], index: number) => string;
  readonly balloon: (itemNumber: number) => string;
  readonly manufacturing?: (kind: 'datum' | 'gdt' | 'weld', index: number) => string;
}

/** 種類とIDを別の配列要素にし、区切り文字を含むIDでも兄弟keyを衝突させない。 */
export function drawingTreeRowKey(kind: DrawingTreeRowKind, id: string): string {
  return `drawing-row:${JSON.stringify([kind, id])}`;
}

export function drawingTreeGroups(
  drawing: DrawingDocument | null,
  resolution: DrawingRefreshResult | null,
  labels: DrawingTreeLabels,
  gdt?: DrawingGdtResolution,
  welds?: readonly ResolvedWeldSymbol[],
): readonly DrawingTreeGroup[] {
  const row = (kind: DrawingTreeRowKind, id: string, label: string, unresolved = false): DrawingTreeRow => ({
    key: drawingTreeRowKey(kind, id), id, kind, label, unresolved,
  });
  const resolvedDimensions = new Map(resolution?.ok === true && resolution.document === drawing
    ? resolution.dimensions.map((dimension) => [dimension.dimension.id, dimension]) : []);
  const group = (id: DrawingTreeGroupId, rows: readonly DrawingTreeRow[]): DrawingTreeGroup => ({
    key: `drawing-group:${id}`, id, rows,
  });
  return [
    group('views', drawing?.views.map((view) => row('view', view.id, view.name)) ?? []),
    group('dimensions', drawing?.dimensions.map((dimension, index) => {
      const resolved = resolvedDimensions.get(dimension.id);
      const text = resolved?.text;
      const label = labels.dimension(dimension, index + 1);
      return row('dimension', dimension.id, text === undefined ? label : `${label} — ${text}`,
        resolved?.status === 'unresolved');
    }) ?? []),
    group('annotations', [
      ...(drawing?.annotations.map((annotation, index) => {
        const firstLine = annotation.text.split(/\r?\n/u)[0].trim();
        const letters = Array.from(firstLine);
        const label = letters.length === 0 ? labels.annotation(annotation.kind, index + 1)
          : letters.length > 40 ? `${letters.slice(0, 40).join('')}…` : firstLine;
        return row('annotation', annotation.id, label);
      }) ?? []),
      ...(drawing?.balloons.map((balloon) => row('balloon', balloon.id, labels.balloon(balloon.itemNumber))) ?? []),
      ...(drawing?.datums.map((datum, index) => row('datum', datum.id, `${labels.manufacturing?.('datum', index + 1) ?? labels.annotation('note', index + 1)} ${datum.label}`,
        gdt?.datums.find((entry) => entry.datum.id === datum.id)?.issues.length !== 0 && gdt !== undefined)) ?? []),
      ...(drawing?.gdtFrames.map((frame, index) => row('gdt', frame.id, labels.manufacturing?.('gdt', index + 1) ?? labels.annotation('note', index + 1),
        gdt?.frames.find((entry) => entry.frame.id === frame.id)?.issues.length !== 0 && gdt !== undefined)) ?? []),
      ...(drawing?.weldSymbols.map((weld, index) => row('weld', weld.id, labels.manufacturing?.('weld', index + 1) ?? labels.annotation('note', index + 1),
        welds !== undefined && welds.find((entry) => entry.symbol.id === weld.id)?.issues.length !== 0)) ?? []),
    ]),
    group('tables', drawing?.tables.map((table, index) => row('table', table.id, labels.table(table.kind, index + 1))) ?? []),
    group('layers', drawing?.layers.map((layer) => row('layer', layer.id, layer.name)) ?? []),
  ];
}
