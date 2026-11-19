/**
 * 付属の組の画面の側(A2): 当てはまる組だけを出す事、覚えた選択を今の本体に合わせる事、予告の数、一括配置で付ける端の決め方。
 */
import { planFrameMembers, PRODUCT_CATALOG_REGISTRY, type FrameCornerRule, type FrameLine } from '@pointercad/model';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  accessoryPreview, effectiveAccessory, exposedEnds, familyAccessoryProps, layoutAccessory, pickedAccessory, rememberAccessory,
  standardAccessoryFamilies, standardAccessoryOptionsFor,
} from './accessoryChoice.js';

const registry = PRODUCT_CATALOG_REGISTRY;
beforeAll(async () => { await registry.ensure(['t-slot-frame-s6', 't-slot-frame-cap', 'aluminum-square-pipe']); });
afterEach(() => { rememberAccessory({ setId: null, ends: 'both', endReference: 'overall', itemKey: '' }); });
const accessoryOptionsFor = (...args: Parameters<typeof familyAccessoryProps>) => familyAccessoryProps(...args).options;

const frame = () => {
  const family = registry.loaded('t-slot-frame-s6');
  const row = family?.rows.find((candidate) => candidate.key === 's6-20x20');
  if (family === undefined || row === undefined) throw new Error('frame family not loaded');
  return { family, row };
};

describe('付属の組の欄の元', () => {
  it('溝つきのフレームには端のキャップの組と候補 2 つ、角パイプには組を出さない', () => {
    const { family, row } = frame();
    expect(accessoryOptionsFor(family, row, { length: '1000' }).map((option) => [option.setId, option.candidates.map((item) => item.itemKey)]))
      .toEqual([['frame-end-caps', ['s6-20x20', 's6-20x20-lock']]]);
    const pipe = registry.loaded('aluminum-square-pipe');
    expect(accessoryOptionsFor(pipe, pipe?.rows[0], { length: '500' })).toEqual([]);
    expect(accessoryOptionsFor(undefined, undefined, {})).toEqual([]);
  });

  it('本体の長さは欄の値(無い欄は族の初めの値)で読み、置く時の付属は覚えた選択を今の候補に合わせる', () => {
    const { family, row } = frame();
    const props = familyAccessoryProps(family, row, { length: '1000' });
    expect(props.lengthMm).toBe(1000);
    expect(pickedAccessory(props.options)).toBeUndefined();
    rememberAccessory({ setId: 'frame-end-caps', ends: 'start', endReference: 'member', itemKey: 'not-a-row' });
    expect(pickedAccessory(props.options)).toEqual({ setId: 'frame-end-caps', choices: { ends: 'start', endReference: 'member', itemKey: 's6-20x20' } });
    expect(effectiveAccessory([], { setId: 'frame-end-caps', ends: 'both', endReference: 'overall', itemKey: '' })).toBeNull();
    expect(layoutAccessory({ kind: 'steel', choiceKey: 'steel:x' })).toBeUndefined();
    expect(layoutAccessory({ kind: 'catalogItem', familyId: 't-slot-frame-s6', itemKey: 's6-20x20', values: {} }))
      .toEqual({ setId: 'frame-end-caps', endReference: 'member', itemKey: 's6-20x20' });
  });

  it('予告: 全長・両端は本体を厚さ × 2 縮め、本体の長さは縮めない', () => {
    expect(accessoryPreview(1000, 3, 'both', 'overall')).toEqual({ hostLengthMm: 994, count: 2 });
    expect(accessoryPreview(1000, 3, 'end', 'member')).toEqual({ hostLengthMm: 1000, count: 1 });
    expect(accessoryPreview(null, 3, 'start', 'overall')).toEqual({ hostLengthMm: null, count: 1 });
  });
});

