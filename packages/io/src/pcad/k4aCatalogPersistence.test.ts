/**
 * 包み K4a の族(カムフォロア・巻きブシュ)の部品の保存の中身。全部の行を置いた保存と開き直し(JSON と ZIP)は、
 * 登録の表から族ごとに回す catalogRegistryPersistence.test.ts が見る(P2)。今の部品の保存のバイトは catalogItemPersistence.test.ts が固定している。
 */
import {
  addComponent, createAssemblyDocument, createComponentFor, createStandardPartSource,
  PRODUCT_CATALOG_REGISTRY, type AssemblyDocument, type StandardPartSource,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { writeAssemblyDocument } from './assemblyJson.js';
import { isRecord } from './guards.js';

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
