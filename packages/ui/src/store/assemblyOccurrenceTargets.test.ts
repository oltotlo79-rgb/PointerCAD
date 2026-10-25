import { beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate, appendSolid, createAssemblyDocument, createEmptyPartDocument, embedPart, EMPTY_PART_LIBRARY,
  resolveAssembly, type AssemblyComponent, type AssemblyDocument, type ComponentSource, type JointOccurrenceInputs,
  type Placement, type PrimitiveFeature, type Quaternion, type SolidBody, type SubShapeRef, type Vec3,
} from '@pointercad/model';
import { subShapeRefOf } from '../solid/subShapeSelection.js';
import { currentOccurrenceDrive, jointValueKey, occurrenceTargetOptions } from './assemblyOccurrenceDriveSlice.js';
import { resetTestStore } from './testing/createTestStore.js';
import { useAppStore } from './useAppStore.js';

/*
 * Face targets of a child joint inside a subassembly placement. The child (fixed base + free arm, same 4 mm box part) has
 * a slider between the top faces (+z, centroid (2, 2, 4)) of arm and base; the parent places it as A turned 90 degrees
 * about z at (10, 20, 0) and as B at (0, 0, 10). The body is a hand-made box like attachAssembly.test.ts; positions are
 * written by hand. Fixture times are historical fixture data, not an execution clock.
 */
const HALF = Math.SQRT1_2;
const TURN_Z: Quaternion = [0, 0, HALF, HALF];
const SLIDE = 'child-face-slide';
const FEATURE = 'solid-1';

function placement(x: number, y: number, z: number, rotation: Quaternion = [0, 0, 0, 1]): Placement {
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation };
}
function component(id: string, source: ComponentSource, at: Placement = placement(0, 0, 0), fixed = false): AssemblyComponent {
  return { id, name: id, source, placement: at, fixed, visible: true, suppressed: false };
}

function body(featureId: string, size: number): SolidBody {
  const box = new THREE.BoxGeometry(size, size, size);
  box.translate(size / 2, size / 2, size / 2);
  const edges = new THREE.EdgesGeometry(box);
  const directions: readonly Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  try {
    const indices = box.getIndex();
    if (indices === null) throw new Error('fixture');
    return { featureId, volume: size ** 3, isValid: true, edges: [], vertices: [], threadMarks: [],
      faces: directions.map((axis, index) => ({ index, surfaceKind: 'plane', area: size * size,
        centroid: [(axis[0] + 1) * size / 2, (axis[1] + 1) * size / 2, (axis[2] + 1) * size / 2],
        axis, radius: null, triangleOffset: index * 2, triangleCount: 2 })),
      mesh: { positions: new Float32Array(box.getAttribute('position').array), normals: new Float32Array(box.getAttribute('normal').array),
        indices: new Uint32Array(indices.array), edgePositions: new Float32Array(edges.getAttribute('position').array), triangleCount: 12 } };
  } finally { edges.dispose(); box.dispose(); }
}

function topFace(): SubShapeRef {
  const reference = subShapeRefOf([body(FEATURE, 4)], `${FEATURE}#face:4`);
  if (reference === null) throw new Error('fixture face');
  return reference;
}

/** Publishes the view with the given current part bodies (by part key); the documents are the same in every case. */
async function publish(bodiesOf: (partRef: string) => ReadonlyMap<string, readonly SolidBody[]>): Promise<{ readonly partRef: string }> {
  const size = expressionValueFromNumber(4);
  const box: PrimitiveFeature = { id: FEATURE, name: 'box', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size } };
  const embedded = await embedPart(EMPTY_PART_LIBRARY, appendSolid(createEmptyPartDocument(), box), 'plate.pcad', 'plate.pcad',
    { importedAt: '2026-01-01T00:00:00.000Z' });
  const part = { kind: 'part', partRef: embedded.partRef } as const;
  const face = topFace();
  const child: AssemblyDocument = { ...createAssemblyDocument('face child'),
    components: [component('base', part, placement(0, 0, 0), true), component('arm', part)],
    joints: [{ id: SLIDE, name: SLIDE, kind: 'slider', a: { kind: 'subShape', componentId: 'arm', ref: face },
      b: { kind: 'subShape', componentId: 'base', ref: face }, minValue: null, maxValue: null, suppressed: false }] };
  const subAssemblies = new Map([['child', child]]);
  const library = { ...embedded.library, assemblies: subAssemblies };
  const document: AssemblyDocument = { ...createAssemblyDocument('parent'), components: [
    component('A', { kind: 'subAssembly', assemblyRef: 'child' }, placement(10, 20, 0, TURN_Z)),
    component('B', { kind: 'subAssembly', assemblyRef: 'child' }, placement(0, 0, 10)),
  ] };
  useAppStore.getState().openAssembly(document, library);
  const source: JointOccurrenceInputs = { document, library, subAssemblies };
  useAppStore.setState({ assemblyView: { sourceDocument: document, source, resolved: resolveAssembly(document, { library, subAssemblies }),
    bodies: bodiesOf(embedded.partRef), appearances: new Map(), diagnosis: null, mateTargetErrors: new Map(), mateTargets: new Map(),
    jointFrames: new Map() } });
  return { partRef: embedded.partRef };
}