describe('ボルトの座金とナットの組(A4)', () => {
  const m8 = 'hexBolt:JIS-B-1180:2014:M8:P1.25:annexJA';

  it('今の 8 分類の六角ボルトだけに組を出し、既定の締め付ける厚さ(ばね座金の無し・有り)を持つ', () => {
    const options = standardAccessoryOptionsFor('hexBolt', m8, '40', 'annexJA', 'coarse');
    expect(options.map((option) => option.setId)).toEqual(['bolt-washer-nut']);
    expect(options[0]?.defaultGripMm?.plain).toBeGreaterThan(options[0]?.defaultGripMm?.spring ?? Infinity);
    expect(standardAccessoryOptionsFor('hexNut', m8, '40', 'annexJA', 'coarse')).toEqual([]);
  });

  it('置く時の付属は、欄の式の厚さか既定の厚さと、ばね座金の有無', () => {
    const options = standardAccessoryOptionsFor('hexBolt', m8, '40', 'annexJA', 'coarse');
    rememberAccessory({ setId: 'bolt-washer-nut', ends: 'both', endReference: 'overall', itemKey: '', springWasher: true });
    expect(pickedAccessory(options)?.choices).toMatchObject({ gripMm: options[0]?.defaultGripMm?.spring, springWasher: true });
    rememberAccessory({ setId: 'bolt-washer-nut', ends: 'both', endReference: 'overall', itemKey: '', gripText: '12+3', springWasher: false });
    expect(pickedAccessory(options)?.choices).toMatchObject({ gripMm: 15, springWasher: false });
  });
});

describe('一括配置で付ける端', () => {
  const section = { minX: -10, minY: -10, maxX: 10, maxY: 10 };
  const path = (points: readonly (readonly [number, number, number])[], closed: boolean): FrameLine[] =>
    points.slice(0, closed ? points.length : points.length - 1).map((start, index) => ({ start, end: points[(index + 1) % points.length] ?? start }));
  const ends = (lines: readonly FrameLine[], corners: FrameCornerRule) => {
    const plan = planFrameMembers(lines, { section, up: [0, 0, 1], startExtension: 0, endExtension: 0, corners });
    if (!plan.ok) throw new Error(plan.reason);
    return exposedEnds(lines, plan);
  };
  const corner: readonly (readonly [number, number, number])[] = [[0, 0, 0], [1000, 0, 0], [1000, 500, 0], [0, 500, 0]];

  it('1 本は両端、開いた L の突き当ては通した部材の両端と当てた部材の外の端、留め・角の扱いなしの角には付けない', () => {
    expect(ends(path(corner.slice(0, 2), false), 'butt')).toEqual(['both']);
    expect(ends(path(corner.slice(0, 3), false), 'butt')).toEqual(['both', 'end']);
    expect(ends(path(corner.slice(0, 3), false), 'miter')).toEqual(['start', 'end']);
    expect(ends(path(corner.slice(0, 3), false), 'none')).toEqual(['start', 'end']);
  });

  it('閉じた長方形の突き当ては通した端だけ、留めには付けない', () => {
    expect(ends(path(corner, true), 'butt')).toEqual(['both', 'end', 'end', null]);
    expect(ends(path(corner, true), 'miter')).toEqual([null, null, null, null]);
  });
});

describe('軸受の C 形止め輪の組(A6)', () => {
  beforeAll(async () => { await registry.ensure(['c-ring-shaft', 'c-ring-bore', 'angular-contact-ball-bearing']); });

  it('8 分類の深溝玉軸受 6204 には軸用 20 と穴用 47 の組、族のアンギュラ玉軸受(内径 20・外径 47)にも同じ組を出す', () => {
    const options = standardAccessoryOptionsFor('deepGrooveBallBearing', 'deepGrooveBallBearing:JIS-B-1521:2012:6204', '', 'annexJA', 'coarse');
    expect(options.map((option) => [option.setId, option.candidates.map((item) => item.itemKey)]))
      .toEqual([['bearing-shaft-rings', ['20']], ['bearing-bore-rings', ['47']]]);
    expect([standardAccessoryFamilies('deepGrooveBallBearing'), standardAccessoryFamilies('hexNut')]).toEqual([['c-ring-shaft', 'c-ring-bore'], []]);
    const angular = registry.loaded('angular-contact-ball-bearing');
    const row = angular?.rows.find((item) => item.dims.boreDiameter === 20 && item.dims.outsideDiameter === 47);
    expect(accessoryOptionsFor(angular, row, {}).map((option) => option.setId)).toEqual(['bearing-shaft-rings', 'bearing-bore-rings']);
  });

  it('置く時の付属は、選んだ組・付ける端・行の鍵', () => {
    const options = standardAccessoryOptionsFor('deepGrooveBallBearing', 'deepGrooveBallBearing:JIS-B-1521:2012:6204', '', 'annexJA', 'coarse');
    rememberAccessory({ setId: 'bearing-bore-rings', ends: 'start', endReference: 'overall', itemKey: '' });
    expect(pickedAccessory(options)).toEqual({ setId: 'bearing-bore-rings', choices: { ends: 'start', endReference: 'overall', itemKey: '47' } });
  });
});
