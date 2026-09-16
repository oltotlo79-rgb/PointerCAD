import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import type { AppearancePattern, AppearancePresetId, WoodSpecies } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import type { NumericFieldRange } from '../sketch/numericInput.js';
import type { AppearanceNumberField } from './appearanceCommands.js';

/**
 * 面の塗り色の見本(FR-310、§0.a-0.5)。ここが履歴へ保存する値の正本で、
 * appShell.css の --pcad-swatch-1〜8 は同じ色を見本の下地に使うための写し。
 * 任意色は P2 以降。
 */
export const FACE_COLORS: readonly string[] = [
  '#7aa2f7',
  '#7dcfff',
  '#9ece6a',
  '#e0af68',
  '#f7768e',
  '#bb9af7',
  '#c0caf5',
  '#8c93a3',
];

/* ---------------------------------------------------------------------------
 * 外観(FR-1106〜1110、要件§4.12、計画書 P5 タスク12)
 * ------------------------------------------------------------------------- */

/** 材質プリセットの見出し(§2.4.1、11 種)。id → ja.json のキーの対応はここ 1 か所に置く。 */
export const PRESET_LABEL_KEYS: Readonly<Record<AppearancePresetId, MessageKey>> = {
  default: 'appearance.preset.default',
  steel: 'appearance.preset.steel',
  checkerPlate: 'appearance.preset.checkerPlate',
  expandedMetal: 'appearance.preset.expandedMetal',
  aluminum: 'appearance.preset.aluminum',
  stainless: 'appearance.preset.stainless',
  plastic: 'appearance.preset.plastic',
  wood: 'appearance.preset.wood',
  mirror: 'appearance.preset.mirror',
  glass: 'appearance.preset.glass',
  custom: 'appearance.preset.custom',
};

/** 木材の樹種の見出し(§0.a-0.5、6 種)。 */
export const WOOD_LABEL_KEYS: Readonly<Record<WoodSpecies, MessageKey>> = {
  hinoki: 'appearance.wood.hinoki',
  sugi: 'appearance.wood.sugi',
  oak: 'appearance.wood.oak',
  walnut: 'appearance.wood.walnut',
  teak: 'appearance.wood.teak',
  maple: 'appearance.wood.maple',
};

/** 柄の種類の見出し(FR-1108、4 種)。 */
export const PATTERN_LABEL_KEYS: Readonly<Record<AppearancePattern['kind'], MessageKey>> = {
  none: 'appearance.pattern.none',
  expandedMetal: 'appearance.pattern.expandedMetal',
  checkerPlate: 'appearance.pattern.checkerPlate',
  woodGrain: 'appearance.pattern.woodGrain',
};

/** 柄の選択肢の並び順(FR-1108)。 */
export const PATTERN_KINDS: readonly AppearancePattern['kind'][] = [
  'none',
  'expandedMetal',
  'checkerPlate',
  'woodGrain',
];

/**
 * 柄を「なし」から選んだときの、繰り返しの間隔の既定値(mm)。プリセット経由
 * (model の `appearanceFromPreset`)は柄ごとに違う既定値を使うが、ここは柄だけを直に
 * 選んだときの初期値なので 1 つでよい(選んだ直後に打ち直せる。NFR-UX-4)。
 */
const DEFAULT_PATTERN_SPACING_MM = 10;

/** 柄を「なし」から木目へ選んだときの、樹種の既定値(§0.a-0.5 の表の先頭)。 */
const DEFAULT_WOOD_SPECIES_FOR_PATTERN: WoodSpecies = 'hinoki';

/**
 * 柄の種類だけを差し替える(FR-1108)。間隔・樹種は引き継ぎ、無ければ既定値を補う。
 * 色・光沢・粗さ・プリセットの扱いは呼び出し側(`appearanceWithPattern`)に任せる。
 */
export function patternWithKind(
  current: AppearancePattern,
  kind: AppearancePattern['kind'],
): AppearancePattern {
  if (current.kind === kind) {
    return current;
  }
  if (kind === 'none') {
    return { kind: 'none' };
  }
  const spacing =
    current.kind === 'none'
      ? expressionValueFromNumber(DEFAULT_PATTERN_SPACING_MM)
      : current.spacing;
  if (kind === 'woodGrain') {
    return {
      kind: 'woodGrain',
      spacing,
      species: current.kind === 'woodGrain' ? current.species : DEFAULT_WOOD_SPECIES_FOR_PATTERN,
    };
  }
  return { kind, spacing };
}

/** 柄の間隔だけを差し替える(FR-1108)。「なし」には間隔が無いのでそのまま返す。 */
export function patternWithSpacing(pattern: AppearancePattern, spacing: ExpressionValue): AppearancePattern {
  switch (pattern.kind) {
    case 'none':
      return pattern;
    case 'expandedMetal':
    case 'checkerPlate':
    case 'woodGrain':
      return { ...pattern, spacing };
  }
}

/** 16進として読めるか(`#rrggbb`)。大文字で打っても小文字にそろえる(FR-1109)。 */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function normalizeHexColor(source: string): string | null {
  const trimmed = source.trim();
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** 透過率・光沢・粗さの範囲(0〜100、FR-1109)。`rangeErrorFor` に渡す形だけ揃える。 */
export const PERCENT_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: true,
  max: 100,
  maxInclusive: true,
};

/** 透過率・光沢・粗さの見出しキー(タスク6の表)。 */
export const PERCENT_FIELD_LABEL_KEYS: Readonly<Record<AppearanceNumberField, MessageKey>> = {
  transmission: 'propertyPanel.appearanceTransmission',
  gloss: 'propertyPanel.appearanceGloss',
  roughness: 'propertyPanel.appearanceRoughness',
};

/**
 * 百分率の記号。ASCII の文字なので ja.json へ分けない(i18n.test.ts が禁じるのは日本語の
 * 直書きだけ)。`numericInput.ts` の `FieldUnit` に「%」を増やすのはここだけのために
 * 割に合わないので、`ExpressionField` は使わず自前で組み立てる(範囲判定だけ
 * `rangeErrorFor` を借りる、下の `renderPercentField` の注釈)。
 */
export const PERCENT_SIGN = '%';

/** 打っている途中の外観の欄。式として読めて範囲にも収まるまで確定しない。 */
export interface AppearanceFieldDraft {
  readonly key: 'color' | AppearanceNumberField | 'spacing';
  readonly source: string;
}
