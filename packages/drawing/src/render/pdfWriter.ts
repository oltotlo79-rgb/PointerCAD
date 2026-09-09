/** PDF 1.4 の最小コンテナ。位置とstream長は符号化後のバイト数だけで数える。 */
export const PDF_POINTS_PER_MM = 72 / 25.4;
export interface PdfOptions {
  readonly widthMm: number;
  readonly heightMm: number;
  /** 描画命令はASCII、メタデータの日本語はPDF文字列へ符号化する。 */
  readonly content: string | Uint8Array;
  readonly creationDate?: string;
  readonly title?: string;
}
export type PdfResult = { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'invalidPageSize' | 'invalidContent' | 'invalidMetadata' | 'tooLarge' };
const encoder = new TextEncoder();

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

export function createPdf(options: PdfOptions): PdfResult {
  if (![options.widthMm, options.heightMm].every((value) => Number.isFinite(value) && value > 0
    && Number((value * PDF_POINTS_PER_MM).toFixed(4)) > 0
    && value * PDF_POINTS_PER_MM <= 14400)) return { ok: false, reason: 'invalidPageSize' };
  const content = typeof options.content === 'string' ? encoder.encode(options.content) : options.content;
  if (content.some((byte) => byte > 127 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13))) {
    return { ok: false, reason: 'invalidContent' };
  }
  const date = options.creationDate === undefined ? undefined : pdfDate(options.creationDate);
  const title = options.title === undefined ? undefined : pdfString(options.title);
  if (date === null || title === null) return { ok: false, reason: 'invalidMetadata' };
  const info = date !== undefined || title !== undefined;
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
  object(2, '<</Type/Pages/Kids[3 0 R]/Count 1>>');
  const width = (options.widthMm * PDF_POINTS_PER_MM).toFixed(4);
  const height = (options.heightMm * PDF_POINTS_PER_MM).toFixed(4);
  object(3, `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${width} ${height}]/Resources<<>>/Contents 4 0 R>>`);
  offsets[4] = length;
  append(`4 0 obj\n<</Length ${content.byteLength}>>\nstream\n`);
  append(content); append('\nendstream\nendobj\n');
  if (info) object(5, `<<${date === undefined ? '' : `/CreationDate(${date})`}${title === undefined ? '' : `/Title${title}`}>>`);
  if (length >= 10_000_000_000) return { ok: false, reason: 'tooLarge' };
  const xref = length;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1)) append(`${String(offset).padStart(10, '0')} 00000 n \n`);
  append(`trailer\n<</Size ${offsets.length}/Root 1 0 R${info ? '/Info 5 0 R' : ''}>>\nstartxref\n${xref}\n%%EOF\n`);
  const bytes = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
  return { ok: true, bytes };
}
