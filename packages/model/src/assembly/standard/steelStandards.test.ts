import { H_BEAM_ADDITION_SAVED_OPTIONS } from './steelHBeamOracle.fixture.js';
import { SECTION_ADDITION_SAVED_OPTIONS } from './steelAngleChannelOracle.fixture.js';
import { describe, expect, it } from 'vitest';

import { createStandardPartSource } from './buildStandardPart.js';
import {
  findSteelProduct, STEEL_PRODUCTS, steelProductFromSource, steelProductOptions,
} from './steelCatalog.js';
import { SGP_ADDITION_SAVED_OPTIONS, SGP_TABLE4_PDF_SHA256, SS400_EXPANSION_SAVED_OPTIONS } from './steelCatalogOracle.fixture.js';
import { S45C_HOT_SAVED_OPTIONS } from './steelS45cOracle.fixture.js';
import { STEEL_STANDARDS, type SteelStandard, type SteelStandardId } from './steelStandards.js';

// Independent transcription of the EX-03 evidence inventory (2026-10-24).
// The G 3192 2020 draft is historical evidence, not evidence for G 3123.
const DRAFTS = [
  ['jis-g-3101-2024', '2023-07-26', 'docs_kouzai_0400JISG3101_20230726.pdf', '797fe421e44bfce54f53b6b89073e4ce488343f59d733288ca9996a26db44893'],
  ['jis-g-3191-2022', '2021-07-28', 'docs_kouzai010_jis12G3191_20210728.pdf', '8ea886730b59558553d49f395e7ada43c093210c51e00e3080c08f2163c0e313'],
  ['jis-g-3192-2024', '2024-07-24', 'docs_kouzai_0400JISG3192_20240724.pdf', 'ca399bdfe4d84de29e04449d7356de9e45b83405b291c6dc8bf9ea7c5c772baa'],
  ['jis-g-3192-2024', '2020-12-02', 'docs_kouzai004_jis02G3192_20201202.pdf', '000c5bf453e141191151608e424731322155f88a4f756a450abd14c8c573a935'],
  ['jis-g-3194-2024', '2024-07-24', 'docs_kouzai_0500JISG3194_20240724.pdf', '07cca88a466a190142c87b74eb6c53c3c72e0c66433d3e120e2af497512b7dea'],
  ['jis-g-3444-2025', '2024-12-20', 'docs_kouzai_1400_JISG3444_20241220.pdf', '755e8484f4006043ff5592f0f0baba5524f86d4aac777aca25f25827483e5fa3'],
  ['jis-g-3452-2026', '2025-12-17', 'docs_kouzai_0500_JISG3452_20251217.pdf', '03b3975041cee440fd7be67ef7928089158cc8d7e7d1fc584399cfb282170318'],
  ['jis-g-3466-2025', '2024-12-20', 'docs_kouzai_1600_JISG3466_20241220.pdf', 'ce00863b95e73a2dd116459bf75595ac6a21779961406cef8d149791af012752'],
  ['jis-g-4051-2026', '2025-12-17', 'docs_kouzai_0700_JISG4051_20251217.pdf', '158ac7b25b0c1cda41ae5cdf68cfe37530b73f1288b9cacf62c2d45584664245'],
] as const;

const STANDARDS = [
  ['jis-g-3101-2024', 'JIS G 3101', '一般構造用圧延鋼材', '2024', null, 'unverified'],
  ['jis-g-3123-2004', 'JIS G 3123', 'みがき棒鋼', '2004', '2004-09-20', 'search-summary'],
  ['jis-g-3191-2022', 'JIS G 3191', '熱間圧延棒鋼及びバーインコイルの形状、寸法、質量及びその許容差', '2022', null, 'unverified'],
  ['jis-g-3192-2024', 'JIS G 3192', '熱間圧延形鋼の形状、寸法、質量及びその許容差', '2024', '2024-11-20', 'search-summary'],
  ['jis-g-3194-2024', 'JIS G 3194', '熱間圧延平鋼の形状、寸法、質量及びその許容差', '2024', null, 'unverified'],
  ['jis-g-3444-2025', 'JIS G 3444', '一般構造用炭素鋼鋼管', '2025', null, 'unverified'],
  ['jis-g-3452-2026', 'JIS G 3452', '配管用炭素鋼鋼管', '2026', '2026-05-20', 'search-summary'],
  ['jis-g-3466-2025', 'JIS G 3466', '一般構造用角形鋼管', '2025', '2025-04-21', 'secondary-source'],
  ['jis-g-4051-2026', 'JIS G 4051', '機械構造用炭素鋼鋼材', '2026', '2026-05-20', 'search-summary'],
] as const;

