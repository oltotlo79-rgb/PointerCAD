/**
 * 材質プリセットの表(FR-1107)と、木材の樹種の表(§0.a-0.5)。
 * 計画書 docs/plans/P5-高度なソリッド・外観と測定.md §2.4.1、タスク1。
 *
 * 色は16進、光沢・粗さ・透過率は 0〜100 の百分率(利用者に見せる単位、rules/04)。
 * three.js へ渡すとき(ui タスク9)に 100 で割って `metalness` / `roughness` /
 * `transmission` にする。この換算は ui 側の責務で、ここには持たない。
 *
 * `default` プリセットは P2 の `createSolidLayer.ts` の単色(`DEFAULT_THEME_COLORS.solid`
 * `0xb8bfcc`、`SOLID_METALNESS = 0.05`、`SOLID_ROUGHNESS = 0.55`。2026-09-05 実測、
 * `packages/ui/src/viewport/themeColors.ts:106` と `createSolidLayer.ts:31-32`。値は
 * 計画書の想定どおり変わっていなかった)そのままにし、外観を割り当てない文書の見た目を
 * P2〜P4 から 1 ドットも変えない(§0.a-0.12)。
 *
 * 密度(木材含む)は自分で知る出典(A5052 は 2.68 g/cm³、黄銅は組成により 8.4〜8.7 g/cm³、
 * 木材の気乾比重は樹種ごとに幅があり、ヒノキ 0.34〜0.54・スギ約0.38・ナラ約0.67・
 * ウォールナット約0.64・チーク0.57〜0.69・メープル0.55〜0.70)と2026-09-05に照合し、
 * 計画書の値はいずれもこの公表範囲の中に収まる。値は変えていない(手順5、rules/02)。
 */

import { expressionValueFromNumber } from '@pointercad/expression';

import type { AppearancePattern, AppearancePresetId, AppearanceSpec, WoodSpecies } from './types.js';

export type { AppearancePresetId, WoodSpecies } from './types.js';

/**
 * 材質プリセット 1 件(§2.4.1)。`AppearanceSpec` と違い、数値は式ではなく素の数(表の値)。
 * `appearanceFromPreset` がここから `ExpressionValue` の `AppearanceSpec` を組み立てる。
 */
export interface MaterialPreset {
  readonly id: AppearancePresetId;
  /** 色(`#rrggbb`)。`colorEditable` が真の材質(プラスチック・自分で決める)は既定値。 */
  readonly color: string;
  /** 光沢 0〜100(→ ui 側で metalness)。 */
  readonly gloss: number;
  /** 粗さ 0〜100(→ ui 側で roughness)。 */
  readonly roughness: number;
  /** 透過率 0〜100(→ ui 側で transmission)。 */
  readonly transmission: number;
  readonly pattern: 'none' | 'expandedMetal' | 'checkerPlate' | 'woodGrain';
  /** 色を利用者が選べるか(プラスチック・自分で決める。FR-1107)。 */
  readonly colorEditable: boolean;
}

/** 木材の樹種 1 件(§0.a-0.5、§2.4.1)。地の色・木目の色・密度を持つ。 */
export interface WoodSpeciesInfo {
  readonly id: WoodSpecies;
  /** 地の色(`#rrggbb`)。 */
  readonly baseColor: string;
  /** 木目の色(`#rrggbb`)。 */
  readonly grainColor: string;
  /** 密度(g/cm³)。質量特性(FR-1101)と共有する(§0.a-0.31)。 */
  readonly density: number;
}

/** 木材 6 樹種(§0.a-0.5、明るい順)。 */
export const WOOD_SPECIES: readonly WoodSpeciesInfo[] = [
  { id: 'hinoki', baseColor: '#e6cfa5', grainColor: '#c9a86f', density: 0.41 },
  { id: 'sugi', baseColor: '#dcc09a', grainColor: '#b8895c', density: 0.38 },
  { id: 'oak', baseColor: '#cbab7d', grainColor: '#9c7a4a', density: 0.68 },
  { id: 'walnut', baseColor: '#6b4a33', grainColor: '#442d1e', density: 0.65 },
  { id: 'teak', baseColor: '#a9793f', grainColor: '#7a5325', density: 0.66 },
  { id: 'maple', baseColor: '#e7d7b4', grainColor: '#c8b083', density: 0.70 },
];

/** 木材プリセットの既定樹種(色と密度の初期値に使う)。 */
const DEFAULT_WOOD_SPECIES: WoodSpecies = 'hinoki';

function woodSpeciesInfo(id: WoodSpecies): WoodSpeciesInfo {
  // WOOD_SPECIES は上で WoodSpecies の 6 通りをすべて列挙しているため、見つからないことはない。
  // 万一に備え、既定樹種(先頭行)へ落とす。
  return WOOD_SPECIES.find((species) => species.id === id) ?? WOOD_SPECIES[0];
}

const DEFAULT_WOOD_INFO = woodSpeciesInfo(DEFAULT_WOOD_SPECIES);

