import type { EvaluateOptions } from '@pointercad/expression';
import { evaluateSheetField } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import type { NumericDefaultSources } from '../sketch/numericDefaultSources.js';
import type { NumericFieldDefinition, NumericFieldRange } from '../sketch/numericInput.js';

const positive: NumericFieldRange = { min: 0, minInclusive: false, max: null, maxInclusive: false };
const nonnegative: NumericFieldRange = { ...positive, minInclusive: true };
const textHeight: NumericFieldRange = { ...positive, max: 100, maxInclusive: true };
const symbolHeight: NumericFieldRange = { ...textHeight, min: 1, minInclusive: true };
interface Definition {
  readonly titleKey: MessageKey;
  readonly field: NumericFieldDefinition;
  readonly unitLabelKey?: MessageKey;
}
const entry = (titleKey: MessageKey, key: string, labelKey: MessageKey, defaultSource: string,
  range: NumericFieldRange, unit: NumericFieldDefinition['unit'] = 'mm'): Definition => ({ titleKey,
  field: { key, labelKey, tooltipKey: labelKey, defaultSource, range, unit } });

/** 作成時の既定値。編集済みの値と、用紙・ひな形から継承する書式は呼出し側で優先する。 */
export const DRAWING_TOOL_DEFAULTS = {
  noteHeight: entry('drawing.note.title', 'noteHeight', 'settings.toolDefaults.textHeight', '3.5', textHeight),
  annotationHeight: entry('drawing.tool.annotation', 'annotationHeight', 'settings.toolDefaults.textHeight', '3.5', textHeight),
  roughness: { ...entry('drawing.tool.annotation', 'roughness', 'settings.toolDefaults.roughness', '3.2', nonnegative, 'ratio'),
    unitLabelKey: 'settings.toolDefaults.micrometre' },
  gdtHeight: entry('drawing.gdt.title', 'gdtHeight', 'settings.toolDefaults.textHeight', '3.5', symbolHeight),
  gdtTolerance: entry('drawing.gdt.title', 'gdtTolerance', 'drawing.gdt.value', '0.05', nonnegative),
  datumHeight: entry('drawing.gdt.datum', 'datumHeight', 'settings.toolDefaults.textHeight', '3.5', symbolHeight),
  weldHeight: entry('drawing.weld.title', 'weldHeight', 'settings.toolDefaults.textHeight', '3.5', symbolHeight),
  weldSize: entry('drawing.weld.title', 'weldSize', 'drawing.weld.size.leg', '5', positive),
  tableRowHeight: entry('drawing.table.title', 'tableRowHeight', 'settings.toolDefaults.rowHeight', '7', positive),
  tableTextHeight: entry('drawing.table.title', 'tableTextHeight', 'settings.toolDefaults.textHeight', '3.5', positive),
  layerWidth: entry('drawing.property.layer', 'layerWidth', 'settings.toolDefaults.lineWidth', '0.25', positive),
  seriesOffset: entry('drawing.series.title', 'seriesOffset', 'settings.toolDefaults.seriesOffset', '8', nonnegative),
} satisfies Record<string, Definition>;

export type DrawingToolDefaultKey = keyof typeof DRAWING_TOOL_DEFAULTS;
export const DRAWING_TOOL_DEFAULT_KEYS = Object.keys(DRAWING_TOOL_DEFAULTS)
  .filter((key): key is DrawingToolDefaultKey => key in DRAWING_TOOL_DEFAULTS);
export const drawingDefaultId = (key: DrawingToolDefaultKey): string => `drawing/default/${key}`;
export const drawingDefaultDefinition = (key: DrawingToolDefaultKey): Definition => DRAWING_TOOL_DEFAULTS[key];

/** 式を保存する欄は原式、従来numberを保存する書式欄は丸めず評価した数値を初期表示する。 */
export function drawingDefaultText(key: DrawingToolDefaultKey, sources: NumericDefaultSources,
  options: EvaluateOptions, mode: 'source' | 'number', fallback?: number): string {
  const definition = drawingDefaultDefinition(key), configured = sources[drawingDefaultId(key)];
  const source = configured ?? (fallback === undefined ? definition.field.defaultSource : String(fallback));
  if (mode === 'source') return source;
  const evaluated = evaluateSheetField(source, definition.field.unit === 'mm' ? 'length' : 'ratio', 'mm', options);
  // 利用文書にない変数等は入力欄へ残し、元の値へ黙って差し替えない。
  return evaluated.ok ? String(evaluated.value.value) : source;
}