// Saved r1 contract: all six strings are literal constants, independent of the catalog builders.
// Do not regenerate this table from STEEL_PRODUCTS when adding provenance or new product rows.
const FROZEN_OPTIONS = [
  ['SS400:flatBar:FB 50×6', 'SS400', 'JIS G 3101', '王子製鉄 公表断面寸法', 'hotRolled-heatTreatmentUnspecified', 'flat'],
  ['SS400:flatBar:FB 50×9', 'SS400', 'JIS G 3101', '王子製鉄 公表断面寸法', 'hotRolled-heatTreatmentUnspecified', 'flat'],
  ['SS400:flatBar:FB 50×12', 'SS400', 'JIS G 3101', '王子製鉄 公表断面寸法', 'hotRolled-heatTreatmentUnspecified', 'flat'],
  ['SS400:flatBar:FB 100×6', 'SS400', 'JIS G 3101', '王子製鉄 公表断面寸法', 'hotRolled-heatTreatmentUnspecified', 'flat'],
  ['SS400:flatBar:FB 100×9', 'SS400', 'JIS G 3101', '王子製鉄 公表断面寸法', 'hotRolled-heatTreatmentUnspecified', 'flat'],
  ['SS400:roundBar:φ13', 'SS400', 'JIS G 3101', '大阪製鐵 公表丸鋼寸法', 'hotRolled-heatTreatmentUnspecified', 'round'],
  ['SS400:roundBar:φ16', 'SS400', 'JIS G 3101', '大阪製鐵 公表丸鋼寸法', 'hotRolled-heatTreatmentUnspecified', 'round'],
  ['SS400:roundBar:φ19', 'SS400', 'JIS G 3101', '大阪製鐵 公表丸鋼寸法', 'hotRolled-heatTreatmentUnspecified', 'round'],
  ['SS400:roundBar:φ22', 'SS400', 'JIS G 3101', '大阪製鐵 公表丸鋼寸法', 'hotRolled-heatTreatmentUnspecified', 'round'],
  ['SS400:roundBar:φ25', 'SS400', 'JIS G 3101', '大阪製鐵 公表丸鋼寸法', 'hotRolled-heatTreatmentUnspecified', 'round'],
  ['SS400:equalAngle:L 40×40×5', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'osaka'],
  ['SS400:equalAngle:L 50×50×6', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'osaka'],
  ['SS400:equalAngle:L 65×65×6', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'osaka'],
  ['SS400:channel:[ 75×40×5×7', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'osaka'],
  ['SS400:channel:[ 100×50×5×7.5', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'osaka'],
  ['SS400:channel:[ 125×65×6×8', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'osaka'],
  ['SS400:hBeam:H 150×150×7×10', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'yamato'],
  ['SS400:hBeam:H 200×200×8×12', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'yamato'],
  ['SS400:hBeam:H 300×300×10×15', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'yamato'],
  ['S45C:roundBar:φ20', 'S45C', 'JIS G 4051', 'JIS G 3123', 'brightBar-heatTreatmentUnspecified', 'brightRound'],
  ['S45C:roundBar:φ25', 'S45C', 'JIS G 4051', 'JIS G 3123', 'brightBar-heatTreatmentUnspecified', 'brightRound'],
  ['S45C:roundBar:φ30', 'S45C', 'JIS G 4051', 'JIS G 3123', 'brightBar-heatTreatmentUnspecified', 'brightRound'],
  ['S45C:flatBar:FB 50×6', 'S45C', 'JIS G 4051', 'JIS G 3123', 'brightBar-heatTreatmentUnspecified', 'brightFlat'],
  ['S45C:flatBar:FB 50×9', 'S45C', 'JIS G 4051', 'JIS G 3123', 'brightBar-heatTreatmentUnspecified', 'brightFlat'],
  ['S45C:flatBar:FB 50×12', 'S45C', 'JIS G 4051', 'JIS G 3123', 'brightBar-heatTreatmentUnspecified', 'brightFlat'],
  ['SGP:steelPipe:15A', 'SGP', 'JIS G 3452', 'JIS G 3452', 'blackPipe-plainEnds', 'pipe'],
  ['SGP:steelPipe:20A', 'SGP', 'JIS G 3452', 'JIS G 3452', 'blackPipe-plainEnds', 'pipe'],
  ['SGP:steelPipe:25A', 'SGP', 'JIS G 3452', 'JIS G 3452', 'blackPipe-plainEnds', 'pipe'],
  ['SGP:steelPipe:32A', 'SGP', 'JIS G 3452', 'JIS G 3452', 'blackPipe-plainEnds', 'pipe'],
  ['SGP:steelPipe:40A', 'SGP', 'JIS G 3452', 'JIS G 3452', 'blackPipe-plainEnds', 'pipe'],
  ['SGP:steelPipe:50A', 'SGP', 'JIS G 3452', 'JIS G 3452', 'blackPipe-plainEnds', 'pipe'],
] as const;

