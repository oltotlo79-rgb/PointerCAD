import {
  appendSolid, createAssemblyDocument, createAssemblyDocumentBundle, createEmptyPartDocument, createPrimitiveFeature, embedPart,
  EMPTY_PART_LIBRARY, type AssemblyComponent, type AssemblyDocument, type ComponentSource, type CrossLevelCamCouplingDefinition,
  type Joint,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import type { ExpressionValueJson } from './guards.js';
import { readDocumentBundle, writeDocumentBundle } from './pcadFile.js';

/*
 * Saved cross-level cams in document.json and in a .pcada bundle, written by hand like the cross-level gear file test:
 * the parent places the middle assembly twice (A, B), the middle assembly places the leaf as M, and the leaf owns the
 * slider child-slide and the revolute child-turn. The stored numbers (999, 888) are deliberately stale: only the
 * sources are authoritative. Fixture times are historical fixture data.
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
const cam = (overrides: Partial<CrossLevelCamCouplingDefinition> = {}): CrossLevelCamCouplingDefinition =>
  ({ id: 'xc-1', kind: 'crossLevelCam', camJointId: 'drive', childPath: ['A', 'M'], childJointId: 'child-slide',
    discRadiusMm: ev('20', 20), eccentricityMm: ev('camE', 999), rollerRadiusMm: ev('4', 4), phaseDeg: ev('30', 30),
    offsetMm: ev('-10', -10), direction: -1, suppressed: false, ...overrides });

function parent(part: ComponentSource, cams?: readonly CrossLevelCamCouplingDefinition[]): AssemblyDocument {
  return { ...createAssemblyDocument('parent'),
    parameters: [{ name: 'camE', value: ev('5', 5), unit: 'none', description: '' }],
    components: [component('ground', part), component('A', sub('mid-ref')), component('B', sub('mid-ref'))],
    joints: [joint('drive', 'revolute', 'A', 'ground'), joint('spin', 'revolute', 'B', 'ground'), joint('lift', 'slider', 'B', 'ground')],
    ...(cams === undefined ? {} : { crossLevelCamCouplings: cams }) };
}
const PART: ComponentSource = { kind: 'part', partRef: 'part-ref' };
const reopen = (document: AssemblyDocument) => readAssemblyDocument(writeAssemblyDocument(document, { savedAt: SAVED_AT }));

describe('cross-level cams in document.json', () => {
  it('keeps the authored sources, direction, typed path and ids through a deterministic reopen; legacy files stay without it', () => {
    const document = parent(PART, [cam(), cam({ id: 'xc-2', camJointId: 'spin', childPath: ['B', 'M'], direction: 1, suppressed: true })]);
    const text = writeAssemblyDocument(document, { savedAt: SAVED_AT });
    const restored = readAssemblyDocument(text);
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.document.crossLevelCamCouplings).toEqual(document.crossLevelCamCouplings);
    expect(restored.document.crossLevelCamCouplings?.map(c => [c.eccentricityMm.source, c.direction])).toEqual([['camE', -1], ['camE', 1]]);
    expect(writeAssemblyDocument(restored.document, { savedAt: SAVED_AT })).toBe(text);
    const legacy = reopen(parent(PART));
    expect(legacy.ok && legacy.document.crossLevelCamCouplings).toBeUndefined();
    expect(text).toContain('"crossLevelCamCouplings"');
    expect(writeAssemblyDocument(parent(PART), { savedAt: SAVED_AT })).not.toContain('crossLevelCamCouplings');
  });

  it('refuses invalid sources, dimensions, references and graphs at file admission', () => {
    expect(reopen(parent(PART, [cam()])).ok).toBe(true);
    for (const invalid of [
      parent(PART, [cam({ discRadiusMm: ev('missingParameter', 20) })]),
      parent(PART, [cam({ eccentricityMm: ev('24', 24) })]),
      parent(PART, [cam({ discRadiusMm: ev('0', 0) })]),
      parent(PART, [cam({ camJointId: 'absent' })]),
      parent(PART, [cam({ camJointId: 'lift' })]),
      parent(PART, [cam({ childPath: [] })]),
      parent(PART, [cam({ childPath: ['ground', 'M'] })]),
      parent(PART, [cam(), cam()]),
      parent(PART, [cam(), cam({ id: 'xc-2', childPath: ['B', 'M'] })]),
      parent(PART, [cam(), cam({ id: 'xc-2', camJointId: 'spin' })]),
      { ...parent(PART, [cam()]), crossLevelGearCouplings: [{ id: 'xg-1', kind: 'crossLevelGear' as const, parentJointId: 'drive',
        childPath: ['B', 'M'], childJointId: 'child-turn', ratio: ev('2', 2), phaseDeg: ev('0', 0), suppressed: false }] },
      // A valid cross-level gear on another joint and placement, so only the shared id refuses it.
      { ...parent(PART, [cam({ id: 'same' })]), crossLevelGearCouplings: [{ id: 'same', kind: 'crossLevelGear' as const,
        parentJointId: 'spin', childPath: ['B', 'M'], childJointId: 'child-turn', ratio: ev('2', 2), phaseDeg: ev('0', 0), suppressed: false }] },
    ]) expect(reopen(invalid).ok).toBe(false);
    expect(reopen({ ...parent(PART, [cam()]), crossLevelGearCouplings: [{ id: 'xg-1', kind: 'crossLevelGear', parentJointId: 'spin',
      childPath: ['B', 'M'], childJointId: 'child-turn', ratio: ev('2', 2), phaseDeg: ev('0', 0), suppressed: false }] }).ok).toBe(true);
    // Hand-edited JSON: a direction other than +1/-1, an unknown kind and a non-string path element are type problems.
    const text = writeAssemblyDocument(parent(PART, [cam()]), { savedAt: SAVED_AT });
    expect(text).toMatch(/"direction":\s*-1/u);
    expect(readAssemblyDocument(text.replace(/"direction":\s*-1/u, '"direction": 2')).ok).toBe(false);
    expect(readAssemblyDocument(text.replace(/"direction":\s*-1/u, '"direction": 0')).ok).toBe(false);
    expect(readAssemblyDocument(text.replace(/"direction":\s*-1/u, '"direction": "-1"')).ok).toBe(false);
    expect(readAssemblyDocument(text.replace(/"direction":\s*-1/u, '"direction": 1')).ok).toBe(true);
    expect(readAssemblyDocument(text.replace('"crossLevelCam"', '"crossLevelGear"')).ok).toBe(false);
    expect(readAssemblyDocument(text.replace(/"childPath":\s*\[/u, '"childPath": [7, ')).ok).toBe(false);
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
  const document = parent(part, [cam({ childJointId })]);
  return writeDocumentBundle(createAssemblyDocumentBundle(document, { ...library, assemblies: new Map([['leaf-ref', leaf], ['mid-ref', mid]]) }),
    { savedAt: SAVED_AT });
}

describe('cross-level cams in a .pcada bundle', () => {
  it('reopens a definition whose path and slider follower exist in the embedded subassemblies', async () => {
    const read = await readDocumentBundle(await bundle('child-slide'), 'assembly');
    if (!read.ok) throw new Error(read.error.message);
    expect(read.bundle.kind === 'assembly' ? read.bundle.document.crossLevelCamCouplings?.map(c => [c.childPath, c.childJointId, c.direction]) : null)
      .toEqual([[['A', 'M'], 'child-slide', -1]]);
  });

  it.each([['missing joint', 'none'], ['revolute joint', 'child-turn']])('refuses a %s as the follower inside the placement', async (_name, childJointId) => {
    const read = await readDocumentBundle(await bundle(childJointId), 'assembly');
    expect(read.ok ? null : read.error.code).toBe('invalidField');
  });
});
