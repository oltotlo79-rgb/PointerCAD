import { drawingPrintOptions, toSvg, type DrawingPrintOptions } from '@pointercad/drawing';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { prepareDrawingOutput } from '../drawing/exportDrawing.js';

export { drawingPrintOptions } from '@pointercad/drawing';

export function drawingPrintCss(options: DrawingPrintOptions): string {
  const orientation = options.landscape ? 'landscape' : 'portrait';
  return `@page { size: ${options.pageSize} ${orientation}; margin: 0; }
@media print {
  html, body { margin: 0 !important; padding: 0 !important; height: auto !important; }
  #root { display: none !important; }
  .pcad-drawing-print-sheet { display: block !important; width: ${options.widthMm}mm; height: ${options.heightMm}mm;
    margin: 0; padding: 0; break-after: avoid; overflow: hidden; background: #fff; print-color-adjust: exact; }
  .pcad-drawing-print-sheet img { display: block; width: ${options.widthMm}mm; height: ${options.heightMm}mm; max-width: none; }
}
@media screen { .pcad-drawing-print-sheet { display: none; } }`;
}

let printing = false;

/** 部数はdesktopだけから渡し、WebではOSの印刷窓に任せる。 */
export async function printDrawing(copies = 1): Promise<boolean> {
  const state = useAppStore.getState();
  const drawing = state.drawing;
  if (drawing === null || printing) { state.setDrawingMessage(t('drawing.error.noPrintDrawing')); return false; }
  const options = drawingPrintOptions(drawing.sheet.paperSizeId, copies);
  if (options === null) { state.setDrawingMessage(t('drawing.error.printOptions')); return false; }
  printing = true;
  let cleanup: (() => void) | null = null;
  try {
    const prepared = await prepareDrawingOutput();
    if (prepared === null) return false;
    const svg = toSvg(prepared.render);
    if (svg === null) throw new Error(t('drawing.error.outputFailed'));
    if (!prepared.isCurrent()) return false;
    if (state.fileGateway.print !== undefined) return await state.fileGateway.print(new TextEncoder().encode(svg), options);
    const sheet = document.createElement('section');
    sheet.className = 'pcad-drawing-print-sheet';
    const style = document.createElement('style');
    style.textContent = drawingPrintCss(options);
    const image = document.createElement('img');
    image.alt = drawing.name;
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    cleanup = (): void => { sheet.remove(); style.remove(); URL.revokeObjectURL(url); };
    image.src = url;
    await image.decode();
    if (!prepared.isCurrent()) return false;
    sheet.append(image);
    document.head.append(style); document.body.append(sheet);
    window.print();
    return true;
  } catch (error) {
    if (useAppStore.getState().drawing === drawing) state.setDrawingMessage(error instanceof Error ? error.message : t('drawing.error.printFailed'));
    return false;
  } finally { cleanup?.(); printing = false; }
}