describe('steel standards evidence ledger', () => {
  it('contains exactly the nine distinct standards and edition IDs', () => {
    expect(Object.keys(STEEL_STANDARDS).sort()).toEqual(STANDARDS.map(([id]) => id).sort());
    expect(new Set(Object.values(STEEL_STANDARDS).map((row) => row.number)).size).toBe(9);
  });

  it.each(STANDARDS)('%s keeps its bibliographic facts and their verification limits',
    (id, number, name, edition, revisedOn, revisionDateBasis) => {
      const row: SteelStandard = STEEL_STANDARDS[id];
      expect(row).toMatchObject({ number, name, edition, revisedOn, revisionDateBasis, checkedOn: '2026-10-24' });
      expect(row.verificationNote.trim().length).toBeGreaterThan(0);
      expect(row.verification).toBe(id === 'jis-g-3123-2004' ? 'unverified' : 'draft');
      expect(row.editionStatus).toBe(id === 'jis-g-3444-2025' ? 'inferred' : 'reported');
      if (row.verification === 'draft') {
        expect(row.draft).not.toBeNull();
        expect(row.verificationNote).toContain('JSA');
        expect(row.verificationNote).toContain('未確認');
      }
      if (row.revisedOn === null) expect(row.verification).toBe('draft');
    });

  it('retains all nine exact URL/hash pairs without assigning a nonexistent draft to G 3123', () => {
    const actual = Object.entries(STEEL_STANDARDS).flatMap(([id, row]) => {
      const drafts = row.draft === null ? row.historicalDrafts : [row.draft, ...row.historicalDrafts];
      return drafts.map((draft) => [id, draft.meetingDate, draft.url, draft.sha256]);
    });
    const expected = DRAFTS.map(([id, date, file, hash]) =>
      [id, date, `https://www.jisf.or.jp/business/standard/jis/documents/${file}`, hash]);
    expect(actual).toEqual(expected);
    expect(actual).toHaveLength(9);
    expect(new Set(actual.map((row) => row[2])).size).toBe(9);
    for (const [, , , hash] of actual) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(STEEL_STANDARDS['jis-g-3123-2004'].draft).toBeNull();
    expect(STEEL_STANDARDS['jis-g-3123-2004'].verificationNote).toContain('寸法表は未確認');
    expect(STEEL_STANDARDS['jis-g-3444-2025'].verificationNote).toContain('2025年版は推測');
  });
});

