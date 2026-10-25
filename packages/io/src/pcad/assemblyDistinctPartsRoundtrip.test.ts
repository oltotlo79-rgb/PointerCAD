/**
 * EX12 real .pcada persistence of 1000 distinct embedded part definitions plus a repeated child assembly with its own
 * mate (UNEXECUTED until Root runs it). Uses the actual bundle writer/reader (writeDocumentBundle/readDocumentBundle,
 * same route as pcadFile.test.ts L136-166) and model resolveAssembly for nested transforms. No kernel geometry: the
 * 1000 parts are box primitives whose dimensions are checked as saved expressions, not as recomputed solids.
 * The size/placement table (sizesOf, positionOf, rotationOf, boxPart) lives in assemblyDistinctPartsFixture.testSupport.ts,
 * shared with the EX12 W01 host fixture; the last describe generates that host fixture with the real kernel.
 */
import { createKernelApi } from '@pointercad/kernel';
import {
  addComponent,
  createAssemblyDocument,
  createAssemblyDocumentBundle,
  createComponentFor,
  createDirectKernelBridge,
  embedPart,
  EMPTY_PART_LIBRARY,
  jointFramePairFromTargets,
  moveComponent,
  partLibraryOfBundle,
  recomputePart,
  resolveAssembly,
  resolveMateTarget,
  solveDrivenJoint,
  solveMates,
  type AssemblyDocument,
  type JointFramePair,
  type Mate,
  type RigidPlacement,
  type SolidBody,
} from '@pointercad/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import {
  boxPart, buildHostAssembly, DISTINCT_PART_COUNT as COUNT, ev, HOST_SHAPE_KINDS, HOST_SLIDER_GROUPS, HOST_TOTAL,
  hostComponentName, hostJointId, hostPositionOf, hostShapeOf, hostStoredRotationOf, placementOf, positionOf, rotationOf,
  sizesOf, storedRotationOf, verifyHostAssembly, withoutDefinition, type HostAssemblyFixture,
} from './assemblyDistinctPartsFixture.testSupport.js';
import { readDocumentBundle, writeDocumentBundle } from './pcadFile.js';

const SAVED_AT = '2026-10-18T00:00:00.000Z';

async function fixture() {
  let library = EMPTY_PART_LIBRARY;
  const refs: string[] = [];
  for (let index = 0; index < COUNT; index += 1) {
    const embedded = await embedPart(library, boxPart(index), `p${String(index)}.pcad`, `p${String(index)}.pcad`);
    library = embedded.library; refs.push(embedded.partRef);
  }
  // Child: definition 0 fixed at the child origin, definition 1 at (4, 0, 0) mated 6 mm away from it.
  let child = createAssemblyDocument('child');
  child = addComponent(child, createComponentFor(child, { kind: 'part', partRef: refs[0] }));
  child = addComponent(child, createComponentFor(child, { kind: 'part', partRef: refs[1] },
    { placement: placementOf([4, 0, 0], [0, 0, 0, 1]) }));
  const [childA, childB] = child.components.map((component) => component.id);
  const childMate: Mate = { id: 'mate-1', name: 'child distance', kind: 'distance',
    a: { kind: 'origin', componentId: childA, element: 'origin' }, b: { kind: 'origin', componentId: childB, element: 'origin' },
    value: ev(6), flipped: false, suppressed: false };
  child = { ...child, components: child.components.map((component, index) => (index === 0 ? { ...component, fixed: true } : component)),
    mates: [childMate] };
  library = { ...library, assemblies: new Map([['child-ref', child]]) };
  let document = createAssemblyDocument('distinct');
  for (let index = 0; index < COUNT; index += 1) {
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: refs[index] },
      { placement: placementOf(positionOf(index), rotationOf(index)) }));
  }
  // Two occurrences of the same child: Rz(90) at (500, 0, 0) and identity at (0, 500, 0).
  document = addComponent(document, createComponentFor(document, { kind: 'subAssembly', assemblyRef: 'child-ref' },
    { placement: placementOf([500, 0, 0], [0, 0, Math.SQRT1_2, Math.SQRT1_2]) }));
  document = addComponent(document, createComponentFor(document, { kind: 'subAssembly', assemblyRef: 'child-ref' },
    { placement: placementOf([0, 500, 0], [0, 0, 0, 1]) }));
  return { library, refs, child, childA, childB, childMate, document };
}

