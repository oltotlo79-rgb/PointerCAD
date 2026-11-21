/** PDF 1.4 の最小コンテナ。位置とstream長は符号化後のバイト数だけで数える。 */
export const PDF_POINTS_PER_MM = 72 / 25.4;
export interface PdfPage {
  readonly widthMm: number;
  readonly heightMm: number;
  /** 描画命令はASCII、メタデータの日本語はPDF文字列へ符号化する。 */
  readonly content: string | Uint8Array;
}
export interface PdfOptions extends PdfPage {
  readonly creationDate?: string;
  readonly title?: string;
}
export type PdfResult = { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'invalidPageSize' | 'invalidContent' | 'invalidMetadata' | 'tooLarge' };
const encoder = new TextEncoder();
const byteLimit = 10_000_000_000;

/** PDF文字列はUTF-16BEのBOM付きhex。絵の日本語をUTF-8のliteral stringへ混ぜない。 */
function pdfString(value: string): string | null {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point >= 0xd800 && point <= 0xdfff) return null;
  }
  let hex = 'FEFF';
  for (let index = 0; index < value.length; index += 1) hex += value.charCodeAt(index).toString(16).padStart(4, '0');
  return `<${hex}>`;
}

/** 日時を現在時刻から補わない。入力済みのPDF日時またはISO UTCだけを受け取る。 */
function pdfDate(value: string): string | null {
  if (/^D:\d{14}Z$/u.test(value)) {
    const digits = value.slice(2, 16);
    return pdfDate(`${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14)}Z`);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?Z$/u.exec(value);
  const time = Date.parse(value);
  if (match === null || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
  return `D:${match.slice(1).join('')}Z`;
}

function pageExtent(mm: number): string | null {
  const points = mm * PDF_POINTS_PER_MM;
  if (!Number.isFinite(mm) || mm <= 0 || points > 14400) return null;
  const rounded = points.toFixed(4);
  return Number(rounded) > 0 ? rounded : null;
}

const pageObjectId = (index: number): number => 3 + 2 * index;

export function createPdfPages(pages: readonly PdfPage[], metadata: Pick<PdfOptions, 'creationDate' | 'title'> = {}): PdfResult {
  if (pages.length === 0) return { ok: false, reason: 'invalidContent' };
  // 有効な命令はASCIIなので、本文だけで上限に達する場合は符号化や連結の前に断れる。
  if (pages.length > 1 && pages.reduce((sum, page) => sum + page.content.length, 0) >= byteLimit) {
    return { ok: false, reason: 'tooLarge' };
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const append = (value: string | Uint8Array): void => {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    chunks.push(bytes); length += bytes.byteLength;
  };
  const offsets: number[] = [0];
  const object = (id: number, body: string): void => {
    offsets[id] = length;
    append(`${id} 0 obj\n${body}\nendobj\n`);
  };
  append('%PDF-1.4\n');
  append(new Uint8Array([37, 0xe2, 0xe3, 0xcf, 0xd3, 10]));
  object(1, '<</Type/Catalog/Pages 2 0 R>>');
  const kids = pages.map((_, index) => `${pageObjectId(index)} 0 R`).join(' ');
  object(2, `<</Type/Pages/Kids[${kids}]/Count ${pages.length}>>`);
  for (const [index, page] of pages.entries()) {
    const width = pageExtent(page.widthMm), height = pageExtent(page.heightMm);
    if (width === null || height === null) return { ok: false, reason: 'invalidPageSize' };
    const content = typeof page.content === 'string' ? encoder.encode(page.content) : page.content;
    if (content.some((byte) => byte > 127 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13))) {
      return { ok: false, reason: 'invalidContent' };
    }
    const id = pageObjectId(index), streamId = id + 1;
    object(id, `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${width} ${height}]/Resources<<>>/Contents ${streamId} 0 R>>`);
    offsets[streamId] = length;
    append(`${streamId} 0 obj\n<</Length ${content.byteLength}>>\nstream\n`);
    append(content); append('\nendstream\nendobj\n');
  }
  const date = metadata.creationDate === undefined ? undefined : pdfDate(metadata.creationDate);
  const title = metadata.title === undefined ? undefined : pdfString(metadata.title);
  if (date === null || title === null) return { ok: false, reason: 'invalidMetadata' };
  const info = date !== undefined || title !== undefined;
  const infoId = offsets.length;
  if (info) object(infoId, `<<${date === undefined ? '' : `/CreationDate(${date})`}${title === undefined ? '' : `/Title${title}`}>>`);
  if (length >= byteLimit) return { ok: false, reason: 'tooLarge' };
  const xref = length;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1)) append(`${String(offset).padStart(10, '0')} 00000 n \n`);
  append(`trailer\n<</Size ${offsets.length}/Root 1 0 R${info ? `/Info ${infoId} 0 R` : ''}>>\nstartxref\n${xref}\n%%EOF\n`);
  if (length >= byteLimit) return { ok: false, reason: 'tooLarge' };
  const bytes = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
  return { ok: true, bytes };
}

export function createPdf(options: PdfOptions): PdfResult {
  return createPdfPages([options], options);
}
