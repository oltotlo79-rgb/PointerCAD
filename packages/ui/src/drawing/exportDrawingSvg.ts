import { renderDrawing, toSvg } from '@pointercad/drawing';
import { resolveDrawingDimensions } from '@pointercad/model';
import { saveFileAsThrough } from '../file/fileGateway.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { displayDrawingDimension } from './dimensionDisplay.js';
import { drawingFont } from './drawingFont.js';
import { displayDrawingAnnotations } from './annotationDisplay.js';

/** 画面と同じ輪郭・実字体をSVGへ渡す。保存文書の上書き先は変更しない(P8-43)。 */
export async function exportDrawingSvg(): Promise<boolean> {
  const state = useAppStore.getState();
  const drawing = state.drawing, source = state.drawingSourceResolution, resolution = state.drawingResolution;
  if (drawing === null || source === null || resolution?.ok !== true || state.drawingBusy) {
    state.setDrawingMessage(t('drawing.error.noPrintDrawing')); return false;
  }
  try {
    if (await drawingFont.load() !== 'ready') throw new Error(t('drawing.error.fontFailed'));
    if (useAppStore.getState().drawing !== drawing || useAppStore.getState().drawingResolution !== resolution) return false;
    const dimensions = resolveDrawingDimensions(drawing, { instances: source.dimensionInstances ?? [], modelCenter: source.center });
    const displays = dimensions.map((dimension) => displayDrawingDimension(drawing, dimension, drawingFont.outline));
    if (displays.some((display, index) => display.unresolved && dimensions[index].status === 'resolved')) {
      throw new Error(t('drawing.error.dimensionUnsupported'));
    }
    const annotations = displayDrawingAnnotations(drawing, source, state.drawingSources, drawingFont.outline);
    const rendered = renderDrawing({ document: drawing, views: resolution.projection.views, elements: [...displays.map((display) => display.element), ...annotations] },
      { forPrint: true, outlineText: drawingFont.outline });
    if (rendered.issues.length > 0) throw new Error(t(rendered.issues.some((issue) => issue.kind === 'font') ? 'drawing.error.fontFailed' : 'drawing.error.svgFailed'));
    const svg = toSvg(rendered.document);
    if (svg === null) throw new Error(t('drawing.error.svgFailed'));
    return await saveFileAsThrough(state.fileGateway, `${drawing.name}.svg`, 'svg', new TextEncoder().encode(svg));
  } catch (error) {
    if (useAppStore.getState().drawing === drawing) state.setDrawingMessage(error instanceof Error ? error.message : t('drawing.error.svgFailed'));
    return false;
  }
}
