/**
 * 材質別の鋼材の表 r2（角形鋼管・一般構造用炭素鋼鋼管・不等辺山形鋼・I 形鋼、2026-11-15 に足した軽量形鋼・CT 形鋼・
 * 配管用ステンレス鋼鋼管）の保存と読み取り。
 * r1 の行の保存は steelPersistence.test.ts（期待は変えていない）と catalogItemPersistence.test.ts の凍結が守る。
 */
import { createKernelApi } from '@pointercad/kernel';
import {
  addComponent, ALL_STEEL_PRODUCTS, canonicalPartDocumentText, createAssemblyDocument, createComponentFor,
  createDirectKernelBridge, createStandardPartSource, recomputePart, resolveAssembly, standardPartNominalVolume,
  steelProductFromSource, steelProductOptions, type AssemblyDocument, type PartDocument, type StandardPartSource,
} from '@pointercad/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '@pointercad/kernel/testing/occt-node';
import { buildStandardPartFromSourceWithReason } from '@pointercad/model/testing/io-operations';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { readPcadaFile, readPcadFile, writePcadaFile, writePcadFile } from './pcadFile.js';

const SAVE_OPTIONS = { savedAt: '2026-11-14T00:00:00.000Z' };
const R2_REVISION = 'jp-steel-2026-11-14-r2';
const r2 = ALL_STEEL_PRODUCTS.filter((row) => row.catalogRevision !== undefined);
const sources = r2.map((row) => ({ key: row.key, source: createStandardPartSource(row.catalog, row.size,
  { ...steelProductOptions(row), length: '1500' }) }));

function build(source: StandardPartSource): PartDocument {
  const result = buildStandardPartFromSourceWithReason(source);
  if (result.document === null) throw new Error(JSON.stringify(result.rejection));
  return result.document;
}

async function reopen(document: AssemblyDocument): Promise<readonly AssemblyDocument[]> {
  const text = writeAssemblyDocument(document, SAVE_OPTIONS);
  const json = readAssemblyDocument(text);
  if (!json.ok) throw new Error(JSON.stringify(json.error));
  const bytes = await writePcadaFile(document, SAVE_OPTIONS);
  const zip = await readPcadaFile(bytes);
  if (!zip.ok) throw new Error(JSON.stringify(zip.error));
  for (const opened of [json.document, zip.document]) {
    expect(opened).toEqual(document);
    expect(writeAssemblyDocument(opened, SAVE_OPTIONS)).toBe(text);
    expect(await writePcadaFile(opened, SAVE_OPTIONS)).toEqual(bytes);
  }
  return [json.document, zip.document];
}

