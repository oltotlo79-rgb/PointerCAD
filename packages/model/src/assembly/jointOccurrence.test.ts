import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { appendSolid, createEmptyPartDocument } from '../part/createPartDocument.js';
import type { PrimitiveFeature } from '../part/types.js';
import { absoluteCoordinate } from '../sketch/createSketchDocument.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from './createAssemblyDocument.js';
import { jointOccurrencePath, resolveJointOccurrence, type JointOccurrenceInputs,
  type JointOccurrenceView } from './jointOccurrence.js';
import { embedPart, EMPTY_PART_LIBRARY } from './partLibrary.js';
import { applyPlacementToDirection, applyPlacementToPoint, type Quaternion, type RigidPlacement } from './placementMath.js';
import { resolveAssembly } from './resolveAssembly.js';
import type { AssemblyComponent, AssemblyDocument, ComponentSource, Placement } from './types.js';

const HALF = Math.SQRT1_2;
const TURN_Z: Quaternion = [0, 0, HALF, HALF];
const TURN_X: Quaternion = [HALF, 0, 0, HALF];

function placement(x: number, y: number, z: number, rotation: Quaternion = [0, 0, 0, 1]): Placement {
  return { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation };
}

function component(id: string, source: ComponentSource,
  at: Placement = DEFAULT_COMPONENT_PLACEMENT): AssemblyComponent {
  return { id, name: id, source, placement: at, fixed: false, visible: true, suppressed: false };
}

function assembly(components: readonly AssemblyComponent[]): AssemblyDocument {
  return { ...createAssemblyDocument('test assembly'), components };
}

function view(source: JointOccurrenceInputs): JointOccurrenceView {
  return { source, resolved: resolveAssembly(source.document,
    { library: source.library, subAssemblies: source.subAssemblies }) };
}

async function fixture(leafId = 'plate', aId = 'A', bId = 'B') {
  const size = expressionValueFromNumber(4);
  const box: PrimitiveFeature = { id: 'solid-1', name: 'box', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size } };
  const part = appendSolid(createEmptyPartDocument(), box);
  const embedded = await embedPart(EMPTY_PART_LIBRARY, part, 'plate.pcad', 'plate.pcad',
    { importedAt: '2026-10-16T00:00:00.000Z' });
  const leaf = component(leafId, { kind: 'part', partRef: embedded.partRef }, placement(2, 0, 0));
  const child = assembly([leaf]);
  const subAssemblies = new Map([['child', child]]);
  const library = { ...embedded.library, assemblies: subAssemblies };
  const document = assembly([
    component(aId, { kind: 'subAssembly', assemblyRef: 'child' }, placement(10, 20, 0, TURN_Z)),
    component(bId, { kind: 'subAssembly', assemblyRef: 'child' }, placement(0, 0, 10)),
  ]);
  const inputs: JointOccurrenceInputs = { document, library, subAssemblies };
  return { inputs, solved: view(inputs), child, leaf, partRef: embedded.partRef };
}

