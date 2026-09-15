import { evaluateExpression, type EvaluateOptions, type ExpressionValue } from '@pointercad/expression';
import { DEFAULT_TOOL_DEFAULTS, TOOL_DEFAULT_KEYS, evaluateSheetField, type ToolDefaults } from '@pointercad/model';
import type { CoordinateMode } from '../sketch/numericInputTools.js';
import { asksCoordinate, defaultModeForStep, NUMERIC_INPUT_STEPS, numericDefaultDefinitions,
  rangeErrorFor, STEP_TITLE_KEYS, type NumericFieldDefinition, type NumericInputStep } from '../sketch/numericInput.js';
import { numericDefaultKey, type NumericDefaultSources } from '../sketch/numericDefaultSources.js';
import { t, type MessageKey } from '../i18n/t.js';
import { sheetToolDefaultDefinitions } from '../sheetMetal/sheetMetalDefaultSources.js';
import type { SheetFieldKey } from '../sheetMetal/sheetFields.js';
import { DRAWING_TOOL_DEFAULT_KEYS, drawingDefaultDefinition, drawingDefaultId, type DrawingToolDefaultKey } from '../drawing/drawingToolDefaults.js';

export interface NumericDefaultEntry {
  readonly id: string;
  readonly group: string;
  readonly step?: NumericInputStep;
  readonly mode?: CoordinateMode;
  readonly sheetKey?: SheetFieldKey;
  readonly drawingKey?: DrawingToolDefaultKey;
  readonly unitLabelKey?: MessageKey;
  readonly titleKey: MessageKey;
  readonly fields: readonly NumericFieldDefinition[];
}
let entries: readonly NumericDefaultEntry[] | undefined;
export function numericToolDefaultEntries(): readonly NumericDefaultEntry[] {
  if (entries !== undefined) return entries;
  const result = new Map<string, NumericDefaultEntry>();
  for (const step of NUMERIC_INPUT_STEPS) {
    const modes: readonly CoordinateMode[] = asksCoordinate(step) ? ['absolute', 'relative', 'polar'] : [defaultModeForStep(step)];
    for (const mode of modes) for (const field of numericDefaultDefinitions(step, mode)) {
      const id = numericDefaultKey(step, mode, field.key), previous = result.get(id);
      result.set(id, { id, group: `${step}/${mode}`, step, mode, titleKey: STEP_TITLE_KEYS[step],
        fields: [...(previous?.fields ?? []), field] });
    }
  }
  entries = [...result.values()]; return entries;
}

let allEntries: readonly NumericDefaultEntry[] | undefined;
export function toolDefaultEntries(): readonly NumericDefaultEntry[] {
  if (allEntries !== undefined) return allEntries;
  const sheetEntries: NumericDefaultEntry[] = sheetToolDefaultDefinitions().map(item => ({
    id: item.id,
    group: 'sheetMetal',
    titleKey: 'sheetMetal.title',
    sheetKey: item.key,
    fields: [{ key: item.key, ...item.definition, defaultSource: item.defaultSource }],
  }));
  const drawingEntries: NumericDefaultEntry[] = DRAWING_TOOL_DEFAULT_KEYS.map(drawingKey => {
    const definition = drawingDefaultDefinition(drawingKey);
    return { id: drawingDefaultId(drawingKey), group: `drawing/${definition.titleKey}`, drawingKey,
      titleKey: definition.titleKey, fields: [definition.field],
      ...(definition.unitLabelKey === undefined ? {} : { unitLabelKey: definition.unitLabelKey }) };
  });
  allEntries = [...numericToolDefaultEntries(), ...sheetEntries, ...drawingEntries];
  return allEntries;
}

/** 入力元に応じたパラメータ文脈で式と道具固有の範囲を確認する。 */
export function numericToolDefaultError(entry: NumericDefaultEntry, source: string,
  options: EvaluateOptions = {}): string | null {
  if (source.trim().length === 0 || source.length > 256) return t('settings.toolDefaults.expressionLimit');
  const sheetField = entry.sheetKey === undefined && entry.drawingKey === undefined ? undefined : entry.fields[0];
  const dimension = sheetField?.unit === 'mm' ? 'length' : sheetField?.unit === 'degree' ? 'angle' : 'ratio';
  let value: ExpressionValue;
  if (entry.sheetKey === undefined && entry.drawingKey === undefined) {
    const evaluated = evaluateExpression(source, options);
    if (!evaluated.ok) return evaluated.error.message;
    value = evaluated.value;
  } else {
    const evaluated = evaluateSheetField(source, dimension, 'mm', options);
    if (!evaluated.ok) return evaluated.message;
    value = evaluated.value;
  }
  for (const field of entry.fields) {
    const range = rangeErrorFor({ ...field, source }, value);
    if (range !== null) return range.message;
    if (field.unit === 'count' && !Number.isSafeInteger(value.value)) return t('settings.toolDefaults.integer');
  }
  return null;
}

