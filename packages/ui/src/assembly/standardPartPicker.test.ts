import { t } from '../i18n/t.js';
import { describe, expect, it } from 'vitest';
import { buildStandardPartFromSource, STEEL_PRODUCTS, steelProductOptions } from '@pointercad/model';

import {
  commitStandardPartChoice, DEFAULT_STANDARD_PART_PICKER, defaultStandardPartChoice,
  findStandardPartChoice, STANDARD_PART_CATEGORIES, standardPartChoices,
  standardPartUsesDimensionSeries, standardPartUsesThreadSeries, steelPartChoices, structuralPartChoices,
  steelPartDimensionGroups, steelPartChoiceAtDimension,
} from './standardPartPicker.js';

describe('standard-part picker choices', () => {
  it('offers every SGP nominal size in black and white conditions with separate saved keys', () => {
    const choices = steelPartChoices('SGP', 'steelPipe');
    expect(choices).toHaveLength(48);
    expect(new Set(choices.map((choice) => choice.key)).size).toBe(48);
    const black = choices.filter((choice) => choice.steelProduct?.condition === 'blackPipe-plainEnds');
    const white = choices.filter((choice) => choice.steelProduct?.condition === 'whitePipe-zincCoated');
    expect(black).toHaveLength(24);
    expect(white).toHaveLength(24);
    expect(black.map((choice) => choice.size).sort()).toEqual(white.map((choice) => choice.size).sort());
    for (const choice of white) {
      const result = commitStandardPartChoice('structuralSection', choice.key, '100');
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('White SGP selection failed');
      expect(result.value.source.options).toMatchObject({ steelProduct: choice.key.slice(6),
        materialGrade: 'SGP', condition: 'whitePipe-zincCoated', length: '100' });
      expect(buildStandardPartFromSource(result.value.source)).not.toBeNull();
    }
  });
  it('keeps all eight approved categories in a stable order', () => {
    expect(STANDARD_PART_CATEGORIES).toEqual([
      'hexBolt', 'hexNut', 'plainWasher', 'springWasher', 'socketHeadCapScrew',
      'panHeadScrew', 'deepGrooveBallBearing', 'structuralSection',
    ]);
  });

  it('defaults to an Annex-JA M8 coarse bolt at length 30', () => {
    expect(DEFAULT_STANDARD_PART_PICKER).toMatchObject({
      category: 'hexBolt', lengthSource: '30', dimensionSeries: 'annexJA', threadSeries: 'coarse',
    });
    expect(findStandardPartChoice(
      'hexBolt', DEFAULT_STANDARD_PART_PICKER.choiceKey, 'annexJA',
    )?.size).toBe('M8');
  });

  it.each(STANDARD_PART_CATEGORIES)('%s has nonempty unique choices', (category) => {
    const choices = standardPartChoices(category);
    expect(choices.length).toBeGreaterThan(0);
    expect(new Set(choices.map((choice) => choice.key)).size).toBe(choices.length);
    expect(choices).toContain(defaultStandardPartChoice(category));
  });

  it('filters bolt and nut rows by the selected dimension series', () => {
    expect(standardPartUsesDimensionSeries('hexBolt')).toBe(true);
    expect(standardPartUsesDimensionSeries('hexNut')).toBe(true);
    expect(standardPartChoices('hexBolt', 'annexJA')).toHaveLength(9);
    expect(standardPartChoices('hexBolt', 'main')).toHaveLength(11);
    expect(standardPartChoices('hexNut', 'annexJA')).toHaveLength(6);
    expect(standardPartChoices('hexNut', 'main')).toHaveLength(11);
    expect(standardPartChoices('hexBolt', 'annexJA')
      .every((choice) => choice.dimensionSeries === 'annexJA')).toBe(true);
  });

  it('shows pitch selection only for threaded parts', () => {
    expect(STANDARD_PART_CATEGORIES.filter(standardPartUsesThreadSeries)).toEqual([
      'hexBolt', 'hexNut', 'socketHeadCapScrew', 'panHeadScrew',
    ]);
  });

  it('combines the approved 40 angle, 16 channel, and 7 H-beam rows', () => {
    const choices = standardPartChoices('structuralSection');
    expect(new Set(choices.map((choice) => choice.catalog)))
      .toEqual(new Set(['equalAngle', 'channel', 'hBeam']));
    expect(choices).toHaveLength(109);
    expect(choices.every((choice) => choice.requiresLength)).toBe(true);
  });

  it('offers the five approved JIS B 1111 pan-head screw sizes', () => {
    expect(standardPartChoices('panHeadScrew').map((choice) => choice.size))
      .toEqual(['M3', 'M4', 'M5', 'M6', 'M8']);
  });

  it('excludes the incomplete M18 socket-head row', () => {
    expect(standardPartChoices('socketHeadCapScrew').some((choice) => choice.size === 'M18'))
      .toBe(false);
  });

  it('preserves an unverified source note for display', () => {
    const m8 = standardPartChoices('plainWasher').find((choice) => choice.size === 'M8');
    expect(m8?.verified).toBe(false);
    expect(m8?.note).toContain('\u8981\u78ba\u8a8d');
  });

  it('persists all semantic defaults for Enter placement', () => {
    const result = commitStandardPartChoice(
      DEFAULT_STANDARD_PART_PICKER.category,
      DEFAULT_STANDARD_PART_PICKER.choiceKey,
      DEFAULT_STANDARD_PART_PICKER.lengthSource,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('\u516d\u89d2\u30dc\u30eb\u30c8 M8\u00d730');
      expect(result.value.source).toMatchObject({
        kind: 'standardPart', catalog: 'hexBolt', size: 'M8',
        options: { length: '30', dimensionSeries: 'annexJA', threadSeries: 'coarse' },
      });
      expect(result.value.source.catalogRevision).not.toBe('');
      expect(result.value.source.generatorRevision).not.toBe('');
    }
  });

  it('persists main-standard and fine-thread selections', () => {
    const choice = standardPartChoices('hexBolt', 'main').find((item) => item.size === 'M8');
    expect(choice).toBeDefined();
    const result = commitStandardPartChoice('hexBolt', choice?.key ?? '', '30', 'main', 'fine');
    expect(result.ok && result.value.source.options).toEqual({
      length: '30', dimensionSeries: 'main', threadSeries: 'fine',
    });
  });

  it('stores a structural length expression verbatim and rejects invalid lengths', () => {
    const choice = defaultStandardPartChoice('structuralSection');
    const result = commitStandardPartChoice('structuralSection', choice.key, '500*2');
    expect(result.ok && result.value.source.options).toEqual({ length: '500*2' });
    expect(result.ok && result.value.name).toContain('\u9577\u3055500*2');
    expect(commitStandardPartChoice('structuralSection', choice.key, '1/'))
      .toEqual({ ok: false, reason: 'invalidLength' });
    expect(commitStandardPartChoice('structuralSection', choice.key, '0'))
      .toEqual({ ok: false, reason: 'invalidLength' });
  });

  it('does not accept a key from another category or dimension series', () => {
    const bearing = defaultStandardPartChoice('deepGrooveBallBearing');
    expect(commitStandardPartChoice('hexBolt', bearing.key, '30'))
      .toEqual({ ok: false, reason: 'unknownChoice' });
    const mainBolt = defaultStandardPartChoice('hexBolt', 'main');
    expect(commitStandardPartChoice('hexBolt', mainBolt.key, '30', 'annexJA'))
      .toEqual({ ok: false, reason: 'unknownChoice' });
  });
});

