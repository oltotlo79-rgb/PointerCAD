/**
 * 規格部品の選ぶ窓の寸法の表(K-07c)の元: 名前と単位を決めた鍵だけを行の順で出し、印の数・番号つきの座標・系列の番号は出さない事。
 * 今の 8 分類は行の型の欄から同じ名前の表を作り、値の無い欄は出さない事。鋼材は dimensions を持つ行だけ表を出す事。
 * 族の行の要確認と簡略の印。線図を作る部品文書は、今の指定の値が通らない時に既定の値で作る事。
 */
import { HEX_BOLT_TABLE, HEX_NUT_TABLE, PRODUCT_CATALOG_REGISTRY } from '@pointercad/model';
import { beforeAll, describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import { familyFigurePart, standardFigurePart } from './dimensionTable.js';
import { standardPartChoices, structuralPartChoices } from './standardPartPicker.js';

beforeAll(async () => { await PRODUCT_CATALOG_REGISTRY.ensure(PRODUCT_CATALOG_REGISTRY.entries.map((entry) => entry.id)); });

function loaded(id: string) {
  const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
  if (family === undefined) throw new Error(`族が無い: ${id}`);
  return family;
}

/** 行の dims の鍵の並びの中で、expected がこの順に現れる事。 */
function inRowOrder(rowKeys: readonly string[], expected: readonly string[]): boolean {
  const positions = expected.map((key) => rowKeys.indexOf(key));
  return positions.every((position, index) => position >= 0 && (index === 0 || position > (positions[index - 1] ?? -1)));
}

describe('族の行の表', () => {
  it('ボス付きのベースの板は取付けの呼び径と板の端からの位置を示す', () => {
    const family = loaded('t-slot-foot-base');
    const row = family.rows.find((candidate) => candidate.key === 'base-75x75x10-boss25-aluminum');
    if (row === undefined) throw new Error('ボス付きのベースの板が無い');
    const part = familyFigurePart(family, row, {});
    expect(part.rows.filter((item) => item.key.startsWith('boss') || item.key === 'adjusterThreadDiameter')
      .map((item) => [t(item.label), item.value, item.unit])).toEqual([
      ['ボスの外径', 25, 'mm'], ['ボスの両端面の間隔', 20, 'mm'],
      ['板の左端からボス中心まで', 43, 'mm'], ['板の手前端からボス中心まで', 43, 'mm'],
      ['アジャスターのめねじの呼び径', 12, 'mm'],
    ]);
    expect(part.rows.some((item) => item.key === 'holeCount')).toBe(false);
    expect(part.marks).toContainEqual({ kind: 'simplified', parts: ['取付け穴は作っていない', 'アジャスターのめねじ'] });
    expect(part.build()).not.toBeNull();
  });

  it('現行のアルミ蝶番板ナットに、めねじの呼び径・軸間・長手端からの位置を表示する', () => {
    const family = loaded('door-part-box');
    const row = family.rows.find((candidate) => candidate.key === 'flat-hinge-plate-nut-15x5x55-al');
    if (row === undefined) throw new Error('アルミ蝶番板ナットが無い');
    const part = familyFigurePart(family, row, {});
    const fields = ['mountingThreadDiameter', 'holePitch', 'mountingThreadFromEnd'];
    expect(part.rows.filter((item) => fields.includes(item.key)).map((item) => [item.key, item.value, item.unit]))
      .toEqual([['mountingThreadDiameter', 6, 'mm'], ['holePitch', 37, 'mm'], ['mountingThreadFromEnd', 9, 'mm']]);
    expect(part.rows.some((item) => item.key === 'holeDiameter')).toBe(false);
    expect(part.build()).not.toBeNull();
  });

  it('板皿の寸法は台座の幅・奥行き、穴数、左下基準の軸中心、厚さを見出しと単位つきで出す', () => {
    const family = loaded('t-slot-adjuster');
    const dims = { padWidth: 80, padDepth: 64, holeCount: 4, shaftCenterX: 28, shaftCenterY: 39, padThickness: 6, threadLength: 30 };
    const row = { ...family.rows[0], key: 'plate-sample', dims };
    const rows = familyFigurePart(family, row, {}).rows;
    expect(rows.map((item) => [item.key, t(item.label), item.value, item.unit])).toEqual([
      ['padWidth', '台座の幅', dims.padWidth, 'mm'], ['padDepth', '台座の奥行き', dims.padDepth, 'mm'],
      ['holeCount', '穴の数', dims.holeCount, ''], ['shaftCenterX', '台座の左端から軸中心まで', dims.shaftCenterX, 'mm'],
      ['shaftCenterY', '台座の手前端から軸中心まで', dims.shaftCenterY, 'mm'], ['padThickness', '台座の厚さ', dims.padThickness, 'mm'],
      ['threadLength', t('catalog.dimension.threadLength'), dims.threadLength, 'mm'],
    ]);
  });

  it.each([
    ['s6-20x20x50-t3-h4-aluminum', 10, 30, 20, 40],
    ['s8-30x30x60-t5-h4-aluminum', 10, 37, 23, 50],
    ['s10-40x40x70-t5-h4-aluminum-67g-a22.5', 10, 43.5, 26.5, 60],
  ] as const)('両脚の穴を共通の幅端から測る (%s)', (key, firstA, lastA, firstB, lastB) => {
    const family = loaded('t-slot-angle-bracket');
    const row = family.rows.find((item) => item.key === key);
    if (row === undefined) throw new Error(key);
    const figure = familyFigurePart(family, row, {});
    expect(figure.rows.filter((item) => item.key.startsWith('angleAcross')).map((item) => [item.value, item.unit]))
      .toEqual([[firstA, 'mm'], [lastA, 'mm'], [firstB, 'mm'], [lastB, 'mm']]);
  });

  it.each([
    ['s10-80x80x75-t14-hb4-rib-aluminum', 'A', 4, 24],
    ['s10-51x40x65-t14-ha2-aluminum', 'B', 2, 22.5],
  ] as const)('取付穴の未作成側を実形状と区別する (%s)', (key, leg, count, center) => {
    const family = loaded('t-slot-angle-bracket');
    const row = family.rows.find((item) => item.key === key);
    if (row === undefined) throw new Error(key);
    const figure = familyFigurePart(family, row, {});
    const value = (field: string) => figure.rows.find((item) => item.key === field)?.value;
    expect(value(`angleHoleCount${leg}`)).toBe(0);
    expect(value(`angleAcross${leg}`)).toBeUndefined();
    expect(value(`angleDrawingCount${leg}`)).toBe(count);
    expect(value(`angleDrawingAlong${leg}`)).toBe(center);
    expect(figure.marks.some((item) => item.kind === 'simplified')).toBe(true);
  });

  it.each([
    ['s10-30x40x40-h2-aluminum', 10, 20, 14, 34, 34],
    ['s10-30x40x50-h2-aluminum', 17.5, 41, 15, 36, 26],
    ['s10-30x40x55-h2-aluminum', 15, 41, 15, 41, 26],
  ] as const)('上面と前面それぞれの穴位置・通し径・座ぐりを表示する (%s)', (key, topV, frontV, bore, topDepth, frontDepth) => {
    const family = loaded('t-slot-block-bracket');
    const row = family.rows.find((item) => item.key === key);
    if (row === undefined) throw new Error(key);
    const figure = familyFigurePart(family, row, {});
    expect(figure.rows.filter((item) => item.key.startsWith('block')).map((item) => [item.value, item.unit])).toEqual([
      [15, 'mm'], [topV, 'mm'], [9, 'mm'], [bore, 'mm'], [topDepth, 'mm'],
      [15, 'mm'], [frontV, 'mm'], [9, 'mm'], [bore, 'mm'], [frontDepth, 'mm'],
    ]);
  });

  it('名前の決まった鍵だけを行の順で出し、値は行のまま、単位は鍵ごと(mm・kg/m・mm²・cm⁴・cm³)', () => {
    const family = loaded('t-slot-frame-s6');
    const row = family.rows[0];
    const part = familyFigurePart(family, row, {});
    const keys = part.rows.map((item) => item.key);
    expect(keys).toEqual(['width', 'height', 'slotPitch', 'slotOpening', 'slotInnerWidth', 'slotDepth', 'centerHole', 'cornerRadius',
      'unitMassKgPerM', 'areaMm2', 'ixCm4', 'iyCm4', 'zxCm3', 'zyCm3'].filter((key) => key in row.dims));
    expect(inRowOrder(Object.keys(row.dims), keys)).toBe(true);
    for (const item of part.rows) expect(item.value).toBe(row.dims[item.key]);
    const unit = (key: string) => part.rows.find((item) => item.key === key)?.unit;
    expect([unit('width'), unit('unitMassKgPerM'), unit('areaMm2'), unit('ixCm4'), unit('zxCm3')]).toEqual(['mm', 'kg/m', 'mm²', 'cm⁴', 'cm³']);
  });

  it('丸角キャップ全5行では大きい角の半径を1回だけ表示し、締結の溝呼びと簡略化した角の値は表示しない', () => {
    const family = loaded('t-slot-frame-cap');
    const expected = [
      ['s6-20x20-r15', 20, 20, 3, 15, 1.2], ['s8-30x30-r22', 30, 30, 3, 22, 2.4],
      ['s10-40x40-r32', 40, 40, 3, 32, 4.8], ['s10-45x45-r35', 45, 45, 3, 35, 6.1],
      ['s8-60x60-r48', 60, 60, 3, 48, 8.9],
    ] as const;
    const caps = family.rows.filter((row) => Object.hasOwn(row.dims, 'largeRadius') || expected.some(([key]) => key === row.key));
    expect(caps.map((row) => row.key)).toEqual(expected.map(([key]) => key));
    for (const [key, width, height, thickness, radius, mass] of expected) {
      const row = caps.find((item) => item.key === key);
      if (row === undefined) throw new Error(`キャップの行が無い: ${key}`);
      const figure = familyFigurePart(family, row, {});
      expect(figure.rows.map((item) => [item.key, item.value, item.unit]), key).toEqual([
        ['width', width, 'mm'], ['height', height, 'mm'], ['thickness', thickness, 'mm'],
        ['largeRadius', radius, 'mm'], ['massG', mass, 'g'],
      ]);
      expect(figure.marks, key).toEqual([{ kind: 'simplified', parts: ['取付けの脚と穴', '角の形'] }]);
    }
  });

  it.each([
    ['t-slot-frame-s6', 's6-40x60-t2s3', 20, 4, 4.2, undefined, 1],
    ['t-slot-frame-s8', 's8-50x100-t2s4', undefined, 8, 6.8, undefined, 2],
    ['t-slot-frame-s10', 's10-45x60-t1s1', undefined, undefined, undefined, 12.5, 3],
    ['t-slot-frame-s8', 's8-30x30-r22', undefined, undefined, undefined, 6.8, undefined],
    ['t-slot-frame-s6', 's6-l40x40-a20', 20, undefined, undefined, undefined, undefined],
  ] as const)('外周指定の寸法だけを表示する(%s/%s)', (familyId, itemKey, pitch, holeCount, diameter, center, radius) => {
    const family = loaded(familyId);
    const row = family.rows.find((item) => item.key === itemKey);
    if (row === undefined) throw new Error(itemKey);
    const part = familyFigurePart(family, row, {});
    const value = (key: string): number | undefined => part.rows.find((item) => item.key === key)?.value;
    expect([value('slotPitch'), value('holeCount'), value('holeDiameter'), value('centerHole'), value('cornerRadius')])
      .toEqual([pitch, holeCount, diameter, center, radius]);
    expect(part.build()).not.toBeNull();
    if (row.simplified !== undefined) expect(part.marks).toContainEqual({ kind: 'simplified', parts: row.simplified });
  });

  it('20×40 の上・左の型を選ぶと資料の軸穴を mm で示し、簡略形と区別する', () => {
    const family = loaded('t-slot-frame-s6');
    const row = family.rows.find((item) => item.key === 's6-20x40-tl');
    if (row === undefined) throw new Error('20×40');
    expect(row.size).toContain('上 1 本・左 2 本');
    const figure = familyFigurePart(family, row, { length: '500' });
    expect(figure.rows.filter(({ key }) => ['holeCount', 'holeDiameter', 'holePitch', 'centerHole', 'ixCm4', 'iyCm4'].includes(key))
      .map(({ key, value, unit }) => [key, value, unit])).toEqual([
      ['holeCount', 2, ''], ['holeDiameter', 4.2, 'mm'], ['holePitch', 20, 'mm'],
    ]);
    expect(figure.marks).toContainEqual({ kind: 'simplified', parts: ['寸法表の軸穴とそれにつながる内空・溝の細部'] });
    expect(figure.build()?.solids.map((feature) => feature.kind)).toEqual(['extrude']);
  });

  it('印の数(車輪の止め・旋回・取付け)と系列の番号は出さず、質量は g、接触角は度', () => {
    const caster = familyFigurePart(loaded('t-slot-caster'), loaded('t-slot-caster').rows[0], {});
    const keys = caster.rows.map((item) => item.key);
    for (const flag of ['brake', 'swivel', 'mount', 'offset', 'series']) expect(keys).not.toContain(flag);
    expect(caster.rows.find((item) => item.key === 'massG')?.unit).toBe('g');
    const bearing = familyFigurePart(loaded('angular-contact-ball-bearing'), loaded('angular-contact-ball-bearing').rows[0], {});
    expect(bearing.rows.find((item) => item.key === 'contactAngle')?.unit).toBe('°');
  });

  it('全部の族の全部の行: 番号つきの座標・溝の印を出さず、値は有限、名前の文は i18n にある', () => {
    for (const entry of PRODUCT_CATALOG_REGISTRY.entries) {
      const family = loaded(entry.id);
      for (const row of family.rows) {
        for (const item of familyFigurePart(family, row, {}).rows) {
          expect(item.key, `${family.id}/${row.key}`).not.toMatch(/^(hole|slot)\d|^slots?(Across|Top|Bottom|Left|Right|Count)$|^slot$/u);
          expect(Number.isFinite(item.value), `${family.id}/${row.key}/${item.key}`).toBe(true);
          expect(t(item.label).length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('要確認の行は理由、簡略の行は簡略にした所を印に出す。鍵は族・行・指定の値で決まる', () => {
    const seal = loaded('oil-seal-specified');
    const unverified = familyFigurePart(seal, seal.rows[0], {});
    expect(unverified.marks).toEqual([{ kind: 'unverified', parts: [seal.rows[0].note] }]);
    const nut = loaded('t-slot-nut');
    const row = nut.rows.find((candidate) => (candidate.simplified ?? []).length > 0);
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(familyFigurePart(nut, row, {}).marks).toContainEqual({ kind: 'simplified', parts: row.simplified });
    expect(familyFigurePart(nut, row, {}).key).toBe(familyFigurePart(nut, row, {}).key);
    expect(familyFigurePart(nut, row, { length: '20' }).key).not.toBe(familyFigurePart(nut, row, {}).key);
  });

  it('道具の画面の値で入れた行は、その寸法の名前を印に出す(名前の無い鍵は出さない)。値の出どころを持たない行(資料と頁の行)は出さない', () => {
    const frame = loaded('t-slot-frame-s6');
    expect('valueSource' in frame.rows[0]).toBe(false);
    const base = familyFigurePart(frame, frame.rows[0], {});
    expect(base.marks.map((mark) => mark.kind)).not.toContain('toolScreen');
    const widthLabel = base.rows.find((item) => item.key === 'width')?.label;
    expect(widthLabel).toBeDefined();
    const screen = familyFigurePart(frame, { ...frame.rows[0], valueSource: { kind: 'toolScreen', fields: ['width', 'noSuchDimension'] } }, {});
    expect(screen.marks).toContainEqual({ kind: 'toolScreen', parts: [widthLabel] });
  });

  it('全部の族の道具の画面の値の行: 挙げた鍵は全部、行の寸法にあり名前の文を持つ(印から黙って落ちない)', () => {
    let count = 0;
    for (const entry of PRODUCT_CATALOG_REGISTRY.entries) {
      const family = loaded(entry.id);
      for (const row of family.rows) {
        if (row.valueSource === undefined) continue;
        count += 1;
        const fields = row.valueSource.fields;
        expect(fields.length, `${family.id}/${row.key}`).toBeGreaterThan(0);
        for (const key of fields) expect(key in row.dims, `${family.id}/${row.key}/${key}`).toBe(true);
        const mark = familyFigurePart(family, row, {}).marks.find((item) => item.kind === 'toolScreen');
        const labels = mark?.kind === 'toolScreen' ? mark.parts : [];
        expect(labels.length, `${family.id}/${row.key}`).toBe(fields.length);
        for (const label of labels) expect(t(label).length).toBeGreaterThan(0);
      }
    }
    expect(count).toBeGreaterThan(0);
  });

  it('線図の部品文書: 指定の値が通らない時(打ちかけの長さ)は既定の値で作る', () => {
    const frame = loaded('t-slot-frame-s6');
    expect(familyFigurePart(frame, frame.rows[0], { length: '-' }).build()).not.toBeNull();
    expect(familyFigurePart(frame, frame.rows[0], {}).build()).not.toBeNull();
  });
});

describe('今の 8 分類と鋼材の表', () => {
  it('六角ボルト: 行の型の欄を呼び径・ピッチ・二面幅・頭の高さ・ねじ部の長さの順に出す(印は窓が出すので無し)', () => {
    const choice = standardPartChoices('hexBolt', 'annexJA').find((candidate) => candidate.size === 'M8');
    const row = HEX_BOLT_TABLE.find((candidate) => candidate.dimensionSeries === 'annexJA' && candidate.size === 'M8');
    expect(choice).toBeDefined();
    expect(row).toBeDefined();
    if (choice === undefined || row === undefined) return;
    const part = standardFigurePart('hexBolt', choice, 'annexJA', 'coarse');
    expect(part.rows.map((item) => [item.key, item.value, item.unit])).toEqual([['nominalDiameter', row.d, 'mm'], ['pitch', row.pitch, 'mm'],
      ['acrossFlats', row.s, 'mm'], ['headHeight', row.k, 'mm'], ['threadLength', row.b1, 'mm']]);
    expect(part.marks).toEqual([]);
    expect(part.build()).not.toBeNull();
  });

  it('六角ナット: 下限の値が無い行は高さ(最小)を出さない', () => {
    for (const row of HEX_NUT_TABLE) {
      const choice = standardPartChoices('hexNut', row.dimensionSeries).find((candidate) => candidate.key === `hexNut:${row.key}`);
      expect(choice).toBeDefined();
      if (choice === undefined) continue;
      const keys = standardFigurePart('hexNut', choice, row.dimensionSeries, 'coarse').rows.map((item) => item.key);
      expect(keys.includes('heightMin')).toBe(row.mMin !== null);
    }
  });

  it('鋼材: 平鋼は幅と厚さ、形鋼(dimensions を持たない行)は表を出さない', () => {
    const flat = structuralPartChoices('SS400', 'flatBar').find((candidate) => candidate.size === 'FB 50×6');
    const angle = structuralPartChoices('SS400', 'equalAngle')[0];
    expect(flat).toBeDefined();
    if (flat === undefined) return;
    expect(standardFigurePart('structuralSection', flat, 'annexJA', 'coarse').rows.map((item) => [item.key, item.value]))
      .toEqual([['width', 50], ['thickness', 6]]);
    expect(standardFigurePart('structuralSection', angle, 'annexJA', 'coarse').rows).toEqual([]);
    expect(standardFigurePart('structuralSection', angle, 'annexJA', 'coarse').build()).not.toBeNull();
  });
});