async function saveAndReopen(document: AssemblyDocument, library: Parameters<typeof createAssemblyDocumentBundle>[1]) {
  const bytes = await writeDocumentBundle(createAssemblyDocumentBundle(document, library), { savedAt: SAVED_AT });
  const read = await readDocumentBundle(bytes, 'assembly');
  if (!read.ok || read.bundle.kind !== 'assembly') throw new Error(read.ok ? 'assembly bundle expected' : read.error.message);
  return { bytes, bundle: read.bundle, document: read.bundle.document, library: partLibraryOfBundle(read.bundle) };
}

function expectNear(actual: readonly number[] | undefined, expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, axis) => expect(actual?.[axis]).toBeCloseTo(value, 9));
}

describe('1000 distinct part definitions and a repeated child assembly survive .pcada save, reopen and a move', () => {
  it('keeps every id, definition, dimension, placement, child mate and nested transform', async () => {
    const f = await fixture();
    const reopened = await saveAndReopen(f.document, f.library);
    expect(reopened.document).toEqual(f.document);
    expect(reopened.library.partFiles).toEqual(f.library.partFiles);
    expect(reopened.library.assemblies?.get('child-ref')).toEqual(f.child);
    // Deterministic: the reopened bundle writes the same bytes.
    expect(await writeDocumentBundle(reopened.bundle, { savedAt: SAVED_AT })).toEqual(reopened.bytes);

    for (let index = 0; index < COUNT; index += 1) {
      const component = reopened.document.components[index];
      expect(component.source).toEqual({ kind: 'part', partRef: f.refs[index] });
      expect(component.placement.position.map((value) => value.value)).toEqual([...positionOf(index)]);
      expect(component.placement.rotation).toEqual([...storedRotationOf(index)]);
      // Independent geometric oracle: every one of the 1000 rotations still represents its authored angle.
      expect(2 * Math.atan2(component.placement.rotation[2], component.placement.rotation[3]))
        .toBeCloseTo(index / 1000, 14);
      const part = reopened.library.parts.get(f.refs[index]);
      const solid = part?.solids[0];
      if (part === undefined || solid?.kind !== 'primitive' || solid.shape.kind !== 'box') throw new Error(`definition ${String(index)}`);
      expect(part.id).toBe(`definition-${String(index)}`);
      expect([solid.shape.sizeX.value, solid.shape.sizeY.value, solid.shape.sizeZ.value]).toEqual([...sizesOf(index)]);
      const file = reopened.library.partFiles.find((entry) => entry.ref === f.refs[index]);
      expect(file?.contentHash).toBe(f.library.partFiles.find((entry) => entry.ref === f.refs[index])?.contentHash);
    }
    const reopenedChild = reopened.library.assemblies?.get('child-ref');
    expect(reopenedChild?.mates).toEqual([f.childMate]);
    expect(reopenedChild?.components[0].fixed).toBe(true);

    // Nested authored transforms from the reopened file: world = parent ∘ local (b local (4, 0, 0)).
    const resolved = resolveAssembly(reopened.document, { library: reopened.library, subAssemblies: reopened.library.assemblies });
    expect(resolved.errors).toEqual([]);
    const [first, second] = reopened.document.components.slice(COUNT).map((component) => component.id);
    expectNear(resolved.subAssemblies?.get(first)?.resolved.placements.get(f.childB)?.position, [500, 4, 0]);
    expectNear(resolved.subAssemblies?.get(second)?.resolved.placements.get(f.childB)?.position, [4, 500, 0]);
    expect(resolved.subAssemblies?.get(first)?.resolved.partKeys.get(f.childA)).toBe(f.refs[0]);
    expect(resolved.subAssemblies?.get(second)?.resolved.partKeys.get(f.childA)).toBe(f.refs[0]);
  }, 300_000);

  it('a move of one occurrence after reopen saves only that placement and leaves the opened input unchanged', async () => {
    const f = await fixture();
    const reopened = await saveAndReopen(f.document, f.library);
    const target = reopened.document.components[500];
    const moved = moveComponent(reopened.document, target.id, placementOf([7, 8, 9], [0, 0, 0, 1]));
    // The opened document and its shared child definition are not mutated by the edit.
    expect(reopened.document.components[500].placement.position.map((value) => value.value)).toEqual([...positionOf(500)]);
    expect(moved.components.filter((component, index) => component !== reopened.document.components[index]).map((c) => c.id))
      .toEqual([target.id]);
    const again = await saveAndReopen(moved, reopened.library);
    expect(again.document.components[500].placement.position.map((value) => value.value)).toEqual([7, 8, 9]);
    expect(again.document.components[500].placement.rotation).toEqual([0, 0, 0, 1]);
    for (const index of [0, 499, 501, 999]) {
      expect(again.document.components[index].placement.position.map((value) => value.value)).toEqual([...positionOf(index)]);
    }
    expect(again.library.assemblies?.get('child-ref')).toEqual(f.child);
    expect(again.library.parts.get(f.refs[500])).toEqual(reopened.library.parts.get(f.refs[500]));
    expect(again.document).toEqual(moved);
  }, 300_000);
});

