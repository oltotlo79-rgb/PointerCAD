import { expressionValueFromNumber as value } from '@pointercad/expression';
import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import type { HoleEntry, HoleFeature } from '../../part/types.js';
import { appendSolid, createEmptyPartDocument } from '../../part/createPartDocument.js';
import { addComponent, createComponentFor } from '../assemblyEdit.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import type { FasteningGeometryContext, FasteningHolePick } from './bindHoleSelection.js';
import type { EntryBoltedJointRequest, EntryHoleSelection } from './holeEntryTypes.js';
import { placement } from './boltedPlacement.testSupport.js';

const ENTRY_REVISIONS = new Map([['a', '1'], ['b', '1']]);

function entryReference(index: number): SubShapeRef {
  return { bodyFeatureId: 'hole', index, fingerprint: { kind: 'face', surfaceKind: 'plane',
    area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null } };
}

function entryAssembly() {
  const empty = createAssemblyDocument('Entry fixture');
  const first = addComponent(empty, createComponentFor(empty, { kind: 'part', partRef: 'a' }));
  return addComponent(first, createComponentFor(first, { kind: 'part', partRef: 'b' }));
}

function entrySelection(first: boolean, x = 0): EntryHoleSelection {
  return { componentId: first ? 'component-1' : 'component-2', sourceKey: first ? 'part:a@1' : 'part:b@1',
    holeFeatureId: 'hole', matingFace: entryReference(10), hole: { kind: 'clearance', diameter: 9, length: first ? 20 : 12 },
    axisOrigin: [x, 0, 0], axisDirection: [0, 0, first ? -1 : 1], matingFaceNormal: [0, 0, first ? 1 : -1] };
}

function entryRequest(): EntryBoltedJointRequest {
  return { first: entrySelection(true), second: entrySelection(false), dimensionSeries: 'annexJA',
    explicitBolt: { nominal: 'M8', threadSeries: 'coarse' }, minimumProtrusion: 0, headWashers: [], nutWashers: [],
    lengthAvailability: [
      { boltRowKey: 'JIS-B-1180:2014:M8:P1.25:annexJA', lengths: [20, 25, 30, 35, 40, 45],
        basis: 'perDiameterEvidence', verified: true, source: 'test fixture (not a standard)' },
      ...['socket-head-cap-screw', 'countersunk-socket-screw'].map(family => ({ boltRowKey: `${family}:M8`,
        lengths: [20, 25, 30, 35, 40, 45], basis: 'globalUnverifiedList' as const, verified: false,
        source: 'user candidates (not standard nominal lengths)' })),
    ] };
}

function entryPick(first: boolean, index = 0): FasteningHolePick {
  return { componentId: first ? 'component-1' : 'component-2', holeFeatureId: 'hole',
    holeFace: entryReference(index), matingFace: entryReference(10) };
}

/** Four bores in one feature. The bore band excludes the entry recess; indices 10/11 are mating/entry planes. */
function entryContext(entry?: HoleEntry, farEntry = false, farOffset = 0): FasteningGeometryContext {
  const feature = (first: boolean): HoleFeature => ({ id: 'hole', name: 'hole', kind: 'hole', suppressed: false,
    targetFeatureId: 'plate', face: entryReference(11), centers: [{ sketchId: 'sketch', pointFeatureId: 'point' }],
    diameter: value(9), depth: { kind: 'through' }, tiltAngle: value(0), tiltAzimuth: value(0),
    ...(first && entry !== undefined ? { entry } : {}) });
  const recess = entry?.kind === 'counterbore' ? entry.depth.value : entry?.kind === 'countersink'
    ? (entry.diameter.value - 9) / (2 * Math.tan(entry.angle.value * Math.PI / 360)) : 0;
  return { document: entryAssembly(), partRevisions: ENTRY_REVISIONS,
    partDocument: component => appendSolid(createEmptyPartDocument(), feature(component.id === 'component-1')),
    resolveFace: (component, ref) => {
      const first = component.id === 'component-1';
      const x = ref.index < 10 ? ref.index * 25 + (first ? 0 : farOffset) : 0;
      if (ref.index >= 10) return { status: 'matched', wall: { status: 'unnamed' }, geometry: {
        kind: 'face', surfaceKind: 'plane', area: 1000, position: [0, 0, ref.index === 10 ? 0 : first ? farEntry ? 0 : -20 : 12],
        axis: [0, 0, 1], radius: null } };
      const span: readonly [number, number] = first ? farEntry ? [-20, -recess] : [-20 + recess, 0] : [0, 12];
      return { status: 'matched', wall: { status: 'hole', origin: { kind: 'hole-face', featureId: 'hole',
        center: { sketchId: 'sketch', producer: { kind: 'point', featureId: `point-${String(ref.index)}` } },
        placement: { kind: 'original' }, stage: 'bore', role: 'wall' } }, geometry: {
        kind: 'face', surfaceKind: 'cylinder', area: 100, position: [x, 0, 0], axis: [0, 0, 1],
        axisOrigin: [x, 0, 0], cylinderSpan: span, radius: 4.5 } };
    } };
}

function translatedEntryContext(distance: number, context: FasteningGeometryContext): FasteningGeometryContext {
  return { ...context, document: { ...context.document, components: context.document.components.map(component =>
    component.id === 'component-2' ? { ...component, placement: placement([distance, 0, 10]) } : component) } };
}

/** A complete scenario: geometry, choices, bound holes and picks share the same four-hole layout. */
export function entryFixture(entry?: HoleEntry, farEntry = false, translation?: number) {
  const local = entryContext(entry, farEntry);
  const context = translation === undefined ? local : translatedEntryContext(translation, local);
  return { context, request: entryRequest(), firstPick: entryPick(true), secondPick: entryPick(false),
    firstSelections: [0, 25, 50, 75].map(x => entrySelection(true, x)),
    secondSelections: [0, 25, 50, 75].map(x => entrySelection(false, x)),
    firstPicks: [0, 1, 2, 3].map(index => entryPick(true, index)),
    secondPicks: [0, 1, 2, 3].map(index => entryPick(false, index)),
    unpairedSecondPick: entryPick(false, 4) };
}
