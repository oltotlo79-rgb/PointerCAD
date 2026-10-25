import { findHelpTopic } from '@pointercad/help-content';
import { describe, expect, it } from 'vitest';
import { commandDefinition } from './commandDefinitions.js';
import { radialCommandAt, radialCommandIds, radialCommandDescription } from './radialCommandItems.js';
import { t } from '../i18n/t.js';

describe('放射メニューは画面の8道具を既存の操作入口へつなぐ', () => {
  it('点の選択時だけ線分を共通の2点接続へ切り替え、ほかの7項目を保つ', () => {
    const ordinary = radialCommandIds('part'), selected = radialCommandIds('part', true);
    expect(selected[1]).toBe('sketch.connectPoints');
    expect(selected.filter((_, index) => index !== 1)).toEqual(ordinary.filter((_, index) => index !== 1));
    expect(radialCommandAt('part', 1, true)).toBe('sketch.connectPoints');
    expect(commandDefinition(selected[1])?.enabledBy).toBe('connectPoints');
    expect(t(commandDefinition(selected[1])?.labelKey ?? 'radial.unavailable')).toBe('2点をつなげる');
    expect(radialCommandDescription(selected[1])).toBe(t('sketch.connect.hint'));
    expect(radialCommandIds('drawing', true)).toBe(radialCommandIds('drawing'));
  });
  it('3点以上の選択では同じ位置を点で面を張る操作へ切り替え、ほかの7項目を保つ', () => {
    const ordinary = radialCommandIds('part'), face = radialCommandIds('part', true, true);
    expect(face[1]).toBe('sketch.faceFromPoints');
    expect(face.filter((_, index) => index !== 1)).toEqual(ordinary.filter((_, index) => index !== 1));
    expect(radialCommandIds('part', false, true)).toEqual(face);
    expect(new Set(face).size).toBe(8);
    expect(radialCommandAt('part', 1, true, true)).toBe('sketch.faceFromPoints');
    expect(commandDefinition(face[1])).toMatchObject({ enabledBy: 'faceFromPoints', documentKinds: ['part'],
      helpTopic: 'sketch-tools', shortcuts: [] });
    expect(findHelpTopic(commandDefinition(face[1])?.helpTopic ?? '')).toBeDefined();
    expect(t(commandDefinition(face[1])?.labelKey ?? 'radial.unavailable')).toBe('点で面を張る');
    expect(radialCommandDescription(face[1])).toBe(t('sketch.facePoints.hint'));
    expect(radialCommandIds('assembly', true, true)).toBe(radialCommandIds('assembly'));
    expect(radialCommandIds('drawing', true, true)).toBe(radialCommandIds('drawing'));
  });
  it('基準点を1つ選んだときだけ同じ位置を基準点に点を置く操作へ切り替え、ほかの7項目を保つ', () => {
    const ordinary = radialCommandIds('part'), reference = radialCommandIds('part', true, false, true);
    expect(reference[1]).toBe('sketch.pointAtReference');
    expect(reference.filter((_, index) => index !== 1)).toEqual(ordinary.filter((_, index) => index !== 1));
    expect(new Set(reference).size).toBe(8);
    expect(radialCommandAt('part', 1, true, false, true)).toBe('sketch.pointAtReference');
    expect(commandDefinition(reference[1])).toMatchObject({ enabledBy: 'pointAtReference', documentKinds: ['part'],
      helpTopic: 'sketch-tools', shortcuts: [] });
    expect(findHelpTopic(commandDefinition(reference[1])?.helpTopic ?? '')).toBeDefined();
    expect(t(commandDefinition(reference[1])?.labelKey ?? 'radial.unavailable')).toBe('基準点に点を置く');
    expect(radialCommandDescription(reference[1])).toBe(t('radial.pointAtReferenceHint'));
    expect(radialCommandDescription(reference[1])).not.toBe(t('radial.unavailable'));
    expect(radialCommandIds('part', true)[1]).toBe('sketch.connectPoints');
    expect(radialCommandIds('assembly', false, false, true)).toBe(radialCommandIds('assembly'));
    expect(radialCommandIds('drawing', false, false, true)).toBe(radialCommandIds('drawing'));
  });
  it.each(['part', 'assembly', 'drawing'] as const)('%sの全方向に固有で実行範囲が一致する操作と説明を持つ', kind => {
    const ids = radialCommandIds(kind);
    expect(ids).toHaveLength(8); expect(new Set(ids).size).toBe(8);
    for (const slot of [0, 1, 2, 3, 4, 5, 6, 7] as const) {
      const definition = commandDefinition(ids[slot]);
      expect(radialCommandAt(kind, slot)).toBe(ids[slot]);
      expect(definition?.documentKinds).toContain(kind);
      expect(findHelpTopic(definition?.helpTopic ?? '')).toBeDefined();
      expect(radialCommandDescription(ids[slot])).not.toBe(t('radial.unavailable'));
      expect(radialCommandDescription(ids[slot]).trim()).not.toBe('');
    }
  });
});