interface GeneratedHost {
  readonly host: HostAssemblyFixture;
  readonly reopened: Awaited<ReturnType<typeof saveAndReopen>>;
  /** Bodies of every definition, each generated once by the real kernel from the reopened file. */
  readonly bodies: ReadonlyMap<string, readonly SolidBody[]>;
}

/**
 * EX12 W01: the host fixture of e2e/tests/assembly1000HostFixture.ts (same size table, kinds box / cylinder / box with a
 * through hole by i % 3) saved and reopened through the bundle, then generated by the real OCCT kernel definition by
 * definition. The verdict is verifyHostAssembly; the expectations come from the closed-form table, not from the solver.
 */
describe('EX12 W01 host fixture: 1000 distinct real shapes from the shared size table', () => {
  // The part-lifetime overload (with releasePart), as in surfaceCutRegeneration.test.ts.
  const createBridge = () => createDirectKernelBridge(createKernelApi(loadOcctForNode));
  let bridge: ReturnType<typeof createBridge> | undefined;
  let generation: Promise<GeneratedHost> | undefined;
  beforeAll(async () => { await loadOcctForNode(); bridge = createBridge(); }, 180_000);
  // The bridge owns kernel state; release it once, even when a test failed.
  afterAll(() => { bridge?.dispose(); bridge = undefined; });

  async function generateHost(): Promise<GeneratedHost> {
    const kernel = bridge;
    if (kernel === undefined) throw new Error('Kernel bridge is not ready');
    const host = await buildHostAssembly();
    const reopened = await saveAndReopen(host.document, host.library);
    const bodies = new Map<string, readonly SolidBody[]>();
    for (const [ref, definition] of reopened.library.parts) {
      try {
        const result = await recomputePart(definition, kernel, { partId: ref });
        if (result.cancelled || result.errors.length > 0) throw new Error(`${ref}: ${JSON.stringify(result.errors)}`);
        bodies.set(ref, result.bodies);
      } finally {
        await kernel.releasePart(ref);
      }
    }
    return { host, reopened, bodies };
  }
  /** Both cases share one generation of the 1000 definitions; either case alone still generates them. */
  const generated = (): Promise<GeneratedHost> => (generation ??= generateHost());
  /**
   * Own limit of the two cases that generate the 1000 definitions (new cases; the file's other limits are unchanged):
   * on this x64-emulated machine the generation alone took 91-133 s and the first case up to about 250 s under load
   * (EX12 W01 runs 20261025-011618 / 012723 / 013623 / 020702 / 022543), so 300 s left too little room.
   */
  const GENERATION_TIMEOUT_MS = 600_000;

  it('counts 1000 definition ids, 1000 generated shapes and 1000 distinct signatures, each on its closed-form volume and XYZ range', async () => {
    const { host, reopened, bodies } = await generated();
    expect(reopened.document).toEqual(host.document);
    expect(reopened.library.partFiles).toEqual(host.library.partFiles);
    expect(HOST_SHAPE_KINDS.map((kind) => host.refs.filter((_, index) => hostShapeOf(index).kind === kind).length))
      .toEqual([334, 333, 333]);
    const resolved = resolveAssembly(reopened.document, { library: reopened.library });
    const evidence = verifyHostAssembly({ document: reopened.document, library: reopened.library, placements: resolved.placements,
      errors: resolved.errors, bodiesOf: (ref) => bodies.get(ref) });
    expect(evidence.problems).toEqual([]);
    expect(evidence.definitionIds.size).toBe(HOST_TOTAL);
    expect(evidence.generatedShapes).toBe(HOST_TOTAL);
    expect(evidence.signatures.size).toBe(HOST_TOTAL);
  }, GENERATION_TIMEOUT_MS);

  it('does not count the same fixture with one definition missing as a success', async () => {
    const { host, reopened, bodies } = await generated();
    const index = 500;
    const missing = withoutDefinition({ ...host, document: reopened.document, library: reopened.library }, index);
    const resolved = resolveAssembly(missing.document, { library: missing.library });
    expect(resolved.placements.size).toBe(HOST_TOTAL);
    expect(resolved.partKeys.size).toBe(HOST_TOTAL - 1);
    const evidence = verifyHostAssembly({ document: missing.document, library: missing.library, placements: resolved.placements,
      errors: resolved.errors, bodiesOf: (ref) => bodies.get(ref) });
    expect(evidence.problems).toEqual([
      `${hostComponentName(index)}: definition ${host.refs[index]} missing`,
      `distinct definition ids: ${String(HOST_TOTAL - 1)} of ${String(HOST_TOTAL)}`,
      `resolve ${missing.document.components[index].id}: missingPart`,
      `definition ids: ${String(HOST_TOTAL - 1)} of ${String(HOST_TOTAL)}`,
      `generated shapes: ${String(HOST_TOTAL - 1)} of ${String(HOST_TOTAL)}`,
      `distinct signatures: ${String(HOST_TOTAL - 1)} of ${String(HOST_TOTAL)}`,
    ]);
    expect(evidence.generatedShapes).toBe(HOST_TOTAL - 1);
  }, GENERATION_TIMEOUT_MS);

  /**
   * The two slider groups of the 1000-component host fixture driven one after the other through the public joint drive
   * (frames from the origin z axes, as attachAssembly.ts builds them). Travel t of a slider is (a.origin - b.origin) . b.z
   * with a = member, b = anchor (assembly1000Fixture.test.ts travel()); both z axes stay world z under a turn about z, so
   * the member goes to its anchor + (0, 0, t). Expectations come from the written table, never from the solver.
   */
  it('drives the two slider groups separately; only the driven member moves and the other 998 keep their placements', async () => {
    const host = await buildHostAssembly();
    const resolved = resolveAssembly(host.document, { library: host.library });
    expect(resolved.errors).toEqual([]);
    const jointFrames = new Map<string, JointFramePair>();
    for (const joint of host.document.joints) {
      const a = resolveMateTarget(joint.a, resolved), b = resolveMateTarget(joint.b, resolved);
      const pair = a.ok && b.ok ? jointFramePairFromTargets(joint, { a: a.target, b: b.target }, resolved.placements) : null;
      if (pair === null) throw new Error(`${joint.id}: no joint frames`);
      jointFrames.set(joint.id, pair);
    }
    const near = (actual: readonly number[] | undefined, expected: readonly number[], tolerance: number): boolean =>
      actual !== undefined && expected.every((value, axis) => Math.abs((actual[axis] ?? Number.NaN) - value) <= tolerance);
    const written = (placements: ReadonlyMap<string, RigidPlacement>, skip: ReadonlySet<number>): string[] =>
      host.document.components.flatMap((component, index) => {
        const placement = placements.get(component.id);
        return skip.has(index) || (near(placement?.position, hostPositionOf(index), 1e-6)
          && near(placement?.rotation, hostStoredRotationOf(index), 1e-9)) ? [] : [hostComponentName(index)];
      });
    // At rest every joint holds: the load-time solve converges and keeps all 1000 written placements.
    const rest = solveMates(host.document, new Map(), resolved.placements, { jointFrames });
    expect(rest.converged).toBe(true);
    expect(written(rest.placements, new Set())).toEqual([]);
    let placements: ReadonlyMap<string, RigidPlacement> = rest.placements;
    const driven = new Set<number>();
    for (const [group, travel] of [[0, 25], [1, 40]] as const) {
      expect(HOST_SLIDER_GROUPS).toContain(group);
      const member = 2 * group + 1;
      const outcome = solveDrivenJoint(host.document, new Map(), placements,
        { jointId: hostJointId(group), coordinate: 'translation', value: travel }, { jointFrames });
      if (!outcome.ok) throw new Error(`${hostJointId(group)}: ${outcome.reason}`);
      expect(outcome.outcome.converged).toBe(true);
      const [x, y, z] = hostPositionOf(member);
      const moved = outcome.placements.get(host.document.components[member].id);
      expect(near(moved?.position, [x, y, z + travel], 1e-6)).toBe(true);
      expect(near(moved?.rotation, hostStoredRotationOf(member), 1e-9)).toBe(true);
      // Every other component keeps exactly the placement it had before this drive.
      const changed = host.document.components.filter((component, index) => index !== member
        && JSON.stringify(outcome.placements.get(component.id)) !== JSON.stringify(placements.get(component.id)));
      expect(changed.map((component) => component.name)).toEqual([]);
      driven.add(member);
      placements = outcome.placements;
    }
    expect(written(placements, driven)).toEqual([]);
    expect(host.document.components.length - driven.size).toBe(998);
  }, 300_000);
});
