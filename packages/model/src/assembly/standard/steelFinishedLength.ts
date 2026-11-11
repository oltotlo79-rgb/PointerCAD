import { evaluateExpression } from '@pointercad/expression';
import type { PartDocument } from '../../part/types.js';
import type { CoordinateInput, SketchFeature } from '../../sketch/types.js';
import { canonicalPartDocumentText } from '../partLibrary.js';
import type { StandardPartSource } from '../resolveAssembly.js';
import { buildStandardPartFromSource } from './buildStandardPart.js';
import { createSteelBend } from './steelBend.js';
import { planSteelBend, steelBendSection, type SteelBendDimensions } from './steelBendGeometry.js';
import { steelLength, steelProductFromSource } from './steelCatalog.js';

/** Any valid bend: the geometric inputs of the section sketches, sweeps, hollow boolean and plane reference do not depend on
 * the radius, angle or legs, so this regenerates everything except the path from the actual source. */
const BEND_PROBE: SteelBendDimensions = { radius: 1000, radiusConvention: 'inside', angleDegrees: 90,
  firstLeg: 100, secondLeg: 100, legDimension: 'tangent' };
const BEND_PATH = 'steel-bend-path';

function absolutePoint(input: CoordinateInput): readonly [number, number, number] | null {
  return input.mode === 'absolute' ? [input.x.value, input.y.value, input.z.value] : null;
}
function segmentLength(feature: SketchFeature | undefined): number | null {
  if (feature?.kind !== 'line') return null;
  const from = absolutePoint(feature.from), to = absolutePoint(feature.to);
  return from === null || to === null ? null : Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
}

/** Proof for an unmachined createSteelBend part: everything except the line/arc/line path equals the bend regenerated
 * from the same source, the path is the line/arc/line that planSteelBend gives for its own tangent legs, centreline
 * radius and turn (start, end, arc centre and every expression a plain literal of its stored number), and the saved
 * centroid path is the purchased length (createSteelBend's own 1e-9 equality).
 * Any extra feature, edited section, reference or path, or a length mismatch stays unavailable. */
function bentFinishedLength(document: PartDocument, source: StandardPartSource): number | null {
  const product = steelProductFromSource(source);
  const section = product === undefined ? null : steelBendSection(product);
  const stock = steelLength(source.options.length ?? '1000');
  if (section === null || stock === null) return null;
  const reference = document.references[0];
  const directionDegrees = reference?.kind === 'referencePlane' && reference.plane.kind === 'tilted' ? reference.plane.angle.value : undefined;
  const dimensions = { ...BEND_PROBE, ...(directionDegrees === undefined ? {} : { directionDegrees }) };
  const plan = planSteelBend(section, dimensions);
  if (!plan.ok) return null;
  const probe = createSteelBend({ ...source, options: { ...source.options, length: String(plan.geometry.centrelineLengthMm) } }, dimensions);
  if (!probe.ok) return null;
  const path = document.sketches.find(sketch => sketch.id === BEND_PATH);
  const probePath = probe.document.sketches.find(sketch => sketch.id === BEND_PATH);
  if (path === undefined || probePath === undefined) return null;
  // Authored recipes differ between the real bend and this fixed geometric probe.
  // Exclude only that source metadata; keep every geometric feature and reference in the proof.
  const geometricSolids = (part: PartDocument) => part.solids.map(feature => {
    if (feature.kind !== 'sweep') return feature;
    const sweep = { ...feature };
    delete sweep.steelBend;
    return sweep;
  });
  const actualInputs = { ...probe.document, references: document.references, solids: geometricSolids(document),
    sketches: document.sketches.map(sketch => sketch.id === BEND_PATH ? probePath : sketch), parameters: document.parameters,
    configurations: document.configurations, activeConfigurationId: document.activeConfigurationId };
  if (canonicalPartDocumentText(actualInputs)
    !== canonicalPartDocumentText({ ...probe.document, solids: geometricSolids(probe.document) })) return null;
  const shape = (features: readonly SketchFeature[]) => JSON.stringify(features.map(feature => [feature.id, feature.kind, feature.planeId]));
  if (shape(path.features) !== shape(probePath.features)
    || JSON.stringify({ ...path, features: [] }) !== JSON.stringify({ ...probePath, features: [] })) return null;
  const [first, arc, second] = path.features;
  if (first?.kind !== 'line' || second?.kind !== 'line' || arc?.kind !== 'arc' || arc.startAngle.value !== 180) return null;
  const turn = arc.startAngle.value - arc.endAngle.value;
  const firstLength = segmentLength(first), secondLength = segmentLength(second);
  if (firstLength === null || secondLength === null || !(turn > 0 && turn < 180) || !(arc.radius.value > 0)) return null;
  const centreline = firstLength + arc.radius.value * turn * Math.PI / 180 + secondLength;
  // Numerical equality only (12-digit saved expressions), exactly createSteelBend's stock-length rule, not a tolerance.
  const equal = (a: number, b: number, scale: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, scale);
  if (!Number.isFinite(centreline) || !equal(centreline, stock.value, Math.max(stock.value, centreline))) return null;
  // The lengths and the arc alone do not fix where the pieces are: a reversed or moved leg, a moved arc centre or a
  // kinked second leg keep them. So the whole path must be the one planSteelBend produces for these tangent legs, this
  // centreline radius (inside radius = centreline minus the section's own inside offset) and this turn.
  const insideOffset = plan.geometry.centrelineRadiusMm - plan.geometry.insideRadiusMm;
  const rebuilt = planSteelBend(section, { radius: arc.radius.value - insideOffset, radiusConvention: 'inside', angleDegrees: turn,
    firstLeg: firstLength, secondLeg: secondLength, legDimension: 'tangent', ...(directionDegrees === undefined ? {} : { directionDegrees }) });
  if (!rebuilt.ok) return null;
  const geometry = rebuilt.geometry;
  const literal = (value: { readonly source: string; readonly value: number }, scale: number): boolean => {
    const evaluated = evaluateExpression(value.source);
    return evaluated.ok && Number.isFinite(evaluated.value.value) && equal(evaluated.value.value, value.value, scale);
  };
  const saved = [first.from, first.to, arc.center, second.from, second.to];
  const expected = [[0, 0, 0], geometry.firstTangent, geometry.arcCentre, geometry.secondTangent, geometry.end] as const;
  for (const [index, input] of saved.entries()) {
    const point = absolutePoint(input);
    if (point === null || input.mode !== 'absolute' || ![input.x, input.y, input.z].every(value => literal(value, stock.value))) return null;
    if (!point.every((value, axis) => equal(value, expected[index][axis], stock.value))) return null;
  }
  if (!literal(arc.radius, stock.value) || !literal(arc.startAngle, 180) || !literal(arc.endAngle, 180)
    || !equal(arc.radius.value, geometry.centrelineRadiusMm, stock.value)) return null;
  return stock.value;
}