describe('r2 の 607 行の保存と開き直し', () => {
  const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
  beforeAll(async () => { await loadOcctForNode(); }, 180_000);
  afterAll(() => { bridge.dispose(); });

  it('607 行を置いたアセンブリが JSON と ZIP で同じバイトに戻り、どの部品も同じ行と同じ形に組み直る', async () => {
    // 2026-11-14 の 273 行と 2026-11-15 の 334 行（軽量形鋼 91・CT 形鋼 53・SUS304TP の鋼管 190）。
    expect(sources).toHaveLength(607);
    expect(sources.every(({ source }) => source.catalogRevision === R2_REVISION)).toBe(true);
    let document = createAssemblyDocument('r2 steel');
    for (const { source } of sources) document = addComponent(document, createComponentFor(document, source));
    const expected = sources.map(({ source }) => canonicalPartDocumentText(build(source)));
    for (const opened of await reopen(document)) {
      const resolved = resolveAssembly(opened, { standardPart: (source) => build(source) });
      expect(resolved.errors).toEqual([]);
      opened.components.forEach((component, index) => {
        const source = component.source;
        if (source.kind !== 'standardPart') throw new Error('Expected the saved steel source');
        expect(steelProductFromSource(source)?.key).toBe(sources[index].key);
        expect(canonicalPartDocumentText(build(source))).toBe(expected[index]);
      });
    }
  });

  it.each(['STKR400:rectTube:□ 100×100×3.2', 'STK400:steelPipe:φ48.6×2.3', 'SS400:unequalAngle:L 90×75×9',
    'SS400:iBeam:I 100×75×5×8', 'SSC400:lipChannel:C 100×50×20×2.3', 'SS400:ctSection:CT 100×200×8×12',
    'SUS304TP:steelPipe:25A×Sch10S'])('%s: 組んだ部品の .pcad と JSON の保存が同じ部品と同じ鋼材の出どころに戻る', (key) => {
    const entry = sources.find((candidate) => candidate.key === key);
    if (entry === undefined) throw new Error(`Missing representative ${key}`);
    const part = build(entry.source);
    const bytes = writePcadFile(part, SAVE_OPTIONS);
    const zip = readPcadFile(bytes);
    const json = parseDocument(serializeDocument(part, SAVE_OPTIONS));
    if (!zip.ok || !json.ok) throw new Error('Generated r2 part must reopen through PCAD and JSON');
    for (const opened of [zip.document, json.document]) {
      expect(canonicalPartDocumentText(opened)).toBe(canonicalPartDocumentText(part));
      expect(opened.steelStockSource).toEqual(entry.source);
    }
    expect(writePcadFile(zip.document, SAVE_OPTIONS)).toEqual(bytes);
  });

  it.each(['STKR400:rectTube:□ 100×100×3.2', 'STKR400:rectTube:□ 150×100×4.5', 'STK400:steelPipe:φ48.6×2.3',
    'SS400:unequalAngle:L 90×75×9', 'SS400:iBeam:I 100×75×5×8', 'SSC400:lightChannel:[ 450×75×75×6.0',
    'SSC400:lightZ:Z 75×40×30×2.3', 'SSC400:lightAngle:L 75×30×3.2', 'SSC400:lipChannel:C 60×30×10×1.6',
    'SSC400:lipZ:Z 100×50×20×2.3', 'SSC400:hatSection:ハット 40×20×20×1.6', 'SS400:ctSection:CT 50×50×5×7',
    'SS400:ctSection:CT 249×432×45×70', 'SUS304TP:steelPipe:650A×Sch160', 'SUS304TP:steelPipe:φ10.5×2.0'])(
    '%s: 実のカーネルで有効な 1 つの立体になり、体積が断面の面積 × 長さに一致する', async (key) => {
      const entry = sources.find((candidate) => candidate.key === key);
      if (entry === undefined) throw new Error(`Missing representative ${key}`);
      const part = build(entry.source);
      const expected = standardPartNominalVolume(entry.source.catalog, entry.source.size, entry.source.options);
      if (expected === null) throw new Error('Missing nominal volume');
      try {
        const result = await recomputePart(part, bridge);
        expect(result.errors).toEqual([]);
        expect(result.bodies).toHaveLength(1);
        expect(result.bodies[0].isValid).toBe(true);
        expect(Math.abs(result.bodies[0].volume - expected) / expected).toBeLessThan(1e-6);
      } finally { await bridge.releasePart(part.id); }
    });

  it('版を取り違えた保存も読めて、解く時に型付きの理由で断り、ファイルは変えない', async () => {
    const entry = sources.find((candidate) => candidate.key === 'STKR400:rectTube:□ 100×100×3.2');
    if (entry === undefined) throw new Error('Missing rect tube fixture');
    const tampered: StandardPartSource = { ...entry.source, catalogRevision: 'jp-steel-2026-10-10-r1' };
    const document = addComponent(createAssemblyDocument('r2 tampered'),
      createComponentFor(createAssemblyDocument('r2 tampered'), tampered));
    for (const opened of await reopen(document)) {
      const result = buildStandardPartFromSourceWithReason(tampered);
      expect(result.rejection?.code).toBe('unsupported-catalog-revision');
      const resolved = resolveAssembly(opened, { standardPart: (source) => buildStandardPartFromSourceWithReason(source).document });
      expect(resolved.parts.size).toBe(0);
      expect(resolved.errors.map((error) => error.text)).toEqual([result.rejection?.text]);
      expect(opened).toEqual(document);
    }
  });
});
