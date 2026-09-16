import { createNumericInput, type NumericInputOptions, type NumericInputState,
  type NumericInputStep, type NumericInputToolId } from '../sketch/numericInput.js';
import type { CoordinateMode } from '../sketch/numericInputTools.js';
import { useAppStore } from '../store/useAppStore.js';
import { readNumericToolDefaults } from './numericToolDefaults.js';

/** 道具の開始時だけ現在の設定を写す。編集中の文書や既存の入力値へ適用し直さない。 */
export function createConfiguredNumericInput(tool: NumericInputToolId, step: NumericInputStep,
  mode?: CoordinateMode, options: NumericInputOptions = {}): NumericInputState {
  const sources = Object.freeze(readNumericToolDefaults(useAppStore.getState().displaySettings.numericToolDefaults));
  return createNumericInput(tool, step, mode, { ...options, defaultSources: sources });
}