/** 材質プリセット 11 種(§2.4.1)。並びは要件・計画書の表の順。 */
export const MATERIAL_PRESETS: readonly MaterialPreset[] = [
  {
    id: 'default',
    color: '#b8bfcc',
    gloss: 5,
    roughness: 55,
    transmission: 0,
    pattern: 'none',
    colorEditable: false,
  },
  {
    id: 'steel',
    color: '#8c9199',
    gloss: 100,
    roughness: 42,
    transmission: 0,
    pattern: 'none',
    colorEditable: false,
  },
  {
    id: 'checkerPlate',
    color: '#8c9199',
    gloss: 100,
    roughness: 45,
    transmission: 0,
    pattern: 'checkerPlate',
    colorEditable: false,
  },
  {
    id: 'expandedMetal',
    color: '#8c9199',
    gloss: 100,
    roughness: 45,
    transmission: 0,
    pattern: 'expandedMetal',
    colorEditable: false,
  },
  {
    id: 'aluminum',
    color: '#c9ced6',
    gloss: 100,
    roughness: 32,
    transmission: 0,
    pattern: 'none',
    colorEditable: false,
  },
  {
    id: 'stainless',
    color: '#b6bcc4',
    gloss: 100,
    roughness: 18,
    transmission: 0,
    pattern: 'none',
    colorEditable: false,
  },
  {
    id: 'plastic',
    color: '#d94f4f',
    gloss: 0,
    roughness: 40,
    transmission: 0,
    pattern: 'none',
    colorEditable: true,
  },
  {
    id: 'wood',
    color: DEFAULT_WOOD_INFO.baseColor,
    gloss: 0,
    roughness: 65,
    transmission: 0,
    pattern: 'woodGrain',
    colorEditable: false,
  },
  {
    id: 'mirror',
    color: '#f2f4f7',
    gloss: 100,
    roughness: 2,
    transmission: 0,
    pattern: 'none',
    colorEditable: false,
  },
  {
    id: 'glass',
    color: '#eaf2f5',
    gloss: 0,
    roughness: 5,
    transmission: 92,
    pattern: 'none',
    colorEditable: false,
  },
  {
    // プリセットの値を利用者が個別に変えたときの状態(FR-1109)。初期値は「既定」と同じにし、
    // そこから利用者の調整で離れていく。
    id: 'custom',
    color: '#b8bfcc',
    gloss: 5,
    roughness: 55,
    transmission: 0,
    pattern: 'none',
    colorEditable: true,
  },
];

/** 柄ごとの既定の繰り返し間隔(mm、§2.4.3)。ui タスク8のテクスチャの既定と同じ値。 */
const PATTERN_DEFAULT_SPACING: Readonly<Record<'expandedMetal' | 'checkerPlate' | 'woodGrain', number>> = {
  expandedMetal: 12,
  checkerPlate: 30,
  woodGrain: 6,
};

/** id からプリセットを引く。無ければ `undefined`。 */
export function findMaterialPreset(id: AppearancePresetId): MaterialPreset | undefined {
  return MATERIAL_PRESETS.find((preset) => preset.id === id);
}

function patternFor(preset: MaterialPreset): AppearancePattern {
  switch (preset.pattern) {
    case 'none':
      return { kind: 'none' };
    case 'expandedMetal':
      return {
        kind: 'expandedMetal',
        spacing: expressionValueFromNumber(PATTERN_DEFAULT_SPACING.expandedMetal),
      };
    case 'checkerPlate':
      return {
        kind: 'checkerPlate',
        spacing: expressionValueFromNumber(PATTERN_DEFAULT_SPACING.checkerPlate),
      };
    case 'woodGrain':
      return {
        kind: 'woodGrain',
        spacing: expressionValueFromNumber(PATTERN_DEFAULT_SPACING.woodGrain),
        species: DEFAULT_WOOD_SPECIES,
      };
  }
}

/**
 * プリセットから `AppearanceSpec` を組み立てる(FR-1107)。`color` は `colorEditable` な
 * プリセット(プラスチック・自分で決める)のときだけ使う。木材の樹種を変える操作は
 * ui タスク11 の `appearanceCommands.ts` が持つ(`pattern.species` と `color` を
 * 同時に差し替える)。
 */
export function appearanceFromPreset(id: AppearancePresetId, color?: string): AppearanceSpec {
  const preset = findMaterialPreset(id) ?? MATERIAL_PRESETS[0];
  const resolvedColor = preset.colorEditable && color !== undefined ? color : preset.color;
  return {
    preset: preset.id,
    color: resolvedColor,
    transmission: expressionValueFromNumber(preset.transmission),
    gloss: expressionValueFromNumber(preset.gloss),
    roughness: expressionValueFromNumber(preset.roughness),
    pattern: patternFor(preset),
  };
}

/** 既定の外観(P2 の単色そのまま、§0.a-0.4)。起動時の文書と「すべて既定に戻す」で使う。 */
export const DEFAULT_APPEARANCE: AppearanceSpec = appearanceFromPreset('default');

/**
 * 外観プリセットに対応する質量特性(FR-1101)の材料の id(§0.a-0.31)。
 * `densityMaterials.ts` の `DensityMaterial.id` を指す。対応が無い(鏡・ガラスの一部の
 * 用途や、既定・自分で決めるなど)ときは `null`。
 */
const PRESET_DENSITY_MATERIAL: Readonly<Partial<Record<AppearancePresetId, string>>> = {
  steel: 'steel',
  checkerPlate: 'steel',
  expandedMetal: 'steel',
  aluminum: 'aluminum',
  stainless: 'stainless',
  plastic: 'abs',
  glass: 'glass',
};

/**
 * 外観プリセットに対応する質量の材料(§0.a-0.31)。木材は樹種ごとに `wood-<樹種>` を返す
 * (`densityMaterials.ts` の id と一致させる)。対応が無ければ `null`。
 */
export function densityMaterialFor(
  preset: AppearancePresetId,
  species: WoodSpecies | null,
): string | null {
  if (preset === 'wood') {
    return species === null ? null : `wood-${species}`;
  }
  return PRESET_DENSITY_MATERIAL[preset] ?? null;
}
