import { describe, expect, it } from 'vitest';

import { liveBodyIds } from '../../part/createPartDocument.js';
import {
  buildStandardPart, buildStandardPartFromSource, createStandardPartSource,
  DEFAULT_STANDARD_FASTENER_LENGTH, DEFAULT_STANDARD_SECTION_LENGTH,
  standardPartNominalVolume,
} from './buildStandardPart.js';
import {
  STANDARD_CATALOG_REVISION, STANDARD_PART_GENERATOR_REVISION,
} from './types.js';

describe('寸法表から普通の部品文書を組む台本', () => {
  it('M8×30六角ボルトは正六角形・押し出し・円柱・簡略外ねじ・和で1ボディになる', () => {
    const document = buildStandardPart('hexBolt', 'M8', { length: '30' });
    expect(document?.name).toBe('六角ボルト M8×30');
    expect(document?.sketches[0].features.some((feature) => feature.kind === 'polygon')).toBe(true);
    expect(document?.solids.map((feature) => feature.kind)).toEqual([
      'extrude', 'primitive', 'threadShaft', 'boolean',
    ]);
    expect(document === null ? [] : liveBodyIds(document)).toHaveLength(1);
  });

  it('六角ボルト・ナットの既定は附属書JAで、本体規格も選べる', () => {
    expect(buildStandardPart('hexBolt', 'M8')?.solids[0]).not.toEqual(
      buildStandardPart('hexBolt', 'M8', { dimensionSeries: 'main' })?.solids[0],
    );
    expect(buildStandardPart('hexNut', 'M8')?.solids[0]).not.toEqual(
      buildStandardPart('hexNut', 'M8', { dimensionSeries: 'main' })?.solids[0],
    );
  });

  it('六角ボルトの長さは利用者の式のまま円柱へ保存する', () => {
    const document = buildStandardPart('hexBolt', 'M8', { length: '10*3' });
    const shaft = document?.solids.find(
      (feature) => feature.kind === 'primitive' && feature.shape.kind === 'cylinder',
    );
    expect(shaft?.kind).toBe('primitive');
    if (shaft?.kind === 'primitive' && shaft.shape.kind === 'cylinder') {
      expect(shaft.shape.height).toMatchObject({ source: '10*3', value: 30 });
    }
  });

  it('六角ナットは正六角柱へP3の下穴径で簡略ねじ穴を通す', () => {
    const document = buildStandardPart('hexNut', 'M8', { dimensionSeries: 'main' });
    expect(document?.solids.map((feature) => feature.kind)).toEqual(['extrude', 'threadHole']);
    const thread = document?.solids.at(-1);
    expect(thread?.kind).toBe('threadHole');
    if (thread?.kind === 'threadHole') {
      expect(thread.drillDiameter.value).toBeCloseTo(6.646835306586815, 10);
      expect(thread.representation).toBe('simplified');
    }
  });

  it('細目を選ぶと共有ねじ表のピッチを外ねじとねじ穴へ保存する', () => {
    const bolt = buildStandardPart('hexBolt', 'M8', { threadSeries: 'fine' });
    const nut = buildStandardPart('hexNut', 'M8', { threadSeries: 'fine' });
    expect(bolt?.solids.find((feature) => feature.kind === 'threadShaft')).toMatchObject({
      series: 'fine', pitch: { value: 1 },
    });
    expect(nut?.solids.find((feature) => feature.kind === 'threadHole')).toMatchObject({
      series: 'fine', pitch: { value: 1 },
    });
  });

  it('平座金は円柱へ貫通穴を通して1ボディにする', () => {
    const document = buildStandardPart('plainWasher', 'M8');
    expect(document?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'hole']);
    expect(document === null ? [] : liveBodyIds(document)).toHaveLength(1);
  });

  it('ばね座金は円環から切り欠きを引き、ねじれを作らない', () => {
    const document = buildStandardPart('springWasher', 'M8');
    expect(document?.solids.map((feature) => feature.kind)).toEqual([
      'primitive', 'primitive', 'boolean', 'primitive', 'boolean',
    ]);
    expect(document === null ? [] : liveBodyIds(document)).toHaveLength(1);
  });

  it('六角穴付きボルトは頭の六角穴を差し引く', () => {
    const document = buildStandardPart('socketHeadCapScrew', 'M8', { length: '30' });
    expect(document?.solids.filter((feature) =>
      feature.kind === 'boolean' && feature.operation === 'subtract',
    )).toHaveLength(1);
    expect(document === null ? [] : liveBodyIds(document)).toHaveLength(1);
  });

  it('十字穴付きなべ小ねじは頭・軸・外ねじ・十字の2切削を1ボディにする', () => {
    const document = buildStandardPart('panHeadScrew', 'M8', { length: '30' });
    expect(document?.name).toBe('十字穴付きなべ小ねじ M8×30');
    expect(document?.solids.filter((feature) =>
      feature.kind === 'boolean' && feature.operation === 'subtract',
    )).toHaveLength(2);
    expect(document === null ? [] : liveBodyIds(document)).toHaveLength(1);
  });

  it('深溝玉軸受は外輪・内輪・中間環の3ボディを作る', () => {
    const document = buildStandardPart('deepGrooveBallBearing', '6000');
    expect(document?.solids).toHaveLength(9);
    expect(document === null ? [] : liveBodyIds(document)).toHaveLength(3);
  });

  it.each([
    ['equalAngle', 'L 50×50×6'],
    ['channel', '[ 100×50×5×7.5'],
    ['hBeam', 'H 100×100×6×8'],
  ] as const)('%sは閉じた断面を長さの式で1回押し出す', (catalog, size) => {
    const document = buildStandardPart(catalog, size, { length: '500*2' });
    expect(document?.solids).toHaveLength(1);
    expect(document?.solids[0].kind).toBe('extrude');
    if (document?.solids[0].kind === 'extrude') {
      expect(document.solids[0].distance).toMatchObject({ source: '500*2', value: 1000 });
    }
    expect(document === null ? [] : liveBodyIds(document)).toHaveLength(1);
  });

  it('同じ呼びと指定から2回組むと同じ文書になる', () => {
    expect(buildStandardPart('hexBolt', 'M8', { length: '30' }))
      .toEqual(buildStandardPart('hexBolt', 'M8', { length: '30' }));
  });

  it('呼びまたは長さを変えると文書が変わる', () => {
    const m8 = buildStandardPart('hexBolt', 'M8', { length: '30' });
    expect(buildStandardPart('hexBolt', 'M10', { length: '30' })).not.toEqual(m8);
    expect(buildStandardPart('hexBolt', 'M8', { length: '40' })).not.toEqual(m8);
  });

  it('表にない呼び・0以下・壊れた長さは断る', () => {
    expect(buildStandardPart('hexBolt', 'M7')).toBeNull();
    expect(buildStandardPart('hexBolt', 'M8', { length: '0' })).toBeNull();
    expect(buildStandardPart('equalAngle', 'L 50×50×6', { length: '1/' })).toBeNull();
    expect(buildStandardPart('socketHeadCapScrew', 'M18')).toBeNull();
  });

  it('既定長はボルト30mm・形鋼1000mm', () => {
    expect(DEFAULT_STANDARD_FASTENER_LENGTH).toBe('30');
    expect(DEFAULT_STANDARD_SECTION_LENGTH).toBe('1000');
    expect(buildStandardPart('hexBolt', 'M8')?.name).toContain('×30');
    expect(buildStandardPart('equalAngle', 'L 50×50×6')?.name).toContain('長さ1000');
  });
});

