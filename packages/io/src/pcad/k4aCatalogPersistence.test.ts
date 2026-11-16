/**
 * 包み K4a の族(カムフォロア・巻きブシュ)の部品を置いたアセンブリの保存と開き直し(JSON と ZIP)。
 * 製品の登録口から族を読み込み、全ての行の部品を 1 つのアセンブリに置いて、開き直しても出どころが同じバイトで残り、
 * 開き直した文書から同じ形が組める事を確かめる。今の部品の保存のバイトは catalogItemPersistence.test.ts が固定している。
 */
import {
  addComponent, buildStandardPartFromSource, createAssemblyDocument, createComponentFor, createStandardPartSource,
  PRODUCT_CATALOG_REGISTRY, resolveAssembly, type AssemblyDocument, type StandardPartSource,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { isRecord } from './guards.js';
import { readPcadaFile, writePcadaFile } from './pcadFile.js';

const SAVE_OPTIONS = { savedAt: '2026-11-15T00:00:00.000Z' };
const K4A_FAMILY_IDS = ['cam-follower-stud-metric', 'wrapped-bush'] as const;

async function k4aSources(): Promise<readonly StandardPartSource[]> {
  await PRODUCT_CATALOG_REGISTRY.ensure(K4A_FAMILY_IDS);
  return K4A_FAMILY_IDS.flatMap((id) => {
    const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
    if (family === undefined) throw new Error(`family not loaded: ${id}`);
    return family.rows.map((row) => createStandardPartSource('catalogItem', row.size, { family: id, item: row.key }));
  });
}

function assemblyOf(sources: readonly StandardPartSource[]): AssemblyDocument {
  let document = createAssemblyDocument('機械要素の保存');
  for (const source of sources) document = addComponent(document, createComponentFor(document, source));
  return document;
}

describe('K4a の族の部品の保存と開き直し', () => {
  it('全ての行(カムフォロア 17・巻きブシュ 116)を置いた文書は、JSON と ZIP で開き直しても同じで、書き直したバイトが一致する', async () => {
    const sources = await k4aSources();
    expect(sources).toHaveLength(133);
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
      expect(resolved.parts.size).toBe(133);
    }
  });

  it('ファイルの中の出どころは族・行の鍵・版だけ(寸法・出どころの資料は書かない)', async () => {
    const sources = await k4aSources();
    const text = writeAssemblyDocument(assemblyOf(sources.slice(0, 1)), SAVE_OPTIONS);
    const parsed: unknown = JSON.parse(text);
    const components: readonly unknown[] = isRecord(parsed) && isRecord(parsed.document) && Array.isArray(parsed.document.components)
      ? parsed.document.components : [];
    const first: unknown = components[0];
    expect(JSON.stringify(isRecord(first) ? first.source : null)).toBe('{"kind":"standardPart","catalog":"catalogItem",'
      + '"size":"D10","options":{"family":"cam-follower-stud-metric","item":"D10"},'
      + '"catalogRevision":"cam-follower-2026-11-r1","generatorRevision":"cam-follower-1"}');
    expect(text).not.toMatch(/sha256|https?:|資料|outsideDiameter/u);
  });
});