describe('large steel choice grouping', () => {
  it('uses two stages only above 100 candidates and groups the entire SS400 grid by numeric thickness', () => {
    const choices = steelPartChoices('SS400', 'flatBar');
    const keys = choices.map((choice) => choice.key);
    expect(choices).toHaveLength(132);
    expect(steelPartDimensionGroups(choices.slice(0, 100))).toBeNull();
    expect(steelPartDimensionGroups(choices.slice(0, 101))).not.toBeNull();
    const grouped = steelPartDimensionGroups(choices);
    expect(grouped?.dimension).toBe('thickness');
    expect(grouped?.groups.map((group) => group.value)).toEqual([4.5, 6, 9, 12, 16, 19, 22, 25, 28, 32, 36]);
    expect(grouped?.groups.every((group) => group.choices.length === 12)).toBe(true);
    expect(grouped?.groups.flatMap((group) => group.choices.map((choice) => choice.key)).sort()).toEqual([...keys].sort());
    expect(choices.map((choice) => choice.key)).toEqual(keys);
    expect(steelPartDimensionGroups(steelPartChoices('SS400', 'roundBar'))).toBeNull();
    expect(steelPartDimensionGroups(structuralPartChoices('unspecified'))).toBeNull();
    expect(steelPartDimensionGroups(structuralPartChoices('SS400'))).toBeNull();
  });

  it('retains width and manufacturing condition while changing thickness and rejects unknown dimensions', () => {
    const choices = steelPartChoices('SS400', 'flatBar');
    expect(steelPartChoiceAtDimension(choices, 'steel:SS400:flatBar:FB 50×6', '28')?.key)
      .toBe('steel:SS400:flatBar:FB 50×28');
    for (const value of ['7', '', 'NaN', 'Infinity', '6.0']) {
      expect(steelPartChoiceAtDimension(choices, choices[0].key, value)).toBeUndefined();
    }
    const carbon = steelPartChoices('S45C', 'flatBar');
    expect(steelPartChoiceAtDimension(carbon, 'steel:S45C:flatBar:FB 50×6', '9')?.key)
      .toBe('steel:S45C:flatBar:FB 50×9');
    expect(steelPartChoiceAtDimension(carbon, 'steel:S45C:flatBar:FB 50×6:hotRolled', '9')?.key)
      .toBe('steel:S45C:flatBar:FB 50×9:hotRolled');
  });

  it('commits every grouped SS400 choice with the same six strings as direct selection', () => {
    const choices = steelPartChoices('SS400', 'flatBar');
    const grouped = steelPartDimensionGroups(choices);
    if (grouped === null) throw new Error('Missing large-choice grouping');
    for (const group of grouped.groups) for (const choice of group.choices) {
      const result = commitStandardPartChoice('structuralSection', choice.key, '500*2');
      expect(result).toEqual(commitStandardPartChoice('structuralSection',
        findStandardPartChoice('structuralSection', choice.key)?.key ?? '', '500*2'));
      if (!result.ok || choice.steelProduct === undefined) throw new Error('Grouped choice did not commit');
      expect(result.value.source.options).toEqual({ ...steelProductOptions(choice.steelProduct), length: '500*2' });
      expect(buildStandardPartFromSource(result.value.source)).not.toBeNull();
    }
  });
});

