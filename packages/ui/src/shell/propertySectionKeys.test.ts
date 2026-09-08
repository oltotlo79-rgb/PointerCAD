import { describe, expect, it } from 'vitest';

import { propertySectionKey } from './propertySectionKeys.js';

const KEYS = {
  component: propertySectionKey('component', 'shared'),
  mate: propertySectionKey('mate', 'shared'),
  joint: propertySectionKey('joint', 'shared'),
  interference: propertySectionKey('interference'),
  bom: propertySectionKey('bom'),
};

describe('propertySectionKey(rules/06 10.9)', () => {
  it.each([
    ['部品', KEYS.component, 'component:shared'],
    ['合致', KEYS.mate, 'mate:shared'],
    ['ジョイント', KEYS.joint, 'joint:shared'],
    ['干渉', KEYS.interference, 'interference'],
    ['部品表', KEYS.bom, 'bom'],
  ])('%sの節に種類の接頭辞を付ける', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });

  it.each([
    ['部品と合致', KEYS.component, KEYS.mate],
    ['部品とジョイント', KEYS.component, KEYS.joint],
    ['部品と干渉', KEYS.component, KEYS.interference],
    ['部品と部品表', KEYS.component, KEYS.bom],
    ['合致とジョイント', KEYS.mate, KEYS.joint],
    ['合致と干渉', KEYS.mate, KEYS.interference],
    ['合致と部品表', KEYS.mate, KEYS.bom],
    ['ジョイントと干渉', KEYS.joint, KEYS.interference],
    ['ジョイントと部品表', KEYS.joint, KEYS.bom],
    ['干渉と部品表', KEYS.interference, KEYS.bom],
  ])('%sは同じidでも兄弟のkeyが食い違う', (_name, left, right) => {
    expect(left).not.toBe(right);
  });

  it('同じ入力から毎回同じkeyを返す', () => {
    expect(propertySectionKey('component', 'component-7'))
      .toBe(propertySectionKey('component', 'component-7'));
  });
});
