/**
 * K-28 束 3: 鋼管の端の継手の組の記録(組の id 'pipe-end-fittings'・役目 startFitting・endFitting・指定の familyId と turn)の保存と読み込み。
 * 版 23 のまま。新しい欄は新しい組の記録だけが持ち、ほかの組の記録に欄があれば読まない。継手の部品と記録は JSON・ZIP で同じに戻り、組める。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, ALL_STEEL_PRODUCTS, applyAccessorySet, buildStandardPartFromSource, createAssemblyDocument, createComponentFor,
  createStandardPartSource, PRODUCT_CATALOG_REGISTRY, resolveAssembly, steelProductOptions, type AssemblyDocument,
} from '@pointercad/model';
import { beforeAll, describe, expect, it } from 'vitest';

import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { readPcadaFile, writePcadaFile } from './pcadFile.js';

const SAVED_AT = { savedAt: '2026-11-19T00:00:00.000Z' };
const registry = PRODUCT_CATALOG_REGISTRY;
const FITTINGS = ['pipe-fitting-socket', 'pipe-fitting-elbow', 'pipe-fitting-tee', 'pipe-fitting-cap', 'pipe-flange-5k', 'pipe-flange-10k'];

beforeAll(async () => { await registry.ensure(FITTINGS); });

/** SGP 25A を長さ 1000 で 1 本置き、両端にエルボ(枝の向き 1)を付けた文書。 */
function elbowedPipe(): AssemblyDocument {
  const pipe = ALL_STEEL_PRODUCTS.find((row) => row.key === 'SGP:steelPipe:25A');
  if (pipe === undefined) throw new Error('SGP 25A missing');
  const empty = createAssemblyDocument('pipe-end-fittings');
  const host = createComponentFor(empty, createStandardPartSource(pipe.catalog, pipe.size, { ...steelProductOptions(pipe), length: '1000' }),
    { partName: 'pipe', placement: { position: [expressionValueFromNumber(0), expressionValueFromNumber(0), expressionValueFromNumber(0)],
      rotation: [0, 0, 0, 1] } });
  const document = addComponent(empty, host);
  const applied = applyAccessorySet(document, host.id, 'pipe-end-fittings',
    { ends: 'both', endReference: 'overall', itemKey: 'elbow-25A', familyId: 'pipe-fitting-elbow', turn: 1 }, registry);
  if (!applied.ok) throw new Error(applied.reason);
  return applied.value.document;
}

interface Parsed { document: { accessorySets: { setId: string; choices: Record<string, unknown> }[] } }
const reparse = (parsed: Parsed): string => JSON.stringify(parsed, null, 2) + String.fromCharCode(10);

describe('K-28 束 3 鋼管の端の継手の記録の保存', () => {
  it('記録・継手の部品は JSON と ZIP で同じに戻り、書き直しは同じバイトで、版は 23、開き直した文書から組める', async () => {
    const document = elbowedPipe();
    const text = writeAssemblyDocument(document, SAVED_AT);
    const bytes = await writePcadaFile(document, SAVED_AT);
    const json = readAssemblyDocument(text);
    const zip = await readPcadaFile(bytes);
    if (!json.ok || !zip.ok) throw new Error('reopen failed');
    for (const reopened of [json.document, zip.document]) {
      expect(reopened).toEqual(document);
      expect(reopened.schemaVersion).toBe(23);
      expect(reopened.accessorySets?.[0]?.choices).toEqual({ ends: 'both', endReference: 'overall', itemKey: 'elbow-25A',
        familyId: 'pipe-fitting-elbow', turn: 1 });
      expect(writeAssemblyDocument(reopened, SAVED_AT)).toBe(text);
      expect(await writePcadaFile(reopened, SAVED_AT)).toEqual(bytes);
      const resolved = resolveAssembly(reopened, { standardPart: buildStandardPartFromSource });
      expect(resolved.errors).toEqual([]);
      expect(resolved.parts.size).toBe(2);
    }
    expect(text.indexOf('"familyId"')).toBeGreaterThan(text.indexOf('"itemKey"'));
    expect(text.indexOf('"turn"')).toBeGreaterThan(text.indexOf('"familyId"'));
  });

  it('鋼管の端の継手の記録に族の id が無い・枝の向きが 0〜3 の整数でない時は読まない', () => {
    const parsed = JSON.parse(writeAssemblyDocument(elbowedPipe(), SAVED_AT)) as Parsed;
    const record = parsed.document.accessorySets[0];
    if (record === undefined) throw new Error('record missing');
    const original = { ...record.choices };
    for (const choices of [{ ...original, familyId: undefined }, { ...original, familyId: '' }, { ...original, turn: 4 }, { ...original, turn: 1.5 },
      { ...original, turn: '1' }]) {
      record.choices = choices;
      expect(readAssemblyDocument(reparse(parsed)).ok).toBe(false);
    }
    record.choices = { ...original, turn: undefined };
    const withoutTurn = readAssemblyDocument(reparse(parsed));
    expect(withoutTurn.ok ? withoutTurn.document.accessorySets?.[0]?.choices : null)
      .toEqual({ ends: 'both', endReference: 'overall', itemKey: 'elbow-25A', familyId: 'pipe-fitting-elbow' });
  });

  it('ほかの組の記録に族の id・枝の向きの欄があれば読まない(新しい欄は新しい組の記録だけ)', () => {
    const parsed = JSON.parse(writeAssemblyDocument(elbowedPipe(), SAVED_AT)) as Parsed;
    const record = parsed.document.accessorySets[0];
    if (record === undefined) throw new Error('record missing');
    record.setId = 'frame-end-caps';
    record.choices = { ends: 'both', endReference: 'overall', itemKey: 's6-20x20', familyId: 't-slot-frame-cap' };
    expect(readAssemblyDocument(reparse(parsed)).ok).toBe(false);
    record.choices = { ends: 'both', endReference: 'overall', itemKey: 's6-20x20', turn: 0 };
    expect(readAssemblyDocument(reparse(parsed)).ok).toBe(false);
  });
});
