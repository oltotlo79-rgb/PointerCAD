import { expressionValueFromNumber } from '@pointercad/expression';
import {
  addComponent, applyFilletWeld, buildStandardPartFromSource, createAssemblyDocument, createComponentFor,
  filletWeldSegmentOptions, planFilletWeld, planFilletWeldEdit, weldSegmentsOf,
  type AssemblyDocument, type FilletWeldEditRequest, type FilletWeldRequest, type Placement, type SolidBody, type SolidEdgeEntry,
  type Vec3, type WeldBodyLookup,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { readAssemblyDocument, writeAssemblyDocument } from './assemblyJson.js';
import { PCAD_SCHEMA_VERSION } from './schema.js';

const REVISIONS: ReadonlyMap<string, string> = new Map([['standing', 'rev-s'], ['base', 'rev-b']]);

function placement(position: Vec3): Placement {
  return { position: [expressionValueFromNumber(position[0]), expressionValueFromNumber(position[1]),
    expressionValueFromNumber(position[2])], rotation: [0, 0, 0, 1] };
}

/** 当たりの判定に使う、平らな面 1 枚(四角形)とその 4 辺だけのボディ(部品座標)。 */
function planeBody(corners: readonly [Vec3, Vec3, Vec3, Vec3], normal: Vec3): SolidBody {
  const edges = corners.map((start, index): SolidEdgeEntry => {
    const end = corners[(index + 1) % 4] ?? start;
    const length = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
    return { index, curveKind: 'line', length, start, end, radius: null, segmentOffset: 0, segmentCount: 0,
      midpoint: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, (start[2] + end[2]) / 2],
      axis: [(end[0] - start[0]) / length, (end[1] - start[1]) / length, (end[2] - start[2]) / length] };
  });
  return {
    featureId: 'extrude-1', volume: 1, isValid: true, vertices: [], threadMarks: [], edges,
    mesh: { positions: new Float32Array(corners.flat()), normals: new Float32Array(12), indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      edgePositions: new Float32Array(0), triangleCount: 2 },
    faces: [{ index: 0, surfaceKind: 'plane', area: 1, axis: normal, radius: null, triangleOffset: 0, triangleCount: 2,
      centroid: [(corners[0][0] + corners[2][0]) / 2, (corners[0][1] + corners[2][1]) / 2, (corners[0][2] + corners[2][2]) / 2] }],
  };
}

/** 立板の側面 y=8(x 0〜100、z 0〜50)と底板の上面 z=10(x 0〜100、y 0〜60)。 */
const BODIES: WeldBodyLookup = (component) => component.source.kind !== 'part' ? null
  : component.source.partRef === 'standing' ? [planeBody([[0, 8, 0], [100, 8, 0], [100, 8, 50], [0, 8, 50]], [0, 1, 0])]
    : component.source.partRef === 'base' ? [planeBody([[0, 0, 10], [100, 0, 10], [100, 60, 10], [0, 60, 10]], [0, 0, 1])] : null;

const CYLINDER_BODIES: WeldBodyLookup = (component) => {
  const parent = BODIES(component);
  if (component.source.kind !== 'part' || component.source.partRef !== 'base' || parent === null) return parent;
  return parent.map((body): SolidBody => ({ ...body, bodyKind: 'solid', faces: [{ index: 0, surfaceKind: 'cylinder', area: 2000 * Math.PI,
    centroid: [50, 34, 0], axis: [1, 0, 0], radius: 10, axisOrigin: [0, 34, 0], cylinderSpan: [0, 100],
    cylinderExterior: true, triangleOffset: 0, triangleCount: 0 }] }));
};

const INNER_BODIES: WeldBodyLookup = component => {
  const bodies = CYLINDER_BODIES(component);
  return component.source.kind !== 'part' || component.source.partRef !== 'base' || bodies === null ? bodies
    : bodies.map(body => ({ ...body, faces: body.faces.map(face => ({ ...face,
      axisOrigin: [0, 34, 20] as const, centroid: [50, 34, 20] as const, cylinderExterior: false })) }));
};

