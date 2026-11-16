/**
 * 包み K4b の族(平行ピン・六角ナットの拡張 3 種・圧縮コイルばね)の部品を置いたアセンブリの保存と開き直し(JSON と ZIP)。
 * 長さなどの指定の値(式)は保存した文字のまま残り、開き直した文書から同じ形が組める事を確かめる。
 */
import {
  addComponent, buildStandardPartFromSource, createAssemblyDocument, createComponentFor, createStandardPartSource,
  PRODUCT_CATALOG_REGISTRY, resolveAssembly, type AssemblyDocument, type StandardPartSource,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { readPcadaFile, writePcadaFile } from './pcadFile.js';

const SAVE_OPTIONS = { savedAt: '2026-11-16T00:00:00.000Z' };
const K4B_FAMILY_IDS = ['parallel-pin', 'hex-nut-style1-extended', 'hex-nut-style2', 'hex-nut-thin', 'compression-spring'] as const;

async function k4bSources(): Promise<readonly StandardPartSource[]> {
  await PRODUCT_CATALOG_REGISTRY.ensure(K4B_FAMILY_IDS);
  return K4B_FAMILY_IDS.flatMap((id) => {
    const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
    if (family === undefined) throw new Error(`family not loaded: ${id}`);
    const values: Readonly<Record<string, string>> = id === 'parallel-pin' ? { length: '12*2' }
      : id === 'compression-spring' ? { wireDiameter: '1.6', meanDiameter: '12', freeLength: '40', totalCoils: '7.5' } : {};
    return family.rows.map((row) => createStandardPartSource('catalogItem', row.size, { family: id, item: row.key, ...values }));
  });
}

function assemblyOf(sources: readonly StandardPartSource[]): AssemblyDocument {
  let document = createAssemblyDocument('機械要素の保存 K4b');
  for (const source of sources) document = addComponent(document, createComponentFor(document, source));
  return document;
}

describe('K4b の族の部品の保存と開き直し', () => {
  it('全ての行(平行ピン 40・ナット 17＋15＋28・ばね 1)を置いた文書は、JSON と ZIP で開き直しても同じで、組める', async () => {
    const sources = await k4bSources();
    expect(sources).toHaveLength(101);
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
      expect(resolved.parts.size).toBe(101);
    }
  });

  it('指定の値は保存した式の文字のまま残る', async () => {
    const sources = await k4bSources();
    const pin = sources.find((source) => source.options.family === 'parallel-pin');
    const spring = sources.find((source) => source.options.family === 'compression-spring');
    expect(pin?.options).toEqual({ family: 'parallel-pin', item: 'St-d0.6', length: '12*2' });
    expect(spring?.options).toEqual({ family: 'compression-spring', item: 'specified', wireDiameter: '1.6', meanDiameter: '12',
      freeLength: '40', totalCoils: '7.5' });
  });
});
