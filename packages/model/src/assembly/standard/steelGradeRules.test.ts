import { describe, expect, it } from 'vitest';

import { STEEL_MATERIAL_GRADES, STEEL_PRODUCTS } from './steelCatalog.js';
import { STEEL_GRADE_RULES, STEEL_SECTION_CATALOGS, s45cProductRule, steelGradeRule } from './steelGradeRules.js';
import { STEEL_STANDARDS } from './steelStandards.js';

// Independent full matrix: a missing/duplicated family or a changed permission must fail.
const EXPECTED_RULES = [
  ['SS400', 'flatBar', true, null],
  ['SS400', 'roundBar', true, null],
  ['SS400', 'equalAngle', true, null],
  ['SS400', 'channel', true, null],
  ['SS400', 'hBeam', true, null],
  ['SS400', 'steelPipe', false, 'pipe-outside-scope'],
  ['S45C', 'flatBar', true, null],
  ['S45C', 'roundBar', true, null],
  ['S45C', 'equalAngle', false, 'section-not-standardized-in-grade'],
  ['S45C', 'channel', false, 'section-not-standardized-in-grade'],
  ['S45C', 'hBeam', false, 'section-not-standardized-in-grade'],
  ['S45C', 'steelPipe', false, 'pipe-outside-scope'],
  ['SGP', 'flatBar', false, 'section-outside-scope'],
  ['SGP', 'roundBar', false, 'section-outside-scope'],
  ['SGP', 'equalAngle', false, 'section-outside-scope'],
  ['SGP', 'channel', false, 'section-outside-scope'],
  ['SGP', 'hBeam', false, 'section-outside-scope'],
  ['SGP', 'steelPipe', true, null],
] as const;