describe('frozen steel catalog saved options', () => {
  it('retains all 31 original keys exactly once', () => {
    expect(FROZEN_OPTIONS).toHaveLength(31);
    expect(S45C_HOT_SAVED_OPTIONS).toHaveLength(152);
    expect(STEEL_PRODUCTS).toHaveLength(459);
    expect(new Set(STEEL_PRODUCTS.map((row) => row.key)).size).toBe(459);
    expect(STEEL_PRODUCTS.map((row) => row.key)).toEqual([...FROZEN_OPTIONS, ...S45C_HOT_SAVED_OPTIONS, ...SS400_EXPANSION_SAVED_OPTIONS, ...SECTION_ADDITION_SAVED_OPTIONS, ...H_BEAM_ADDITION_SAVED_OPTIONS, ...SGP_ADDITION_SAVED_OPTIONS].map(([key]) => key));
  });

  it.each([...FROZEN_OPTIONS, ...S45C_HOT_SAVED_OPTIONS, ...SS400_EXPANSION_SAVED_OPTIONS, ...SECTION_ADDITION_SAVED_OPTIONS, ...H_BEAM_ADDITION_SAVED_OPTIONS, ...SGP_ADDITION_SAVED_OPTIONS])('%s preserves all six saved strings and excludes ledger metadata',
    (steelProduct, materialGrade, materialStandard, productStandard, condition, evidence) => {
      const row = STEEL_PRODUCTS.find((candidate) => candidate.key === steelProduct);
      if (row === undefined) throw new Error(`Missing frozen steel product: ${steelProduct}`);
      const expected = { steelProduct, materialGrade, materialStandard, productStandard, condition, evidence };
      expect(steelProductOptions(row)).toEqual(expected);
      expect(findSteelProduct(row.catalog, row.size, expected)).toBe(row);
      const source = createStandardPartSource(row.catalog, row.size, { ...expected, length: '500*2' });
      expect(source.options).toEqual({ ...expected, length: '500*2' });
      expect(steelProductFromSource(source)?.standardReferences).toEqual(row.standardReferences);
      expect(steelProductFromSource({ ...source, generatorRevision: '2-steel-1' })?.standardReferences)
        .toEqual(row.standardReferences);
      for (const field of Object.keys(expected)) {
        expect(findSteelProduct(row.catalog, row.size, { ...expected, [field]: 'changed-saved-value' }), field)
          .toBeUndefined();
      }
    });

  it('references the correct material and dimensional ledger for all 459 rows', () => {
    const expected: Readonly<Record<string, readonly [SteelStandardId, SteelStandardId]>> = {
      'SS400:flatBar': ['jis-g-3101-2024', 'jis-g-3194-2024'],
      'SS400:roundBar': ['jis-g-3101-2024', 'jis-g-3191-2022'],
      'SS400:equalAngle': ['jis-g-3101-2024', 'jis-g-3192-2024'],
      'SS400:channel': ['jis-g-3101-2024', 'jis-g-3192-2024'],
      'SS400:hBeam': ['jis-g-3101-2024', 'jis-g-3192-2024'],
      'S45C:flatBar': ['jis-g-4051-2026', 'jis-g-3123-2004'],
      'S45C:roundBar': ['jis-g-4051-2026', 'jis-g-3123-2004'],
      'SGP:steelPipe': ['jis-g-3452-2026', 'jis-g-3452-2026'],
    };
    for (const row of STEEL_PRODUCTS) {
      expect([row.standardReferences.material, row.standardReferences.dimensions], row.key)
        .toEqual(row.key.endsWith(':hotRolled')
          ? ['jis-g-4051-2026', row.catalog === 'roundBar' ? 'jis-g-4051-2026' : 'jis-g-3194-2024']
          : expected[`${row.materialGrade}:${row.catalog}`]);
      expect(STEEL_STANDARDS[row.standardReferences.material].number).toBe(row.materialStandard);
      expect(STEEL_STANDARDS[row.standardReferences.dimensions]).toBeDefined();
    }
  });
});

it('pins the SGP table 4 PDF hash without changing the provisional standard ledger', () => {
  expect(STEEL_STANDARDS['jis-g-3452-2026'].draft?.sha256).toBe(SGP_TABLE4_PDF_SHA256);
  expect(SGP_TABLE4_PDF_SHA256).toBe('03b3975041cee440fd7be67ef7928089158cc8d7e7d1fc584399cfb282170318');
  expect(SGP_ADDITION_SAVED_OPTIONS).toHaveLength(42);
});
