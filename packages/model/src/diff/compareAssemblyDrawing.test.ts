import { withBeamAnalysisInputs } from '../analysis/beamInputs.js';
import { beamMetadataInputs } from '../analysis/beamMetadata.testSupport.js';
import { describe, expect, it } from 'vitest';
import type { AssemblyDocument, MechanismCamCoupling, MechanismGearCoupling } from '../assembly/types.js';
import type { ContextReferenceLink } from '../assembly/contextReference.js';
import { addComponent, createComponentFor } from '../assembly/assemblyEdit.js';
import { createAssemblyDocument } from '../assembly/createAssemblyDocument.js';
import { createDrawingDocument } from '../drawing/createDrawingDocument.js';
import { DocumentComparisonLimit } from './compareDocuments.js';
import { compareAssemblyDocuments, compareDrawingDocuments, type AssemblyLibraryDigest } from './compareAssemblyDrawing.js';

const library = (hash = 'h1', attachments = 'a1'): AssemblyLibraryDigest => ({
  parts: new Map([['part-1', { name: '部品', hash }]]), assemblies: new Map(), attachmentsDigest: attachments });
const base = createAssemblyDocument('組立');
const withParts = (count: number) => {
  let document = base;
  for (let index = 0; index < count; index += 1) document = addComponent(document,
    createComponentFor(document, { kind: 'part', partRef: 'part-1' }));
  return document;
};
const source = { sourceRef: 'src-1', sourceKind: 'part' as const, fileName: 'a.pcad', path: 'a.pcad', contentHash: 'x', importedAt: '2026-01-01T00:00:00.000Z' };

describe('組立の定義比較', () => {
  const options = { relationship: 'versions' as const, beforeLibrary: library(), afterLibrary: library() };
  it('同じ文書は無変更で、入力を更新しない', () => {
    const document = Object.freeze(withParts(2));
    const result = compareAssemblyDocuments(document, document, options);
    expect(result.changes).toEqual([]); expect(result.geometryCompared).toBe(false); expect(result.unchanged).toBeGreaterThan(0);
  });
  it('部品の追加、名前・抑制の変更、抱き込んだ部品の内容ハッシュと添付の変更を別々に示す', () => {
    const before = withParts(1);
    const changed = { ...addComponent(before, createComponentFor(before, { kind: 'part', partRef: 'part-1' })), name: '組立2' };
    const first = changed.components[0];
    if (first === undefined) throw new Error('component');
    const after = { ...changed, components: [{ ...first, suppressed: true }, ...changed.components.slice(1)] };
    const result = compareAssemblyDocuments(before, after, { ...options, afterLibrary: library('h2', 'a2') });
    const groups = result.changes.map(change => `${change.status}:${change.group}`);
    expect(groups).toEqual(expect.arrayContaining(['added:component', 'changed:component', 'changed:assembly-document',
      'changed:library-part', 'changed:attachments']));
  });
  it('由来のない2文書は全削除・全追加として示す', () => {
    const result = compareAssemblyDocuments(withParts(1), withParts(1), { ...options, relationship: 'unrelated' });
    expect(result.changes.every(change => change.status !== 'changed')).toBe(true);
    expect(result.unchanged).toBe(0);
  });
  it('作業量の上限を超えたら結果を返さず上限の例外にする', () => {
    expect(() => compareAssemblyDocuments(withParts(5), withParts(5), { ...options, maxWork: 3 })).toThrow(DocumentComparisonLimit);
  });
});