/** 保存済み値は構文・有限値を確認する。ひな形のパラメータ式は使う文書で評価する。 */
function storedNumericToolDefaultError(entry: NumericDefaultEntry, source: string): string | null {
  if (source.trim().length === 0 || source.length > 256) return t('settings.toolDefaults.expressionLimit');
  const error = numericToolDefaultError(entry, source);
  if (error === null) return null;
  const evaluated = evaluateExpression(source);
  return !evaluated.ok && evaluated.error.code === 'unknownVariable' ? null : error;
}

/** 欠落・不正な設定を部分採用しない。表示テーマなど別の設定は読み手が保持する。 */
export function readNumericToolDefaults(value: unknown): NumericDefaultSources {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const pairs = Object.entries(value);
  if (pairs.length === 0 || pairs.length > 1024) return {};
  const catalog = new Map(toolDefaultEntries().map(entry => [entry.id, entry]));
  const result: Record<string, string> = {};
  let length = 0;
  for (const [id, source] of pairs) {
    const entry = catalog.get(id);
    if (entry === undefined || typeof source !== 'string' || (length += source.length) > 65_536
      || storedNumericToolDefaultError(entry, source) !== null) return {};
    result[id] = source;
  }
  return result;
}

const TEMPLATE_DEFAULT_IDS = {
  extrudeDistance: 'extrudeDistance/absolute/distance', holeDiameter: 'holeSize/absolute/diameter',
  filletRadius: 'filletRadius/absolute/radius', chamferDistance: 'chamferSize/absolute/chamferDistance',
  circleRadius: 'circleRadius/absolute/radius',
} satisfies Record<keyof ToolDefaults, string>;

export function templateToolDefaults(sources: NumericDefaultSources | undefined,
  options: EvaluateOptions): ToolDefaults | null {
  const value = readNumericToolDefaults(sources);
  const result = { extrudeDistance: value[TEMPLATE_DEFAULT_IDS.extrudeDistance] ?? DEFAULT_TOOL_DEFAULTS.extrudeDistance,
    holeDiameter: value[TEMPLATE_DEFAULT_IDS.holeDiameter] ?? DEFAULT_TOOL_DEFAULTS.holeDiameter,
    filletRadius: value[TEMPLATE_DEFAULT_IDS.filletRadius] ?? DEFAULT_TOOL_DEFAULTS.filletRadius,
    chamferDistance: value[TEMPLATE_DEFAULT_IDS.chamferDistance] ?? DEFAULT_TOOL_DEFAULTS.chamferDistance,
    circleRadius: value[TEMPLATE_DEFAULT_IDS.circleRadius] ?? DEFAULT_TOOL_DEFAULTS.circleRadius };
  const catalog = new Map(numericToolDefaultEntries().map(entry => [entry.id, entry]));
  for (const key of TOOL_DEFAULT_KEYS) {
    const entry = catalog.get(TEMPLATE_DEFAULT_IDS[key]);
    if (entry === undefined || numericToolDefaultError(entry, result[key], options) !== null) return null;
  }
  return result;
}

/** ひな形の既存5項目を確認してまとめて配り、それ以外の端末設定を保持する。 */
export function mergeTemplateToolDefaults(current: NumericDefaultSources | undefined, imported: ToolDefaults,
  options: EvaluateOptions): NumericDefaultSources | null {
  const result = { ...readNumericToolDefaults(current) };
  for (const key of TOOL_DEFAULT_KEYS) result[TEMPLATE_DEFAULT_IDS[key]] = imported[key];
  const checked = readNumericToolDefaults(result);
  if (Object.keys(checked).length !== Object.keys(result).length) return null;
  const catalog = new Map(numericToolDefaultEntries().map(entry => [entry.id, entry]));
  for (const key of TOOL_DEFAULT_KEYS) {
    const entry = catalog.get(TEMPLATE_DEFAULT_IDS[key]);
    if (entry === undefined || numericToolDefaultError(entry, imported[key], options) !== null) return null;
  }
  return checked;
}
