import type { DrawingPrintOptions } from '@pointercad/ui/print-settings';

/** 字体を輪郭化したSVGを画像として使う。文字列をHTML本体へ挿し込まない。 */
export function drawingPrintDocument(svg: Uint8Array, options: DrawingPrintOptions): string {
  const orientation = options.landscape ? 'landscape' : 'portrait';
  const data = Buffer.from(svg).toString('base64');
  return '<!doctype html><html><head><meta charset="utf-8"><title>PointerCAD</title>'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">'
    + `<style>@page { size: ${options.pageSize} ${orientation}; margin: 0; }`
    + `html,body { margin:0; padding:0; width:${options.widthMm}mm; height:${options.heightMm}mm; overflow:hidden; background:white; }`
    + `img { display:block; width:${options.widthMm}mm; height:${options.heightMm}mm; }</style></head>`
    + `<body><img alt="" src="data:image/svg+xml;base64,${data}"></body></html>`;
}