describe('steel grade and section permission ledger', () => {
  it('allows both SGP pipe conditions without widening any of the eighteen family decisions', () => {
    const pipes = STEEL_PRODUCTS.filter((row) => row.materialGrade === 'SGP');
    expect(pipes).toHaveLength(48);
    for (const condition of ['blackPipe-plainEnds', 'whitePipe-zincCoated']) {
      expect(pipes.filter((row) => row.condition === condition)).toHaveLength(24);
    }
    expect(pipes.every((row) => row.catalog === 'steelPipe' && steelGradeRule('SGP', row.catalog).allowed)).toBe(true);
    expect(steelGradeRule('SGP', 'steelPipe').allowed).toBe(true);
  });
  it('covers all 18 pairs exactly once, with eight allowed and ten denied', () => {
    expect(STEEL_MATERIAL_GRADES).toEqual(['SS400', 'S45C', 'SGP']);
    expect(STEEL_SECTION_CATALOGS).toEqual(['flatBar', 'roundBar', 'equalAngle', 'channel', 'hBeam', 'steelPipe']);
    expect(Object.keys(STEEL_GRADE_RULES)).toEqual([...STEEL_MATERIAL_GRADES]);
    for (const grade of STEEL_MATERIAL_GRADES) {
      expect(Object.keys(STEEL_GRADE_RULES[grade])).toEqual([...STEEL_SECTION_CATALOGS]);
    }
    const pairs = STEEL_MATERIAL_GRADES.flatMap((grade) =>
      STEEL_SECTION_CATALOGS.map((catalog) => `${grade}:${catalog}`));
    expect(pairs).toEqual(EXPECTED_RULES.map(([grade, catalog]) => `${grade}:${catalog}`));
    expect(new Set(pairs).size).toBe(18);
    const rules = STEEL_MATERIAL_GRADES.flatMap((grade) =>
      STEEL_SECTION_CATALOGS.map((catalog) => steelGradeRule(grade, catalog)));
    expect(rules.filter((rule) => rule.allowed)).toHaveLength(8);
    expect(rules.filter((rule) => !rule.allowed)).toHaveLength(10);
  });

  it.each(EXPECTED_RULES)('%s / %s has an explicit decision, citations and rejection reason',
    (grade, catalog, allowed, reasonCode) => {
      const rule = steelGradeRule(grade, catalog);
      expect(rule).toBe(STEEL_GRADE_RULES[grade][catalog]);
      expect(rule.allowed).toBe(allowed);
      expect(rule.basis.length).toBeGreaterThan(0);
      for (const citation of rule.basis) {
        expect(STEEL_STANDARDS[citation.standardId]).toBeDefined();
        expect(citation.locator.trim().length).toBeGreaterThan(0);
      }
      if (rule.allowed) {
        expect(Object.hasOwn(rule, 'reasonCode')).toBe(false);
        expect(Object.hasOwn(rule, 'reason')).toBe(false);
        expect(rule.note.trim().length).toBeGreaterThan(0);
      } else {
        expect(rule.reasonCode).toBe(reasonCode);
        expect(rule.reason).toMatch(/[ぁ-んァ-ヶ一-龯]/);
        expect(rule.reason).toContain(grade);
        expect(rule.reason).toMatch(/適用範囲|7[.]5/);
        for (const citation of rule.basis) {
          const standard = STEEL_STANDARDS[citation.standardId];
          expect(rule.reason).toContain(standard.number);
          expect(rule.reason).toContain(standard.name);
        }
      }
    });

  it('allows exactly the eight material/section pairs of the 459 catalog rows', () => {
    expect(STEEL_PRODUCTS).toHaveLength(459);
    const actualPairs = [...new Set(STEEL_PRODUCTS.map((row) => `${row.materialGrade}:${row.catalog}`))].sort();
    const allowedPairs = EXPECTED_RULES.filter(([grade, catalog]) => steelGradeRule(grade, catalog).allowed)
      .map(([grade, catalog]) => `${grade}:${catalog}`).sort();
    expect(allowedPairs).toHaveLength(8);
    expect(allowedPairs).toEqual(actualPairs);
    for (const row of STEEL_PRODUCTS) {
      const rule = row.materialGrade === 'S45C'
        ? s45cProductRule(row.catalog, row.condition, row.productStandard)
        : steelGradeRule(row.materialGrade, row.catalog);
      expect(rule.allowed, row.key).toBe(true);
      const ids = rule.basis.map((citation) => citation.standardId);
      expect(ids).toContain(row.standardReferences.material);
      expect(ids).toContain(row.standardReferences.dimensions);
    }
  });

  it('distinguishes S45C agreement products from excluded pipes', () => {
    for (const catalog of ['equalAngle', 'channel', 'hBeam'] as const) {
      const rule = steelGradeRule('S45C', catalog);
      if (rule.allowed) throw new Error('S45C rolled sections must not be catalog permissions');
      expect(rule.reasonCode).toBe('section-not-standardized-in-grade');
      expect(rule.reason).toContain('7.5');
      expect(rule.reason).toContain('協定品');
      expect(rule.basis).toEqual([
        { standardId: 'jis-g-4051-2026', locator: '7.5 その他の形状・寸法（受渡当事者間の協定）' },
      ]);
    }
    expect(steelGradeRule('S45C', 'steelPipe')).toMatchObject({ allowed: false, reasonCode: 'pipe-outside-scope' });
  });

  it('does not promote producer-confirmed S45C bright bars to a verified JIS dimension table', () => {
    for (const catalog of ['flatBar', 'roundBar'] as const) {
      const rule = steelGradeRule('S45C', catalog);
      if (!rule.allowed) throw new Error('Existing S45C bright bars must remain available');
      expect(rule.note).toContain('みがき');
      expect(rule.note).toContain('製造元資料で確認');
      expect(rule.note).toContain('JIS G 3123の原案・寸法表は未確認');
      expect(rule.basis.map((citation) => citation.standardId)).toContain('jis-g-3123-2004');
    }
    expect(STEEL_STANDARDS['jis-g-3123-2004'].verification).toBe('unverified');
  });
});

