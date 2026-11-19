import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, applyAccessorySet, createAssemblyDocument, createCatalogItemSource, createComponentFor, PRODUCT_CATALOG_REGISTRY,
  type AssemblyDocument,
} from '@pointercad/model';
import { beforeAll, describe, expect, it } from 'vitest';

import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';

const SAVED_AT = '2026-11-19T00:00:00.000Z';
const registry = PRODUCT_CATALOG_REGISTRY;

beforeAll(async () => {
  await registry.ensure(['t-slot-frame-s6', 't-slot-frame-cap']);
});

/** 溝幅 6 の 20×20 を長さ 1000 で 1 本置いた文書。 */
function plainDocument(): { readonly document: AssemblyDocument; readonly hostId: string } {
  const family = registry.loaded('t-slot-frame-s6');
  const row = family?.rows.find((candidate) => candidate.key === 's6-20x20');
  if (family === undefined || row === undefined) throw new Error('frame family not loaded');
  const empty = createAssemblyDocument('accessory-records');
  const host = createComponentFor(empty, createCatalogItemSource(family, row, { length: '1000' }), { partName: 'host',
    placement: { position: [expressionValueFromNumber(0), expressionValueFromNumber(0), expressionValueFromNumber(0)], rotation: [0, 0, 0, 1] } });
  return { document: addComponent(empty, host), hostId: host.id };
}

function withCaps(): AssemblyDocument {
  const { document, hostId } = plainDocument();
  const applied = applyAccessorySet(document, hostId, 'frame-end-caps', { ends: 'both', endReference: 'overall', itemKey: 's6-20x20' }, registry);
  if (!applied.ok) throw new Error(applied.reason);
  return applied.value.document;
}

describe('付属の組の記録の保存(版 23 の V-b)', () => {
  it('記録の無い文書は欄を書かず、版も上げない', () => {
    const text = writeAssemblyDocument(plainDocument().document, { savedAt: SAVED_AT });
    expect(text).not.toContain('accessorySets');
    expect((JSON.parse(text) as { readonly schema: number }).schema).toBe(plainDocument().document.schemaVersion);
  });

  it('記録は往復で同じに戻り、書き直しは同じ文になる', () => {
    const document = withCaps();
    const text = writeAssemblyDocument(document, { savedAt: SAVED_AT });
    const read = readAssemblyDocument(text);
    if (!read.ok) throw new Error('read refused');
    expect(read.document.accessorySets).toEqual(document.accessorySets);
    expect(read.document.schemaVersion).toBe(23);
    expect(writeAssemblyDocument(read.document, { savedAt: SAVED_AT })).toBe(text);
  });

  it('版 22 では書かず、版 22 のファイルに欄があれば読まない', () => {
    const document = withCaps();
    expect(() => writeAssemblyDocument({ ...document, schemaVersion: 22 }, { savedAt: SAVED_AT })).toThrow(RangeError);
    const text = writeAssemblyDocument(document, { savedAt: SAVED_AT });
    const older = text.replace('"schema": 23', '"schema": 22').replace('"schemaVersion": 23', '"schemaVersion": 22');
    expect(readAssemblyDocument(older).ok).toBe(false);
  });

  it('ボルトの座金とナットの組の記録(役目と締め付ける厚さ・ばね座金の欄)も往復し、欄の値が正でない時は読まない', () => {
    const parsed = JSON.parse(writeAssemblyDocument(withCaps(), { savedAt: SAVED_AT })) as {
      document: { accessorySets: { setId: string; accessories: { componentId: string; role: string }[]; choices: Record<string, unknown> }[] } };
    const record = parsed.document.accessorySets[0];
    if (record === undefined) throw new Error('record missing');
    record.setId = 'bolt-washer-nut';
    record.accessories = record.accessories.map((item, index) => ({ ...item, role: index === 0 ? 'headWasher' : 'nut' }));
    record.choices = { ends: 'both', endReference: 'member', itemKey: 'M8', gripMm: 12.5, springWasher: true };
    const text = JSON.stringify(parsed, null, 2) + String.fromCharCode(10);
    const read = readAssemblyDocument(text);
    if (!read.ok) throw new Error('read refused');
    expect(read.document.accessorySets?.[0]?.choices).toEqual({ ends: 'both', endReference: 'member', itemKey: 'M8', gripMm: 12.5, springWasher: true });
    expect(writeAssemblyDocument(read.document, { savedAt: SAVED_AT })).toBe(text);
    record.choices = { ...record.choices, gripMm: -1 };
    expect(readAssemblyDocument(JSON.stringify(parsed, null, 2) + String.fromCharCode(10)).ok).toBe(false);
  });

  it('付属が空・役目や端が知らない値・id が重なる記録は読まない', () => {
    const text = writeAssemblyDocument(withCaps(), { savedAt: SAVED_AT });
    expect(readAssemblyDocument(text.replace(/"accessories": \[[^\]]*\]/u, '"accessories": []')).ok).toBe(false);
    expect(readAssemblyDocument(text.replace('"role": "startCap"', '"role": "middle"')).ok).toBe(false);
    expect(readAssemblyDocument(text.replace('"ends": "both"', '"ends": "all"')).ok).toBe(false);
    const parsed = JSON.parse(text) as { document: { accessorySets: unknown[] } };
    parsed.document.accessorySets = [parsed.document.accessorySets[0], parsed.document.accessorySets[0]];
    expect(readAssemblyDocument(JSON.stringify(parsed, null, 2) + String.fromCharCode(10)).ok).toBe(false);
  });
});
