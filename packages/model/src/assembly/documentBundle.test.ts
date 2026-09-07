import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument } from '../part/createPartDocument.js';
import { createAssemblyDocument } from './createAssemblyDocument.js';
import { embedPart, EMPTY_PART_LIBRARY, emptyEmbeddedPartAttachments } from './partLibrary.js';
import {
  createAssemblyDocumentBundle,
  createPartDocumentBundle,
  partLibraryOfBundle,
} from './documentBundle.js';

describe('文書の束', () => {
  it('部品文書と原本の添付を参照を保って持つ', () => {
    const document = createEmptyPartDocument();
    const attachments = emptyEmbeddedPartAttachments();
    const bundle = createPartDocumentBundle(document, attachments);
    expect(bundle.kind).toBe('part');
    expect(bundle.document).toBe(document);
    expect(bundle.attachments).toBe(attachments);
  });

  it('新規アセンブリにも文書と空の添付・部品の表がある', () => {
    const document = createAssemblyDocument('組立1');
    const bundle = createAssemblyDocumentBundle(document);
    expect(bundle.document).toBe(document);
    expect(bundle.embeddedDocuments.size).toBe(0);
    expect(partLibraryOfBundle(bundle)).toEqual(EMPTY_PART_LIBRARY);
  });

  it('部品ライブラリとの往復で文書・原本・素性を失わない', async () => {
    const attachments = {
      ...emptyEmbeddedPartAttachments(),
      shapes: new Map([['shape-1', Uint8Array.of(1, 2, 3)]]),
    };
    const embedded = await embedPart(
      EMPTY_PART_LIBRARY, createEmptyPartDocument(), 'part.pcad', './part.pcad',
      { importedAt: '2026-09-07T00:00:00.000Z', attachments },
    );
    const bundle = createAssemblyDocumentBundle(createAssemblyDocument('組立1'), embedded.library);
    expect(partLibraryOfBundle(bundle)).toEqual(embedded.library);
    expect(bundle.embeddedDocuments.get(embedded.partRef)?.attachments).toBe(attachments);
  });
});