describe('S45C product conditions', () => {
  const conditions = [
    ['roundBar', 'brightBar-heatTreatmentUnspecified', 'JIS G 3123', 'jis-g-3123-2004'],
    ['flatBar', 'brightBar-heatTreatmentUnspecified', 'JIS G 3123', 'jis-g-3123-2004'],
    ['roundBar', 'hotRolled-heatTreatmentUnspecified', 'JIS G 4051', 'jis-g-4051-2026'],
    ['flatBar', 'hotRolled-heatTreatmentUnspecified', 'JIS G 3194', 'jis-g-3194-2024'],
  ] as const;

  it.each(conditions)('%s / %s identifies the correct product standard without promising a size',
    (catalog, condition, productStandard, dimensionId) => {
      const rule = s45cProductRule(catalog, condition, productStandard);
      if (!rule.allowed) throw new Error(`Missing S45C condition: ${catalog}/${condition}`);
      expect(rule).toMatchObject({ allowed: true, condition, productStandard });
      expect(rule.basis.map((item) => item.standardId)).toContain(dimensionId);
      expect(rule.basis.map((item) => item.standardId)).toContain('jis-g-4051-2026');
      const family = steelGradeRule('S45C', catalog);
      if (!family.allowed) throw new Error(`Missing S45C family: ${catalog}`);
      expect(family.conditions).toHaveLength(2);
      expect(family.conditions).toContainEqual({ condition, productStandard, basis: rule.basis, note: rule.note });
      for (const citation of rule.basis) {
        expect(STEEL_STANDARDS[citation.standardId]).toBeDefined();
        expect(citation.locator.length).toBeGreaterThan(0);
      }
      if (condition === 'hotRolled-heatTreatmentUnspecified') {
        expect(rule.basis[0].locator).toContain('5 c)');
        expect(rule.note).toContain('個別に照合');
        expect(rule.note).toContain('強度値');
      }
    });

  it.each(conditions)('%s / %s rejects substitution of the product standard',
    (catalog, condition, expectedStandard) => {
      for (const standard of ['JIS G 3123', 'JIS G 4051', 'JIS G 3194', 'JIS G 3191', 'JIS G 3452', '']) {
        if (standard === expectedStandard) continue;
        const result = s45cProductRule(catalog, condition, standard);
        if (result.allowed) throw new Error(`Accepted wrong standard: ${standard}`);
        expect(result.reasonCode).toBe('product-standard-mismatch');
        expect(result.reason).toContain(expectedStandard);
        expect(result.reason).toContain('JIS G 4051 7.1・7.3');
      }
    });

  it.each(['N', 'A', 'QT', 'Q', 'T', 'normalized', 'annealed', 'quenched-tempered', '焼ならし',
    '焼なまし', '焼入焼戻し', 'hotRolled-QT', 'brightBar-N', 'blackPipe-plainEnds', ''])(
    'rejects the unsupported S45C condition %s with the heat-treatment clause', (condition) => {
      for (const catalog of ['roundBar', 'flatBar'] as const) {
        const rule = s45cProductRule(catalog, condition, 'JIS G 4051');
        if (rule.allowed) throw new Error(`Accepted unsupported condition: ${condition}`);
        expect(rule.reasonCode).toBe('condition-not-supported');
        expect(rule.reason).toContain('JIS G 4051 5 c)');
        expect(rule.reason).toContain('熱処理未指定');
        expect(rule.basis[0].standardId).toBe('jis-g-4051-2026');
      }
    });

  it('returns the W1 rolled-section rejection for I sections without adding a catalog family', () => {
    expect(s45cProductRule('iBeam', 'hotRolled-heatTreatmentUnspecified', 'JIS G 3192'))
      .toBe(steelGradeRule('S45C', 'hBeam'));
    expect(STEEL_SECTION_CATALOGS).not.toContain('iBeam');
  });
});
