import { ASSEMBLY_EXAMPLES, DRAWING_EXAMPLES, drawingSourceInputHash, drawingSourceInputOf } from '@pointercad/model';
import { expect, it } from 'vitest';
import { readDrawingBundle, writeDrawingBundle } from './drawingBundle.js';
import { readDocumentBundle, writeDocumentBundle } from './pcadFile.js';

/** The reader also returns the digest of each kept shape (empty here: the examples keep no imported shape). */
const withShapeDigests = <T extends { readonly attachments?: object }>(part: T): T =>
  ({ ...part, attachments: { ...part.attachments, shapeDigests: new Map<string, string>() } });

it.each(ASSEMBLY_EXAMPLES)('$id は部品の参照・配置・原本を含めて保存前と同じ組立に戻る', async example => {
  const bundle = await example.create();
  const opened = await readDocumentBundle(await writeDocumentBundle(bundle), 'assembly');
  if (!opened.ok) throw new Error(opened.error.message);
  expect(opened.bundle).toEqual({ ...bundle,
    embeddedDocuments: new Map([...bundle.embeddedDocuments].map(([key, part]) => [key, withShapeDigests(part)])) });
});

it.each(DRAWING_EXAMPLES)('$id は三面図・寸法・表・埋め込んだ部品を一緒に読み直せる', async example => {
  const { document, library } = await example.create();
  const entry = library.sources.find(item => item.metadata.sourceRef === document.source.sourceRef);
  const source = entry === undefined ? null : drawingSourceInputOf(entry);
  if (source?.sourceKind !== 'part') throw new Error('Missing drawing source');
  const opened = await readDrawingBundle(await writeDrawingBundle(document, { source }));
  if (!opened.ok) throw new Error(opened.error.message);
  expect(opened.document).toEqual(document);
  expect(opened.source).toEqual(withShapeDigests(source));
  expect(await drawingSourceInputHash(opened.source)).toBe(document.source.contentHash);
});