describe('exact nested joint occurrence resolution', () => {
  it('distinguishes repeated child occurrences without copying their geometry or document', async () => {
    const f = await fixture();
    const before = JSON.stringify(f.inputs.document);
    const a = resolveJointOccurrence(f.inputs, ['A', 'plate'], f.solved);
    const b = resolveJointOccurrence(f.inputs, ['B', 'plate'], f.solved);
    expect(a.ok).toBe(true); expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('fixture must resolve');
    expect(a.occurrence.motionOwnerId).toBe('A');
    expect(b.occurrence.motionOwnerId).toBe('B');
    expect(a.occurrence.occurrenceKey).not.toBe(b.occurrence.occurrenceKey);
    expect(a.occurrence.leafDocument).toBe(f.child);
    expect(b.occurrence.leafComponent).toBe(f.leaf);
    expect(a.occurrence.partKey).toBe(f.partRef);
    expect(a.occurrence.sourceKey).toBe(b.occurrence.sourceKey);
    expect(a.occurrence.worldPlacement).toBe(f.solved.resolved.subAssemblies?.get('A')?.resolved.placements.get('plate'));
    expect(JSON.stringify(f.inputs.document)).toBe(before);
    expect(f.inputs.subAssemblies.get('child')).toBe(f.child);
  });

  it('retains slash, comma, quotes and Unicode IDs as array elements', async () => {
    const leaf = 'plate/面,"β';
    const f = await fixture(leaf, 'A/子', 'A');
    const ids = ['A/子', leaf];
    const result = resolveJointOccurrence(f.inputs, ids, f.solved);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('special IDs must resolve');
    expect(result.occurrence.path).toEqual(['A/子', leaf]);
    expect(JSON.parse(result.occurrence.occurrenceKey)).toEqual(['A/子', leaf]);
    ids[0] = 'changed';
    expect(result.occurrence.path[0]).toBe('A/子');
    expect(resolveJointOccurrence(f.inputs, ['A', '子', leaf], f.solved).ok).toBe(false);
  });

  it('uses the solved world placement once: Rz90([2,0,0]+[1,0,0])+[10,20,0]', async () => {
    const f = await fixture();
    const result = resolveJointOccurrence(f.inputs, ['A', 'plate'], f.solved);
    if (!result.ok) throw new Error('fixture must resolve');
    const point = applyPlacementToPoint(result.occurrence.worldPlacement, [1, 0, 0]);
    point.forEach((value, index) => expect(value).toBeCloseTo([10, 23, 0][index] ?? NaN, 12));
    const direction = applyPlacementToDirection(result.occurrence.worldPlacement, [1, 0, 0]);
    direction.forEach((value, index) => expect(value).toBeCloseTo([0, 1, 0][index] ?? NaN, 12));
  });

  it('keeps noncommuting Rz90 then Rx90 at two ancestor levels', async () => {
    const f = await fixture();
    const leaf = { ...f.leaf, placement: placement(0, 2, 0) };
    const inner = assembly([leaf]);
    const child = assembly([component('turn', { kind: 'subAssembly', assemblyRef: 'inner' }, placement(2, 0, 0, TURN_X))]);
    const subAssemblies = new Map([['child', child], ['inner', inner]]);
    const inputs = { ...f.inputs, subAssemblies, library: { ...f.inputs.library, assemblies: subAssemblies } };
    const result = resolveJointOccurrence(inputs, ['A', 'turn', 'plate'], view(inputs));
    if (!result.ok) throw new Error('nested fixture must resolve');
    // Rx90 maps [1,2,0] to [1,0,2]; add [2,0,0], then Rz90 and [10,20,0].
    const point = applyPlacementToPoint(result.occurrence.worldPlacement, [1, 0, 0]);
    point.forEach((value, index) => expect(value).toBeCloseTo([10, 23, 2][index] ?? NaN, 12));
    const direction = applyPlacementToDirection(result.occurrence.worldPlacement, [0, 1, 0]);
    direction.forEach((value, index) => expect(value).toBeCloseTo([0, 0, 1][index] ?? NaN, 12));
  });

  it('retains a solved placement differing from the saved leaf placement', async () => {
    const f = await fixture();
    const inputs = { ...f.inputs, document: assembly([f.leaf]) };
    const solved = view(inputs);
    const world: RigidPlacement = { position: [30, 40, 50], rotation: [0, 0, 0, 1] };
    const result = resolveJointOccurrence(inputs, ['plate'], { ...solved,
      resolved: { ...solved.resolved, placements: new Map([['plate', world]]) } });
    if (!result.ok) throw new Error('solved placement must resolve');
    expect(result.occurrence.worldPlacement).toBe(world);
    expect(result.occurrence.motionOwnerId).toBe('plate');
    expect(f.leaf.placement.position[0].value).toBe(2);
  });

  it('rejects empty paths and missing, duplicate or suppressed occurrences', async () => {
    const f = await fixture();
    expect(jointOccurrencePath([])).toBeNull();
    expect(jointOccurrencePath(['A', ''])).toBeNull();
    const sparse: string[] = ['A'];
    sparse.length = 2;
    expect(jointOccurrencePath(sparse)).toBeNull();
    expect(resolveJointOccurrence(f.inputs, [], f.solved)).toEqual({ ok: false, code: 'invalid-path', index: 0 });
    expect(resolveJointOccurrence(f.inputs, ['A', 'absent'], f.solved)).toEqual({ ok: false, code: 'missing-component', index: 1 });
    for (const components of [[f.leaf, f.leaf], [{ ...f.leaf, suppressed: true }]]) {
      const child = assembly(components);
      const subAssemblies = new Map([['child', child]]);
      const inputs = { ...f.inputs, subAssemblies, library: { ...f.inputs.library, assemblies: subAssemblies } };
      expect(resolveJointOccurrence(inputs, ['A', 'plate'], view(inputs))).toEqual({ ok: false,
        code: components.length === 2 ? 'ambiguous-component' : 'suppressed-component', index: 1 });
    }
    const root = f.inputs.document.components[0];
    if (root === undefined) throw new Error('root missing');
    const inputs = { ...f.inputs, document: assembly([{ ...root, suppressed: true }]) };
    expect(resolveJointOccurrence(inputs, ['A', 'plate'], view(inputs))).toEqual({ ok: false, code: 'suppressed-component', index: 0 });
    const duplicate = { ...f.inputs, document: assembly([root, root]) };
    expect(resolveJointOccurrence(duplicate, ['A', 'plate'], view(duplicate))).toEqual({ ok: false, code: 'ambiguous-component', index: 0 });
  });

  it('rejects changed source snapshots and mismatched child documents', async () => {
    const f = await fixture();
    for (const inputs of [{ ...f.inputs, document: { ...f.inputs.document } },
      { ...f.inputs, library: { ...f.inputs.library } }, { ...f.inputs, subAssemblies: new Map(f.inputs.subAssemblies) }]) {
      expect(resolveJointOccurrence(inputs, ['A', 'plate'], f.solved)).toEqual({ ok: false, code: 'stale-view', index: 0 });
    }
    const nested = f.solved.resolved.subAssemblies?.get('A');
    if (nested === undefined) throw new Error('nested missing');
    for (const broken of [{ ...nested, assembly: { ...f.child } }, { ...nested, componentId: 'B' },
      { ...nested, assemblyRef: 'elsewhere' }, { ...nested, placement: { ...nested.placement, position: [0, 0, 0] satisfies readonly [number, number, number] } }]) {
      const solved = { ...f.solved, resolved: { ...f.solved.resolved, subAssemblies: new Map([['A', broken]]) } };
      expect(resolveJointOccurrence(f.inputs, ['A', 'plate'], solved)).toEqual({ ok: false, code: 'inconsistent-tree', index: 0 });
    }
  });

  it('refuses non-subassembly ancestors, subassembly leaves and missing child libraries', async () => {
    const f = await fixture();
    expect(resolveJointOccurrence(f.inputs, ['A'], f.solved)).toEqual({ ok: false, code: 'unsupported-leaf', index: 0 });
    expect(resolveJointOccurrence(f.inputs, ['A', 'plate', 'extra'], f.solved)).toEqual({ ok: false, code: 'not-subassembly', index: 1 });
    const inputs = { ...f.inputs, subAssemblies: new Map<string, AssemblyDocument>() };
    expect(resolveJointOccurrence(inputs, ['A', 'plate'], { ...f.solved, source: inputs })).toEqual({ ok: false, code: 'missing-subassembly', index: 0 });
  });

  it('refuses absent/ambiguous source metadata and empty leaf geometry', async () => {
    const f = await fixture();
    const file = f.inputs.library.partFiles[0];
    if (file === undefined) throw new Error('embedded metadata missing');
    for (const files of [[], [file, file]]) {
      const inputs = { ...f.inputs, library: { ...f.inputs.library, partFiles: files } };
      expect(resolveJointOccurrence(inputs, ['A', 'plate'], { ...f.solved, source: inputs })).toEqual({ ok: false,
        code: files.length === 0 ? 'missing-source' : 'ambiguous-source', index: 1 });
    }
    const inputs = { ...f.inputs, document: assembly([f.leaf]) };
    const solved = view(inputs);
    const part = solved.resolved.parts.get(f.partRef);
    if (part === undefined) throw new Error('resolved part missing');
    const empty = { ...solved, resolved: { ...solved.resolved,
      parts: new Map([[f.partRef, { ...part, steps: [], liveBodyIds: [] }]]) } };
    expect(resolveJointOccurrence(inputs, ['plate'], empty)).toEqual({ ok: false, code: 'unsupported-geometry', index: 0 });
  });

  it('refuses missing tree entries, bad keys and invalid raw or solved rotations without repair', async () => {
    const f = await fixture();
    const inputs = { ...f.inputs, document: assembly([f.leaf]) };
    const solved = view(inputs);
    for (const resolved of [{ ...solved.resolved, placements: new Map() },
      { ...solved.resolved, partKeys: new Map([['plate', 'wrong']]) }]) {
      expect(resolveJointOccurrence(inputs, ['plate'], { ...solved, resolved })).toEqual({ ok: false, code: 'inconsistent-tree', index: 0 });
    }
    const badPlacement = placement(2, 0, 0, [0, 0, 0, 0]);
    const invalid = { ...inputs, document: assembly([{ ...f.leaf, placement: badPlacement }]) };
    const before = JSON.stringify(invalid.document);
    expect(resolveJointOccurrence(invalid, ['plate'], view(invalid))).toEqual({ ok: false, code: 'invalid-placement', index: 0 });
    expect(JSON.stringify(invalid.document)).toBe(before);
    const badWorld: RigidPlacement = { position: [0, 0, 0], rotation: [0, 0, 0, 0] };
    expect(resolveJointOccurrence(inputs, ['plate'], { ...solved, resolved: { ...solved.resolved,
      placements: new Map([['plate', badWorld]]) } })).toEqual({ ok: false, code: 'invalid-placement', index: 0 });
  });

  it('refuses excessive depth, unresolved source results and conflicting library trees', async () => {
    const f = await fixture();
    expect(resolveJointOccurrence(f.inputs, Array.from({ length: 10 }, () => 'A'), f.solved))
      .toEqual({ ok: false, code: 'depth-exceeded', index: 8 });
    const failed: JointOccurrenceView = { ...f.solved, resolved: { ...f.solved.resolved,
      errors: [{ componentId: 'A', code: 'invalidValue', message: 'invalid source' }] } };
    expect(resolveJointOccurrence(f.inputs, ['A', 'plate'], failed))
      .toEqual({ ok: false, code: 'unresolved-view', index: 0 });
    const inputs = { ...f.inputs, library: { ...f.inputs.library,
      assemblies: new Map([['child', { ...f.child }]]) } };
    expect(resolveJointOccurrence(inputs, ['A', 'plate'], { ...f.solved, source: inputs }))
      .toEqual({ ok: false, code: 'inconsistent-tree', index: 0 });
  });

  it('binds attached geometry revisions consistently with public bolt and weld drafts', async () => {
    const f = await fixture();
    const file = f.inputs.library.partFiles[0];
    if (file === undefined) throw new Error('embedded metadata missing');
    const keys: string[] = [];
    for (const digest of ['a'.repeat(64), 'b'.repeat(64)]) {
      const inputs = { ...f.inputs, library: { ...f.inputs.library,
        partFiles: [{ ...file, attachmentsDigest: digest }] } };
      const result = resolveJointOccurrence(inputs, ['A', 'plate'], view(inputs));
      if (!result.ok) throw new Error('attachment revision fixture must resolve');
      expect(result.occurrence.sourceKey).toBe(`part:${f.partRef}@${file.contentHash}:${digest}`);
      keys.push(result.occurrence.sourceKey);
    }
    expect(keys[0]).not.toBe(keys[1]);
    expect(f.inputs.library.partFiles[0]).toBe(file);
  });
});
