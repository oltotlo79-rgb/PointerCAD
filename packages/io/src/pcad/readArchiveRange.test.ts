import { randomFillSync } from 'node:crypto';
import { createAssemblyDocument, createAssemblyDocumentBundle, createDrawingDocument, createEmptyPartDocument,
  embedDrawingSource, embedPart, EMPTY_PART_LIBRARY, emptyDrawingSourceLibrary, emptyEmbeddedPartAttachments,
  type DrawingSourceInput } from '@pointercad/model';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ARCHIVE_READ_CHUNK_BYTES, ArchiveReadSourceError, type ArchiveReadSource } from './archiveReadSource.js';
import { openArchiveSource, readArchive } from './readArchive.js';
import { readAssemblyFromSource, readDocumentBundle, writeDocumentBundle } from './pcadFile.js';
import { readDrawingBundle, readDrawingFromSource, writeDrawingBundle } from './drawingBundle.js';
import zip64 from './zip64Fixtures.json';
import descriptors from './zipDescriptorFixtures.json';

function sourceOf(bytes: Uint8Array, shorten = false) {
  const requests: { offset: number; length: number }[] = [];
  const source: ArchiveReadSource = {
    size: bytes.length,
    read(offset, length) {
      requests.push({ offset, length });
      return Promise.resolve(bytes.slice(offset, offset + length - (shorten ? 1 : 0)));
    },
  };
  return { source, requests };
}

async function extractAll(source: ArchiveReadSource) {
  const opened = await openArchiveSource(source);
  return opened.ok ? opened.archive.extract({ shouldExtract: () => true }) : opened;
}

describe('上限付きの範囲ソースからZIPを読む', () => {
  it.each([0, 6] as const)('方式 %s は実際の圧縮入力が複数の範囲をまたいでも全バイトを復元する', async level => {
    const payload = randomFillSync(new Uint8Array(ARCHIVE_READ_CHUNK_BYTES * 2 + 127));
    const bytes = zipSync({ 'canvases/orphan.png': payload }, { level });
    const { source, requests } = sourceOf(bytes);
    expect(bytes.byteLength).toBeGreaterThan(ARCHIVE_READ_CHUNK_BYTES * 2);
    const result = await extractAll(source);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.reason);
    expect(result.entries.get('canvases/orphan.png')).toEqual(payload);
    expect(requests.some(({ offset }) => offset >= ARCHIVE_READ_CHUNK_BYTES)).toBe(true);
    expect(Math.max(...requests.map(({ length }) => length))).toBe(ARCHIVE_READ_CHUNK_BYTES);
  });

  it('独立のZIP64と省略可能なdescriptor署名を既存のバイト読取と同じ解釈にする', async () => {
    for (const fixture of [...zip64.fixtures, ...descriptors.fixtures]) {
      const bytes = Uint8Array.from(atob(fixture.zip), char => char.charCodeAt(0));
      const expected = readArchive(bytes, { shouldExtract: () => true });
      expect(expected.ok).toBe(true);
      expect(await extractAll(sourceOf(bytes).source)).toEqual(expected);
    }
  });

  it('CRC が実データと違う場合と短縮された読取を区別して断る', async () => {
    const bytes = zipSync({ 'document.json': strToU8('{}') }, { level: 0 });
    const payload = 30 + 'document.json'.length;
    bytes[payload] = (bytes[payload] ?? 0) ^ 1;
    await expect(extractAll(sourceOf(bytes).source)).resolves.toMatchObject({ ok: false, error: { kind: 'invalidZip' } });
    await expect(extractAll(sourceOf(bytes, true).source)).rejects.toBeInstanceOf(ArchiveReadSourceError);
  });

  it('図面の封筒と参照元の展開を別に要求しても同じ合計予算を使う', async () => {
    const bytes = zipSync({ 'document.json': strToU8('abcd'), 'source/ref/canvases/a.png': strToU8('xyz') });
    const opened = await openArchiveSource(sourceOf(bytes).source, {
      archiveCompressedBytes: 1, archiveEntryCount: 2, archiveEntryExpandedBytes: 6, archiveTotalExpandedBytes: 6,
    });
    if (!opened.ok) throw new Error(opened.error.reason);
    await expect(opened.archive.extract({ shouldExtract: name => name === 'document.json' })).resolves.toMatchObject({ ok: true });
    await expect(opened.archive.extract({ shouldExtract: name => name.startsWith('source/') }))
      .resolves.toMatchObject({ ok: false, error: { kind: 'totalExpanded' } });
  });

  it('組立と図面の参照元を添付まで従来の読み手と同じように復元する', async () => {
    const attachments = { ...emptyEmbeddedPartAttachments(), canvases: new Map([['canvas', Uint8Array.of(1, 2, 3)]]) };
    const part = createEmptyPartDocument();
    const embedded = await embedPart(EMPTY_PART_LIBRARY, part, 'source.pcad', '', { attachments });
    const assembly = createAssemblyDocument('範囲読取の組立');
    const bundle = createAssemblyDocumentBundle(assembly, embedded.library);
    const assemblyBytes = await writeDocumentBundle(bundle);
    const expectedAssembly = await readDocumentBundle(assemblyBytes, 'assembly');
    expect(expectedAssembly.ok).toBe(true);
    await expect(readAssemblyFromSource(sourceOf(assemblyBytes).source)).resolves.toEqual(expectedAssembly);
    const sources: DrawingSourceInput[] = [{ sourceKind: 'part', document: part, attachments },
      { sourceKind: 'assembly', document: assembly, library: embedded.library }];
    for (const source of sources) {
      const embeddedSource = await embedDrawingSource(emptyDrawingSourceLibrary(), source, 'source', '');
      const drawing = createDrawingDocument('範囲読取の図面', embeddedSource.source);
      const bytes = await writeDrawingBundle(drawing, { source });
      const expected = await readDrawingBundle(bytes);
      expect(expected.ok).toBe(true);
      await expect(readDrawingFromSource(sourceOf(bytes).source)).resolves.toEqual(expected);
    }
  });
});