describe('material-first steel picker', () => {
  it('offers only compatible shapes and preserves a material-aware choice through the existing commit signature', () => {
    expect(steelPartChoices('S45C', 'hBeam')).toEqual([]);
    expect(steelPartChoices('SS400', 'steelPipe')).toEqual([]);
    for (const row of STEEL_PRODUCTS) {
      const choice = steelPartChoices(row.materialGrade, row.catalog).find((item) => item.key === `steel:${row.key}`);
      expect(choice?.key).toBe(`steel:${row.key}`);
      const result = commitStandardPartChoice('structuralSection', choice?.key ?? '', '500*2');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.source.options).toEqual({ ...steelProductOptions(row), length: '500*2' });
        expect(result.value.name).toContain(row.materialGrade);
        expect(buildStandardPartFromSource(result.value.source)).not.toBeNull();
      }
    }
  });
  it('rejects invalid length bounds and category/forged material keys', () => {
    const choice = steelPartChoices('SGP', 'steelPipe')[0];
    for (const length of ['0', '-1', '0.5', '12001', '1/', '1e999']) {
      expect(commitStandardPartChoice('structuralSection', choice.key, length))
        .toEqual({ ok: false, reason: 'invalidLength' });
    }
    for (const length of ['1', '12000']) {
      expect(commitStandardPartChoice('structuralSection', choice.key, length).ok).toBe(true);
    }
    expect(commitStandardPartChoice('hexBolt', choice.key, '100'))
      .toEqual({ ok: false, reason: 'unknownChoice' });
    expect(commitStandardPartChoice('structuralSection', choice.key.replace('SGP:', 'SS400:'), '100'))
      .toEqual({ ok: false, reason: 'unknownChoice' });
  });
});

describe('explicit unassigned legacy selection', () => {
  it('keeps every old row selectable and commits the prior versions without an inferred grade', () => {
    const old = standardPartChoices('structuralSection');
    expect(structuralPartChoices('unspecified')).toEqual(old);
    expect(old).toHaveLength(109);
    for (const choice of old) {
      const result = commitStandardPartChoice('structuralSection', choice.key, '0.5');
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Legacy selection refused');
      expect(result.value.source).toMatchObject({ catalog: choice.catalog, size: choice.size,
        catalogRevision: 'jis-2026-09-08-r1', generatorRevision: '1', options: { length: '0.5' } });
      expect(result.value.source.options).toEqual({ length: '0.5' });
      expect(buildStandardPartFromSource(result.value.source)).not.toBeNull();
    }
  });
  it('keeps the known-grade path restricted to confirmed rows', () => {
    expect(structuralPartChoices('SS400')).toHaveLength(253);
    expect(structuralPartChoices('S45C')).toHaveLength(158);
    expect(structuralPartChoices('SGP')).toHaveLength(48);
    expect(structuralPartChoices('S45C', 'hBeam')).toEqual([]);
    expect(structuralPartChoices('SS400', 'steelPipe')).toEqual([]);
    expect(structuralPartChoices('SGP').every((choice) => choice.steelProduct?.materialGrade === 'SGP')).toBe(true);
  });
});


