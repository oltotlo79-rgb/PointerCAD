import { drawingDimensionContext } from '@pointercad/model';
import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { fitTolerance, resolveDimensionTolerance, type Dimension, type DimensionTolerance, type DrawingDocument } from '@pointercad/drawing';
import { analyzeParameters, resolveDrawingDimensions } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

export type DrawingToleranceInput =
  | { readonly kind: 'none' }
  | { readonly kind: 'symmetric'; readonly value: string }
  | { readonly kind: 'deviation'; readonly upper: string; readonly lower: string }
  | { readonly kind: 'fit'; readonly symbol: string; readonly showDeviation: boolean };

export interface DrawingDimensionPresentation {
  readonly prefix: string;
  readonly suffix: string;
  readonly reference: boolean;
  readonly basic?: boolean;
  readonly placement: Dimension['placement'];
}

function expression(document: DrawingDocument, source: string): ExpressionValue | null {
  const result = evaluateExpression(source, analyzeParameters(document.parameters, [source]));
  return result.ok ? result.value : null;
}

/** 選択した寸法へ1回のUndoで許容差またははめあいを付ける。値そのものは編集しない。 */
export function applyDrawingTolerance(id: string, input: DrawingToleranceInput, presentation?: DrawingDimensionPresentation, expected?: Dimension): boolean {
  const state = useAppStore.getState();
  const drawing = state.drawing;
  const dimension = drawing?.dimensions.find((item) => item.id === id);
  if (drawing == null || dimension === undefined || state.drawingBusy) return false;
  if (expected !== undefined && (dimension !== expected || !state.drawingSelectedIds.includes(id))) return false;
  const base = { ...dimension };
  if (presentation !== undefined) {
    if (!Number.isFinite(presentation.placement.commonNormalCoordinate)
      || presentation.placement.textPosition?.some((coordinate) => !Number.isFinite(coordinate)) === true
      || [presentation.prefix, presentation.suffix].some((text) => text.length > 100 || [...text].some((character) => character.charCodeAt(0) < 32))) {
      state.setDrawingMessage(t('drawing.error.dimensionPresentationInvalid')); return false;
    }
    Object.assign(base, { reference: presentation.reference, placement: presentation.placement });
    if (presentation.basic === true) base.basic = true; else if (presentation.basic === false) delete base.basic;
    if (presentation.prefix === '') delete base.prefix; else base.prefix = presentation.prefix;
    if (presentation.suffix === '') delete base.suffix; else base.suffix = presentation.suffix;
  }
  delete base.tolerance;
  delete base.fit;
  if (base.basic === true && (input.kind !== 'none' || base.reference)) {
    state.setDrawingMessage(t('drawing.error.basicDimensionConflict')); return false;
  }
  let next: Dimension = base;
  if (input.kind === 'fit') {
    const source = state.drawingSourceResolution;
    if (source === null || !['length', 'diameter'].includes(dimension.kind)) {
      state.setDrawingMessage(t('drawing.error.fitUnavailable')); return false;
    }
    const value = resolveDrawingDimensions({ ...drawing, dimensions: [base] }, drawingDimensionContext(source))[0].value;
    if (value === null || fitTolerance(value, input.symbol) === null) {
      state.setDrawingMessage(t('drawing.error.fitUnavailable')); return false;
    }
    next = { ...base, fit: { symbol: input.symbol, showDeviation: input.showDeviation } };
  } else if (input.kind !== 'none') {
    let tolerance: DimensionTolerance;
    if (input.kind === 'symmetric') {
      const value = expression(drawing, input.value);
      if (value === null) { state.setDrawingMessage(t('drawing.error.toleranceInvalid')); return false; }
      tolerance = { kind: 'symmetric', value };
    } else {
      const upper = expression(drawing, input.upper), lower = expression(drawing, input.lower);
      if (upper === null || lower === null) { state.setDrawingMessage(t('drawing.error.toleranceInvalid')); return false; }
      tolerance = { kind: 'deviation', upper, lower };
    }
    if (resolveDimensionTolerance(tolerance) === null) {
      state.setDrawingMessage(t(input.kind === 'deviation' ? 'drawing.error.toleranceOrder' : 'drawing.error.toleranceInvalid')); return false;
    }
    next = { ...base, tolerance };
  }
  if (JSON.stringify(dimension) === JSON.stringify(next)) return true;
  state.applyDrawing({ ...drawing, dimensions: drawing.dimensions.map((item) => item.id === id ? next : item) });
  state.setDrawingTool('select');
  state.selectDrawingIds([id]);
  return true;
}
