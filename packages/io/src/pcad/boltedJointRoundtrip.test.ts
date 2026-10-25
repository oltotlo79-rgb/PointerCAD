import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, appendSolid, buildStandardPartFromSource, commitBoltedJoint, commitBoltedJointEdit, createAssemblyDocument,
  createComponentFor, createEmptyPartDocument, createStandardPartSource, HEX_BOLT_LENGTH_THREAD_GENERATOR_REVISION,
  joinRigidGroup, previewBoltedJoint, previewBoltedJointEdit, releaseRigidGroup, STANDARD_PART_GENERATOR_REVISION,
  withBoltedJointRecord,
  type AssemblyComponent, type AssemblyDocument, type BoltedJointCatalogChoices, type BoltedJointChoices, type BoltedJointPlan,
  type BoltedJointUserChoices, type FaceResolution, type FasteningGeometryContext, type FasteningHolePick, type HoleFeature,
  type MateSubShapeGeometry, type PartDocument, type Placement, type StandardPartSource, type SubShapeRef, type Vec3,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { PCAD_SCHEMA_VERSION } from './schema.js';

function threeParts(): AssemblyDocument {
  let document = createAssemblyDocument('組立1');
  for (const partRef of ['part-1', 'part-2', 'part-3']) {
    document = addComponent(document, createComponentFor(document, { kind: 'part', partRef }, {}));
  }
  return document;
}

describe('互いに固定した組の保存と読込み', () => {
  it('組の id を保存して読み戻し、組に属さない部品には欄を書かない', () => {
    const document = joinRigidGroup(threeParts(), ['component-1', 'component-2']);
    const text = writeAssemblyDocument(document);
    const read = readAssemblyDocument(text);
    if (!read.ok) throw new Error(JSON.stringify(read));
    expect(read.document.components.map((component) => component.rigidGroupId)).toEqual(['fastening-1', 'fastening-1', undefined]);
    const parsed: unknown = JSON.parse(text);
    const saved = parsed as { readonly document?: { readonly components?: readonly Record<string, unknown>[] } };
    const components = saved.document?.components ?? [];
    expect(components.map((component) => 'rigidGroupId' in component)).toEqual([true, true, false]);
  });

  it('組の無い旧い文書は今までと同じ形で書き、そのまま読める', () => {
    const document = threeParts();
    const text = writeAssemblyDocument(document);
    expect(text.includes('rigidGroupId')).toBe(false);
    const read = readAssemblyDocument(text);
    expect(read.ok).toBe(true);
  });

  it('組を解いた文書は欄を書かない', () => {
    const document = releaseRigidGroup(joinRigidGroup(threeParts(), ['component-1', 'component-2']), 'fastening-1');
    expect(writeAssemblyDocument(document).includes('rigidGroupId')).toBe(false);
  });
});

function threadLengthOf(source: StandardPartSource): number | null {
  const thread = buildStandardPartFromSource(source)?.solids.find((feature) => feature.kind === 'threadShaft');
  return thread?.kind === 'threadShaft' ? thread.length.value : null;
}

describe('六角ボルトの台本の版の保存と読込み(追加要件6)', () => {
  it('旧版 1 と長さの区分の版の 125mm 超のボルトを、版を変えずに書いて読み戻し、同じ形に組み直す', () => {
    const current = createStandardPartSource('hexBolt', 'M20', { length: '150', dimensionSeries: 'main', threadSeries: 'coarse' });
    expect(current.generatorRevision).toBe(HEX_BOLT_LENGTH_THREAD_GENERATOR_REVISION);
    const legacy: StandardPartSource = { ...current, generatorRevision: STANDARD_PART_GENERATOR_REVISION };
    let document = createAssemblyDocument('版');
    for (const source of [legacy, current]) document = addComponent(document, createComponentFor(document, source, {}));
    const read = readAssemblyDocument(writeAssemblyDocument(document));
    if (!read.ok) throw new Error(JSON.stringify(read));
    const sources = read.document.components.map((component) => component.source);
    expect(sources).toEqual([legacy, current]);
    const [readLegacy, readCurrent] = sources;
    if (readLegacy?.kind !== 'standardPart' || readCurrent?.kind !== 'standardPart') throw new Error('規格部品の出どころが無い');
    // 旧版は b(ℓ≤125)=46 のまま、新しい版は 125<ℓ≤200 の 52。読み戻しで黙って新しい版へ変えない。
    expect([threadLengthOf(readLegacy), threadLengthOf(readCurrent)]).toEqual([46, 52]);
    expect(buildStandardPartFromSource(readLegacy)).toEqual(buildStandardPartFromSource(legacy));
    expect(buildStandardPartFromSource(readCurrent)).toEqual(buildStandardPartFromSource(current));
  });

  it('知らない版は読み戻しても書き換えず、現在の台本で代わりに組まない', () => {
    const unknown: StandardPartSource = { ...createStandardPartSource('hexBolt', 'M20', { length: '150', dimensionSeries: 'main' }),
      generatorRevision: '9-future' };
    const document = addComponent(createAssemblyDocument('未知'), createComponentFor(createAssemblyDocument('未知'), unknown, {}));
    const read = readAssemblyDocument(writeAssemblyDocument(document));
    if (!read.ok) throw new Error(JSON.stringify(read));
    const source = read.document.components[0]?.source;
    expect(source).toEqual(unknown);
    expect(source?.kind === 'standardPart' ? buildStandardPartFromSource(source) : 'not standard').toBeNull();
  });
});

