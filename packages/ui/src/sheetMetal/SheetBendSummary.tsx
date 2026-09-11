import { resolveSheetRule, sheetBendMetrics, sheetStraightLength, type LengthUnit, type SheetMetalFeature, type SheetMetalRule } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { evaluateSheetDraft } from './sheetDraft.js';
import type { SheetFieldKey } from './sheetFields.js';

/** 確定と同じ式評価で寸法基準の換算を表示する。形状計算や文書変更を起こさない。 */
export function SheetBendSummary({ feature, rule, sources, lengthUnit }: {
  readonly feature: SheetMetalFeature; readonly rule: SheetMetalRule | undefined;
  readonly sources: Readonly<Partial<Record<SheetFieldKey, string>>>; readonly lengthUnit: LengthUnit;
}): React.JSX.Element | null {
  const analysis = useAppStore((state) => state.parameterAnalysis), nonLengthVariables = useAppStore((state) => state.nonLengthVariables);
  if (rule === undefined || (feature.kind !== 'sheetFlange' && feature.kind !== 'sheetBend')) return null;
  const result = evaluateSheetDraft(feature, sources, lengthUnit, { variables: analysis.variables, exactVariables: analysis.exactVariables, nonLengthVariables });
  if (!result.ok || (result.feature.kind !== 'sheetFlange' && result.feature.kind !== 'sheetBend')) return null;
  const candidate = result.feature, resolved = resolveSheetRule(rule, candidate.rule); if (!resolved.ok) return null;
  const metrics = sheetBendMetrics({ ...resolved.rule, angle: candidate.angle.value }); if (!metrics.ok) return null;
  const straight = candidate.kind === 'sheetFlange' && candidate.profile === null
    ? sheetStraightLength(candidate.length.value, candidate.lengthBasis, metrics.metrics) : null;
  const text = (value: number) => Number(value.toPrecision(12)).toString();
  return <dl className="pcad-properties pcad-sheet-metal__dimensions" aria-label={t('sheetMetal.convertedDimensions')}>
    <dt className="pcad-properties__key">{t('sheetMetal.bendAllowance')}</dt><dd>{text(metrics.metrics.bendAllowance)} mm</dd>
    <dt className="pcad-properties__key">{t('sheetMetal.bendDeduction')}</dt><dd>{text(metrics.metrics.bendDeduction)} mm</dd>
    {straight === null ? null : <><dt className="pcad-properties__key">{t('sheetMetal.straightLength')}</dt><dd>{text(straight)} mm</dd></>}
  </dl>;
}