describe('規格部品の版と体積の検算', () => {
  it('新規出どころへ寸法表版と生成器版を必ず保存する', () => {
    expect(createStandardPartSource('hexBolt', 'M8', { length: '30' })).toEqual({
      kind: 'standardPart', catalog: 'hexBolt', size: 'M8',
      options: { length: '30', dimensionSeries: 'annexJA', threadSeries: 'coarse' },
      catalogRevision: STANDARD_CATALOG_REVISION,
      generatorRevision: STANDARD_PART_GENERATOR_REVISION,
    });
  });

  it('保存版が一致すると組める', () => {
    const source = createStandardPartSource('plainWasher', 'M8');
    expect(buildStandardPartFromSource(source)?.name).toBe('平座金 M8');
  });

  it('未知の寸法表版を現在表で代用しない', () => {
    const source = { ...createStandardPartSource('hexBolt', 'M8'), catalogRevision: 'old' };
    expect(buildStandardPartFromSource(source)).toBeNull();
  });

  it('未知の生成器版を現在台本で代用しない', () => {
    const source = { ...createStandardPartSource('hexBolt', 'M8'), generatorRevision: 'old' };
    expect(buildStandardPartFromSource(source)).toBeNull();
  });

  it('M8×30六角ボルトの簡略体積と鋼質量を固定する', () => {
    const volume = standardPartNominalVolume('hexBolt', 'M8', {
      length: '30', dimensionSeries: 'main',
    });
    expect(volume).not.toBeNull();
    expect(volume ?? 0).toBeCloseTo(2283.668, 2);
    expect((volume ?? 0) / 1000 * 7.85).toBeCloseTo(17.927, 2);
  });

  it('M8六角ナットの簡略体積を固定する', () => {
    expect(standardPartNominalVolume('hexNut', 'M8', { dimensionSeries: 'main' }))
      .toBeCloseTo(759.282, 2);
  });

  it('M8平座金の簡略体積を固定する', () => {
    expect(standardPartNominalVolume('plainWasher', 'M8')).toBeCloseTo(233.03, 2);
  });

  it('L50×50×6・1mの角を丸めない形は公表質量と2%以内で一致する', () => {
    const volume = standardPartNominalVolume('equalAngle', 'L 50×50×6', { length: '1000' });
    const massKg = (volume ?? 0) / 1e9 * 7_850;
    expect(massKg).toBeCloseTo(4.4274, 4);
    expect(Math.abs(massKg - 4.43) / 4.43).toBeLessThan(0.02);
  });

  it.each([
    ['springWasher', 'M8'],
    ['socketHeadCapScrew', 'M8'],
    ['panHeadScrew', 'M8'],
    ['deepGrooveBallBearing', '6000'],
    ['channel', '[ 100×50×5×7.5'],
    ['hBeam', 'H 100×100×6×8'],
  ] as const)('%sの簡略体積は正である', (catalog, size) => {
    expect(standardPartNominalVolume(catalog, size)).toBeGreaterThan(0);
  });
});