describe('EX12 gear coupling document definitions', () => {
  const options = { relationship: 'versions' as const, beforeLibrary: library(), afterLibrary: library() };
  function fixture() {
    const document = withParts(3), [ground, a, b] = document.components;
    if (ground === undefined || a === undefined || b === undefined) throw new Error('fixture');
    const before: AssemblyDocument = { ...document, joints: [a, b].map((component, index) => ({
      id: `joint-${String(index + 1)}`, name: component.name, kind: 'revolute',
      a: { kind: 'origin', componentId: component.id, element: 'origin' },
      b: { kind: 'origin', componentId: ground.id, element: 'origin' },
      minValue: null, maxValue: null, suppressed: false })) };
    const coupling: MechanismGearCoupling = { id: 'joint-1', kind: 'gear', jointAId: 'joint-1', jointBId: 'joint-2',
      ratio: { source: '-2', value: -2, display: '-2' }, phaseDeg: { source: '10', value: 10, display: '10' },
      referenceAngleA: 179, suppressed: false };
    return { before, coupling, added: { ...before, mechanismCouplings: [coupling] } };
  }
  it('reports create, signed edit and removal without conflating a coupling ID with a joint ID', () => {
    const { before, coupling, added } = fixture();
    const edited = { ...added, mechanismCouplings: [{ ...coupling, ratio: { source: '-3', value: -3, display: '-3' } }] };
    const originals = [before, added, edited].map(document => JSON.stringify(document));
    const addition = compareAssemblyDocuments(before, added, options);
    expect(addition.changes).toHaveLength(1);
    expect(addition.changes[0]).toMatchObject({ group: 'assembly-document', status: 'changed' });
    expect(addition.changes[0].differences[0]).toMatchObject({ path: ['mechanismCouplings'], before: '[]' });
    expect(addition.changes[0].differences[0].after).toContain('joint-1');
    const change = compareAssemblyDocuments(added, edited, options);
    expect(change.changes).toHaveLength(1);
    expect(change.changes[0].differences).toEqual([{ path: ['mechanismCouplings', '1', 'ratio'],
      kind: 'expression-and-value', before: '-2', after: '-3', beforeStoredValue: -2, afterStoredValue: -3 }]);
    const removal = compareAssemblyDocuments(edited, before, options);
    expect(removal.changes).toHaveLength(1);
    expect(removal.changes[0].differences[0]).toMatchObject({ path: ['mechanismCouplings'], after: '[]' });
    expect([before, added, edited].map(document => JSON.stringify(document))).toEqual(originals);
    expect(compareAssemblyDocuments(before, { ...before, mechanismCouplings: [] }, options).changes).toEqual([]);
  });
  it('separates source definition, stored value and display-only changes using the existing expression comparator', () => {
    const { coupling, added } = fixture();
    const edited = (phaseDeg: MechanismGearCoupling['phaseDeg']) => ({ ...added,
      mechanismCouplings: [{ ...coupling, phaseDeg }] });
    const expression = compareAssemblyDocuments(added, edited({ source: '5+5', value: 10, display: '10' }), options);
    expect(expression.changes[0].differences).toEqual([{ path: ['mechanismCouplings', '1', 'phaseDeg'],
      kind: 'expression', before: '10', after: '5+5', beforeStoredValue: 10, afterStoredValue: 10 }]);
    const cached = compareAssemblyDocuments(added, edited({ source: '10', value: 11, display: '11' }), options);
    expect(cached.changes[0].differences[0]).toMatchObject({ path: ['mechanismCouplings', '1', 'phaseDeg'], kind: 'stored-value' });
    expect(compareAssemblyDocuments(added, edited({ ...coupling.phaseDeg, display: '10.000' }), options).changes).toEqual([]);
  });
});

describe('図面の定義比較', () => {
  const options = { relationship: 'versions' as const, beforeSourceHash: 's1', afterSourceHash: 's1' };
  it('同じ図面は無変更', () => {
    const drawing = createDrawingDocument('図面', source);
    expect(compareDrawingDocuments(drawing, drawing, options).changes).toEqual([]);
  });
  it('用紙・レイヤー名・参照元の内容ハッシュの変更を示す', () => {
    const before = createDrawingDocument('図面', source);
    const layer = before.layers[0];
    if (layer === undefined) throw new Error('layer');
    const after = { ...before, sheet: { ...before.sheet, scale: 2 }, layers: [{ ...layer, name: '別の名前' }, ...before.layers.slice(1)] };
    const result = compareDrawingDocuments(before, after, { ...options, afterSourceHash: 's2' });
    const groups = result.changes.map(change => `${change.status}:${change.group}`);
    expect(groups).toEqual(expect.arrayContaining(['changed:drawing-document', 'changed:layer', 'changed:drawing-source']));
  });
});

describe('beam analysis input metadata is retained by document comparison', () => {
  it('reports attachment addition, a signed load edit and removal without mutating either document', () => {
    const before = createAssemblyDocument('Beam metadata');
    const added = withBeamAnalysisInputs(before, beamMetadataInputs(before.id, 10));
    const edited = withBeamAnalysisInputs(added, beamMetadataInputs(before.id, -20));
    const originals = [before, added, edited].map(value => JSON.stringify(value));
    const addition = compareAssemblyDocuments(before, added, { relationship: 'versions', beforeLibrary: library(), afterLibrary: library() });
    expect(addition.changes).toHaveLength(1);
    expect(addition.changes[0]).toMatchObject({ group: 'assembly-document', status: 'changed' });
    expect(addition.changes[0].differences[0]).toMatchObject({ path: ['beamAnalysisInputs'], before: 'undefined' });
    expect(addition.changes[0].differences[0].after).toContain('pointercad-beam-inputs/1');
    const update = compareAssemblyDocuments(added, edited, { relationship: 'versions', beforeLibrary: library(), afterLibrary: library() });
    expect(update.changes).toHaveLength(1);
    expect(update.changes[0].differences).toEqual([{
      path: ['beamAnalysisInputs', 'analyses', '1', 'document', 'loads', '1', 'force', '1'],
      kind: 'value', before: '10', after: '-20',
    }]);
    const removal = compareAssemblyDocuments(edited, before, { relationship: 'versions', beforeLibrary: library(), afterLibrary: library() });
    expect(removal.changes).toHaveLength(1);
    expect(removal.changes[0].differences[0]).toMatchObject({ path: ['beamAnalysisInputs'], after: 'undefined' });
    expect(removal.changes[0].differences[0].before).toContain('pointercad-beam-inputs/1');
    expect([addition, update, removal].every(value => value.geometryCompared === false)).toBe(true);
    expect([before, added, edited].map(value => JSON.stringify(value))).toEqual(originals);
  });
});