describe('S45C treatment-free picker contract', () => {
  it.each([
    ['roundBar', 'φ25', 'JIS G 4051', 'hotRound'],
    ['flatBar', 'FB 50×6', 'JIS G 3194', 'hotFlat'],
  ] as const)('%s selects hot and bright products of the same size by distinct keys',
    (catalog, size, productStandard, evidence) => {
      const brightKey = `steel:S45C:${catalog}:${size}`;
      const hotKey = `${brightKey}:hotRolled`;
      const choices = steelPartChoices('S45C', catalog).filter((choice) => choice.size === size);
      expect(choices.map((choice) => choice.key)).toEqual([brightKey, hotKey]);
      const result = commitStandardPartChoice('structuralSection', hotKey, '500*2');
      if (!result.ok) throw new Error('Hot S45C choice was refused');
      expect(result.value.source.options).toEqual({
        steelProduct: `S45C:${catalog}:${size}:hotRolled`, materialGrade: 'S45C',
        materialStandard: 'JIS G 4051', productStandard, condition: 'hotRolled-heatTreatmentUnspecified', evidence,
        length: '500*2',
      });
      expect(buildStandardPartFromSource(result.value.source)).not.toBeNull();
      const bright = commitStandardPartChoice('structuralSection', brightKey, '500*2');
      expect(bright.ok && bright.value.source.options.condition).toBe('brightBar-heatTreatmentUnspecified');
      expect(bright.ok && bright.value.source.options.steelProduct).toBe(`S45C:${catalog}:${size}`);
    });

  it('preserves each original S45C choice without inferring a treatment or strength preset', () => {
    const originals = [
      ['roundBar', 'φ20', 'brightRound'], ['roundBar', 'φ25', 'brightRound'],
      ['roundBar', 'φ30', 'brightRound'], ['flatBar', 'FB 50×6', 'brightFlat'],
      ['flatBar', 'FB 50×9', 'brightFlat'], ['flatBar', 'FB 50×12', 'brightFlat'],
    ] as const;
    for (const [catalog, size, evidence] of originals) {
      const key = `steel:S45C:${catalog}:${size}`;
      const choice = findStandardPartChoice('structuralSection', key);
      expect(choice?.steelProduct?.condition).toBe('brightBar-heatTreatmentUnspecified');
      const committed = commitStandardPartChoice('structuralSection', key, '100');
      if (!committed.ok) throw new Error(`S45C choice was refused: ${key}`);
      expect(committed.value.source.options).toEqual({
        steelProduct: `S45C:${catalog}:${size}`, materialGrade: 'S45C', materialStandard: 'JIS G 4051',
        productStandard: 'JIS G 3123', condition: 'brightBar-heatTreatmentUnspecified', evidence, length: '100',
      });
      expect(buildStandardPartFromSource(committed.value.source)).not.toBeNull();
      for (const suffix of ['N', 'A', 'QT', 'normalized', 'annealed', 'quenched-tempered']) {
        expect(commitStandardPartChoice('structuralSection', `${key}-${suffix}`, '100'))
          .toEqual({ ok: false, reason: 'unknownChoice' });
      }
    }
  });

  it('keeps excluded S45C shapes unselectable and rejects forged keys before placement', () => {
    for (const [catalog, size] of [
      ['steelPipe', '15A'], ['equalAngle', 'L 40×40×5'], ['channel', '[ 75×40×5×7'],
      ['hBeam', 'H 150×150×7×10'],
    ] as const) {
      expect(steelPartChoices('S45C', catalog)).toEqual([]);
      expect(commitStandardPartChoice('structuralSection', `steel:S45C:${catalog}:${size}`, '100'))
        .toEqual({ ok: false, reason: 'unknownChoice' });
    }
    expect(commitStandardPartChoice('structuralSection', 'steel:S45C:iBeam:I 100×75×5×8', '100'))
      .toEqual({ ok: false, reason: 'unknownChoice' });
  });

  it('provides separate localized explanations for scope, agreement products and strength references', () => {
    expect(t('assembly.steel.s45c.pipeOutsideScope')).toContain('JIS G 4051');
    expect(t('assembly.steel.s45c.pipeOutsideScope')).toContain('箇条1');
    expect(t('assembly.steel.s45c.sectionNotStandardized')).toContain('JIS G 4051');
    expect(t('assembly.steel.s45c.sectionNotStandardized')).toContain('7.5');
    expect(t('assembly.steel.s45c.sectionNotStandardized')).toContain('協定品');
    expect(t('assembly.steel.s45c.treatmentUnspecified')).toContain('JIS G 4051 5 c)');
    expect(t('assembly.steel.s45c.strengthSeparate')).toContain('別に選び');
    expect(t('assembly.steel.s45c.strengthSeparate')).toContain('自動設定されません');
  });
});
