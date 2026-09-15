import {
  createEmptyPartDocument,
  createSheetBendFeature,
  createSheetFlangeFeature,
  createSheetReliefFeature,
  defaultSheetMetalRule,
  type SheetMetalFeature,
} from '@pointercad/model';

import type { NumericDefaultSources } from '../sketch/numericDefaultSources.js';
import { SHEET_FIELD_DEFINITIONS, sheetFieldValues, type SheetFieldKey } from './sheetFields.js';

export type SheetMetalDefaultSourceSnapshot = Readonly<Partial<Record<SheetFieldKey, string>>>;

const SHEET_FIELD_KEY_TABLE = {
  sheetThickness: true,
  sheetRadius: true,
  sheetKFactor: true,
  sheetLength: true,
  sheetAngle: true,
  sheetStartOffset: true,
  sheetEndOffset: true,
  sheetReliefPosition: true,
  sheetReliefWidth: true,
  sheetReliefDepth: true,
} satisfies Record<SheetFieldKey, true>;

export const SHEET_DEFAULT_KEYS: readonly SheetFieldKey[] = Object.keys(SHEET_FIELD_KEY_TABLE)
  .filter((key): key is SheetFieldKey => key in SHEET_FIELD_KEY_TABLE);

export function sheetDefaultId(key: SheetFieldKey): string {
  return `sheetMetal/default/${key}`;
}

let defaults: Readonly<Record<SheetFieldKey, string>> | undefined;

/** モデルの作成関数から10欄の従来値を取り出し、同じ数を設定側へ複製しない。 */
export function sheetDefaultSources(): Readonly<Record<SheetFieldKey, string>> {
  if (defaults !== undefined) return defaults;
  const document = createEmptyPartDocument();
  const rule = defaultSheetMetalRule();
  const flange = createSheetFlangeFeature(document, 'default-sheet', []);
  const bend = createSheetBendFeature(document, 'default-sheet', 'default-panel', {
    sketchId: 'default-sketch', lineFeatureId: 'default-line',
  });
  const relief = createSheetReliefFeature(document, 'default-sheet', {
    panelId: 'default-panel', boundaryId: 'default-edge',
  }, rule);
  defaults = Object.freeze({
    sheetThickness: rule.thickness.source,
    sheetRadius: rule.innerRadius.source,
    sheetKFactor: rule.kFactor.source,
    sheetLength: flange.length.source,
    sheetAngle: bend.angle.source,
    sheetStartOffset: flange.startOffset.source,
    sheetEndOffset: flange.endOffset.source,
    sheetReliefPosition: relief.position.source,
    sheetReliefWidth: relief.width.source,
    sheetReliefDepth: relief.depth.source,
  });
  return defaults;
}

export interface SheetToolDefaultDefinition {
  readonly key: SheetFieldKey;
  readonly id: string;
  readonly defaultSource: string;
  readonly definition: (typeof SHEET_FIELD_DEFINITIONS)[SheetFieldKey];
}

/** 設定画面は作成パネルと同じ単位・範囲の正本を読む。 */
export function sheetToolDefaultDefinitions(): readonly SheetToolDefaultDefinition[] {
  const defaults = sheetDefaultSources();
  return SHEET_DEFAULT_KEYS.map(key => ({
    key, id: sheetDefaultId(key), defaultSource: defaults[key], definition: SHEET_FIELD_DEFINITIONS[key],
  }));
}

/** 編集済みの有効欄を除き、新しく使う欄だけへ開始時の端末設定を渡す。 */
export function snapshotSheetMetalDefaultSources(sources: NumericDefaultSources | undefined,
  editing: SheetMetalFeature | undefined): SheetMetalDefaultSourceSnapshot {
  if (sources === undefined) return Object.freeze({});
  const active = new Set(editing === undefined ? [] : sheetFieldValues(editing).map(([key]) => key));
  const result: Partial<Record<SheetFieldKey, string>> = {};
  for (const key of SHEET_DEFAULT_KEYS) {
    const source = sources[sheetDefaultId(key)];
    if (source !== undefined && !active.has(key)) result[key] = source;
  }
  return Object.freeze(result);
}