/*
 * EX-06.PERSIST: a through-bolt joint committed by the real model commands, exactly as the store does it
 * (previewBoltedJoint -> commitBoltedJoint -> withBoltedJointRecord), then saved and reopened.
 * Plate A: z -10..0 with a 9 mm through hole at (20, 10). Plate B: z 0..12 with a 9 mm through hole at (0, 0), placed
 * tilted at (100, 0, 0) (part +Z = world +X); the commit pulls it onto A's hole: position (20, 10, 0), no rotation.
 * The face table stands in for the kernel (each plate's own frame); the planner, the record and the serializer are the
 * product code. Hand-derived values (annex JA M8: nut m 6.5, thread b 22; plain washer M8 t 1.6; the candidate lengths
 * are test inputs, not JIS values):
 *   protrusion 0, plain washer under the head: grip 10 + 12 + 1.6 = 23.6, L >= 23.6 + 6.5 = 30.1 -> 35
 *   (shank 35 - 22 = 13 <= 23.6), the tail sticks out 35 - 30.1 = 4.9. The washer lies on A's outer face z -10, the
 *   bolt bears on it at z -11.6 and the nut sits on B's outer face z 12, all on the axis (20, 10).
 *   protrusion 5: L >= 35.1 -> 40 (shank 18 <= 23.6), the tail sticks out 40 - 30.1 = 9.9.
 */

const JOINT_SAVED_AT = '2026-10-24T00:00:00.000Z';
const JOINT_REVISIONS: ReadonlyMap<string, string> = new Map([['plateA', 'rev-a'], ['plateB', 'rev-b']]);
const HALF = Math.SQRT1_2;
const HOLE_RADIUS = 4.5;

function placementAt(position: Vec3, rotation: readonly [number, number, number, number]): Placement {
  return { position: [expressionValueFromNumber(position[0]), expressionValueFromNumber(position[1]),
    expressionValueFromNumber(position[2])], rotation };
}

/** The saved reference of a picked hole wall (the fingerprint the screen pick recorded). */
function wallRef(center: Vec3, length: number): SubShapeRef {
  return { bodyFeatureId: 'hole-1', index: 1, fingerprint: { kind: 'face', surfaceKind: 'cylinder',
    area: 2 * Math.PI * HOLE_RADIUS * length, position: center, axis: [0, 0, 1], radius: HOLE_RADIUS } };
}

function matingRef(position: Vec3): SubShapeRef {
  return { bodyFeatureId: 'hole-1', index: 2, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 400, position,
    axis: [0, 0, 1], radius: null } };
}

function holedPlate(): PartDocument {
  const hole: HoleFeature = {
    id: 'hole-1', name: '穴1', suppressed: false, kind: 'hole', targetFeatureId: 'extrude-1',
    face: { bodyFeatureId: 'extrude-1', index: 0, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1200,
      position: [20, 15, 0], axis: [0, 0, 1], radius: null } },
    centers: [{ sketchId: 'sketch-1', pointFeatureId: 'point-1' }], diameter: expressionValueFromNumber(9),
    depth: { kind: 'through' }, tiltAngle: expressionValueFromNumber(0), tiltAzimuth: expressionValueFromNumber(0),
  };
  return appendSolid(createEmptyPartDocument(), hole);
}

function wallGeometry(center: Vec3, length: number): MateSubShapeGeometry {
  return { kind: 'face', surfaceKind: 'cylinder', area: 2 * Math.PI * HOLE_RADIUS * length, position: center,
    axis: [0, 0, 1], axisOrigin: center, cylinderSpan: [-length / 2, length / 2], radius: HOLE_RADIUS };
}