describe('cam and context reference document definitions', () => {
  const options = { relationship: 'versions' as const, beforeLibrary: library(), afterLibrary: library() };
  const before = withParts(2);
  const cam: MechanismCamCoupling = { id: 'cam-1', kind: 'cam', camJointId: 'joint-1', followerJointId: 'joint-2',
    discRadiusMm: { source: '25', value: 25, display: '25' },
    eccentricityMm: { source: '4', value: 4, display: '4' },
    rollerRadiusMm: { source: '2', value: 2, display: '2' },
    phaseDeg: { source: '40', value: 40, display: '40' }, referenceAngleCam: 0, suppressed: false };
  const link: ContextReferenceLink = { id: 'context-1', targetComponentId: 'component-1', targetReferenceId: 'point-1',
    sourceComponentId: 'component-2', source: { bodyFeatureId: 'extrude-1', index: 3,
      fingerprint: { kind: 'face', surfaceKind: 'cylinder', area: 10, position: [5, 0, 0], axis: [0, 0, 1], radius: 2 } } };

  it('reports cam creation, signed phase edit and removal as assembly document changes without mutating inputs', () => {
    const added: AssemblyDocument = { ...before, camCouplings: [cam] };
    const edited: AssemblyDocument = { ...before, camCouplings: [{ ...cam,
      phaseDeg: { source: '-25', value: -25, display: '-25' } }] };
    const originals = [before, added, edited].map(document => JSON.stringify(document));
    const addition = compareAssemblyDocuments(before, added, options);
    expect(addition.changes).toHaveLength(1);
    expect(addition.changes[0]).toMatchObject({ group: 'assembly-document', status: 'changed' });
    expect(addition.changes[0].differences[0]).toMatchObject({ path: ['camCouplings'], before: '[]' });
    expect(addition.changes[0].differences[0].after).toContain('cam-1');
    const update = compareAssemblyDocuments(added, edited, options);
    expect(update.changes).toHaveLength(1);
    expect(update.changes[0]).toMatchObject({ group: 'assembly-document', status: 'changed' });
    expect(update.changes[0].differences).toEqual([{ path: ['camCouplings', '1', 'phaseDeg'],
      kind: 'expression-and-value', before: '40', after: '-25', beforeStoredValue: 40, afterStoredValue: -25 }]);
    const removal = compareAssemblyDocuments(edited, before, options);
    expect(removal.changes).toHaveLength(1);
    expect(removal.changes[0].differences[0]).toMatchObject({ path: ['camCouplings'], after: '[]' });
    expect([addition, update, removal].every(result => result.geometryCompared === false)).toBe(true);
    expect([before, added, edited].map(document => JSON.stringify(document))).toEqual(originals);
  });

  it('reports context creation, target point replacement and removal without conflating component definitions', () => {
    const added: AssemblyDocument = { ...before, contextReferences: [link] };
    const edited: AssemblyDocument = { ...before, contextReferences: [{ ...link, targetReferenceId: 'point-2' }] };
    const originals = [before, added, edited].map(document => JSON.stringify(document));
    const addition = compareAssemblyDocuments(before, added, options);
    expect(addition.changes).toHaveLength(1);
    expect(addition.changes[0]).toMatchObject({ group: 'assembly-document', status: 'changed' });
    expect(addition.changes[0].differences[0]).toMatchObject({ path: ['contextReferences'], before: '[]' });
    expect(addition.changes[0].differences[0].after).toContain('context-1');
    const update = compareAssemblyDocuments(added, edited, options);
    expect(update.changes).toHaveLength(1);
    expect(update.changes[0]).toMatchObject({ group: 'assembly-document', status: 'changed' });
    expect(update.changes[0].differences).toEqual([{ path: ['contextReferences', '1', 'targetReferenceId'],
      kind: 'value', before: JSON.stringify('point-1'), after: JSON.stringify('point-2') }]);
    const removal = compareAssemblyDocuments(edited, before, options);
    expect(removal.changes).toHaveLength(1);
    expect(removal.changes[0].differences[0]).toMatchObject({ path: ['contextReferences'], after: '[]' });
    expect([addition, update, removal].every(result => result.geometryCompared === false)).toBe(true);
    expect([before, added, edited].map(document => JSON.stringify(document))).toEqual(originals);
  });

  it('treats only the three optional relation arrays as equal when absent or empty, in both directions', () => {
    const variants: readonly AssemblyDocument[] = [
      { ...before, mechanismCouplings: [] }, { ...before, camCouplings: [] }, { ...before, contextReferences: [] },
      { ...before, mechanismCouplings: [], camCouplings: [], contextReferences: [] },
    ];
    for (const empty of variants) {
      expect(compareAssemblyDocuments(before, empty, options).changes).toEqual([]);
      expect(compareAssemblyDocuments(empty, before, options).changes).toEqual([]);
    }
    const changedName: AssemblyDocument = { ...variants[3], ...before, name: 'renamed',
      mechanismCouplings: [], camCouplings: [], contextReferences: [] };
    expect(compareAssemblyDocuments(before, changedName, options).changes[0].differences)
      .toEqual([{ path: ['name'], kind: 'value', before: JSON.stringify(before.name), after: JSON.stringify('renamed') }]);
  });
});


