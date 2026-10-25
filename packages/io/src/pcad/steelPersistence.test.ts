import { createKernelApi } from '@pointercad/kernel';
import {
  addComponent, canonicalPartDocumentText, createAssemblyDocument, createComponentFor, createDirectKernelBridge,
  createStandardPartSource, recomputePart, resolveAssembly, STEEL_PRODUCTS, STEEL_STANDARDS, steelProductFromSource, steelProductOptions,
  type AssemblyDocument, type PartDocument, type StandardPartSource,
} from '@pointercad/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import {
  buildStandardPartFromSourceWithReason, standardPartRejection, type StandardPartRejectionCode,
} from '../../../model/src/assembly/standard/buildStandardPart.js';
import { CHANNEL_TABLE, EQUAL_ANGLE_TABLE, H_BEAM_TABLE } from '../../../model/src/assembly/standard/sections.js';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { readPcadFile, readPcadaFile, writePcadFile, writePcadaFile } from './pcadFile.js';

const SAVE_OPTIONS = { savedAt: '2026-10-25T00:00:00.000Z' };
const FAMILIES = ['flatBar', 'roundBar', 'equalAngle', 'channel', 'hBeam', 'steelPipe'] as const;
const REPRESENTATIVE_KEYS = [
  'SS400:flatBar:FB 50×6', 'S45C:roundBar:φ20', 'SS400:equalAngle:L 50×50×6',
  'SS400:channel:[ 100×50×5×7.5', 'SS400:hBeam:H 150×150×7×10', 'SGP:steelPipe:15A',
] as const;
const representatives = REPRESENTATIVE_KEYS.map(key => {
  const row = STEEL_PRODUCTS.find(candidate => candidate.key === key);
  if (row === undefined) throw new Error(`Missing persistence representative ${key}`);
  return row;
});
const graded = STEEL_PRODUCTS.map(row => ({ key: row.key, grade: row.materialGrade,
  source: createStandardPartSource(row.catalog, row.size, steelProductOptions(row)) }));
const legacy = [
  ...EQUAL_ANGLE_TABLE.map(row => ({ catalog: 'equalAngle' as const, size: row.size })),
  ...CHANNEL_TABLE.map(row => ({ catalog: 'channel' as const, size: row.size })),
  ...H_BEAM_TABLE.map(row => ({ catalog: 'hBeam' as const, size: row.size })),
].map(row => ({ key: `unspecified:${row.catalog}:${row.size}`, grade: undefined,
  source: createStandardPartSource(row.catalog, row.size, { length: '1000' }) }));

function build(source: StandardPartSource): PartDocument {
  const result = buildStandardPartFromSourceWithReason(source);
  if (result.document === null) throw new Error(JSON.stringify(result.rejection));
  expect(result.rejection).toBeNull();
  return result.document;
}

function assembly(source: StandardPartSource): AssemblyDocument {
  const document = createAssemblyDocument('Steel persistence');
  return addComponent(document, createComponentFor(document, source));
}

async function reopenAssembly(document: AssemblyDocument): Promise<readonly AssemblyDocument[]> {
  const text = writeAssemblyDocument(document, SAVE_OPTIONS);
  const json = readAssemblyDocument(text);
  if (!json.ok) throw new Error(JSON.stringify(json.error));
  const bytes = await writePcadaFile(document, SAVE_OPTIONS);
  const zip = await readPcadaFile(bytes);
  if (!zip.ok) throw new Error(JSON.stringify(zip.error));
  for (const reopened of [json.document, zip.document]) {
    expect(reopened).toEqual(document);
    expect(writeAssemblyDocument(reopened, SAVE_OPTIONS)).toBe(text);
  }
  expect(await writePcadaFile(zip.document, SAVE_OPTIONS)).toEqual(bytes);
  return [json.document, zip.document];
}

function resolve(document: AssemblyDocument): PartDocument {
  const built: PartDocument[] = [];
  const result = resolveAssembly(document, { standardPart: source => {
    const part = build(source);
    built.push(part);
    return part;
  } });
  expect(result.errors).toEqual([]);
  expect(result.parts.size).toBe(1);
  expect(result.partKeys.size).toBe(1);
  for (const part of result.parts.values()) expect(part.errors).toEqual([]);
  expect(built).toHaveLength(1);
  return built[0];
}