function planeGeometry(position: Vec3): MateSubShapeGeometry {
  return { kind: 'face', surfaceKind: 'plane', area: 400, position, axis: [0, 0, 1], radius: null };
}

/** Index 1 is the hole wall and 2 the mating face, in each plate's own frame (as the kernel reports them). */
const PLATE_FACES: Readonly<Record<string, Readonly<Record<number, MateSubShapeGeometry>>>> = {
  plateA: { 1: wallGeometry([20, 10, -5], 10), 2: planeGeometry([20, 10, 0]) },
  plateB: { 1: wallGeometry([0, 0, 6], 12), 2: planeGeometry([0, 0, 0]) },
};

function partRefOf(component: AssemblyComponent): string {
  return component.source.kind === 'part' ? component.source.partRef : '';
}

function jointContext(document: AssemblyDocument): FasteningGeometryContext {
  return {
    document, partRevisions: JOINT_REVISIONS,
    partDocument: (component) => (component.source.kind === 'part' ? holedPlate() : null),
    resolveFace: (component, reference): FaceResolution => {
      const geometry = PLATE_FACES[partRefOf(component)]?.[reference.index];
      if (geometry === undefined) return { status: 'missing' };
      return { status: 'matched', geometry, wall: reference.index !== 1 ? { status: 'unnamed' } : { status: 'hole', origin: {
        kind: 'hole-face', featureId: 'hole-1', center: { sketchId: 'sketch-1', producer: { kind: 'point', featureId: 'point-1' } },
        placement: { kind: 'original' }, stage: 'bore', role: 'wall' } } };
    },
  };
}

const PICK_A: FasteningHolePick = { componentId: 'component-1', holeFeatureId: 'hole-1',
  holeFace: wallRef([20, 10, -5], 10), matingFace: matingRef([20, 10, 0]) };
const PICK_B: FasteningHolePick = { componentId: 'component-2', holeFeatureId: 'hole-1',
  holeFace: wallRef([0, 0, 6], 12), matingFace: matingRef([0, 0, 0]) };
const USER_CHOICES: BoltedJointUserChoices = { dimensionSeries: 'annexJA', explicitBolt: { nominal: 'M8', threadSeries: 'coarse' },
  minimumProtrusion: 0, headWashers: ['plainWasher'], nutWashers: [] };
const LENGTHS: BoltedJointCatalogChoices = { lengthAvailability: [{ boltRowKey: 'JIS-B-1180:2014:M8:P1.25:annexJA',
  lengths: [20, 25, 30, 35, 40], basis: 'perDiameterEvidence', verified: true, source: 'test fixture (not a JIS value)' }] };

function plates(): AssemblyDocument {
  let document = createAssemblyDocument('締結の保存');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plateA' },
    { placement: placementAt([0, 0, 0], [0, 0, 0, 1]) }));
  return addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'plateB' },
    { placement: placementAt([100, 0, 0], [0, HALF, 0, HALF]) }));
}

/** The joint committed and recorded exactly as the store does it (one new document). */
function committedJoint(): { readonly document: AssemblyDocument; readonly plan: BoltedJointPlan } {
  const before = plates();
  const choices: BoltedJointChoices = { ...USER_CHOICES, ...LENGTHS };
  const preview = previewBoltedJoint(jointContext(before), PICK_A, PICK_B, choices);
  if (!preview.ok) throw new Error(JSON.stringify(preview.rejections));
  const committed = commitBoltedJoint(jointContext(before), PICK_A, PICK_B, choices, preview.plan);
  if (!committed.ok) throw new Error(JSON.stringify(committed.rejections));
  return { document: withBoltedJointRecord(committed.document, PICK_A, PICK_B, choices, committed.componentIds),
    plan: preview.plan };
}

function reopen(text: string): AssemblyDocument {
  const read = readAssemblyDocument(text);
  if (!read.ok) throw new Error(JSON.stringify(read.error));
  return read.document;
}

/** The same saved file in an older envelope (the schema and document version an earlier release wrote). */
function olderEnvelope(text: string, schema: number): string {
  const envelope = JSON.parse(text) as Readonly<Record<string, unknown>> & { readonly document: Readonly<Record<string, unknown>> };
  return JSON.stringify({ ...envelope, schema, document: { ...envelope.document, schemaVersion: schema } });
}

function hardwareOf(document: AssemblyDocument): readonly (readonly [string, string, string, string | null])[] {
  return document.components.flatMap((component) => component.source.kind === 'standardPart'
    ? [[component.id, component.source.catalog, component.source.size, component.source.options.length ?? null] as const] : []);
}

