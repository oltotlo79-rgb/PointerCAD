import { describe, expect, it } from 'vitest';
import { createPdf, createPdfPages, type PdfOptions } from './pdfWriter.js';

const options: PdfOptions = { widthMm: 210, heightMm: 297, content: '' };
function pdf(patch: Partial<PdfOptions> = {}): Uint8Array {
  const result = createPdf({ ...options, ...patch });
  if (!result.ok) throw new Error(result.reason);
  return result.bytes;
}
const ascii = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);
/** writerの長さ計算を再利用せず、実際のxrefから各objectの先頭を読む。 */
function readXref(bytes: Uint8Array): string[] {
  const end = ascii(bytes);
  const start = /startxref\n(\d+)\n%%EOF\n$/u.exec(end);
  if (start === null) throw new Error('startxrefなし');
  const table = ascii(bytes.slice(Number(start[1])));
  const header = /^xref\n0 (\d+)\n0000000000 65535 f \n/u.exec(table);
  if (header === null) throw new Error('xrefなし');
  const entries = table.slice(header[0].length).split('\n').slice(0, Number(header[1]) - 1);
  return entries.map((entry, index) => {
    expect(entry).toMatch(/^\d{10} 00000 n $/u);
    const object = ascii(bytes.slice(Number(entry.slice(0, 10))));
    expect(object.startsWith(`${index + 1} 0 obj\n`)).toBe(true);
    return object.slice(object.indexOf('\n') + 1, object.indexOf('\nendobj'));
  });
}

describe('PDF 1.4のバイト単位の骨組み(P8-45)', () => {
  it('版と終端を持つ', () => { const content = ascii(pdf()); expect(content.startsWith('%PDF-1.4\n')).toBe(true); expect(content.endsWith('%%EOF\n')).toBe(true); });
  it('空のPDFは500bytes未満で4objectを持つ', () => { const bytes = pdf(); expect(bytes.byteLength).toBeLessThan(500); expect(readXref(bytes)).toHaveLength(4); });
  it('A4のMediaBoxはmmを72/25.4倍した実寸', () => expect(readXref(pdf())[2]).toContain('/MediaBox[0 0 595.2756 841.8898]'));
  it('A3横のMediaBox', () => expect(readXref(pdf({ widthMm: 420 }))[2]).toContain('/MediaBox[0 0 1190.5512 841.8898]'));
  it('Catalog→Pages→Page→Contentsの参照が一致', () => {
    const objects = readXref(pdf()); expect(objects[0]).toContain('/Pages 2 0 R');
    expect(objects[1]).toContain('/Kids[3 0 R]/Count 1'); expect(objects[2]).toContain('/Contents 4 0 R');
  });
  it('内容の改行を含むバイト長をLengthへ書く', () => {
    const content = '0 0 m\n10 10 l S\n';
    const stream = readXref(pdf({ content }))[3];
    expect(stream).toContain(`/Length ${new TextEncoder().encode(content).byteLength}`);
    const start = stream.indexOf('stream\n') + 'stream\n'.length;
    expect(stream.slice(start, start + content.length)).toBe(content);
    expect(stream.slice(start + content.length)).toBe('\nendstream');
  });
  it('Uint8Arrayのstreamも同じバイト列', () => {
    const content = '0 0 m\r\n10 10 l S';
    expect(pdf({ content: new TextEncoder().encode(content) })).toEqual(pdf({ content }));
  });
  it('日本語と補助文字のメタデータでもxrefが各objectを指す', () => {
    const bytes = pdf({ title: '板😀', creationDate: '2026-09-09T12:34:56Z' });
    const info = readXref(bytes)[4]; expect(info).toContain('/Title<FEFF677fd83dde00>');
    expect(info).toContain('/CreationDate(D:20260909123456Z)');
  });
  it('メタデータへPDF命令を紛れ込ませられない', () => {
    const title = ')>> /OpenAction 6 0 R';
    expect(ascii(pdf({ title }))).not.toContain('/OpenAction');
  });
  it('同じ引数なら日時を補わず完全一致', () => expect(pdf({ title: '検査' })).toEqual(pdf({ title: '検査' })));
  it('明示日時の変更が保存される', () => expect(pdf({ creationDate: '2026-09-09T00:00:00Z' })).not.toEqual(pdf({ creationDate: '2026-09-10T00:00:00Z' })));
  it.each([0, -1, NaN, Infinity, 6000])('不正な用紙幅 %s を断る', (widthMm) => expect(createPdf({ ...options, widthMm })).toEqual({ ok: false, reason: 'invalidPageSize' }));
  it.each(['日本語を直接描く', '\0', '\u007f\u0080'])('ASCIIでない命令や制御文字を断る', (content) => expect(createPdf({ ...options, content }).ok).toBe(false));
  it.each(['2026-02-31T00:00:00Z', 'D:20261301000000Z', 'bad', '2026-01-01T00:00:00+09:00'])('不正な日時 %s を断る', (creationDate) => expect(createPdf({ ...options, creationDate })).toEqual({ ok: false, reason: 'invalidMetadata' }));
  it('単独サロゲートを欠損文字へ置き換えない', () => expect(createPdf({ ...options, title: '\ud800' })).toEqual({ ok: false, reason: 'invalidMetadata' }));
  it('呼び出し側のstreamは変更しない', () => {
    const content = new TextEncoder().encode('0 0 m'); const before = content.slice(); pdf({ content }); expect(content).toEqual(before);
  });
});