/** 立板(部品座標の側面 y=8、下の辺 x 方向 100)を底板(上面 z=10)の上に置き、断続ビード2本で溶接する。 */
function weldedTee(cylinder = false, inner = false): AssemblyDocument {
  let document = createAssemblyDocument('溶接');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'standing' }, { placement: placement([0, 26, 10]) }));
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'base' }, { placement: placement([0, 0, 0]) }));
  const face = (componentId: string, partRef: string, centroid: Vec3, normal: Vec3): FilletWeldRequest['first'] => ({
    componentId, sourceKey: `part:${partRef}@${REVISIONS.get(partRef) ?? ''}`, centroid, normal,
    face: { bodyFeatureId: 'extrude-1', index: 0, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 100, position: centroid, axis: normal, radius: null } },
  });
  const request: FilletWeldRequest = {
    first: face('component-1', 'standing', [50, 8, 25], [0, 1, 0]),
    second: cylinder ? { componentId: 'component-2', sourceKey: 'part:base@rev-b', centroid: [50, 34, inner ? 20 : 0], normal: null,
      face: { bodyFeatureId: 'extrude-1', index: 0, fingerprint: {
        kind: 'face', surfaceKind: 'cylinder', radius: 10, area: 2000 * Math.PI, position: [50, 34, inner ? 20 : 0], axis: [1, 0, 0],
      } } } : face('component-2', 'base', [50, 30, 10], [0, 0, 1]),
    edge: { midpoint: [50, 8, 0], direction: [1, 0, 0], length: 100,
      edge: { bodyFeatureId: 'extrude-1', index: 0, fingerprint: { kind: 'edge', curveKind: 'line', length: 100, position: [50, 8, 0], axis: [1, 0, 0], radius: null } } },
    legOnSecond: 6, legOnFirst: 8, segments: [{ start: 5, length: 12.5 }, { start: 60, length: 30 }], materialId: 'stainless',
  };
  const planned = planFilletWeld(document, request, REVISIONS, inner ? INNER_BODIES : cylinder ? CYLINDER_BODIES : BODIES);
  if (!planned.ok) throw new Error(JSON.stringify(planned.rejections));
  const applied = applyFilletWeld(document, planned.plan, REVISIONS);
  if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
  return applied.document;
}

function summary(document: AssemblyDocument): unknown {
  return document.components.map((component) => ({
    id: component.id, source: component.source, materialId: component.materialId, rigidGroupId: component.rigidGroupId,
    fixed: component.fixed, position: component.placement.position.map((value) => value.value), rotation: component.placement.rotation,
  }));
}

describe('すみ肉溶接のビードの保存と読込み', () => {
  it.each([false, true])('roundtrips curved radius/revision, irregular runs, material and arc profile (inner=%s)', (inner) => {
    const original = weldedTee(true, inner);
    const read = readAssemblyDocument(writeAssemblyDocument(original));
    if (!read.ok) throw new Error(JSON.stringify(read));
    expect(summary(read.document)).toEqual(summary(original));
    for (const component of read.document.components) {
      if (component.source.kind !== 'standardPart') continue;
      expect(component.source.generatorRevision).toBe(inner ? 'fillet-weld-4' : 'fillet-weld-3');
      expect(component.source.options.weldCylinderSide).toBe(inner ? 'interior' : undefined);
      expect(component.source.options.weldCylinderRadius).toBe('10');
      const before = original.components.find(item => item.id === component.id);
      if (before?.source.kind !== 'standardPart') throw new Error('Missing original bead');
      const part = buildStandardPartFromSource(component.source);
      expect(part).not.toBeNull();
      expect(part).toEqual(buildStandardPartFromSource(before.source));
      expect(part?.sketches.flatMap(sketch => sketch.features).filter(feature => feature.kind === 'arc')).toHaveLength(1);
    }
    const edit = { weldId: 'weld-1', legOnSecond: 6, legOnFirst: 8, segments: [{ start: 0, length: 100 }], materialId: 'stainless' };
    const valid = planFilletWeldEdit(read.document, edit, REVISIONS, inner ? INNER_BODIES : CYLINDER_BODIES);
    expect(valid.ok ? valid.plan.cylindricalRadius : valid.rejections).toBe(10);
    expect(planFilletWeldEdit(read.document, edit, REVISIONS, BODIES).ok).toBe(false);
  });

  it('ビードの台本・材質・配置・組を書いて読み戻し、同じ形に組み直す', () => {
    const document = weldedTee();
    const read = readAssemblyDocument(writeAssemblyDocument(document));
    if (!read.ok) throw new Error(JSON.stringify(read));
    expect(summary(read.document)).toEqual(summary(document));
    const beads = read.document.components.filter((component) => component.source.kind === 'standardPart');
    expect(beads.map((component) => component.materialId)).toEqual(['stainless', 'stainless']);
    for (const bead of beads) {
      const original = document.components.find((component) => component.id === bead.id);
      if (bead.source.kind !== 'standardPart' || original?.source.kind !== 'standardPart') throw new Error('not standard');
      expect(buildStandardPartFromSource(bead.source)).toEqual(buildStandardPartFromSource(original.source));
    }
  });

  it('読み戻した文書でも溶接を直せる(保存した配置から同じ溶接線に戻る)', () => {
    const read = readAssemblyDocument(writeAssemblyDocument(weldedTee()));
    if (!read.ok) throw new Error(JSON.stringify(read));
    expect([...weldSegmentsOf(read.document).keys()]).toEqual(['weld-1']);
    const edit = planFilletWeldEdit(read.document, {
      weldId: 'weld-1', legOnSecond: 6, legOnFirst: 8, segments: [{ start: 0, length: 100 }], materialId: 'stainless',
    }, REVISIONS, BODIES);
    if (!edit.ok) throw new Error(JSON.stringify(edit.rejections));
    edit.plan.frame.origin.forEach((value, index) => expect(value).toBeCloseTo([0, 34, 10][index] ?? Number.NaN, 9));
    expect(edit.plan.contactLength).toBe(100);
  });
});