function positionOf(document: AssemblyDocument, id: string): readonly number[] {
  return document.components.find((component) => component.id === id)?.placement.position.map((entry) => entry.value) ?? [];
}

function expectNear(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((entry, index) => expect(entry).toBeCloseTo(expected[index] ?? Number.NaN, 9));
}

describe('EX-06.PERSIST 実際の計画で確定した締結の保存と読込み', () => {
  it('締結の記録(穴・合わせ面・部品の参照と指定)・金物・配置・組を丸ごと保ち、2 回目の書き出しも同じバイトになる', () => {
    const { document, plan } = committedJoint();
    // 確定した文書の事実(手で求めた値)。
    expect(plan.configuration).toBe('throughBoltWithNut');
    expect(plan.gripLength).toBeCloseTo(23.6, 9);
    expect(plan.boltLength).toBe(35);
    expect(plan.protrusion).toBeCloseTo(4.9, 9);
    expect(hardwareOf(document)).toEqual([
      ['component-3', 'plainWasher', 'M8', null], ['component-4', 'hexBolt', 'M8', '35'], ['component-5', 'hexNut', 'M8', null]]);
    expectNear(positionOf(document, 'component-2'), [20, 10, 0]);
    expectNear((document.components[1]?.placement.rotation ?? []).map((entry) => Math.abs(entry)), [0, 0, 0, 1]);

    const text = writeAssemblyDocument(document, { savedAt: JOINT_SAVED_AT });
    const reopened = reopen(text);
    expect(reopened).toEqual(document);
    expect(writeAssemblyDocument(reopened, { savedAt: JOINT_SAVED_AT })).toBe(text);
    // 利用者の入力(2 つの穴と合わせ面の参照、寸法系列・呼び・突き出し・座金)と、足した部品・板・組の id が同じ。
    expect(reopened.boltedJoints).toEqual([{ id: 'bolted-joint-1', first: PICK_A, second: PICK_B, choices: USER_CHOICES,
      componentIds: ['component-3', 'component-4', 'component-5'] }]);
    expect(reopened.components.map((component) => [component.id, component.rigidGroupId])).toEqual([
      ['component-1', 'fastening-1'], ['component-2', 'fastening-1'], ['component-3', 'fastening-1'],
      ['component-4', 'fastening-1'], ['component-5', 'fastening-1']]);
    expect(hardwareOf(reopened)).toEqual(hardwareOf(document));
    expectNear(positionOf(reopened, 'component-3'), [20, 10, -10]);
    expectNear(positionOf(reopened, 'component-4'), [20, 10, -11.6]);
    expectNear(positionOf(reopened, 'component-5'), [20, 10, 12]);
  });

  it('旧版の封筒(schema 17 = 公開済みの版・21 = 直前の版)に入れた同じ締結も、今の読み手が同じ文書として読み、今の版で同じバイトに書き戻す', () => {
    const { document } = committedJoint();
    expect(document.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
    const text = writeAssemblyDocument(document, { savedAt: JOINT_SAVED_AT });
    for (const schema of [17, 21]) {
      const old = olderEnvelope(text, schema);
      expect(JSON.parse(old)).toMatchObject({ schema, document: { schemaVersion: schema } });
      const reopened = reopen(old);
      expect(reopened.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
      expect(reopened).toEqual(document);
      expect(writeAssemblyDocument(reopened, { savedAt: JOINT_SAVED_AT })).toBe(text);
    }
  });

  it('公開済みの版(schema 17)で規格部品として置いた版 1 のボルト・ナットは、版・形・配置を変えずに読み、締結の記録も組も作らない', () => {
    const bolt: StandardPartSource = { ...createStandardPartSource('hexBolt', 'M8',
      { length: '40', dimensionSeries: 'annexJA', threadSeries: 'coarse' }), generatorRevision: STANDARD_PART_GENERATOR_REVISION };
    const nut = createStandardPartSource('hexNut', 'M8', { dimensionSeries: 'annexJA', threadSeries: 'coarse' });
    let document = createAssemblyDocument('規格部品');
    document = addComponent(document, createComponentFor(document, bolt, { placement: placementAt([20, 10, -10], [0, 0, 0, 1]) }));
    document = addComponent(document, createComponentFor(document, nut, { placement: placementAt([20, 10, 12], [0, 0, 0, 1]) }));
    const text = writeAssemblyDocument(document, { savedAt: JOINT_SAVED_AT });
    expect(text).not.toContain('rigidGroupId');
    expect(text).not.toContain('boltedJoints');
    const reopened = reopen(olderEnvelope(text, 17));
    expect(reopened).toEqual(document);
    expect(reopened.boltedJoints).toBeUndefined();
    expect(reopened.components.map((component) => component.rigidGroupId)).toEqual([undefined, undefined]);
    const [readBolt, readNut] = reopened.components.map((component) => component.source);
    expect(readBolt).toEqual(bolt);
    expect(readNut).toEqual(nut);
    if (readBolt?.kind !== 'standardPart' || readNut?.kind !== 'standardPart') throw new Error('規格部品の出どころが無い');
    expect(buildStandardPartFromSource(readBolt)).toEqual(buildStandardPartFromSource(bolt));
    expect(buildStandardPartFromSource(readNut)).toEqual(buildStandardPartFromSource(nut));
    expect(writeAssemblyDocument(reopened, { savedAt: JOINT_SAVED_AT })).toBe(text);
  });

  it('開き直した入力から同じ金物を導き(導出は入力に結び付く)、入力を変えると導出が変わり、板がずれていれば古い入力で作り直さない', () => {
    const { document } = committedJoint();
    const reopened = reopen(writeAssemblyDocument(document, { savedAt: JOINT_SAVED_AT }));
    const record = reopened.boltedJoints?.[0];
    if (record === undefined) throw new Error('締結の記録が無い');
    // 同じ入力 -> 保存した金物と同じ台本(呼び・長さ・欄)と配置。板は同じ組なので動かさない。
    const same = previewBoltedJointEdit(jointContext(reopened), record.id, record.choices, LENGTHS);
    if (!same.ok) throw new Error(JSON.stringify(same));
    expect(same.plan.alignment.movedComponentIds).toEqual([]);
    expect(same.plan.boltLength).toBe(35);
    expect(same.plan.gripLength).toBeCloseTo(23.6, 9);
    const saved = record.componentIds.map((id) => reopened.components.find((component) => component.id === id));
    expect(same.plan.operations.map((operation) => [operation.catalog, operation.size, operation.options]))
      .toEqual(saved.map((component) => (component?.source.kind === 'standardPart'
        ? [component.source.catalog, component.source.size, component.source.options] : null)));
    same.plan.operations.forEach((operation, index) => {
      expectNear(operation.placement.position.map((entry) => entry.value), positionOf(reopened, saved[index]?.id ?? ''));
      expectNear(operation.placement.rotation, saved[index]?.placement.rotation ?? []);
    });

    // 入力(突き出し 0 -> 5)を変えると導出したボルトが 35 -> 40 になり、保存し直しても新しい入力と導出が残る。
    const longer: BoltedJointUserChoices = { ...record.choices, minimumProtrusion: 5 };
    const changed = previewBoltedJointEdit(jointContext(reopened), record.id, longer, LENGTHS);
    if (!changed.ok) throw new Error(JSON.stringify(changed));
    expect(changed.plan.boltLength).toBe(40);
    expect(changed.plan.protrusion).toBeCloseTo(9.9, 9);
    const edited = commitBoltedJointEdit(jointContext(reopened), record.id, longer, LENGTHS, changed.plan);
    if (!edited.ok) throw new Error(JSON.stringify(edited));
    const reread = reopen(writeAssemblyDocument(edited.document, { savedAt: JOINT_SAVED_AT }));
    expect(reread).toEqual(edited.document);
    expect(hardwareOf(reread)).toEqual([
      ['component-6', 'plainWasher', 'M8', null], ['component-7', 'hexBolt', 'M8', '40'], ['component-8', 'hexNut', 'M8', null]]);
    expect(reread.boltedJoints).toEqual([{ ...record, choices: longer, componentIds: ['component-6', 'component-7', 'component-8'] }]);
    expect(reread.components.slice(0, 2)).toEqual(reopened.components.slice(0, 2));

    // 締結の後に板 B が 1 mm ずれた文書では、保存した入力から金物を作り直さない(今の形に結び付けて確かめ直す)。
    const shifted: AssemblyDocument = { ...reopened, components: reopened.components.map((component) => (component.id !== 'component-2'
      ? component : { ...component, placement: placementAt([21, 10, 0], [0, 0, 0, 1]) })) };
    const refused = previewBoltedJointEdit(jointContext(shifted), record.id, record.choices, LENGTHS);
    // 同じ組なので動かせず(alignmentBlocked)、軸が 1 mm ずれている(axesNotCoaxial)。
    expect(refused.ok ? null : [refused.reason, refused.rejections.map((rejection) => rejection.code)])
      .toEqual(['planRejected', ['alignmentBlocked', 'axesNotCoaxial']]);
  });
});
