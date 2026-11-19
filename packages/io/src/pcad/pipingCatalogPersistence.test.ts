/**
 * 包み K-28 の配管の族(ねじ込み式管継手のエルボ・チーズ・ソケット)の部品を置いたアセンブリの保存と開き直し(JSON と ZIP)。
 * 族ごとに全ての行を置き、開き直しても出どころが同じバイトで残り、開き直した文書から同じ形が組める事を確かめる。
 */
import {
  addComponent, buildStandardPartFromSource, createAssemblyDocument, createComponentFor, createStandardPartSource,
  PRODUCT_CATALOG_REGISTRY, resolveAssembly, type AssemblyDocument, type StandardPartSource,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { readPcadaFile, writePcadaFile } from './pcadFile.js';

const SAVE_OPTIONS = { savedAt: '2026-11-19T00:00:00.000Z' };
/** [族の id, 行の数]。 */
const PIPING_FAMILIES: [string, number][] = [['pipe-fitting-elbow', 14], ['pipe-fitting-tee', 14], ['pipe-fitting-socket', 14]];

async function sourcesOf(id: string): Promise<readonly StandardPartSource[]> {
  await PRODUCT_CATALOG_REGISTRY.ensure([id]);
  const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
  if (family === undefined) throw new Error(`family not loaded: ${id}`);
  return family.rows.map((row) => createStandardPartSource('catalogItem', row.size, { family: id, item: row.key }));
}

function assemblyOf(sources: readonly StandardPartSource[]): AssemblyDocument {
  let document = createAssemblyDocument('配管の保存 K-28');
  for (const source of sources) document = addComponent(document, createComponentFor(document, source));
  return document;
}

describe('K-28 の配管の族の部品の保存と開き直し', () => {
  it('登録口の配管の族は 3(分類 piping。行は合わせて 42)', () => {
    expect(PRODUCT_CATALOG_REGISTRY.entries.filter((entry) => entry.group === 'piping').map((entry) => entry.id))
      .toEqual(PIPING_FAMILIES.map(([id]) => id));
    expect(PIPING_FAMILIES.reduce((sum, [, count]) => sum + count, 0)).toBe(42);
  });

  it.each(PIPING_FAMILIES)('%s の全ての行を置いた文書は、JSON と ZIP で開き直しても同じで、組める(%i 行)', async (id, count) => {
    const sources = await sourcesOf(id);
    expect(sources).toHaveLength(count);
    const document = assemblyOf(sources);
    const text = writeAssemblyDocument(document, SAVE_OPTIONS);
    const bytes = await writePcadaFile(document, SAVE_OPTIONS);
    const json = readAssemblyDocument(text);
    const zip = await readPcadaFile(bytes);
    if (!json.ok || !zip.ok) throw new Error('reopen failed');
    for (const reopened of [json.document, zip.document]) {
      expect(reopened).toEqual(document);
      expect(writeAssemblyDocument(reopened, SAVE_OPTIONS)).toBe(text);
      expect(await writePcadaFile(reopened, SAVE_OPTIONS)).toEqual(bytes);
      const resolved = resolveAssembly(reopened, { standardPart: buildStandardPartFromSource });
      expect(resolved.errors).toEqual([]);
      expect(resolved.parts.size).toBe(count);
    }
  });
});
