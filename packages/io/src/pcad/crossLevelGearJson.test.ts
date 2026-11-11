import {
  appendSolid, createAssemblyDocument, createAssemblyDocumentBundle, createEmptyPartDocument, createPrimitiveFeature, embedPart,
  EMPTY_PART_LIBRARY, type AssemblyComponent, type AssemblyDocument, type ComponentSource, type CrossLevelGearCouplingDefinition,
  type Joint,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import type { ExpressionValueJson } from './guards.js';
import { readDocumentBundle, writeDocumentBundle } from './pcadFile.js';

/*
 * Saved cross-level gears in document.json and in a .pcada bundle. The tree is written by hand: the parent places the
 * middle assembly twice (A, B), the middle assembly places the leaf as M, and the leaf owns the revolute child-turn and
 * the slider child-slide. Fixture times are historical fixture data.
 */
const SAVED_AT = '2026-09-01T00:00:00.000Z';
function ev(source: string, value: number): ExpressionValueJson {
  return { source, value, display: String(value) };
}
function component(id: string, source: ComponentSource): AssemblyComponent {
  return { id, name: id, source, placement: { position: [ev('0', 0), ev('0', 0), ev('0', 0)], rotation: [0, 0, 0, 1] },
    fixed: false, visible: true, suppressed: false };
}
function joint(id: string, kind: Joint['kind'], a: string, b: string): Joint {
  return { id, name: id, kind, a: { kind: 'origin', componentId: a, element: 'z' }, b: { kind: 'origin', componentId: b, element: 'z' },
    minValue: null, maxValue: null, suppressed: false };
}
const sub = (assemblyRef: string): ComponentSource => ({ kind: 'subAssembly', assemblyRef });
const gear = (overrides: Partial<CrossLevelGearCouplingDefinition> = {}): CrossLevelGearCouplingDefinition =>
  ({ id: 'xg-1', kind: 'crossLevelGear', parentJointId: 'drive', childPath: ['A', 'M'], childJointId: 'child-turn',
    ratio: ev('-2', 999), phaseDeg: ev('gearPhase*2', 888), suppressed: false, ...overrides });

function parent(part: ComponentSource, couplings?: readonly CrossLevelGearCouplingDefinition[]): AssemblyDocument {
  return { ...createAssemblyDocument('parent'),
    parameters: [{ name: 'gearPhase', value: ev('10', 10), unit: 'degree', description: '' }],
    components: [component('ground', part), component('A', sub('mid-ref')), component('B', sub('mid-ref'))],
    joints: [joint('drive', 'revolute', 'A', 'ground'), joint('lift', 'slider', 'B', 'ground')],
    ...(couplings === undefined ? {} : { crossLevelGearCouplings: couplings }) };
}
const PART: ComponentSource = { kind: 'part', partRef: 'part-ref' };
const reopen = (document: AssemblyDocument) => readAssemblyDocument(writeAssemblyDocument(document, { savedAt: SAVED_AT }));

describe('cross-level gears in document.json', () => {
  it('keeps the authored sources, the typed path and the ids through a deterministic reopen; legacy files stay without it', () => {
    const document = parent(PART, [gear(), gear({ id: 'xg-2', childPath: ['B', 'M'], suppressed: true })]);
    const text = writeAssemblyDocument(document, { savedAt: SAVED_AT });
    const restored = readAssemblyDocument(text);
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.document.crossLevelGearCouplings).toEqual(document.crossLevelGearCouplings);
    expect(restored.document.crossLevelGearCouplings?.[0]?.phaseDeg.source).toBe('gearPhase*2');
    expect(restored.document.crossLevelGearCouplings?.[1]?.childPath).toEqual(['B', 'M']);
    expect(writeAssemblyDocument(restored.document, { savedAt: SAVED_AT })).toBe(text);
    const legacy = reopen(parent(PART));
    expect(legacy.ok && legacy.document.crossLevelGearCouplings).toBeUndefined();
    expect(text).toContain('"crossLevelGearCouplings"');
    expect(writeAssemblyDocument(parent(PART), { savedAt: SAVED_AT })).not.toContain('crossLevelGearCouplings');
  });

  it('refuses invalid sources, references and graphs at file admission', () => {
    // A valid same-level gear on drive (both revolute), so only the cross-level rule can refuse it.
    const base = parent(PART, [gear()]);
    const coupled = { ...base, joints: [...base.joints, joint('other', 'revolute', 'B', 'ground')],
      mechanismCouplings: [{ id: 'same', kind: 'gear' as const, jointAId: 'drive', jointBId: 'other', ratio: ev('1', 1),
        phaseDeg: ev('0', 0), referenceAngleA: 0, suppressed: false }] };
    expect(reopen({ ...coupled, crossLevelGearCouplings: [] }).ok).toBe(true);
    for (const invalid of [
      parent(PART, [gear({ ratio: ev('missingParameter', -2) })]),
      parent(PART, [gear({ ratio: ev('0', 0) })]),
      parent(PART, [gear({ parentJointId: 'absent' })]),
      parent(PART, [gear({ parentJointId: 'lift' })]),
      parent(PART, [gear({ childPath: [] })]),
      parent(PART, [gear({ childPath: ['ground', 'M'] })]),
      parent(PART, [gear(), gear({ id: 'xg-2' })]),
      parent(PART, [gear(), gear()]),
      coupled,
    ]) expect(reopen(invalid).ok).toBe(false);
    // Hand-edited JSON: an unknown kind and a non-string path element are type problems.
    const text = writeAssemblyDocument(parent(PART, [gear()]), { savedAt: SAVED_AT });
    expect(readAssemblyDocument(text.replace('"crossLevelGear"', '"crossLevelCam"')).ok).toBe(false);
    expect(readAssemblyDocument(text.replace(/"childPath":\s*\[/u, '"childPath": [7, ')).ok).toBe(false);
    expect(readAssemblyDocument(text.replace(/"childPath":\s*\[/u, '"childPath": ["", ')).ok).toBe(false);
    expect(readAssemblyDocument(text).ok).toBe(true);
  });
});

async function bundle(childJointId: string): Promise<Uint8Array> {
  let library = EMPTY_PART_LIBRARY;
  const empty = { ...createEmptyPartDocument(), name: 'block' };
  const embedded = await embedPart(library, appendSolid(empty, createPrimitiveFeature(empty, 'box')), 'block.pcad', '', { importedAt: SAVED_AT });
  library = embedded.library;
  const part: ComponentSource = { kind: 'part', partRef: embedded.partRef };
  const leaf: AssemblyDocument = { ...createAssemblyDocument('leaf'), components: [component('base', part), component('arm', part)],
    joints: [joint('child-turn', 'revolute', 'arm', 'base'), joint('child-slide', 'slider', 'arm', 'base')] };
  const mid: AssemblyDocument = { ...createAssemblyDocument('mid'), components: [component('mid-base', part), component('M', sub('leaf-ref'))] };
  const document = parent(part, [gear({ childJointId })]);
  return writeDocumentBundle(createAssemblyDocumentBundle(document, { ...library, assemblies: new Map([['leaf-ref', leaf], ['mid-ref', mid]]) }),
    { savedAt: SAVED_AT });
}

describe('cross-level gears in a .pcada bundle', () => {
  it('reopens a definition whose path and child joint exist in the embedded subassemblies', async () => {
    const read = await readDocumentBundle(await bundle('child-turn'), 'assembly');
    if (!read.ok) throw new Error(read.error.message);
    expect(read.bundle.kind === 'assembly' ? read.bundle.document.crossLevelGearCouplings?.map(c => [c.childPath, c.childJointId]) : null)
      .toEqual([[['A', 'M'], 'child-turn']]);
  });

  it.each([['missing joint', 'none'], ['slider joint', 'child-slide']])('refuses a %s inside the placement', async (_name, childJointId) => {
    const read = await readDocumentBundle(await bundle(childJointId), 'assembly');
    expect(read.ok ? null : read.error.code).toBe('invalidField');
  });
});
