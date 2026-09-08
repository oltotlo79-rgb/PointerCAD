import { describe, expect, it } from 'vitest';

import {
  commitStandardPartChoice, DEFAULT_STANDARD_PART_PICKER, defaultStandardPartChoice,
  findStandardPartChoice, STANDARD_PART_CATEGORIES, standardPartChoices,
  standardPartUsesDimensionSeries, standardPartUsesThreadSeries,
} from './standardPartPicker.js';

describe('standard-part picker choices', () => {
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

  it('combines the approved 26 angle, 8 channel, and 7 H-beam rows', () => {
    const choices = standardPartChoices('structuralSection');
    expect(new Set(choices.map((choice) => choice.catalog)))
      .toEqual(new Set(['equalAngle', 'channel', 'hBeam']));
    expect(choices).toHaveLength(41);
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