describe('new optional assembly record arrays retain serialization equivalence', () => {
  const options = { relationship: 'versions' as const, beforeLibrary: library(), afterLibrary: library() };
  it.each(['boltedJoints', 'crossLevelGearCouplings', 'crossLevelCamCouplings'] as const)(
    'treats absent and empty %s as equal in both directions without mutating inputs', (field) => {
      const before = createAssemblyDocument('records');
      expect(Object.hasOwn(before, field)).toBe(false);
      const after: AssemblyDocument = { ...before, [field]: [] };
      const original = JSON.stringify([before, after]);
      expect(compareAssemblyDocuments(before, after, options).changes).toEqual([]);
      expect(compareAssemblyDocuments(after, before, options).changes).toEqual([]);
      expect(JSON.stringify([before, after])).toBe(original);
    });
});

it('reports independent signed edits to nonempty cross-level gear and cam records', () => {
  const number = (value: number) => ({ source: String(value), value, display: String(value) });
  const gear = { id: 'gear-1', kind: 'crossLevelGear', parentJointId: 'drive', childPath: ['A'],
    childJointId: 'turn', ratio: number(-2), phaseDeg: number(0), suppressed: false
  } satisfies NonNullable<AssemblyDocument['crossLevelGearCouplings']>[number];
  const cam = { id: 'cam-1', kind: 'crossLevelCam', camJointId: 'drive', childPath: ['A'], childJointId: 'push',
    discRadiusMm: number(20), eccentricityMm: number(5), rollerRadiusMm: number(4), phaseDeg: number(0),
    offsetMm: number(-10), direction: 1, suppressed: false
  } satisfies NonNullable<AssemblyDocument['crossLevelCamCouplings']>[number];
  const before: AssemblyDocument = { ...createAssemblyDocument('records'),
    crossLevelGearCouplings: [gear], crossLevelCamCouplings: [cam] };
  const after: AssemblyDocument = { ...before, crossLevelGearCouplings: [{ ...gear, ratio: number(-3) }],
    crossLevelCamCouplings: [{ ...cam, offsetMm: number(-12) }] };
  const original = JSON.stringify([before, after]);
  const result = compareAssemblyDocuments(before, after,
    { relationship: 'versions', beforeLibrary: library(), afterLibrary: library() });
  expect(result.changes).toHaveLength(1);
  expect(result.changes[0].differences).toEqual([
    { path: ['crossLevelCamCouplings', '1', 'offsetMm'], kind: 'expression-and-value',
      before: '-10', after: '-12', beforeStoredValue: -10, afterStoredValue: -12 },
    { path: ['crossLevelGearCouplings', '1', 'ratio'], kind: 'expression-and-value',
      before: '-2', after: '-3', beforeStoredValue: -2, afterStoredValue: -3 },
  ]);
  expect(result.geometryCompared).toBe(false);
  const empty = createAssemblyDocument('records');
  const options = { relationship: 'versions' as const, beforeLibrary: library(), afterLibrary: library() };
  const added = compareAssemblyDocuments(empty, before, options);
  expect(added.changes).toHaveLength(1);
  expect(added.changes[0].differences.map(difference => [difference.path, difference.before]))
    .toEqual([[['crossLevelCamCouplings'], '[]'], [['crossLevelGearCouplings'], '[]']]);
  expect(added.changes[0].differences[0].after).toContain('cam-1');
  expect(added.changes[0].differences[1].after).toContain('gear-1');
  const removed = compareAssemblyDocuments(before, empty, options);
  expect(removed.changes).toHaveLength(1);
  expect(removed.changes[0].differences.map(difference => [difference.path, difference.after]))
    .toEqual([[['crossLevelCamCouplings'], '[]'], [['crossLevelGearCouplings'], '[]']]);
  expect(JSON.stringify([before, after])).toBe(original);
});