describe('複数頁のPDFコンテナ', () => {
  it('1頁の両方の入口が旧版の固定バイト列を返す', () => {
    const page = { widthMm: 25.4, heightMm: 50.8, content: 'q\nQ' };
    const metadata = { creationDate: '2026-09-09T12:34:56Z', title: '板' };
    // 旧版の出力を転記。先頭のバイナリコメントとxref各行末の空白も1バイトずつ比較する。
    const legacy = [
      '%PDF-1.4', String.fromCharCode(37, 0xe2, 0xe3, 0xcf, 0xd3),
      '1 0 obj', '<</Type/Catalog/Pages 2 0 R>>', 'endobj',
      '2 0 obj', '<</Type/Pages/Kids[3 0 R]/Count 1>>', 'endobj',
      '3 0 obj', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 72.0000 144.0000]/Resources<<>>/Contents 4 0 R>>', 'endobj',
      '4 0 obj', '<</Length 3>>', 'stream', 'q', 'Q', 'endstream', 'endobj',
      '5 0 obj', '<</CreationDate(D:20260909123456Z)/Title<FEFF677f>>>', 'endobj',
      'xref', '0 6', '0000000000 65535 f ', '0000000015 00000 n ', '0000000060 00000 n ',
      '0000000111 00000 n ', '0000000214 00000 n ', '0000000264 00000 n ',
      'trailer', '<</Size 6/Root 1 0 R/Info 5 0 R>>', 'startxref', '332', '%%EOF', '',
    ].join('\n');
    const expected = Uint8Array.from(legacy, (character) => character.charCodeAt(0));
    const single = pdf({ ...page, ...metadata });
    const result = createPdfPages([page], metadata);
    if (!result.ok) throw new Error(result.reason);
    expect(single).toEqual(expected);
    expect(result.bytes).toEqual(single);
  });

  it('異なる用紙と命令を入力順で参照し、xrefと各stream長が実バイトに合う', () => {
    const first = { ...options, content: new TextEncoder().encode('q\r\nQ') };
    const second = { widthMm: 297, heightMm: 210, content: '0 0 m\n1 1 l\nS' };
    const result = createPdfPages([first, second], { title: '板' });
    if (!result.ok) throw new Error(result.reason);
    expect(readXref(result.bytes)).toEqual([
      '<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R 5 0 R]/Count 2>>',
      '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595.2756 841.8898]/Resources<<>>/Contents 4 0 R>>',
      '<</Length 4>>\nstream\nq\r\nQ\nendstream',
      '<</Type/Page/Parent 2 0 R/MediaBox[0 0 841.8898 595.2756]/Resources<<>>/Contents 6 0 R>>',
      '<</Length 13>>\nstream\n0 0 m\n1 1 l\nS\nendstream',
      '<</Title<FEFF677f>>>',
    ]);
    expect(ascii(result.bytes)).toContain('trailer\n<</Size 8/Root 1 0 R/Info 7 0 R>>');
  });

  it('空の頁配列と後続頁の不正な用紙・命令を断る', () => {
    expect(createPdfPages([])).toEqual({ ok: false, reason: 'invalidContent' });
    expect(createPdfPages([options, { ...options, heightMm: 0 }])).toEqual({ ok: false, reason: 'invalidPageSize' });
    expect(createPdfPages([options, { ...options, content: '板' }])).toEqual({ ok: false, reason: 'invalidContent' });
  });
});