/**
 * 直角でない当たり: 立板の面 y=0(外向き (0,−1,0)、x 0〜100、z 0〜50)を下の辺を軸に X まわりに 30° 回して (0,0,10) に
 * 置き、底板の上面 z=10(x 0〜100、y −40〜0)に当てる。内角 60°。
 */
const OBLIQUE_BODIES: WeldBodyLookup = (component) => component.source.kind !== 'part' ? null
  : component.source.partRef === 'standing' ? [planeBody([[0, 0, 0], [100, 0, 0], [100, 0, 50], [0, 0, 50]], [0, -1, 0])]
    : component.source.partRef === 'base' ? [planeBody([[0, -40, 10], [100, -40, 10], [100, 0, 10], [0, 0, 10]], [0, 0, 1])] : null;

function weldedObliqueTee(): AssemblyDocument {
  const half = Math.PI / 12;
  let document = createAssemblyDocument('斜めの溶接');
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'standing' },
    { placement: { ...placement([0, 0, 10]), rotation: [Math.sin(half), 0, 0, Math.cos(half)] } }));
  document = addComponent(document, createComponentFor(document, { kind: 'part', partRef: 'base' }, { placement: placement([0, 0, 0]) }));
  const face = (componentId: string, partRef: string, centroid: Vec3, normal: Vec3): FilletWeldRequest['first'] => ({
    componentId, sourceKey: `part:${partRef}@${REVISIONS.get(partRef) ?? ''}`, centroid, normal,
    face: { bodyFeatureId: 'extrude-1', index: 0, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 100, position: centroid, axis: normal, radius: null } },
  });
  const planned = planFilletWeld(document, {
    first: face('component-1', 'standing', [50, 0, 25], [0, -1, 0]),
    second: face('component-2', 'base', [50, -20, 10], [0, 0, 1]),
    edge: { midpoint: [50, 0, 0], direction: [1, 0, 0], length: 100,
      edge: { bodyFeatureId: 'extrude-1', index: 0, fingerprint: { kind: 'edge', curveKind: 'line', length: 100, position: [50, 0, 0], axis: [1, 0, 0], radius: null } } },
    legOnSecond: 6, legOnFirst: 8, segments: [{ start: 5, length: 12.5 }, { start: 60, length: 30 }], materialId: 'stainless',
  }, REVISIONS, OBLIQUE_BODIES);
  if (!planned.ok) throw new Error(JSON.stringify(planned.rejections));
  const applied = applyFilletWeld(document, planned.plan, REVISIONS);
  if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
  return applied.document;
}

