/**
 * 包み K-05 の族(ローラフォロア・アンギュラ玉軸受・スラスト玉軸受・円筒ころ軸受ほか)の部品を置いたアセンブリの
 * 保存と開き直し(JSON と ZIP)。族ごとに全ての行を置き、開き直しても出どころが同じバイトで残り、
 * 開き直した文書から同じ形が組める事を確かめる。
 */
import {
  addComponent, buildStandardPartFromSource, createAssemblyDocument, createComponentFor, createStandardPartSource,
  PRODUCT_CATALOG_REGISTRY, resolveAssembly, type AssemblyDocument, type StandardPartSource,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { readPcadaFile, writePcadaFile } from './pcadFile.js';

const SAVE_OPTIONS = { savedAt: '2026-11-16T00:00:00.000Z' };
/** [族の id, 行の数]。 */
const K5_FAMILIES: [string, number][] = [
  ['roller-follower-yoke-metric', 14], ['angular-contact-ball-bearing', 183], ['thrust-ball-bearing-flat-seat', 40],
  ['cylindrical-roller-bearing-nu', 129], ['cylindrical-roller-bearing-nj', 83], ['cylindrical-roller-bearing-nup', 99],
  ['cylindrical-roller-bearing-n', 49], ['cylindrical-roller-bearing-nf', 49], ['needle-roller-bearing-rna', 34],
  ['cross-recessed-pan-head-screw', 9], ['cross-recessed-countersunk-screw', 9], ['plain-washer-normal', 29],
  ['plain-washer-small', 21], ['spring-washer-number2', 23], ['spring-washer-number3', 12], ['socket-head-cap-screw', 19],
  ['countersunk-socket-screw', 10], ['hex-bolt-main', 28], ['button-head-socket-screw', 8],
  ['e-ring', 17], ['plain-washer-large', 18], ['parallel-key-square', 32], ['taper-pin', 20],
  ['split-pin', 16], ['flange-nut', 8], ['cross-recessed-cheese-head-screw', 7],
  ['set-screw-cup-point', 12], ['set-screw-flat-point', 12], ['set-screw-dog-point', 12], ['set-screw-cone-point', 12],
  ['oil-seal-specified', 1], ['o-ring-p', 122], ['o-ring-g', 46], ['c-ring-shaft', 39], ['c-ring-bore', 50],
];

async function sourcesOf(id: string): Promise<readonly StandardPartSource[]> {
  await PRODUCT_CATALOG_REGISTRY.ensure([id]);
  const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
  if (family === undefined) throw new Error(`family not loaded: ${id}`);
  return family.rows.map((row) => createStandardPartSource('catalogItem', row.size, { family: id, item: row.key }));
}

function assemblyOf(sources: readonly StandardPartSource[]): AssemblyDocument {
  let document = createAssemblyDocument('機械要素の保存 K-05');
  for (const source of sources) document = addComponent(document, createComponentFor(document, source));
  return document;
}

describe('K-05 の族の部品の保存と開き直し', () => {
  it('登録口の K-05 の族は 35(行は合わせて 1272)', () => {
    expect(K5_FAMILIES.every(([id]) => PRODUCT_CATALOG_REGISTRY.entry(id) !== undefined)).toBe(true);
    expect(K5_FAMILIES.reduce((sum, [, count]) => sum + count, 0)).toBe(1272);
  });

  it.each(K5_FAMILIES)('%s の全ての行を置いた文書は、JSON と ZIP で開き直しても同じで、組める(%i 行)', async (id, count) => {
    const sources = await sourcesOf(id);
    expect(sources).toHaveLength(count);
    expect(sources.every((source) => source.catalogRevision !== '' && source.generatorRevision !== '')).toBe(true);
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
