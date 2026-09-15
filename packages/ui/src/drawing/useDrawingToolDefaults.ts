import { useState } from 'react';
import { analyzeParameters, evaluateSheetField } from '@pointercad/model';
import { useAppStore } from '../store/useAppStore.js';
import { drawingDefaultDefinition, drawingDefaultText, type DrawingToolDefaultKey } from './drawingToolDefaults.js';

/** 設定と数式の文脈は道具を開いた時点で固定し、入力途中の設定変更で置き換えない。 */
export function snapshotDrawingToolDefaults() {
  const state = useAppStore.getState(), sources = Object.freeze({ ...state.displaySettings.numericToolDefaults });
  const options = analyzeParameters(state.drawing?.parameters ?? state.document.parameters, Object.values(sources));
  return {
    source: (key: DrawingToolDefaultKey) => drawingDefaultText(key, sources, options, 'source'),
    number: (key: DrawingToolDefaultKey, fallback?: number) => drawingDefaultText(key, sources, options, 'number', fallback),
    expression: (key: DrawingToolDefaultKey) => {
      const source = drawingDefaultText(key, sources, options, 'source');
      const dimension = drawingDefaultDefinition(key).field.unit === 'mm' ? 'length' : 'ratio';
      const value = evaluateSheetField(source, dimension, 'mm', options);
      return value.ok ? value.value : { source, value: 0, display: source };
    },
  };
}

export function useDrawingToolDefaults() {
  return useState(snapshotDrawingToolDefaults)[0];
}
