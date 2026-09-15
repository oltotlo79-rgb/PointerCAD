import type { CoordinateMode } from './numericInputTools.js';
import type { NumericFieldDefinition, NumericInputStep } from './numericInput.js';

export type NumericDefaultSources = Readonly<Record<string, string>>;
export function numericDefaultKey(step: NumericInputStep, mode: CoordinateMode, field: string): string {
  return `${step}/${mode}/${field}`;
}

/** 既存の値・クリックした座標・編集中の値には触れず、新しい欄の既定だけを差し替える。 */
export function applyNumericDefaultSources(step: NumericInputStep, mode: CoordinateMode,
  fields: readonly NumericFieldDefinition[], sources: NumericDefaultSources | undefined): readonly NumericFieldDefinition[] {
  if (sources === undefined) return fields;
  return fields.map(field => {
    const key = numericDefaultKey(step, mode, field.key);
    return Object.hasOwn(sources, key) ? { ...field, defaultSource: sources[key] } : field;
  });
}