function gradeOf(document: PartDocument): string | undefined {
  return document.steelStockSource === undefined ? undefined
    : steelProductFromSource(document.steelStockSource)?.materialGrade;
}

async function roundTrip(source: StandardPartSource, grade: string | undefined): Promise<readonly PartDocument[]> {
  const sourceBefore = structuredClone(source);
  const part = build(source);
  const before = canonicalPartDocumentText(part);
  expect(gradeOf(part)).toBe(grade);
  const json = parseDocument(serializeDocument(part, SAVE_OPTIONS));
  const zip = readPcadFile(writePcadFile(part, SAVE_OPTIONS));
  if (!json.ok || !zip.ok) throw new Error('Generated part must reopen through JSON and PCAD');
  const document = assembly(source);
  const documentBefore = structuredClone(document);
  const regenerated = (await reopenAssembly(document)).map(resolve);
  for (const opened of [json.document, zip.document, ...regenerated]) {
    expect(canonicalPartDocumentText(opened)).toBe(before);
    expect(opened.steelStockSource).toEqual(part.steelStockSource);
    expect(gradeOf(opened)).toBe(grade);
  }
  expect(source).toEqual(sourceBefore);
  expect(document).toEqual(documentBefore);
  expect(canonicalPartDocumentText(part)).toBe(before);
  return [part, ...regenerated];
}

describe('EX03 W10 all authored steel sources through JSON and PCAD ZIP', () => {
  it('covers exactly 459 graded and 109 unspecified rows without duplicate sources', () => {
    expect(graded).toHaveLength(459);
    expect(legacy).toHaveLength(109);
    expect(['SS400', 'S45C', 'SGP'].map(grade => graded.filter(row => row.grade === grade).length))
      .toEqual([253, 158, 48]);
    expect(new Set([...graded, ...legacy].map(row => JSON.stringify(row.source))).size).toBe(568);
    expect(representatives.map(row => row.catalog)).toEqual(FAMILIES);
  });
  it.each([...graded, ...legacy])('$key: all inputs, canonical document and resolved grade survive', async row => {
    await roundTrip(row.source, row.grade);
  });
  it.each(representatives)('$key: authored 12000 mm maximum survives both formats', async row => {
    await roundTrip(createStandardPartSource(row.catalog, row.size, { ...steelProductOptions(row), length: '12000' }),
      row.materialGrade);
  });
});

interface TamperCase {
  readonly key: string;
  readonly field: string;
  readonly source: StandardPartSource;
  readonly code: StandardPartRejectionCode;
}
const savedOptionFields = ['steelProduct', 'materialGrade', 'materialStandard', 'productStandard', 'condition', 'evidence'] as const;
const tamperCases: readonly TamperCase[] = representatives.flatMap(row => {
  const source = createStandardPartSource(row.catalog, row.size, steelProductOptions(row));
  return [
    ...savedOptionFields.map(field => ({ key: row.key, field, code: 'saved-fields-mismatch' as const,
      source: { ...source, options: { ...source.options, [field]: `${source.options[field]}-tampered` } } })),
    { key: row.key, field: 'size', code: 'size-not-in-catalog' as const, source: { ...source, size: 'unknown-size' } },
    { key: row.key, field: 'catalogRevision', code: 'unsupported-catalog-revision' as const,
      source: { ...source, catalogRevision: 'jp-steel-future' } },
    { key: row.key, field: 'generatorRevision', code: 'unsupported-generator-revision' as const,
      source: { ...source, generatorRevision: 'steel-generator-future' } },
    { key: row.key, field: 'disallowed-grade-section',
      code: row.catalog === 'steelPipe' ? 'pipe-outside-scope' as const : 'section-outside-scope' as const,
      source: { ...source, options: { ...source.options, steelProduct: 'forged-product',
        materialGrade: row.catalog === 'steelPipe' ? 'SS400' : 'SGP' } } },
    { key: row.key, field: 'length', code: 'invalid-steel-length' as const,
      source: { ...source, options: { ...source.options, length: '12001' } } },
    { key: row.key, field: 'options', code: 'saved-fields-mismatch' as const,
      source: { ...source, options: { ...source.options, unexpected: 'authored-but-unsupported' } } },
  ];
});

