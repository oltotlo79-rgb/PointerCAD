export interface PdfFontScanOffender {
  readonly pages: ReadonlySet<number>;
  readonly chars: ReadonlySet<string>;
}
export interface PdfFontScanResult {
  readonly pages: number;
  readonly offenders: ReadonlyMap<string, PdfFontScanOffender>;
}
export function scanPdf(pdf: Uint8Array, covered: (char: string) => boolean): PdfFontScanResult;