describe('直角でない当たりのビードの保存と読込み', () => {
  it('内角の欄と版を保ったまま書いて読み戻し、同じ斜めの断面に組み直し、読み戻した文書でも内角を保って直せる', () => {
    const document = weldedObliqueTee();
    const read = readAssemblyDocument(writeAssemblyDocument(document));
    if (!read.ok) throw new Error(JSON.stringify(read));
    expect(summary(read.document)).toEqual(summary(document));
    const beads = read.document.components.filter((component) => component.source.kind === 'standardPart');
    expect(beads).toHaveLength(2);
    for (const bead of beads) {
      const original = document.components.find((component) => component.id === bead.id);
      if (bead.source.kind !== 'standardPart' || original?.source.kind !== 'standardPart') throw new Error('not standard');
      expect(bead.source.generatorRevision).toBe('fillet-weld-2');
      expect(Number(bead.source.options.weldAngle)).toBeCloseTo(60, 9);
      expect(buildStandardPartFromSource(bead.source)).toEqual(buildStandardPartFromSource(original.source));
    }
    const edit = planFilletWeldEdit(read.document, {
      weldId: 'weld-1', legOnSecond: 6, legOnFirst: 8, segments: [{ start: 0, length: 100 }], materialId: 'stainless',
    }, REVISIONS, OBLIQUE_BODIES);
    if (!edit.ok) throw new Error(JSON.stringify(edit.rejections));
    expect(edit.plan.interiorAngle?.degrees).toBeCloseTo(60, 9);
    edit.plan.frame.origin.forEach((value, index) => expect(value).toBeCloseTo([100, 0, 10][index] ?? Number.NaN, 9));
  });
});

/** 立板・底板の id を読点・印の頭・`%`・`:` を含む利用者の名付けにして溶接した T 継手。 */
function namedWeldedTee(first: string, second: string): AssemblyDocument {
  let document = createAssemblyDocument('名付けた溶接');
  document = addComponent(document, { ...createComponentFor(document, { kind: 'part', partRef: 'standing' }, { placement: placement([0, 26, 10]) }), id: first });
  document = addComponent(document, { ...createComponentFor(document, { kind: 'part', partRef: 'base' }, { placement: placement([0, 0, 0]) }), id: second });
  const face = (componentId: string, partRef: string, centroid: Vec3, normal: Vec3): FilletWeldRequest['first'] => ({
    componentId, sourceKey: `part:${partRef}@${REVISIONS.get(partRef) ?? ''}`, centroid, normal,
    face: { bodyFeatureId: 'extrude-1', index: 0, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 100, position: centroid, axis: normal, radius: null } },
  });
  const planned = planFilletWeld(document, {
    first: face(first, 'standing', [50, 8, 25], [0, 1, 0]), second: face(second, 'base', [50, 30, 10], [0, 0, 1]),
    edge: { midpoint: [50, 8, 0], direction: [1, 0, 0], length: 100,
      edge: { bodyFeatureId: 'extrude-1', index: 0, fingerprint: { kind: 'edge', curveKind: 'line', length: 100, position: [50, 8, 0], axis: [1, 0, 0], radius: null } } },
    legOnSecond: 6, legOnFirst: 8, segments: [{ start: 5, length: 12.5 }, { start: 60, length: 30 }], materialId: 'stainless',
  }, REVISIONS, BODIES);
  if (!planned.ok) throw new Error(JSON.stringify(planned.rejections));
  const applied = applyFilletWeld(document, planned.plan, REVISIONS);
  if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
  return applied.document;
}

