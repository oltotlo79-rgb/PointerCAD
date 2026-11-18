// 規格資料の出典は規格番号と一般名で照合する。
import { H_BEAM_ADDITION_SAVED_OPTIONS } from './steelHBeamOracle.fixture.js';
import { SECTION_ADDITION_SAVED_OPTIONS } from './steelAngleChannelOracle.fixture.js';
import { describe, expect, it } from 'vitest';

import { createStandardPartSource } from './buildStandardPart.js';
import {
  findSteelProduct, STEEL_PRODUCTS, steelProductFromSource, steelProductOptions,
} from './steelCatalog.js';
import { SGP_ADDITION_SAVED_OPTIONS, SGP_TABLE4_REFERENCE, SS400_EXPANSION_SAVED_OPTIONS } from './steelCatalogOracle.fixture.js';
import { S45C_HOT_SAVED_OPTIONS } from './steelS45cOracle.testSupport.js';
import { STEEL_STANDARDS, type SteelStandard, type SteelStandardReference } from './steelStandards.js';

type SteelStandardId = SteelStandardReference['standardId'];

// Independent transcription of the EX-03 evidence inventory (2026-10-24).
// The G 3192 2020 draft is historical evidence, not evidence for G 3123.
const DRAFTS = [
  ['jis-g-3101-2024', '2023-07-26', 'JIS G 3101 原案 2023-07-26'],
  ['jis-g-3191-2022', '2021-07-28', 'JIS G 3191 原案 2021-07-28'],
  ['jis-g-3192-2024', '2024-07-24', 'JIS G 3192 原案 2024-07-24'],
  ['jis-g-3192-2024', '2020-12-02', 'JIS G 3192 原案 2020-12-02'],
  ['jis-g-3194-2024', '2024-07-24', 'JIS G 3194 原案 2024-07-24'],
  // 2026-11-15 の追加（鋼材の第 2 弾）: G 3350・G 3459 の 2020-12-02 の改正案。
  ['jis-g-3350-2021', '2020-12-02', 'JIS G 3350 原案 2020-12-02'],
  ['jis-g-3444-2025', '2024-12-20', 'JIS G 3444 原案 2024-12-20'],
  ['jis-g-3452-2026', '2025-12-17', 'JIS G 3452 原案 2025-12-17'],
  ['jis-g-3459-2021', '2020-12-02', 'JIS G 3459 原案 2020-12-02'],
  ['jis-g-3466-2025', '2024-12-20', 'JIS G 3466 原案 2024-12-20'],
  ['jis-g-4051-2026', '2025-12-17', 'JIS G 4051 原案 2025-12-17'],
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

// 2026-11-15 の追加（鋼材の第 2 弾）。確認日が違うので上の 9 行とは別の表で確かめる。
const K3_STANDARDS = [
  ['jis-g-3350-2021', 'JIS G 3350', '一般構造用軽量形鋼', '2021', '2021-04-20', 'search-summary'],
  ['jis-g-3459-2021', 'JIS G 3459', '配管用ステンレス鋼鋼管', '2021', '2021-04-20', 'search-summary'],
] as const;

// Saved r1 contract: all six strings are literal constants, independent of the catalog builders.
// Do not regenerate this table from STEEL_PRODUCTS when adding provenance or new product rows.
const FROZEN_OPTIONS = [
  ['SS400:flatBar:FB 50×6', 'SS400', 'JIS G 3101', '公表平鋼寸法', 'hotRolled-heatTreatmentUnspecified', 'flat'],
  ['SS400:flatBar:FB 50×9', 'SS400', 'JIS G 3101', '公表平鋼寸法', 'hotRolled-heatTreatmentUnspecified', 'flat'],
  ['SS400:flatBar:FB 50×12', 'SS400', 'JIS G 3101', '公表平鋼寸法', 'hotRolled-heatTreatmentUnspecified', 'flat'],
  ['SS400:flatBar:FB 100×6', 'SS400', 'JIS G 3101', '公表平鋼寸法', 'hotRolled-heatTreatmentUnspecified', 'flat'],
  ['SS400:flatBar:FB 100×9', 'SS400', 'JIS G 3101', '公表平鋼寸法', 'hotRolled-heatTreatmentUnspecified', 'flat'],
  ['SS400:roundBar:φ13', 'SS400', 'JIS G 3101', '公表丸鋼寸法', 'hotRolled-heatTreatmentUnspecified', 'round'],
  ['SS400:roundBar:φ16', 'SS400', 'JIS G 3101', '公表丸鋼寸法', 'hotRolled-heatTreatmentUnspecified', 'round'],
  ['SS400:roundBar:φ19', 'SS400', 'JIS G 3101', '公表丸鋼寸法', 'hotRolled-heatTreatmentUnspecified', 'round'],
  ['SS400:roundBar:φ22', 'SS400', 'JIS G 3101', '公表丸鋼寸法', 'hotRolled-heatTreatmentUnspecified', 'round'],
  ['SS400:roundBar:φ25', 'SS400', 'JIS G 3101', '公表丸鋼寸法', 'hotRolled-heatTreatmentUnspecified', 'round'],
  ['SS400:equalAngle:L 40×40×5', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'rolledSections'],
  ['SS400:equalAngle:L 50×50×6', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'rolledSections'],
  ['SS400:equalAngle:L 65×65×6', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'rolledSections'],
  ['SS400:channel:[ 75×40×5×7', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'rolledSections'],
  ['SS400:channel:[ 100×50×5×7.5', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'rolledSections'],
  ['SS400:channel:[ 125×65×6×8', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'rolledSections'],
  ['SS400:hBeam:H 150×150×7×10', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'wideFlange'],
  ['SS400:hBeam:H 200×200×8×12', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'wideFlange'],
  ['SS400:hBeam:H 300×300×10×15', 'SS400', 'JIS G 3101', 'JIS G 3192', 'hotRolled-heatTreatmentUnspecified', 'wideFlange'],
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
  it('contains exactly the eleven distinct standards and edition IDs', () => {
    expect(Object.keys(STEEL_STANDARDS).sort()).toEqual([...STANDARDS, ...K3_STANDARDS].map(([id]) => id).sort());
    expect(new Set(Object.values(STEEL_STANDARDS).map((row) => row.number)).size).toBe(11);
  });

  it.each(K3_STANDARDS)('%s keeps its bibliographic facts and the draft-only verification limit',
    (id, number, name, edition, revisedOn, revisionDateBasis) => {
      const row: SteelStandard = STEEL_STANDARDS[id];
      expect(row).toMatchObject({ number, name, edition, revisedOn, revisionDateBasis,
        verification: 'draft', editionStatus: 'reported' });
      expect(row.draft?.meetingDate).toBe('2020-12-02');
      expect(row.verificationNote).toContain('規格票');
      expect(row.verificationNote).toContain('未確認');
      expect(row.verificationNote).toContain('2020-12-02');
      expect(row.historicalDrafts).toEqual([]);
    });

  it.each(STANDARDS)('%s keeps its bibliographic facts and their verification limits',
    (id, number, name, edition, revisedOn, revisionDateBasis) => {
      const row: SteelStandard = STEEL_STANDARDS[id];
      expect(row).toMatchObject({ number, name, edition, revisedOn, revisionDateBasis });
      expect(row.verificationNote.trim().length).toBeGreaterThan(0);
      expect(row.verification).toBe(id === 'jis-g-3123-2004' ? 'unverified' : 'draft');
      expect(row.editionStatus).toBe(id === 'jis-g-3444-2025' ? 'inferred' : 'reported');
      if (row.verification === 'draft') {
        expect(row.draft).not.toBeNull();
        expect(row.verificationNote).toContain('規格票');
        expect(row.verificationNote).toContain('未確認');
      }
      if (row.revisedOn === null) expect(row.verification).toBe('draft');
    });

  it('retains all eleven exact draft references without assigning a nonexistent draft to G 3123', () => {
    const actual = Object.entries(STEEL_STANDARDS).flatMap(([id, row]) => {
      const drafts = row.draft === null ? row.historicalDrafts : [row.draft, ...row.historicalDrafts];
      return drafts.map((draft) => [id, draft.meetingDate, draft.reference]);
    });
    expect(actual).toEqual(DRAFTS);
    expect(actual).toHaveLength(11);
    expect(new Set(actual.map((row) => row[2])).size).toBe(11);
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

it('pins the SGP table 4 reference without changing the provisional standard ledger', () => {
  expect(STEEL_STANDARDS['jis-g-3452-2026'].draft?.reference).toBe(SGP_TABLE4_REFERENCE);
  expect(SGP_TABLE4_REFERENCE).toBe('JIS G 3452 原案 2025-12-17');
  expect(SGP_ADDITION_SAVED_OPTIONS).toHaveLength(42);
});