describe('EX03 W10 tampered assembly inputs remain readable and reject only during resolution', () => {
  it('covers six saved option fields and six additional invalid categories in every family', () => {
    expect(tamperCases).toHaveLength(72);
    for (const row of representatives) expect(tamperCases.filter(test => test.key === row.key)).toHaveLength(12);
  });
  it.each(tamperCases)('$key / $field: preserves input and supplies $code without mutating the file', async test => {
    const document = assembly(test.source);
    const before = structuredClone(document);
    for (const opened of await reopenAssembly(document)) {
      const source = opened.components[0].source;
      if (source.kind !== 'standardPart') throw new Error('Expected the authored standard source');
      expect(source).toEqual(test.source);
      const sourceBefore = structuredClone(source);
      const result = buildStandardPartFromSourceWithReason(source);
      expect(result.document).toBeNull();
      expect(result.rejection?.code).toBe(test.code);
      expect(standardPartRejection(source)).toEqual(result.rejection);
      const resolved = resolveAssembly(opened, { standardPart: candidate => buildStandardPartFromSourceWithReason(candidate).document });
      expect(resolved.parts.size).toBe(0);
      expect(resolved.partKeys.size).toBe(0);
      expect(resolved.errors).toHaveLength(1);
      expect(resolved.errors[0].message).toBe(result.rejection?.message);
      expect(source).toEqual(sourceBefore);
      expect(opened).toEqual(before);
    }
    expect(document).toEqual(before);
  });
  it.each(tamperCases)('$key / $field: rejection explains its W9 reason and applicable basis', test => {
    const result = buildStandardPartFromSourceWithReason(test.source);
    if (result.rejection === null) throw new Error('Expected typed rejection');
    const rejection = result.rejection;
    expect(result.document).toBeNull();
    expect(rejection.code).toBe(test.code);
    expect(rejection.message.trim().length).toBeGreaterThan(0);
    if (test.code === 'saved-fields-mismatch') {
      const field = test.field === 'options' ? 'unexpected' : test.field;
      expect(rejection.fields).toEqual([field]);
      expect(rejection.message).toContain(field);
    } else if (test.code === 'unsupported-catalog-revision' || test.code === 'unsupported-generator-revision') {
      expect(rejection.message).toContain('版');
    } else if (test.code === 'invalid-steel-length') {
      expect(rejection.message).toContain('長さ');
    } else {
      expect(rejection.message).toMatch(/JIS G [0-9]{4}/u);
      expect(rejection.message).toMatch(/適用範囲|箇条|表[0-9０-９]|[0-9]+[.][0-9]+/u);
      expect(rejection.basis.length).toBeGreaterThan(0);
      for (const basis of rejection.basis) {
        expect(rejection.message).toContain(STEEL_STANDARDS[basis.standardId].number);
        expect(rejection.message).toContain(basis.locator);
      }
    }
  });
});

describe('EX03 W10 representative real OCCT volumes before and after persistence', () => {
  const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
  beforeAll(async () => { await loadOcctForNode(); }, 180_000);
  afterAll(() => { bridge.dispose(); });
  it.each(representatives)('$key: both reopened assemblies regenerate the same valid volume to relative 1e-9', async row => {
    const source = createStandardPartSource(row.catalog, row.size, steelProductOptions(row));
    const documents = await roundTrip(source, row.materialGrade);
    const volumes: number[] = [];
    for (const document of documents) {
      const before = canonicalPartDocumentText(document);
      try {
        const result = await recomputePart(document, bridge);
        expect(result.cancelled).toBe(false);
        expect(result.errors).toEqual([]);
        expect(result.bodies).toHaveLength(1);
        expect(result.bodies[0].isValid).toBe(true);
        expect(result.bodies[0].mesh.triangleCount).toBeGreaterThan(0);
        expect(result.bodies[0].volume).toBeGreaterThan(0);
        volumes.push(result.bodies[0].volume);
      } finally { await bridge.releasePart(document.id); }
      expect(canonicalPartDocumentText(document)).toBe(before);
    }
    expect(volumes).toHaveLength(3);
    for (const volume of volumes.slice(1)) expect(Math.abs(volume - volumes[0]) / volumes[0]).toBeLessThan(1e-9);
    process.stdout.write(`STEEL_PERSISTENCE_VOLUME ${JSON.stringify({ key: row.key, before: volumes[0],
      json: volumes[1], zip: volumes[2], maxRelativeError: Math.max(...volumes.slice(1).map(v => Math.abs(v - volumes[0]) / volumes[0])) })}\n`);
  });
});