describe('読点を含む部品の id の溶接の保存と読込み', () => {
  // 期待する欄は手で書いた(読点を含む時だけ `v2:<1つ目>:<2つ目>`、id の中の `%`・`,`・`:` は `%25`・`%2C`・`%3A`)。
  it.each([
    ['立板,左', 'v2:底板%2C:1', 'v2:立板%2C左:v2%3A底板%252C%3A1'],
    ['plate', 'base,A,B', 'v2:plate:base%2CA%2CB'],
    ['v2:a', 'b%2C', 'v2:a,b%2C'],
  ])('2部品の id (%s / %s) を保存の欄 %s で書き、読み戻した文書で同じ2部品の溶接として直せる', (first, second, stored) => {
    const document = namedWeldedTee(first, second);
    const text = writeAssemblyDocument(document);
    const read = readAssemblyDocument(text);
    if (!read.ok) throw new Error(JSON.stringify(read));
    expect(summary(read.document)).toEqual(summary(document));
    const beads = read.document.components.filter((component) => component.source.kind === 'standardPart');
    expect(beads.map((bead) => (bead.source.kind === 'standardPart' ? bead.source.options.weldParts : null))).toEqual([stored, stored]);
    for (const bead of beads) {
      const original = document.components.find((component) => component.id === bead.id);
      if (bead.source.kind !== 'standardPart' || original?.source.kind !== 'standardPart') throw new Error('not standard');
      expect(buildStandardPartFromSource(bead.source)).toEqual(buildStandardPartFromSource(original.source));
    }
    const edit = planFilletWeldEdit(read.document, {
      weldId: 'weld-1', legOnSecond: 5, legOnFirst: 5, segments: [{ start: 0, length: 100 }], materialId: 'stainless',
    }, REVISIONS, BODIES);
    if (!edit.ok) throw new Error(JSON.stringify(edit.rejections));
    expect([edit.plan.firstComponentId, edit.plan.secondComponentId]).toEqual([first, second]);
    const edited = applyFilletWeld(read.document, edit.plan, REVISIONS);
    if (!edited.ok) throw new Error(JSON.stringify(edited.rejections));
    // 直した文書を保存し直しても、同じ欄で2部品を指す。
    const reread = readAssemblyDocument(writeAssemblyDocument(edited.document));
    if (!reread.ok) throw new Error(JSON.stringify(reread));
    const rebeads = reread.document.components.filter((component) => component.source.kind === 'standardPart');
    expect(rebeads.map((bead) => (bead.source.kind === 'standardPart' ? [bead.source.size, bead.source.options.weldParts] : null)))
      .toEqual([['5x5', stored]]);
  });
});

/*
 * EX-08.PERSIST: the welded tees above (planned and applied by the product functions, as the store does it), saved,
 * reopened from older envelopes, and re-derived from the reopened inputs. Hand-derived for weldedTee(): beads at
 * stations 5 and 60 with lengths 12.5 and 30 (gap 60 - 17.5 = 42.5) on the 100 mm contact, legs 6 / 8, total 42.5,
 * nominal volume 6 x 8 / 2 x 42.5 = 1020 mm^3; the second bead shortened to 20 gives 6 x 8 / 2 x 32.5 = 780 mm^3.
 */

const PERSIST_SAVED_AT = '2026-10-24T00:00:00.000Z';

/** The same saved file in an older envelope (the schema and document version an earlier release wrote). */
function olderEnvelope(text: string, schema: number): string {
  const envelope = JSON.parse(text) as Readonly<Record<string, unknown>> & { readonly document: Readonly<Record<string, unknown>> };
  return JSON.stringify({ ...envelope, schema, document: { ...envelope.document, schemaVersion: schema } });
}

function reopened(text: string): AssemblyDocument {
  const read = readAssemblyDocument(text);
  if (!read.ok) throw new Error(JSON.stringify(read.error));
  return read.document;
}

