import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import type { SolidBody, SolidEdgeEntry } from '../../kernelBridge/solidContracts.js';
import { appendSolid, createEmptyPartDocument } from '../../part/createPartDocument.js';
import type { PrimitiveFeature } from '../../part/types.js';
import { absoluteCoordinate } from '../../sketch/createSketchDocument.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import type { JointOccurrenceInputs, JointOccurrenceView } from '../jointOccurrence.js';
import { embedPart, EMPTY_PART_LIBRARY } from '../partLibrary.js';
import { resolveAssembly } from '../resolveAssembly.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import type { CircularWeldPathEvidence } from './curvedWeldPath.js';
import { resolveCircularWeldSelection, type CircularWeldSelectionContext } from './circularWeldSelection.js';
import { weldTestBox, weldTestPlacement } from './filletWeld.testSupport.js';

const LEAF = 'leaf/円,"β';
function solved(inputs: JointOccurrenceInputs): JointOccurrenceView {
  return { source: inputs, resolved: resolveAssembly(inputs.document, { library: inputs.library, subAssemblies: inputs.subAssemblies }) };
}
function circle(): SolidEdgeEntry {
  // Analytic native-shaped table for pure selection tests, matching the R2 partial
  // circle of the Root native8 oracle; this fixture does not execute native code.
  return { index: 0, curveKind: 'circle', length: Math.PI, midpoint: [-4 / Math.PI, 4 / Math.PI, 0],
    start: [0, 2, 0], end: [-2, 0, 0], axis: [0, 0, 1], axisOrigin: [0, 0, 0], radius: 2,
    circleBasis: { origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1],
      parameterRange: [Math.PI / 2, Math.PI], orientation: 1 }, segmentOffset: 0, segmentCount: 1 };
}
async function fixture() {
  const feature: PrimitiveFeature = { id: 'extrude-1', name: 'cylinder', kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'cylinder', radius: expressionValueFromNumber(2), height: expressionValueFromNumber(4) } };
  const embedded = await embedPart(EMPTY_PART_LIBRARY, appendSolid(createEmptyPartDocument(), feature), 'circle.pcad', 'circle.pcad',
    { importedAt: '2026-10-16T00:00:00.000Z' });
  const leaf: AssemblyComponent = { id: LEAF, name: 'leaf', source: { kind: 'part', partRef: embedded.partRef },
    placement: DEFAULT_COMPONENT_PLACEMENT, fixed: true, visible: true, suppressed: false };
  const child: AssemblyDocument = { ...createAssemblyDocument('shared child'), components: [leaf] };
  const owner = (id: string): AssemblyComponent => ({ id, name: id, source: { kind: 'subAssembly', assemblyRef: 'child' },
    placement: id === 'A' ? weldTestPlacement([11, 13, 17], [.5, .5, .5, .5]) : weldTestPlacement([100, 0, 0]),
    fixed: true, visible: true, suppressed: false });
  const subAssemblies = new Map([['child', child]]), document = { ...createAssemblyDocument('root'), components: [owner('A'), owner('B')] };
  const inputs: JointOccurrenceInputs = { document, library: { ...embedded.library, assemblies: subAssemblies }, subAssemblies };
  const body: SolidBody = { ...weldTestBox([-2, -2, 0], [2, 2, 4]), bodyKind: 'solid', edges: [circle()] };
  const bodies = new Map<string, readonly SolidBody[]>([[embedded.partRef, [body]]]);
  const context: CircularWeldSelectionContext = { inputs, view: solved(inputs), bodiesOf: occurrence => bodies.get(occurrence.partKey) ?? null };
  const reference: SubShapeRef = { bodyFeatureId: 'extrude-1', index: 0, fingerprint: { kind: 'edge', curveKind: 'circle',
    length: Math.PI, position: [-4 / Math.PI, 4 / Math.PI, 0], axis: [0, 0, 1], radius: 2 } };
  return { context, body, bodies, reference, partRef: embedded.partRef, child, leaf };
}
function must(value: CircularWeldPathEvidence | null): CircularWeldPathEvidence {
  if (value === null) throw new Error('Expected independently specified current circle');
  return value;
}
function at(e: CircularWeldPathEvidence, u: number): Vec3 {
  const coordinate = (i: number): number => e.centerMm[i] + e.radiusMm * (e.xAxis[i] * Math.cos(u) + e.yAxis[i] * Math.sin(u));
  return [coordinate(0), coordinate(1), coordinate(2)];
}
function point(actual: Vec3, expected: Vec3) { expected.forEach((x, i) => expect(actual[i]).toBeCloseTo(x, 12)); }

