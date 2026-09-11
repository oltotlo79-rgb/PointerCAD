/** 案内線の候補を作成欄・再編集・確定の3経路で共用する。 */
import type { PartDocument, SketchCurveRef, SweepFeature } from '@pointercad/model';
import { t } from '../i18n/t.js';

export interface SweepGuideCandidate {
  readonly value: string;
  readonly label: string;
  readonly reference: SketchCurveRef;
}

export function sweepGuideValue(reference: SketchCurveRef): string {
  return JSON.stringify([reference.sketchId, ...reference.curveIds]);
}

export function sweepGuideCandidates(document: PartDocument, path?: SketchCurveRef): readonly SweepGuideCandidate[] {
  return document.sketches.flatMap((sketch) => sketch.features.flatMap((feature) => {
    if (feature.kind !== 'line' && feature.kind !== 'arc' && feature.kind !== 'ellipse' && feature.kind !== 'spline'
      && feature.kind !== 'rectangle' && feature.kind !== 'polygon' && feature.kind !== 'slot' && feature.kind !== 'offset') return [];
    if (feature.construction || (path?.sketchId === sketch.id && path.curveIds.includes(feature.id))) return [];
    const reference: SketchCurveRef = { sketchId: sketch.id, curveIds: [feature.id] };
    return [{ value: sweepGuideValue(reference), label: `${sketch.name} / ${feature.name}`, reference }];
  }));
}

/** メニューにない値は採らない。表示時と確定時の文書差し替えにも同じ判定を使う。 */
export function selectedSweepGuide(document: PartDocument, value: string | undefined, path?: SketchCurveRef): SketchCurveRef | null | undefined {
  if (value === undefined || value === 'none') return undefined;
  return sweepGuideCandidates(document, path).find((candidate) => candidate.value === value)?.reference ?? null;
}

export function setSweepGuide(feature: SweepFeature, value: string, document: PartDocument): SweepFeature {
  if (feature.guide !== undefined && value === sweepGuideValue(feature.guide)) return feature;
  const guide = selectedSweepGuide(document, value, feature.path);
  if (guide === null) return feature;
  if (guide !== undefined) return { ...feature, guide };
  const { guide: previous, ...withoutGuide } = feature;
  return previous === undefined ? feature : withoutGuide;
}

/** 保存済みの複数線・参照切れも表示を空欄にしない。新規候補の判定とは分ける。 */
export function sweepGuideDisplayCandidates(document: PartDocument, feature: SweepFeature): readonly SweepGuideCandidate[] {
  const candidates = sweepGuideCandidates(document, feature.path), reference = feature.guide;
  if (reference === undefined) return candidates;
  const value = sweepGuideValue(reference);
  if (candidates.some((candidate) => candidate.value === value)) return candidates;
  const sketch = document.sketches.find((item) => item.id === reference.sketchId);
  const names = reference.curveIds.map((id) => sketch?.features.find((item) => item.id === id)?.name);
  const label = sketch === undefined || names.some((name) => name === undefined)
    ? t('numericInput.sweepGuide.missing') : `${sketch.name} / ${names.join(' → ')}`;
  return [{ value, label, reference }, ...candidates];
}
