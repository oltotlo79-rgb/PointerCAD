import { evaluateExpression, exactExpressionValueFromNumber, expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';

import { appendReference, appendSolid, createEmptyPartDocument } from '../../part/createPartDocument.js';
import type { PartDocument, SteelBendFeatureInput, SweepFeature } from '../../part/types.js';
import { canonicalTextOf } from '../partLibrary.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import { absoluteCoordinate, appendFeature, DEFAULT_FACE_COLOR } from '../../sketch/createSketchDocument.js';
import type { SketchArcFeature, SketchDocument, SketchLineFeature } from '../../sketch/types.js';
import { STEEL_GENERATOR_REVISION, steelLength, steelProductFromSource } from './steelCatalog.js';
import { planSteelBend, steelBendSection, type SteelBendDimensions, type SteelBendGeometry,
  type SteelBendGeometryResult } from './steelBendGeometry.js';
import type { SteelProfileSegment } from './steelSectionProfiles.js';

export type SteelBendResult =
  | { readonly ok: true; readonly document: PartDocument; readonly geometry: SteelBendGeometry }
  | { readonly ok: false; readonly reason: 'unsupportedSource' | 'invalidStockLength' | 'stockLengthMismatch' | 'invalidExpression'
      | Extract<SteelBendGeometryResult, { readonly ok: false }>['reason'] };

export const STEEL_BEND_GENERATOR_REVISION = 'steel-bend-1';

function authoredExpression(value: number, source: string | undefined): ExpressionValue | null {
  if (source === undefined) return exactExpressionValueFromNumber(value);
  const evaluated = evaluateExpression(source);
  return evaluated.ok && evaluated.value.value === value ? evaluated.value : null;
}

function bendInput(source: StandardPartSource, productKey: string, input: SteelBendDimensions): SteelBendFeatureInput | null {
  const radius = authoredExpression(input.radius, input.sources?.radius);
  const angleDegrees = authoredExpression(input.angleDegrees, input.sources?.angleDegrees);
  const firstLeg = authoredExpression(input.firstLeg, input.sources?.firstLeg);
  const secondLeg = authoredExpression(input.secondLeg, input.sources?.secondLeg);
  const directionDegrees = input.directionDegrees === undefined ? undefined
    : authoredExpression(input.directionDegrees, input.sources?.directionDegrees);
  if (radius === null || angleDegrees === null || firstLeg === null || secondLeg === null || directionDegrees === null
    || (input.directionDegrees === undefined && input.sources?.directionDegrees !== undefined)) return null;
  return { id: 'steel-bend-sweep-0', generatorRevision: STEEL_BEND_GENERATOR_REVISION, productKey,
    stockSource: { ...source, options: { ...source.options } },
    radiusConvention: input.radiusConvention, legDimension: input.legDimension,
    radius, angleDegrees, firstLeg, secondLeg,
    ...(directionDegrees === undefined ? {} : { directionDegrees }) };
}

function profileSketch(base: SketchDocument, segments: readonly SteelProfileSegment[], index: number): SketchDocument {
  let sketch: SketchDocument = { ...base, id: `steel-bend-section-${index}`, name: `Steel section ${index}`, features: [] };
  for (const [edge, segment] of segments.entries()) {
    const common = { id: `edge-${edge}`, name: `Edge ${edge}`, planeId: 'xy', construction: false };
    const feature: SketchLineFeature | SketchArcFeature = segment.kind === 'line'
      ? { ...common, kind: 'line', from: absoluteCoordinate(...segment.from, 0), to: absoluteCoordinate(...segment.to, 0) }
      : { ...common, kind: 'arc', center: absoluteCoordinate(...segment.center, 0),
        radius: expressionValueFromNumber(segment.radius),
        startAngle: expressionValueFromNumber(segment.startAngle * 180 / Math.PI),
        endAngle: expressionValueFromNumber(segment.endAngle * 180 / Math.PI) };
    sketch = appendFeature(sketch, feature);
  }
  return appendFeature(sketch, { id: 'section-face', name: 'Section', kind: 'face', planeId: 'xy',
    boundary: segments.map((_, edge) => ({ featureId: `edge-${edge}` })), color: DEFAULT_FACE_COLOR });
}

function pathSketch(base: SketchDocument, geometry: SteelBendGeometry, angle: number): SketchDocument {
  const common = { planeId: geometry.directionDegrees === undefined ? 'xz' : 'steel-bend-plane', construction: false };
  return { ...base, id: 'steel-bend-path', name: 'Steel bend path', features: [
    { ...common, id: 'first-leg', name: 'First tangent leg', kind: 'line',
      from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(...geometry.firstTangent) },
    { ...common, id: 'bend-arc', name: 'Bend radius and angle', kind: 'arc',
      center: absoluteCoordinate(...geometry.arcCentre), radius: expressionValueFromNumber(geometry.centrelineRadiusMm),
      startAngle: expressionValueFromNumber(180), endAngle: expressionValueFromNumber(180 - angle) },
    { ...common, id: 'second-leg', name: 'Second tangent leg', kind: 'line',
      from: absoluteCoordinate(...geometry.secondTangent), to: absoluteCoordinate(...geometry.end) },
  ] };
}

/**
 * Ordinary editable sketches and sweeps, with the authored recipe on the outer sweep.
 * Source length must equal the geometric area-centroid path length so the stock ledger is not silently relabeled.
 * This volume-preserving geometric model does not specify a manufacturing neutral axis or springback.
 */
export function createSteelBend(source: StandardPartSource, input: SteelBendDimensions): SteelBendResult {
  const product = steelProductFromSource(source);
  if (product === undefined || source.generatorRevision !== STEEL_GENERATOR_REVISION) {
    return { ok: false, reason: 'unsupportedSource' };
  }
  const section = steelBendSection(product);
  if (section === null) return { ok: false, reason: 'invalidSection' };
  const plan = planSteelBend(section, input);
  if (!plan.ok) return plan;
  const stockLength = steelLength(source.options.length ?? '1000');
  if (stockLength === null) return { ok: false, reason: 'invalidStockLength' };
  // Numerical equality only, not an extra cutting/stock allowance or a loosened modeling bound.
  if (Math.abs(stockLength.value - plan.geometry.centrelineLengthMm)
    > 1e-9 * Math.max(1, stockLength.value, plan.geometry.centrelineLengthMm)) {
    return { ok: false, reason: 'stockLengthMismatch' };
  }
  const steelBend = bendInput(source, product.key, input);
  if (steelBend === null) return { ok: false, reason: 'invalidExpression' };
  let document = createEmptyPartDocument();
  if (plan.geometry.directionDegrees !== undefined) {
    document = appendReference(document, { id: 'steel-bend-plane', name: 'Steel bend direction',
      kind: 'referencePlane', visible: false,
      plane: { kind: 'tilted', base: 'xz', axis: { kind: 'world', axis: 'z' },
        angle: expressionValueFromNumber(plan.geometry.directionDegrees) } });
  }
  const base = document.sketches[0];
  const profiles = section.loops.map((loop, index) => profileSketch(base, loop, index));
  const path = pathSketch(base, plan.geometry, input.angleDegrees);
  document = { ...document, sketches: [...profiles, path], activeSketchId: path.id,
    name: `${product.materialGrade} ${product.size} bend`,
    steelStockSource: { ...source, options: { ...source.options } } };
  for (const [index, sketch] of profiles.entries()) {
    const sweep: SweepFeature = { id: `steel-bend-sweep-${index}`, name: `Steel sweep ${index}`,
      ...(index === 0 ? { steelBend } : {}),
      kind: 'sweep', suppressed: false, profile: { sketchId: sketch.id, faceFeatureId: 'section-face' },
      path: { sketchId: path.id, curveIds: ['first-leg', 'bend-arc', 'second-leg'] }, frenet: true };
    document = appendSolid(document, sweep);
  }
  if (profiles.length === 2) {
    document = appendSolid(document, { id: 'steel-bend-hollow', name: 'Hollow steel bend', kind: 'boolean',
      suppressed: false, operation: 'subtract', targetFeatureId: 'steel-bend-sweep-0', toolFeatureId: 'steel-bend-sweep-1' });
  }
  return { ok: true, document, geometry: plan.geometry };
}

export type SteelBendInputState =
  | { readonly status: 'missing' }
  | { readonly status: 'original' | 'modified' | 'unsupported'; readonly input: SteelBendFeatureInput };

/** Compare source histories, never saved geometry or a persisted fingerprint. This status is derived, not saved. */
export function steelBendInputState(document: PartDocument): SteelBendInputState {
  const owners = document.solids.filter((feature): feature is SweepFeature => feature.kind === 'sweep' && feature.steelBend !== undefined);
  const owner = owners[0];
  const input = owner?.steelBend;
  if (input === undefined) return { status: 'missing' };
  if (input.generatorRevision !== STEEL_BEND_GENERATOR_REVISION
    || input.stockSource.generatorRevision !== STEEL_GENERATOR_REVISION
    || steelProductFromSource(input.stockSource)?.key !== input.productKey) return { status: 'unsupported', input };
  if (owners.length !== 1 || input.id !== owner.id
    || canonicalTextOf(document.steelStockSource) !== canonicalTextOf(input.stockSource)) return { status: 'modified', input };
  const regenerated = createSteelBend(input.stockSource, {
    radius: input.radius.value, radiusConvention: input.radiusConvention,
    angleDegrees: input.angleDegrees.value, firstLeg: input.firstLeg.value, secondLeg: input.secondLeg.value,
    legDimension: input.legDimension,
    ...(input.directionDegrees === undefined ? {} : { directionDegrees: input.directionDegrees.value }),
    sources: { radius: input.radius.source, angleDegrees: input.angleDegrees.source,
      firstLeg: input.firstLeg.source, secondLeg: input.secondLeg.source,
      ...(input.directionDegrees === undefined ? {} : { directionDegrees: input.directionDegrees.source }) },
  });
  if (!regenerated.ok) return { status: 'modified', input };
  // The outer document's ID, name, units, appearance and view state do not change the generated history.
  const history = (part: PartDocument) => ({ sketches: part.sketches, references: part.references,
    solids: part.solids.map(feature => {
      if (feature.kind !== 'sweep') return feature;
      const sweep = { ...feature };
      delete sweep.steelBend;
      return sweep;
    }), parameters: part.parameters, configurations: part.configurations, activeConfigurationId: part.activeConfigurationId });
  return { status: canonicalTextOf(history(document)) === canonicalTextOf(history(regenerated.document)) ? 'original' : 'modified', input };
}
