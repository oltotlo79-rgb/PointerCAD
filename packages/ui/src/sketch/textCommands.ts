import { evaluateExpression, expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { analyzeParameters, nextFeatureId, nextFeatureName, parseDisplayInput, textFeature,
  type SketchDocument, type TextFeatureInput, type Vec3, type WorkPlane } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { drawingFont } from '../drawing/drawingFont.js';
import { useAppStore } from '../store/useAppStore.js';

export interface SketchTextInput {
  readonly text: string;
  readonly heightSource: string;
  readonly angleSource: string;
  readonly align: 'start' | 'middle' | 'end';
  readonly origin: Vec3;
  readonly plane: WorkPlane;
}
export type SketchTextOutcome = { readonly ok: true; readonly document: SketchDocument; readonly createdIds: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** 字形を既存の線分・制御点スプラインへ写し、IDは通常の割当処理を通す。 */
export function commitSketchText(document: SketchDocument, input: Omit<TextFeatureInput, 'idPrefix' | 'name'>): SketchTextOutcome {
  if (input.text.trim().length === 0 || input.text.length > 1000) return { ok: false, reason: t('text.error.empty') };
  const result = textFeature({ ...input, idPrefix: 'text-outline', name: t('text.tool') });
  if (!result.ok) return { ok: false, reason: t(result.reason === 'fontUnavailable' ? 'drawing.error.fontFailed'
    : result.reason === 'missingGlyph' ? 'text.error.missingGlyph' : 'text.error.invalid') };
  if (result.features.length === 0) return { ok: false, reason: t('text.error.empty') };
  const added: (typeof result.features[number])[] = [];
  const lastByKind = new Map<string, typeof result.features[number]>();
  const createdIds: string[] = [];
  for (const feature of result.features) {
    // 各種類の初回だけ既存履歴を走査する。以後は直前の最大連番を同じ割当関数へ渡す。
    const last = lastByKind.get(feature.kind);
    const context = last === undefined ? document : { ...document, features: [last] };
    const id = nextFeatureId(context, feature.kind);
    const created = { ...feature, id, name: nextFeatureName(context, feature.kind) };
    lastByKind.set(feature.kind, created); added.push(created);
    createdIds.push(id);
  }
  return { ok: true, document: { ...document, features: [...document.features, ...added] }, createdIds };
}

/** 字体待ちの間も操作を止めない。別文書・別スケッチになった結果は適用しない。 */
export async function applySketchText(input: SketchTextInput): Promise<boolean> {
  const state = useAppStore.getState(), document = state.document, sketch = state.sketch;
  if (state.activeTool !== 'text' || state.workPlaneId !== input.plane.id) return false;
  const isCurrent = (): boolean => {
    const current = useAppStore.getState();
    return current.document === document && current.sketch === sketch && current.workPlaneId === input.plane.id
      && current.activeTool === state.activeTool && current.numericInput === state.numericInput;
  };
  const heightSource = parseDisplayInput(input.heightSource, state.displaySettings.lengthUnit);
  const analysis = analyzeParameters(document.parameters, [heightSource, input.angleSource]);
  const height = evaluateExpression(heightSource, analysis);
  const angle = evaluateExpression(input.angleSource, analysis);
  if (!height.ok || !angle.ok || height.value.value <= 0 || !input.origin.every(Number.isFinite)) {
    state.setShapeError(t('text.error.invalid')); return false;
  }
  state.setShapeError(t('text.status.loadingFont'));
  try {
    const status = await drawingFont.load();
    if (!isCurrent()) return false;
    if (status !== 'ready') { state.setShapeError(t('drawing.error.fontFailed')); return false; }
    const origin: readonly [ExpressionValue, ExpressionValue, ExpressionValue] = [
      expressionValueFromNumber(input.origin[0]), expressionValueFromNumber(input.origin[1]), expressionValueFromNumber(input.origin[2]),
    ];
    const result = commitSketchText(sketch, { text: input.text, height: height.value, angleDegrees: angle.value.value,
      align: input.align, origin, plane: input.plane, outlineText: drawingFont.outline });
    if (!result.ok) { state.setShapeError(result.reason); return false; }
    state.setSketch(result.document);
    state.setShapeError(null);
    state.setActiveTool('select');
    return true;
  } catch {
    if (isCurrent()) state.setShapeError(t('drawing.error.fontFailed'));
    return false;
  }
}
