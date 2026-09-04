import { describe, expect, it } from 'vitest';

import {
  appearanceFromPreset,
  DEFAULT_APPEARANCE,
  densityMaterialFor,
  findMaterialPreset,
  MATERIAL_PRESETS,
  WOOD_SPECIES,
} from './materialPresets.js';

const HEX_COLOR = /^#[0-9a-f]{6}$/;

describe('MATERIAL_PRESETS', () => {
  it('11 種そろっている(§2.4.1)', () => {
    expect(MATERIAL_PRESETS.length).toBe(11);
  });

  it('すべての色が #rrggbb(小文字16進)の形をしている', () => {
    for (const preset of MATERIAL_PRESETS) {
      expect(preset.color).toMatch(HEX_COLOR);
    }
  });

  it('すべての光沢・粗さ・透過率が 0〜100 に収まる', () => {
    for (const preset of MATERIAL_PRESETS) {
      expect(preset.gloss).toBeGreaterThanOrEqual(0);
      expect(preset.gloss).toBeLessThanOrEqual(100);
      expect(preset.roughness).toBeGreaterThanOrEqual(0);
      expect(preset.roughness).toBeLessThanOrEqual(100);
      expect(preset.transmission).toBeGreaterThanOrEqual(0);
      expect(preset.transmission).toBeLessThanOrEqual(100);
    }
  });

  it('id は重複しない', () => {
    const ids = MATERIAL_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('WOOD_SPECIES', () => {
  it('6 種そろっている(§0.a-0.5)', () => {
    expect(WOOD_SPECIES.length).toBe(6);
  });

  it('地の色・木目の色が #rrggbb の形をしている', () => {
    for (const species of WOOD_SPECIES) {
      expect(species.baseColor).toMatch(HEX_COLOR);
      expect(species.grainColor).toMatch(HEX_COLOR);
    }
  });

  it('ナラの密度は 0.68 g/cm³(§2.4.1)', () => {
    const oak = WOOD_SPECIES.find((species) => species.id === 'oak');
    expect(oak?.density).toBe(0.68);
  });
});

describe('findMaterialPreset', () => {
  it('存在する id はプリセットを返す', () => {
    expect(findMaterialPreset('steel')?.id).toBe('steel');
  });
});

describe('appearanceFromPreset', () => {
  it('既定の色は #b8bfcc(P2 の SOLID_COLOR そのまま)', () => {
    expect(DEFAULT_APPEARANCE.color).toBe('#b8bfcc');
  });

  it('既定の光沢は 5、粗さは 55(SOLID_METALNESS=0.05 / SOLID_ROUGHNESS=0.55 を100倍)', () => {
    expect(DEFAULT_APPEARANCE.gloss.value).toBe(5);
    expect(DEFAULT_APPEARANCE.roughness.value).toBe(55);
  });

  it('既定の透過率は 0、柄は none', () => {
    expect(DEFAULT_APPEARANCE.transmission.value).toBe(0);
    expect(DEFAULT_APPEARANCE.pattern.kind).toBe('none');
  });

  it('ガラスの透過率は 92(§2.4.1)', () => {
    expect(appearanceFromPreset('glass').transmission.value).toBe(92);
  });

  it('鏡の粗さは 2(§2.4.1)', () => {
    expect(appearanceFromPreset('mirror').roughness.value).toBe(2);
  });

  it('プラスチックは色を選べる(colorEditable、FR-1107)', () => {
    expect(appearanceFromPreset('plastic', '#112233').color).toBe('#112233');
  });

  it('鉄板は色を選べない(colorEditable が偽なので渡しても無視する)', () => {
    expect(appearanceFromPreset('steel', '#112233').color).toBe('#8c9199');
  });

  it('木材は既定樹種(ヒノキ)の地の色になる', () => {
    expect(appearanceFromPreset('wood').color).toBe('#e6cfa5');
    expect(appearanceFromPreset('wood').pattern.kind).toBe('woodGrain');
  });

  it('柄の既定の繰り返し間隔(§2.4.3): エキスパンドメタル12mm・縞鋼板30mm・木目6mm', () => {
    expect(appearanceFromPreset('expandedMetal').pattern.kind).toBe('expandedMetal');
    const expandedMetal = appearanceFromPreset('expandedMetal').pattern;
    expect(expandedMetal.kind === 'expandedMetal' && expandedMetal.spacing.value).toBe(12);

    const checkerPlate = appearanceFromPreset('checkerPlate').pattern;
    expect(checkerPlate.kind === 'checkerPlate' && checkerPlate.spacing.value).toBe(30);

    const wood = appearanceFromPreset('wood').pattern;
    expect(wood.kind === 'woodGrain' && wood.spacing.value).toBe(6);
  });
});

describe('densityMaterialFor', () => {
  it('アルミの外観はアルミの質量材料に対応する(§0.a-0.31)', () => {
    expect(densityMaterialFor('aluminum', null)).toBe('aluminum');
  });

  it('鏡には密度が意味を持たないので null', () => {
    expect(densityMaterialFor('mirror', null)).toBeNull();
  });

  it('既定・自分で決めるも対応する材料が無いので null', () => {
    expect(densityMaterialFor('default', null)).toBeNull();
    expect(densityMaterialFor('custom', null)).toBeNull();
  });

  it('木材は樹種ごとの id(wood-<樹種>)になる', () => {
    expect(densityMaterialFor('wood', 'oak')).toBe('wood-oak');
  });

  it('木材で樹種が無ければ null', () => {
    expect(densityMaterialFor('wood', null)).toBeNull();
  });

  it('鉄板・縞鋼板・エキスパンドメタルはいずれも鋼に対応する', () => {
    expect(densityMaterialFor('steel', null)).toBe('steel');
    expect(densityMaterialFor('checkerPlate', null)).toBe('steel');
    expect(densityMaterialFor('expandedMetal', null)).toBe('steel');
  });
});