describe('current world circular weld selection', () => {
  it('resolves real embedded-part/occurrence identities and applies the solved parent placement once', async () => {
    const f = await fixture(), e = must(resolveCircularWeldSelection(f.context, ['A', LEAF], f.reference));
    point(e.centerMm, [11, 13, 17]); point(e.xAxis, [0, 1, 0]); point(e.yAxis, [0, 0, 1]); point(e.normal, [1, 0, 0]);
    point(at(e, Math.PI / 2), [11, 13, 19]); point(at(e, Math.PI), [11, 11, 17]);
    expect(e.radiusMm * (e.parameterRange[1] - e.parameterRange[0])).toBeCloseTo(Math.PI, 12);
    expect(e.parameterRange).toEqual([Math.PI / 2, Math.PI]); expect(e.orientation).toBe(1);
    expect(e.source).toMatchObject({ documentId: f.context.inputs.document.id, ownerId: LEAF,
      occurrencePath: ['A', LEAF], placementKey: JSON.stringify([[11, 13, 17], [.5, .5, .5, .5]]), bodyFeatureId: 'extrude-1', edgeIndex: 0 });
    const file = f.context.inputs.library.partFiles[0];
    expect(e.source.sourceKey).toBe(`part:${f.partRef}@${file.contentHash}:${file.attachmentsDigest}`);
    expect(e.source.bodyKey).toBe(f.context.view.resolved.subAssemblies?.get('A')?.resolved.parts.get(f.partRef)?.steps.find(step => step.featureId === 'extrude-1')?.key);
  });
  it('keeps sibling occurrences of the same leaf separate while sharing the original body table', async () => {
    const f = await fixture(), a = must(resolveCircularWeldSelection(f.context, ['A', LEAF], f.reference));
    const b = must(resolveCircularWeldSelection(f.context, ['B', LEAF], f.reference));
    expect(a.source.sourceKey).toBe(b.source.sourceKey); expect(a.source.bodyKey).toBe(b.source.bodyKey);
    expect(a.source.occurrencePath).toEqual(['A', LEAF]); expect(b.source.occurrencePath).toEqual(['B', LEAF]);
    expect(a.source.placementKey).not.toBe(b.source.placementKey); point(b.centerMm, [100, 0, 0]); point(b.xAxis, [1, 0, 0]);
    point(at(b, Math.PI / 2), [100, 2, 0]); expect(f.bodies.get(f.partRef)?.[0]).toBe(f.body);
  });
  it('retains native raw range and flips only the tangent under reversed orientation', async () => {
    const f = await fixture(), original = circle(), basis = original.circleBasis;
    if (basis === undefined) throw new Error('Basis fixture missing');
    f.bodies.set(f.partRef, [{ ...f.body, edges: [{ ...original, circleBasis: { ...basis, orientation: -1 } }] }]);
    const e = must(resolveCircularWeldSelection(f.context, ['A', LEAF], f.reference));
    expect(e.orientation).toBe(-1); expect(e.parameterRange).toEqual([Math.PI / 2, Math.PI]); point(at(e, Math.PI / 2), [11, 13, 19]);
    const tangent: Vec3 = [-e.orientation * e.xAxis[0], -e.orientation * e.xAxis[1], -e.orientation * e.xAxis[2]];
    point(tangent, [0, 1, 0]); expect(original.start).toEqual([0, 2, 0]);
  });
  it('uses the current match rather than saved fingerprint geometry or the saved index', async () => {
    const f = await fixture(), pick: SubShapeRef = { ...f.reference, index: 99, fingerprint: { kind: 'edge', curveKind: 'circle',
      length: Math.PI + .001, position: [-4 / Math.PI + .001, 4 / Math.PI, 0], axis: [0, 0, 1], radius: 2.001 } };
    const before = JSON.stringify(pick), e = must(resolveCircularWeldSelection(f.context, ['A', LEAF], pick));
    expect(e.radiusMm).toBe(2); expect(e.source.edgeIndex).toBe(0); point(e.centerMm, [11, 13, 17]); expect(JSON.stringify(pick)).toBe(before);
  });
  it('rejects stale document/library/subassembly views before invoking the body lookup', async () => {
    const f = await fixture(); let calls = 0;
    for (const inputs of [{ ...f.context.inputs, document: { ...f.context.inputs.document } },
      { ...f.context.inputs, library: { ...f.context.inputs.library } }, { ...f.context.inputs, subAssemblies: new Map(f.context.inputs.subAssemblies) }]) {
      expect(resolveCircularWeldSelection({ ...f.context, inputs, bodiesOf: () => { calls++; return [f.body]; } }, ['A', LEAF], f.reference)).toBeNull();
    }
    expect(calls).toBe(0);
  });
  it('rejects suppressed or ambiguous leaf occurrences with freshly resolved views', async () => {
    const f = await fixture();
    for (const components of [[{ ...f.leaf, suppressed: true }], [f.leaf, f.leaf]]) {
      const child = { ...f.child, components }, subAssemblies = new Map([['child', child]]);
      const inputs = { ...f.context.inputs, subAssemblies, library: { ...f.context.inputs.library, assemblies: subAssemblies } };
      expect(resolveCircularWeldSelection({ ...f.context, inputs, view: solved(inputs) }, ['A', LEAF], f.reference)).toBeNull();
    }
  });
  it('rejects a duplicate body, missing/invalid body, and an ambiguous current edge rather than choosing an index', async () => {
    const f = await fixture();
    const ambiguous: SolidBody = { ...f.body, edges: [circle(), { ...circle(), index: 1 }] };
    for (const bodies of [null, [], [f.body, f.body], [{ ...f.body, isValid: false }]]) {
      expect(resolveCircularWeldSelection({ ...f.context, bodiesOf: () => bodies }, ['A', LEAF], f.reference)).toBeNull();
    }
    // An existing matching index contributes to the unchanged kernel score. Use
    // an obsolete index so both identical current circles are actually tied.
    expect(resolveCircularWeldSelection({ ...f.context, bodiesOf: () => [ambiguous] }, ['A', LEAF], { ...f.reference, index: 99 })).toBeNull();
  });
  it('rejects non-circles and absent or incomplete metadata without inventing a radius/basis', async () => {
    const f = await fixture(), { circleBasis, ...legacy } = circle();
    if (circleBasis === undefined) throw new Error('Basis fixture missing');
    const incomplete = structuredClone(circleBasis); Reflect.deleteProperty(incomplete, 'normal');
    for (const edge of [legacy, { ...circle(), curveKind: 'line' as const, radius: null }, { ...circle(), circleBasis: incomplete }]) {
      expect(resolveCircularWeldSelection({ ...f.context, bodiesOf: () => [{ ...f.body, edges: [edge] }] }, ['A', LEAF], f.reference)).toBeNull();
    }
  });
  it.each(['nonunit', 'parallel', 'left-handed', 'nonfinite'])( 'rejects %s basis before any normalization', async bad => {
    const f = await fixture(), edge = circle(), basis = edge.circleBasis;
    if (basis === undefined) throw new Error('Basis fixture missing');
    const xAxis: Vec3 = bad === 'nonunit' ? [2, 0, 0] : bad === 'nonfinite' ? [NaN, 0, 0] : [1, 0, 0];
    const yAxis: Vec3 = bad === 'parallel' ? [1, 0, 0] : [0, 1, 0], normal: Vec3 = bad === 'left-handed' ? [0, 0, -1] : [0, 0, 1];
    f.bodies.set(f.partRef, [{ ...f.body, edges: [{ ...edge, circleBasis: { ...basis, xAxis, yAxis, normal } }] }]);
    expect(resolveCircularWeldSelection(f.context, ['A', LEAF], f.reference)).toBeNull();
  });
  it('requires a currently visible/live body step, not any same-named cached body', async () => {
    const f = await fixture(), nested = f.context.view.resolved.subAssemblies?.get('A');
    if (nested === undefined) throw new Error('Resolved child missing');
    const part = nested.resolved.parts.get(f.partRef);
    if (part === undefined) throw new Error('Resolved part missing');
    const resolved = { ...nested.resolved, parts: new Map([[f.partRef, { ...part, steps: part.steps.map(step => ({ ...step, visible: false })) }]]) };
    const view = { ...f.context.view, resolved: { ...f.context.view.resolved, subAssemblies: new Map([['A', { ...nested, resolved }]]) } };
    expect(resolveCircularWeldSelection({ ...f.context, view }, ['A', LEAF], f.reference)).toBeNull();
  });
  it('owns all returned arrays and source strings even when lookup tables and input paths later mutate', async () => {
    const f = await fixture(), path = ['A', LEAF], e = must(resolveCircularWeldSelection(f.context, path, f.reference));
    const before = JSON.stringify(e), basis = f.body.edges[0].circleBasis;
    if (basis === undefined) throw new Error('Basis fixture missing');
    Object.assign(basis.origin, { 0: 999 }); Object.assign(basis.xAxis, { 0: -1 }); Object.assign(basis.parameterRange, { 0: 0 }); path[0] = 'B';
    expect(JSON.stringify(e)).toBe(before); expect(Object.isFrozen(e)).toBe(true); expect(Object.isFrozen(e.source)).toBe(true);
    for (const array of [e.centerMm, e.xAxis, e.yAxis, e.normal, e.parameterRange, e.source.occurrencePath]) expect(Object.isFrozen(array)).toBe(true);
  });
});
