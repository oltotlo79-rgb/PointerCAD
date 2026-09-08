import { describe, expect, it } from 'vitest';

import { createAssemblyDocument } from '../assembly/createAssemblyDocument.js';
import { createEmptyPartDocument } from '../part/createPartDocument.js';
import type { PartDocument } from '../part/types.js';
import {
  canonicalDrawingSourceText,
  drawingSourceContentHash,
  drawingSourceDocumentOf,
  embedDrawingSource,
  emptyDrawingSourceLibrary,
  replaceDrawingSource,
} from './sourceLibrary.js';

function namedPart(name: string): PartDocument {
  return { ...createEmptyPartDocument(), name };
}

describe('図面へ参照元を抱き込む', () => {
  it('同じ文書の内容ハッシュは2回とも一致する', async () => {
    const part = namedPart('部品');
    await expect(drawingSourceContentHash(part)).resolves.toBe(await drawingSourceContentHash(part));
  });

  it('文書名が1文字違えば内容ハッシュが変わる', async () => {
    const first = namedPart('部品A');
    const second = namedPart('部品B');
    expect(await drawingSourceContentHash(first)).not.toBe(await drawingSourceContentHash(second));
  });

  it('オブジェクトの鍵順に依存しない決定的な文字列を作る', () => {
    expect(canonicalDrawingSourceText({ b: 2, a: 1 })).toBe(
      canonicalDrawingSourceText({ a: 1, b: 2 }),
    );
  });

  it('最初の文書をsource-1として抱き込む', async () => {
    const part = namedPart('部品');
    const result = await embedDrawingSource(
      emptyDrawingSourceLibrary(),
      { sourceKind: 'part', document: part },
      'part.pcad',
      './part.pcad',
      { importedAt: '2026-09-08T00:00:00.000Z' },
    );
    expect(result.source).toMatchObject({
      sourceRef: 'source-1', sourceKind: 'part', fileName: 'part.pcad',
    });
    expect(drawingSourceDocumentOf(result.library, 'source-1')).toBe(part);
  });

  it('同じ種類・同じ中身は再利用する', async () => {
    const part = namedPart('部品');
    const first = await embedDrawingSource(
      emptyDrawingSourceLibrary(),
      { sourceKind: 'part', document: part },
      'part.pcad',
      './part.pcad',
    );
    const second = await embedDrawingSource(
      first.library,
      { sourceKind: 'part', document: part },
      'copy.pcad',
      './copy.pcad',
    );
    expect(second.reused).toBe(true);
    expect(second.library).toBe(first.library);
    expect(second.source.sourceRef).toBe('source-1');
  });

  it('部品とアセンブリを別の参照として抱き込む', async () => {
    const first = await embedDrawingSource(
      emptyDrawingSourceLibrary(),
      { sourceKind: 'part', document: namedPart('部品') },
      'part.pcad',
      './part.pcad',
    );
    const second = await embedDrawingSource(
      first.library,
      { sourceKind: 'assembly', document: createAssemblyDocument('組立') },
      'assembly.pcada',
      './assembly.pcada',
    );
    expect(second.source.sourceRef).toBe('source-2');
    expect(second.library.sources).toHaveLength(2);
  });

  it('抱き込む値にB-repやメッシュの別添付を作らない', async () => {
    const result = await embedDrawingSource(
      emptyDrawingSourceLibrary(),
      { sourceKind: 'part', document: namedPart('部品') },
      'part.pcad',
      './part.pcad',
    );
    expect(result.library).not.toHaveProperty('shapes');
    expect(result.library).not.toHaveProperty('meshes');
  });

  it('差し替えは元を変えずハッシュと文書を更新する', async () => {
    const first = await embedDrawingSource(
      emptyDrawingSourceLibrary(),
      { sourceKind: 'part', document: namedPart('部品A') },
      'part.pcad',
      './part.pcad',
    );
    const nextPart = namedPart('部品B');
    const next = await replaceDrawingSource(
      first.library,
      'source-1',
      { sourceKind: 'part', document: nextPart },
      { importedAt: '2026-09-09T00:00:00.000Z' },
    );
    expect(next).not.toBe(first.library);
    expect(drawingSourceDocumentOf(first.library, 'source-1')).not.toBe(nextPart);
    expect(drawingSourceDocumentOf(next, 'source-1')).toBe(nextPart);
    expect(next.sources[0]?.metadata.importedAt).toBe('2026-09-09T00:00:00.000Z');
  });

  it('知らない参照の差し替えは元を返す', async () => {
    const library = emptyDrawingSourceLibrary();
    await expect(replaceDrawingSource(
      library,
      'missing',
      { sourceKind: 'part', document: namedPart('部品') },
    )).resolves.toBe(library);
  });
});