describe('EX-08.PERSIST 旧版の封筒と、開き直した入力からの導出', () => {
  it.each([
    ['直角(版 1)', () => weldedTee(), 'fillet-weld-1'],
    ['斜め 60°(版 2)', () => weldedObliqueTee(), 'fillet-weld-2'],
    ['円筒の外側(版 3)', () => weldedTee(true), 'fillet-weld-3'],
    ['円筒の内側(版 4)', () => weldedTee(true, true), 'fillet-weld-4'],
  ] as const)('%s のビードを schema 17・21 の封筒に入れたファイルも、同じ文書として読み、今の版で同じバイトに書き戻す', (_name, make, revision) => {
    const document = make();
    expect(document.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
    const text = writeAssemblyDocument(document, { savedAt: PERSIST_SAVED_AT });
    for (const schema of [17, 21]) {
      const old = olderEnvelope(text, schema);
      expect(JSON.parse(old)).toMatchObject({ schema, document: { schemaVersion: schema } });
      const read = reopened(old);
      expect(read.schemaVersion).toBe(PCAD_SCHEMA_VERSION);
      expect(summary(read)).toEqual(summary(document));
      expect(writeAssemblyDocument(read, { savedAt: PERSIST_SAVED_AT })).toBe(text);
      const beads = read.components.filter((component) => component.source.kind === 'standardPart');
      expect(beads.map((bead) => (bead.source.kind === 'standardPart' ? bead.source.generatorRevision : null)))
        .toEqual([revision, revision]);
    }
  });

  it('開き直した入力(脚長・区間・材質・配置の溶接線)から同じビードと公称体積を導き、長さを変えると体積と形が変わる', () => {
    const document = weldedTee();
    const read = reopened(writeAssemblyDocument(document, { savedAt: PERSIST_SAVED_AT }));
    const beads = weldSegmentsOf(read).get('weld-1') ?? [];
    // 入力の照合: ビード 2 本(始点 5・60、長さ 12.5・30)、脚長 6 / 8、当たり 100、溶接した 2 部品、材質。
    expect(beads.map((bead) => (bead.source.kind === 'standardPart'
      ? [bead.id, bead.source.size, filletWeldSegmentOptions(bead.source.options)] : null))).toEqual([
      ['component-3', '6x8', { weldId: 'weld-1', segment: 0, station: 5, length: 12.5, contactLength: 100,
        parts: ['component-1', 'component-2'] }],
      ['component-4', '6x8', { weldId: 'weld-1', segment: 1, station: 60, length: 30, contactLength: 100,
        parts: ['component-1', 'component-2'] }],
    ]);
    expect(beads.map((bead) => bead.materialId)).toEqual(['stainless', 'stainless']);

    const request: FilletWeldEditRequest = { weldId: 'weld-1', legOnSecond: 6, legOnFirst: 8,
      segments: [{ start: 5, length: 12.5 }, { start: 60, length: 30 }], materialId: 'stainless' };
    const before = planFilletWeldEdit(document, request, REVISIONS, BODIES);
    const after = planFilletWeldEdit(read, request, REVISIONS, BODIES);
    if (!before.ok || !after.ok) throw new Error(JSON.stringify([before, after]));
    expect(after.plan.totalLength).toBe(42.5);
    expect(after.plan.nominalVolume).toBeCloseTo(1020, 9);
    // 保存前の文書と同じ溶接線(配置から戻した座標系)・当たり・置き換える区間の計画。
    expect(after.plan).toEqual(before.plan);
    // 同じ入力で組み直すと、保存したビードと同じ台本・配置・材質(導出は入力に結び付く)。id は古いものを使わない。
    const rebuilt = applyFilletWeld(read, after.plan, REVISIONS);
    if (!rebuilt.ok) throw new Error(JSON.stringify(rebuilt.rejections));
    const rebuiltBeads = weldSegmentsOf(rebuilt.document).get('weld-1') ?? [];
    expect(rebuiltBeads.map((bead) => bead.id)).toEqual(['component-5', 'component-6']);
    expect(rebuiltBeads.map((bead) => [bead.source, bead.placement, bead.materialId]))
      .toEqual(beads.map((bead) => [bead.source, bead.placement, bead.materialId]));

    // 2 本目の長さを 30 -> 20 に変えると、公称体積は 780 になり、その区間の台本と形だけが変わる。
    const shorter = planFilletWeldEdit(read, { ...request, segments: [{ start: 5, length: 12.5 }, { start: 60, length: 20 }] },
      REVISIONS, BODIES);
    if (!shorter.ok) throw new Error(JSON.stringify(shorter.rejections));
    expect(shorter.plan.totalLength).toBe(32.5);
    expect(shorter.plan.nominalVolume).toBeCloseTo(780, 9);
    const changed = applyFilletWeld(read, shorter.plan, REVISIONS);
    if (!changed.ok) throw new Error(JSON.stringify(changed.rejections));
    const [first, second] = weldSegmentsOf(changed.document).get('weld-1') ?? [];
    expect([first?.source, first?.placement]).toEqual([beads[0]?.source, beads[0]?.placement]);
    if (second?.source.kind !== 'standardPart' || beads[1]?.source.kind !== 'standardPart') throw new Error('bead missing');
    expect(second.source.options.length).toBe('20');
    expect(second.placement).toEqual(beads[1].placement);
    expect(buildStandardPartFromSource(second.source)).not.toEqual(buildStandardPartFromSource(beads[1].source));
    const resaved = reopened(writeAssemblyDocument(changed.document, { savedAt: PERSIST_SAVED_AT }));
    expect(summary(resaved)).toEqual(summary(changed.document));
  });
});
