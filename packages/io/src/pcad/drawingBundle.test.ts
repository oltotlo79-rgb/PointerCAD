import { describe, expect, it } from 'vitest';
import { createAssemblyDocument, createDrawingDocument, createEmptyPartDocument, embedDrawingSource,
  embedPart, EMPTY_PART_LIBRARY, emptyDrawingSourceLibrary, emptyEmbeddedPartAttachments,
  type DrawingSourceInput } from '@pointercad/model';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { readDrawingBundle, writeDrawingBundle } from './drawingBundle.js';
import { writePcaddFile } from './pcadFile.js';

const savedAt = '2026-09-10T00:00:00.000Z';
async function fixture(source: DrawingSourceInput) {
  const embedded = await embedDrawingSource(emptyDrawingSourceLibrary(), source, 'source.pcad', '', { importedAt: savedAt });
  return { document: createDrawingDocument('図面', embedded.source), source };
}
async function assemblySource(): Promise<Extract<DrawingSourceInput, { sourceKind: 'assembly' }>> {
  const attachments = { ...emptyEmbeddedPartAttachments(), shapes: new Map([['original', new Uint8Array([1, 2, 3, 4])]]) };
  const part = await embedPart(EMPTY_PART_LIBRARY, createEmptyPartDocument(), 'part.pcad', '', { attachments, importedAt: savedAt });
  return { sourceKind: 'assembly', document: createAssemblyDocument('組'), library: part.library };
}

describe('図面が参照元の部品文書と原本を一緒に保存する(P8-59/64)', () => {
  it('新しい部品の図面を往復する', async () => {
    const input = await fixture({ sourceKind: 'part', document: createEmptyPartDocument() });
    const read = await readDrawingBundle(await writeDrawingBundle(input.document, { source: input.source, savedAt }));
    expect(read).toMatchObject({ ok: true, document: input.document, source: input.source, savedAt });
  });
  it('従来の添付なしpcaddも開ける', async () => {
    const input = await fixture({ sourceKind: 'part', document: createEmptyPartDocument() });
    expect(await readDrawingBundle(writePcaddFile(input.document, { source: input.source, savedAt }))).toMatchObject({ ok: true, document: input.document });
  });
  it('部品の未参照原本も捨てずに保存する', async () => {
    const attachments = { ...emptyEmbeddedPartAttachments(), shapes: new Map([['source-a', new Uint8Array([8, 9])]]),
      canvases: new Map([['canvas-a', new Uint8Array([10, 11])]]) };
    const input = await fixture({ sourceKind: 'part', document: createEmptyPartDocument(), attachments });
    const result = await readDrawingBundle(await writeDrawingBundle(input.document, { source: input.source, savedAt }));
    expect(result).toMatchObject({ ok: true, source: { attachments } });
  });
  it('組図の部品文書・原本・素性を再起動後にも取り出せる', async () => {
    const input = await fixture(await assemblySource());
    const read = await readDrawingBundle(await writeDrawingBundle(input.document, { source: input.source, savedAt }));
    expect(read).toMatchObject({ ok: true, source: input.source });
  });
  it('同じ名前空間にあるサブアセンブリ文書も保持する', async () => {
    const source = await assemblySource();
    if (source.library === undefined) throw new Error('Missing fixture library');
    const nested = createAssemblyDocument('内部の組');
    const input = await fixture({ ...source, library: { ...source.library, assemblies: new Map([['assembly-1', nested]]) } });
    const read = await readDrawingBundle(await writeDrawingBundle(input.document, { source: input.source, savedAt }));
    expect(read).toMatchObject({ ok: true, source: { library: { assemblies: new Map([['assembly-1', nested]]) } } });
  });
  it('同じ時刻と文書なら組図のZIP全体が一致する', async () => {
    const input = await fixture(await assemblySource());
    expect(await writeDrawingBundle(input.document, { source: input.source, savedAt }))
      .toEqual(await writeDrawingBundle(input.document, { source: input.source, savedAt }));
  });
  it('部品の原本が書き換わったときはダイジェスト検査で断る', async () => {
    const input = await fixture(await assemblySource());
    const entries = unzipSync(await writeDrawingBundle(input.document, { source: input.source, savedAt }));
    const path = Object.keys(entries).find((key) => key.endsWith('/shapes/original.brep'));
    if (path === undefined) throw new Error('Missing fixture original');
    entries[path] = new Uint8Array([99]);
    expect(await readDrawingBundle(zipSync(entries))).toMatchObject({ ok: false });
  });
  it('欠落した部品の参照と素性を保持し、開いた後に未解決を知らせられる', async () => {
    const input = await fixture(await assemblySource());
    const entries = unzipSync(await writeDrawingBundle(input.document, { source: input.source, savedAt }));
    const path = Object.keys(entries).find((key) => key.endsWith('/parts/part-1.json'));
    if (path === undefined) throw new Error('Missing fixture part');
    delete entries[path];
    const read = await readDrawingBundle(zipSync(entries));
    expect(read).toMatchObject({ ok: true, source: { library: { parts: new Map(),
      partFiles: [{ ref: 'part-1', fileName: 'part.pcad' }] } } });
  });
  it('壊れた抱き込み文書のJSONを断る', async () => {
    const input = await fixture(await assemblySource());
    const entries = unzipSync(await writeDrawingBundle(input.document, { source: input.source, savedAt }));
    const path = Object.keys(entries).find((key) => key.endsWith('/parts/part-1.json'));
    if (path === undefined) throw new Error('Missing fixture part');
    entries[path] = strToU8('{');
    expect(await readDrawingBundle(zipSync(entries))).toMatchObject({ ok: false });
  });
  it('種類の異なる参照を誤って保存しない', async () => {
    const input = await fixture({ sourceKind: 'part', document: createEmptyPartDocument() });
    await expect(writeDrawingBundle(input.document, { source: await assemblySource(), savedAt })).rejects.toThrow('kind mismatch');
  });
  it('危険な参照名で名前空間の外へ書かない', async () => {
    const input = await fixture({ sourceKind: 'part', document: createEmptyPartDocument() });
    await expect(writeDrawingBundle({ ...input.document, source: { ...input.document.source, sourceRef: '../outside' } },
      { source: input.source, savedAt })).rejects.toThrow('reference');
  });
  it('ZIPでない入力は例外を漏らさず断る', async () => {
    expect(await readDrawingBundle(new Uint8Array([1, 2, 3]))).toMatchObject({ ok: false });
  });
});