/** Proof for the generator's +Z stock and a single chain of transverse XY cuts, or an unmachined createSteelBend part.
 * Unknown references, oblique cuts, branches, both-side cuts and other machining stay unavailable.
 * No fingerprints/meshes are used as authoritative geometry.
 */
export function steelFinishedLength(document: PartDocument, source: StandardPartSource): number | null {
  const first = document.solids[0];
  const length = first?.kind === 'primitive' && first.shape.kind === 'cylinder' ? first.shape.height
    : first?.kind === 'extrude' ? first.distance : undefined;
  if (length === undefined) return first?.kind === 'sweep' ? bentFinishedLength(document, source) : null;
  const generated = buildStandardPartFromSource({ ...source, options: { ...source.options, length: length.source } });
  if (generated === null) return null;
  const prefix = document.solids.slice(0, generated.solids.length);
  const actualInputs = { ...generated, sketches: document.sketches, references: document.references,
    solids: prefix, parameters: document.parameters, configurations: document.configurations,
    activeConfigurationId: document.activeConfigurationId };
  if (canonicalPartDocumentText(actualInputs) !== canonicalPartDocumentText(generated)) return null;
  if (new Set(document.solids.map(feature => feature.id)).size !== document.solids.length) return null;
  let target = generated.solids.at(-1)?.id;
  if (target === undefined) return null;
  let low = 0, high = length.value;
  for (const feature of document.solids.slice(generated.solids.length)) {
    if (feature.kind !== 'cut') return null;
    if (feature.suppressed) continue;
    // PlaneSpec workPlane/xy: canonical normal is +Z and offset is signed along it.
    if (feature.targetFeatureId !== target || feature.pairedWith !== null
      || feature.plane.kind !== 'workPlane' || feature.plane.planeId !== 'xy') return null;
    const offset = evaluateExpression(feature.plane.offset.source);
    if (!offset.ok || !Number.isFinite(offset.value.value) || offset.value.value !== feature.plane.offset.value) return null;
    if (feature.keep === 'positive') low = Math.max(low, offset.value.value);
    else high = Math.min(high, offset.value.value);
    if (!(high > low)) return null; // Empty/failed geometry is not silently accepted as a finished part.
    target = feature.id;
  }
  return high - low;
}
