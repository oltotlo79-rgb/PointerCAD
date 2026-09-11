/** 板金の式・入力単位・上流参照を集約する。表示値の丸めを計算へ戻さない。 */
import { containsLengthUnit, evaluateExpression, type EvaluateOptions, type ExpressionValue } from '@pointercad/expression';
import type { ValueMapper } from '../sketch/mapExpressions.js';
import { parseDisplayInput, type LengthUnit } from '../units/length.js';
import type { SheetBendRuleOverride, SheetMetalFeature, SheetMetalRule } from './types.js';

export type SheetFieldDimension = 'length' | 'angle' | 'ratio';
export type SheetFieldResult = { readonly ok: true; readonly value: ExpressionValue }
  | { readonly ok: false; readonly message: string };

/** Kと角度は表示がinchでも包まない。変数のexact値・無次元分類をそのまま評価器へ渡す。 */
export function evaluateSheetField(source: string, dimension: SheetFieldDimension, unit: LengthUnit, options: EvaluateOptions = {}): SheetFieldResult {
  if (dimension !== 'length' && containsLengthUnit(source)) return { ok: false, message: '角度とK係数には長さの単位を付けないでください。' };
  const savedSource = dimension === 'length' ? parseDisplayInput(source, unit) : source;
  const result = evaluateExpression(savedSource, options);
  return result.ok ? result : { ok: false, message: result.error.message };
}

export interface SheetRuleValues { readonly thickness: number; readonly radius: number; readonly kFactor: number }
export function resolveSheetRule(rule: SheetMetalRule, override?: SheetBendRuleOverride):
  { readonly ok: true; readonly rule: SheetRuleValues } | { readonly ok: false; readonly message: string } {
  const thickness = rule.thickness.value, radius = (override?.innerRadius ?? rule.innerRadius).value;
  const kFactor = (override?.kFactor ?? rule.kFactor).value;
  if (![thickness, radius, kFactor].every(Number.isFinite)) return { ok: false, message: '板金の条件に計算できない値があります。式とパラメータを確認してください。' };
  if (Math.min(thickness, radius) <= 1e-7) return { ok: false, message: '板厚と内半径には幾何許容差を超える正の長さを指定してください。' };
  if (kFactor < 0 || kFactor > 0.5) return { ok: false, message: 'K係数は0以上0.5以下で指定してください。' };
  return { ok: true, rule: { thickness, radius, kFactor } };
}

function mapOverride(rule: SheetBendRuleOverride, map: ValueMapper): SheetBendRuleOverride {
  return { innerRadius: rule.innerRadius === null ? null : map(rule.innerRadius), kFactor: rule.kFactor === null ? null : map(rule.kFactor) };
}
function rebuild(feature: SheetMetalFeature, map: ValueMapper): SheetMetalFeature {
  switch (feature.kind) {
    case 'sheetBase':
      return { ...feature, rule: { thickness: map(feature.rule.thickness), innerRadius: map(feature.rule.innerRadius), kFactor: map(feature.rule.kFactor) } };
    case 'sheetFlange':
      return { ...feature, length: map(feature.length), angle: map(feature.angle), startOffset: map(feature.startOffset), endOffset: map(feature.endOffset), rule: mapOverride(feature.rule, map) };
    case 'sheetBend':
      return { ...feature, angle: map(feature.angle), rule: mapOverride(feature.rule, map) };
    case 'sheetRelief':
      return { ...feature, position: map(feature.position), width: map(feature.width), depth: map(feature.depth) };
  }
}

/** 評価・改名・使用変数の抽出が同じ全フィールドを訪れる。変化なしなら元の参照を返す。 */
export function mapSheetMetalExpressions(feature: Extract<SheetMetalFeature, { kind: 'sheetBase' | 'sheetFlange' | 'sheetBend' | 'sheetRelief' }>, map: ValueMapper): Extract<SheetMetalFeature, { kind: 'sheetBase' | 'sheetFlange' | 'sheetBend' | 'sheetRelief' }>;
export function mapSheetMetalExpressions(feature: SheetMetalFeature, map: ValueMapper): SheetMetalFeature;
export function mapSheetMetalExpressions(feature: SheetMetalFeature, map: ValueMapper): SheetMetalFeature {
  let changed = false;
  const result = rebuild(feature, (value) => {
    const next = map(value); if (next !== value) changed = true; return next;
  });
  return changed ? result : feature;
}

export interface SheetFeatureDependencies {
  readonly bodyIds: readonly string[];
  readonly sketchItems: readonly { readonly sketchId: string; readonly featureId: string }[];
}
/** IDを使って依存を追う。作り直すたびに変わり得るOCCTの面番号は参照にしない。 */
export function sheetFeatureDependencies(feature: SheetMetalFeature): SheetFeatureDependencies {
  switch (feature.kind) {
    case 'sheetBase':
      return { bodyIds: [], sketchItems: [feature.profile, ...feature.holes].map((ref) => ({ sketchId: ref.sketchId, featureId: ref.faceFeatureId })) };
    case 'sheetFlange':
      return { bodyIds: [feature.targetFeatureId], sketchItems: feature.profile === null ? [] : [feature.profile.face, ...feature.profile.holes]
        .map((ref) => ({ sketchId: ref.sketchId, featureId: ref.faceFeatureId })) };
    case 'sheetBend':
      return { bodyIds: [feature.targetFeatureId], sketchItems: [{ sketchId: feature.line.sketchId, featureId: feature.line.lineFeatureId }] };
    case 'sheetRelief':
      return { bodyIds: [feature.targetFeatureId], sketchItems: [] };
  }
}

/** 区切り文字を含む利用者のIDでも衝突しない、順序に依存しないパネルID。 */
export function sheetPanelId(featureId: string, sourceBoundaryId: string | null): string {
  return JSON.stringify(['sheet-panel', featureId, sourceBoundaryId]);
}