beforeEach(() => { resetTestStore(); });

describe('face targets of flexible subassembly joints', () => {
  it('re-selects the child face on the current part body, like the top-level targets', () => {
    const options = occurrenceTargetOptions(new Map([['part-key', [body(FEATURE, 4)]]]));
    const geometry = options.subShape?.('part-key', topFace());
    if (geometry?.kind !== 'face') throw new Error('face geometry');
    expect([geometry.position, geometry.axis]).toEqual([[2, 2, 4], [0, 0, 1]]);
    // No body for the part key, or no body of the saved feature: nothing is invented.
    expect(options.subShape?.('other-key', topFace())).toBeNull();
    expect(occurrenceTargetOptions(new Map([['part-key', [body('other-feature', 4)]]])).subShape?.('part-key', topFace())).toBeNull();
  });

  it('solves a face-to-face child slider in one placement only instead of refusing it', async () => {
    await publish(partRef => new Map([[partRef, [body(FEATURE, 4)]]]));
    const document = useAppStore.getState().assembly;
    expect(useAppStore.getState().driveAssemblyOccurrenceJoint(['A'], SLIDE, 'translation', 5)).toBe(true);
    const state = useAppStore.getState();
    const drive = currentOccurrenceDrive(state, ['A']);
    const arm: Vec3 = drive?.placements.get('arm')?.position ?? [Number.NaN, Number.NaN, Number.NaN];
    // Independent pose: A is at (10, 20, 0) turned 90 degrees about z and the arm slides 5 along the face normal (child z),
    // so the arm origin is (10, 20, 0) + R(0, 0, 5) = (10, 20, 5). The solver stops at the first iterate inside its row
    // tolerances (solveRigid.ts: 1e-9 mm per length row, 1e-9 rad per angle row) and the face frame is at the centroid
    // (2, 2, 4), so an allowed rotation residual w also moves the arm origin by w x (2, 2, 4): at most |w| * sqrt(24) mm.
    const contract = 1e-9 + Math.sqrt(3) * 1e-9 * Math.hypot(2, 2, 4);
    const expected: Vec3 = [10, 20, 5];
    for (const axis of [0, 1, 2] as const) expect(Math.abs(arm[axis] - expected[axis])).toBeLessThan(contract);
    // The shown slider value is the driver row itself (|value - 5| < 1e-9 mm, without the lever).
    expect(Math.abs((drive?.values.get(jointValueKey(SLIDE, 'translation')) ?? Number.NaN) - 5)).toBeLessThan(1e-9);
    // The fixed base is not a solver variable: it stays where placement A puts the child origin.
    const base: Vec3 = drive?.placements.get('base')?.position ?? [Number.NaN, Number.NaN, Number.NaN];
    expect(base[0]).toBeCloseTo(10, 9);
    expect(base[1]).toBeCloseTo(20, 9);
    expect(base[2]).toBeCloseTo(0, 9);
    // Only placement A holds a drive; B, the second placement of the same child, is untouched.
    expect(state.assemblyOccurrenceDrives.size).toBe(1);
    expect(currentOccurrenceDrive(state, ['B'])).toBeUndefined();
    expect(state.assembly).toBe(document);
  });

  it('keeps refusing when the face geometry is missing from the view', async () => {
    await publish(() => new Map());
    expect(useAppStore.getState().driveAssemblyOccurrenceJoint(['A'], SLIDE, 'translation', 5)).toBe(false);
    expect(useAppStore.getState().assemblyOccurrenceDrives.size).toBe(0);
    await publish(partRef => new Map([[partRef, [body('other-feature', 4)]]]));
    expect(useAppStore.getState().driveAssemblyOccurrenceJoint(['A'], SLIDE, 'translation', 5)).toBe(false);
    expect(useAppStore.getState().assemblyOccurrenceDrives.size).toBe(0);
  });
});
