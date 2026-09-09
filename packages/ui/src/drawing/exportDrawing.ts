import { renderDrawing, toPdf, toSvg, type DrawingDocument, type RenderDocument } from '@pointercad/drawing';
import { resolveDrawingDimensions } from '@pointercad/model';
import { writeDrawingDxf } from '@pointercad/io';
import { saveFileAsThrough } from '../file/fileGateway.js';
import { hasSaveRecoveryCopy } from '../file/saveFailure.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { displayDrawingDimension } from './dimensionDisplay.js';
import { drawingFont } from './drawingFont.js';
import { displayDrawingAnnotations } from './annotationDisplay.js';
import { rasterDrawing, type DrawingDpi } from './rasterDrawing.js';
import { displayDrawingTables } from './tableDisplay.js';
import { drawingProjectionRenderViews } from './projectionDisplay.js';

export type DrawingOutputFormat = 'pdf' | 'svg' | 'png' | 'jpg' | 'dxf';
export interface PreparedDrawingOutput {
  readonly drawing: DrawingDocument;
  readonly render: RenderDocument;
  readonly isCurrent: () => boolean;
}

/** 出力と印刷は同じ確定済みの描画を使う。字体の待機中に文書が替わったら保存しない。 */
export async function prepareDrawingOutput(): Promise<PreparedDrawingOutput | null> {
  const state = useAppStore.getState();
  const drawing = state.drawing, source = state.drawingSourceResolution, resolution = state.drawingResolution;
  if (drawing === null || source === null || resolution?.ok !== true || state.drawingBusy) {
    state.setDrawingMessage(t('drawing.error.noPrintDrawing')); return null;
  }
  const isCurrent = (): boolean => {
    const latest = useAppStore.getState();
    return latest.drawing === drawing && latest.drawingSourceResolution === source
      && latest.drawingSources === state.drawingSources && latest.drawingResolution === resolution && !latest.drawingBusy;
  };
  if (await drawingFont.load() !== 'ready') throw new Error(t('drawing.error.fontFailed'));
  if (!isCurrent()) return null;
  const dimensions = resolveDrawingDimensions(drawing, { instances: source.dimensionInstances ?? [], modelCenter: source.center });
  const displays = dimensions.map((dimension) => displayDrawingDimension(drawing, dimension, drawingFont.outline));
  if (displays.some((display, index) => display.unresolved && dimensions[index].status === 'resolved')) {
    throw new Error(t('drawing.error.dimensionUnsupported'));
  }
  const annotations = displayDrawingAnnotations(drawing, source, state.drawingSources, drawingFont.outline);
  const tables = displayDrawingTables(drawing, source, drawingFont.outline);
  if (tables.unresolved.length > 0) throw new Error(t('drawing.table.unresolved'));
  const rendered = renderDrawing({ document: drawing, views: drawingProjectionRenderViews(resolution.projection.views),
    elements: [...displays.map((display) => display.element), ...annotations, ...tables.elements] }, { forPrint: true, outlineText: drawingFont.outline });
  if (rendered.issues.length > 0) throw new Error(t(rendered.issues.some((issue) => issue.kind === 'font')
    ? 'drawing.error.fontFailed' : 'drawing.error.outputFailed'));
  return { drawing, render: rendered.document, isCurrent };
}

const exporting = new Set<string>();

export async function exportDrawing(options: { readonly format: DrawingOutputFormat; readonly dpi?: DrawingDpi }): Promise<boolean> {
  const state = useAppStore.getState();
  const drawing = state.drawing;
  if (drawing === null || exporting.has(drawing.id)) {
    state.setDrawingMessage(t('drawing.error.noPrintDrawing')); return false;
  }
  exporting.add(drawing.id);
  try {
    const prepared = await prepareDrawingOutput();
    if (prepared === null) return false;
    let bytes: Uint8Array;
    let notice: string | null = null;
    if (options.format === 'dxf') {
      const result = writeDrawingDxf(prepared.render, drawing.layers);
      bytes = new TextEncoder().encode(result.text);
      notice = t('drawing.export.dxfDetails').replace('{omitted}', String(result.skippedPrimitiveCount))
        .replace('{colors}', String(result.approximatedColorCount)).replace('{curves}', String(result.flattenedCurveCount));
    } else if (options.format === 'pdf') {
      const result = toPdf(prepared.render, { title: drawing.sheet.titleBlock.title || drawing.name });
      if (!result.ok) throw new Error(t('drawing.error.outputFailed'));
      bytes = result.bytes;
    } else {
      const svg = toSvg(prepared.render);
      if (svg === null) throw new Error(t('drawing.error.outputFailed'));
      if (options.format === 'svg') bytes = new TextEncoder().encode(svg);
      else {
        const raster = await rasterDrawing(svg, prepared.render.widthMm, prepared.render.heightMm, options.format, options.dpi ?? 300);
        if (!raster.ok) throw new Error(t(raster.reason === 'tooLarge' ? 'drawing.error.rasterTooLarge' : 'drawing.error.outputFailed'));
        bytes = raster.bytes;
      }
    }
    if (!prepared.isCurrent()) return false;
    const saved = await saveFileAsThrough(state.fileGateway, `${drawing.name}.${options.format}`, options.format, bytes);
    if (saved && notice !== null && prepared.isCurrent()) state.setDrawingMessage(notice);
    return saved;
  } catch (error) {
    if (useAppStore.getState().drawing === drawing) state.setDrawingMessage(hasSaveRecoveryCopy(error)
      ? t('file.saveRecoveryCopyRetained') : error instanceof Error ? error.message : t('drawing.error.outputFailed'));
    return false;
  } finally { exporting.delete(drawing.id); }
}
