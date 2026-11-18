/**
 * フレームの締結の入口(J-02 P6b・P7)の検査: 組立の部品から溝つきのフレームの候補を作り(隠した・抑制した・溝の無い部品は入れない、
 * 絞りの部品だけ)、溝の呼びの幅を行から読み(汎用の族は null)、穴ごとに頭(入口の無い穴は座の深さ 0、ざぐりの穴は座の深さつき)を
 * 決めて計画を 1 つにまとめる事。1 つでも断られたら計画を返さず、穴の番号つきの理由を返す事。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import { beforeAll, describe, expect, it } from 'vitest';

import { T_SLOT_NUT_FAMILY } from '../catalog/families/framePartCatalog.js';
import { T_SLOT_NUT_RECORDS } from '../catalog/families/framePartRows.js';
import { SOCKET_HEAD_CAP_SCREW_FAMILY } from '../catalog/families/socketHeadCapScrew.js';
import { T_SLOT_FRAME_FAMILY } from '../catalog/families/tSlotFrame.js';
import { T_SLOT_CATALOG_FAMILIES } from '../catalog/families/tSlotFrameCatalog.js';
import { PRODUCT_CATALOG_REGISTRY, type CatalogRegistry } from '../catalog/registry.js';
import { createCatalogItemSource } from '../catalog/source.js';
import type { CatalogFamily, CatalogItemRow } from '../catalog/types.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import { planFrameMembers } from '../frame/frameMembers.js';
import type { RigidPlacement } from '../placementMath.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { componentSourceKey } from './frames.js';
import type { EntryHoleSelection } from './holeEntryTypes.js';
import { frameSlotCandidates, planFrameSlotHoles, profileClearanceHole } from './frameSlotRequest.js';
import type { SolidEdgeEntry, SolidFaceEntry } from '../../kernelBridge/solidContracts.js';

const FAMILY = T_SLOT_CATALOG_FAMILIES.s6;
const ROW = FAMILY.rows.find((row) => row.key === 's6-20x20');
const REVISIONS: ReadonlyMap<string, string> = new Map([['plate', 'r1']]);
const DEFAULT_RIGID: RigidPlacement = { position: [0, 0, 0], rotation: [0, 0, 0, 1] };

/** 線 (0,0,0)-(500,0,0) に置いた部材と、その配置。 */
function placedFrame(id: string): { readonly component: AssemblyComponent; readonly placement: RigidPlacement; readonly top: number } {
  if (ROW === undefined) throw new Error('row');
  const bounds = FAMILY.sectionBounds?.(ROW, { length: '500' });
  if (bounds === null || bounds === undefined) throw new Error('bounds');
  const plan = planFrameMembers([{ start: [0, 0, 0], end: [500, 0, 0] }], { section: bounds, up: [0, 0, 1], startExtension: 0,
    endExtension: 0, corners: 'none' });
  const member = plan.ok ? plan.members[0] : undefined;
  if (member === undefined) throw new Error('member');
  const [x, y, z] = member.placement.position;
  return { component: { id, name: id, source: createCatalogItemSource(FAMILY, ROW, { length: String(member.lengthMm) }), fixed: true,
    placement: { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)],
      rotation: member.placement.rotation }, visible: true, suppressed: false },
  placement: member.placement, top: (bounds.maxY - bounds.minY) / 2 };
}

function plate(): AssemblyComponent {
  return { id: 'plate', name: 'plate', source: { kind: 'part', partRef: 'plate' }, placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false,
    visible: true, suppressed: false };
}

/** 板の合わせ面(下の面)の上の通し穴。`entry` はざぐり(頭側の面からの深さ)。 */
function hole(component: AssemblyComponent, point: Vec3, thickness: number, entry?: EntryHoleSelection['entry']): EntryHoleSelection {
  const key = componentSourceKey(component, REVISIONS);
  if (key === null) throw new Error('key');
  const matingFace: SubShapeRef = { bodyFeatureId: 'plate', index: 0, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1,
    position: point, axis: [0, 0, -1], radius: null } };
  return { componentId: component.id, sourceKey: key, holeFeatureId: 'hole', matingFace, hole: { kind: 'clearance', diameter: 6,
    length: thickness }, axisOrigin: point, axisDirection: [0, 0, 1], matingFaceNormal: [0, 0, -1], ...(entry === undefined ? {} : { entry }) };
}

beforeAll(async () => {
  await PRODUCT_CATALOG_REGISTRY.ensure(['socket-head-cap-screw', 't-slot-nut', FAMILY.id, T_SLOT_FRAME_FAMILY.id]);
});

describe('フレームの締結の入口', () => {
  it('溝つきのフレームだけを候補にし(隠した・抑制した部品と絞りの外は入れない)、溝の呼びの幅を行から読む', () => {
    const frame = placedFrame('frame');
    const hidden = { ...placedFrame('hidden').component, visible: false };
    const document: AssemblyDocument = { ...createAssemblyDocument('締結'), components: [frame.component, hidden, plate()] };
    const placements = new Map([['frame', frame.placement], ['hidden', frame.placement], ['plate', DEFAULT_RIGID]]);
    const all = frameSlotCandidates(document, placements);
    expect(all.map((candidate) => [candidate.componentId, candidate.slotWidth, candidate.lines.length > 0])).toEqual([['frame', 6, true]]);
    expect(frameSlotCandidates(document, placements, new Set(['plate']))).toEqual([]);
    // 寸法を指定する汎用の族は溝を持つが、溝の呼びの幅が決まらない(計画が slotWidthUnknown で断る)。
    const specifiedRow = T_SLOT_FRAME_FAMILY.rows.at(0);
    if (specifiedRow === undefined) throw new Error('row');
    const specified: AssemblyComponent = { ...plate(), id: 'specified', source: createCatalogItemSource(T_SLOT_FRAME_FAMILY, specifiedRow,
      { length: '500' }) };
    const generic = frameSlotCandidates({ ...document, components: [specified] }, new Map([['specified', DEFAULT_RIGID]]));
    expect(generic.map((candidate) => [candidate.componentId, candidate.slotWidth])).toEqual([['specified', null]]);
  });

  it('ざぐりの穴は座の深さを引いた厚さでボルトを選び、頭を座に置く(厚さ 10 の通し穴と、厚さ 15・ざぐり 5 の穴は同じ長さ・同じ頭の高さ)', () => {
    const frame = placedFrame('frame');
    const board = plate();
    const document: AssemblyDocument = { ...createAssemblyDocument('締結'), components: [frame.component, board] };
    const frames = frameSlotCandidates(document, new Map([['frame', frame.placement]]));
    const plain = hole(board, [100, 0, frame.top], 10);
    const bored = hole(board, [200, 0, frame.top], 15, { kind: 'counterbore', diameter: 11, depth: 5, side: 'outer' });
    const result = planFrameSlotHoles(document, { holes: [plain, bored], frames, choices: { nominal: 'M5', nutEntry: '後入れ', nutMaterial: 'steel' },
      nutFamily: T_SLOT_NUT_FAMILY, nutRecords: T_SLOT_NUT_RECORDS, partRevisions: REVISIONS });
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    const [first, second] = result.entries;
    expect([first?.holeIndex, second?.holeIndex]).toEqual([0, 1]);
    // 頭の上の面の高さ = 合わせ面 + (厚さ − 座の深さ) + 頭の高さ(六角穴付きボルトの行の値)。
    const headHeight = SOCKET_HEAD_CAP_SCREW_FAMILY.rows.find((row) => row.size === 'M5')?.dims.headHeight ?? NaN;
    const topOf = (z: { readonly value: number } | undefined): number => z?.value ?? NaN;
    expect(topOf(first?.bolt.placement.position[2])).toBeCloseTo(frame.top + 10 + headHeight, 9);
    expect(topOf(second?.bolt.placement.position[2])).toBeCloseTo(frame.top + 10 + headHeight, 9);
    expect(second?.bolt.length).toBe(first?.bolt.length);
  });

  it('1 つでも断られたら計画を返さず、穴の番号つきの理由を返す(表に無い呼びは頭の理由)', () => {
    const frame = placedFrame('frame');
    const board = plate();
    const document: AssemblyDocument = { ...createAssemblyDocument('締結'), components: [frame.component, board] };
    const frames = frameSlotCandidates(document, new Map([['frame', frame.placement]]));
    const inputs = { frames, nutFamily: T_SLOT_NUT_FAMILY, nutRecords: T_SLOT_NUT_RECORDS, partRevisions: REVISIONS };
    const offSlot = planFrameSlotHoles(document, { ...inputs, holes: [hole(board, [100, 0, frame.top], 10), hole(board, [200, 3, frame.top], 10)],
      choices: { nominal: 'M5', nutEntry: '後入れ', nutMaterial: 'steel' } });
    expect(offSlot.ok ? null : offSlot.failures.map((failure) => [failure.holeIndex, failure.code])).toEqual([[1, 'offSlot']]);
    const unknown = planFrameSlotHoles(document, { ...inputs, holes: [hole(board, [100, 0, frame.top], 4)],
      choices: { nominal: 'M99', nutEntry: '後入れ', nutMaterial: 'steel' } });
    expect(unknown.ok ? null : unknown.failures.map((failure) => [failure.holeIndex, failure.code])).toEqual([[0, 'noBoltLength']]);
  });
});


/** 板(z = 0〜6)の下の面 0・上の面 1 と、それを軸 +Z で貫く全周の内側の円筒 2(径 6。上下の面と辺を共有)。 */
function face(index: number, entry: Partial<SolidFaceEntry> & Pick<SolidFaceEntry, 'surfaceKind' | 'axis'>): SolidFaceEntry {
  return { index, area: 100, centroid: [40, 5, 0], radius: null, triangleOffset: 0, triangleCount: 0, ...entry };
}
const BOTTOM = face(0, { surfaceKind: 'plane', axis: [0, 0, -1], centroid: [40, 5, 0] });
const TOP = face(1, { surfaceKind: 'plane', axis: [0, 0, 1], centroid: [40, 5, 6] });
const BORE = face(2, { surfaceKind: 'cylinder', axis: [0, 0, 1], axisOrigin: [10, 0, 3], cylinderSpan: [-3, 3], cylinderExterior: false,
  radius: 3, centroid: [10, 0, 3], adjacentFaces: [0, 1] });

describe('穴のフィーチャーで作っていない通し穴(断面の輪の穴)', () => {
  const board = plate();
  const matingRef: SubShapeRef = { bodyFeatureId: 'plate', index: 0, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 100,
    position: [40, 5, 0], axis: [0, 0, -1], radius: null } };
  const read = (mating: SolidFaceEntry, hole: SolidFaceEntry = BORE, others: readonly SolidFaceEntry[] = []) =>
    profileClearanceHole(board, REVISIONS, { holeFeatureId: 'extrude-1', hole, mating, matingRef, bodyFaces: [BOTTOM, TOP, hole, ...others], bodyEdges: [] });

  it('全周の内側の円筒 1 つと帯の両端の平面: 合わせ面が下の端なら軸を板の中(+Z)へ向け、上の端なら −Z へ向ける', () => {
    const below = read(BOTTOM);
    expect(typeof below === 'string' || 'code' in below ? below
      : [below.axisOrigin, below.axisDirection, below.hole]).toEqual([[10, 0, 0], [0, 0, 1], { kind: 'clearance', diameter: 6, length: 6 }]);
    const above = read(TOP);
    expect(typeof above === 'string' || 'code' in above ? above : above.axisDirection).toEqual([-0, -0, -1]);
  });

  it('長穴・切り欠き(全周でない円筒)、外側の円筒、円筒でない面は通し穴にしない', () => {
    expect(read(BOTTOM, { ...BORE, cylinderSpan: null })).toBe('partialCylinder');
    expect(read(BOTTOM, { ...BORE, cylinderExterior: true })).toBe('exteriorCylinder');
    expect(read(BOTTOM, { ...BORE, surfaceKind: 'plane' })).toBe('notCylinder');
  });

  it('合わせ面が平面でない・軸に直交しない・帯の端にない時は断る', () => {
    expect(read({ ...BOTTOM, surfaceKind: 'cylinder' })).toBe('matingNotPlane');
    expect(read({ ...BOTTOM, axis: [1, 0, 0] })).toBe('matingNotPerpendicular');
    expect(read({ ...BOTTOM, centroid: [40, 5, 2] })).toBe('matingNotAtEnd');
  });

  it('反対の端に直交する平面が無い穴(止まり穴)と、途中で径が変わる穴(同じ軸の径の違う円筒・円錐)は断る', () => {
    const blind = profileClearanceHole(board, REVISIONS, { holeFeatureId: 'extrude-1', hole: { ...BORE, adjacentFaces: [0] }, mating: BOTTOM,
      matingRef, bodyFaces: [BOTTOM, { ...BORE, adjacentFaces: [0] }], bodyEdges: [] });
    expect(blind).toBe('oppositeEndMissing');
    const counterbore = face(3, { surfaceKind: 'cylinder', axis: [0, 0, 1], axisOrigin: [10, 0, 5], cylinderSpan: [-1, 1], radius: 5,
      cylinderExterior: false });
    expect(read(BOTTOM, BORE, [counterbore])).toBe('steppedHole');
    const countersink = face(3, { surfaceKind: 'cone', axis: [0, 0, 1], axisOrigin: [10, 0, 6] });
    expect(read(BOTTOM, BORE, [countersink])).toBe('steppedHole');
    // 同じ軸でも、同じ径の小片(縫い目で分かれた同じ穴)は段にしない。
    expect(typeof read(BOTTOM, BORE, [{ ...BORE, index: 4 }])).toBe('object');
  });

  it('部品の出どころの版が分からない時は、締結と同じ断り(missingSourceRevision)を返す', () => {
    const result = profileClearanceHole(board, new Map(), { holeFeatureId: 'extrude-1', hole: BORE, mating: BOTTOM, matingRef,
      bodyFaces: [BOTTOM, TOP, BORE], bodyEdges: [] });
    expect(typeof result === 'object' && 'code' in result ? result.code : null).toBe('missingSourceRevision');
  });
});

/**
 * 断面の輪の円を弧に分けて押し出した穴の壁(全周でない内側の円筒)。`count` 等分した `part` 番目の面で、軸 +Z・径 3・板 z = 0〜6。
 * 面は前後の弧の面と上下の面(0・1)と辺を共有し、縁は帯の両端の円弧 2 本(辺の番号は面ごとに 2 つ)。
 */
function arcWall(index: number, part: number, count: number, options: { readonly x?: number; readonly radius?: number;
  readonly neighbours?: readonly number[]; readonly edges?: boolean } = {}): SolidFaceEntry {
  const radius = options.radius ?? 3, x = options.x ?? 10, angle = 2 * Math.PI / count;
  return face(index, { surfaceKind: 'cylinder', axis: [0, 0, 1], axisOrigin: [x, 0, 3], cylinderSpan: null, cylinderAxialExtent: [-3, 3],
    cylinderExterior: false, radius, area: angle * radius * 6, centroid: [x, 0, 3], adjacentFaces: [...(options.neighbours ?? []), 0, 1],
    ...(options.edges === false ? {} : { boundaryEdgeIndices: [100 + 2 * part, 101 + 2 * part] }) });
}

/** 弧の面 `part` の縁の円弧 2 本(帯の下の端 z = 0 と上の端 z = 6。長さは 角度 × 径)。 */
function arcEdges(part: number, count: number, x = 10, radius = 3): SolidEdgeEntry[] {
  const length = 2 * Math.PI / count * radius;
  return [0, 6].map((z, end): SolidEdgeEntry => ({ index: 100 + 2 * part + end, curveKind: 'circle', length, midpoint: [x + radius, 0, z],
    start: [x + radius, 0, z], end: [x - radius, 0, z], axis: [0, 0, 1], axisOrigin: [x, 0, z], radius, segmentOffset: 0, segmentCount: 0 }));
}

describe('弧に分かれた輪の穴(資料のブラケットは輪の円を半円 2 つで作る)', () => {
  const board = plate();
  const matingRef: SubShapeRef = { bodyFeatureId: 'plate', index: 0, fingerprint: { kind: 'face', surfaceKind: 'plane',
    area: 100, position: [40, 5, 0], axis: [0, 0, -1], radius: null } };
  const read = (hole: SolidFaceEntry, faces: readonly SolidFaceEntry[], edges: readonly SolidEdgeEntry[]) =>
    profileClearanceHole(board, REVISIONS, { holeFeatureId: 'extrude-1', hole, mating: BOTTOM, matingRef, bodyFaces: [BOTTOM, TOP, ...faces],
      bodyEdges: edges });

  it('半円 2 面・3 等分の 3 面で全周を閉じる穴は、1 つの通し穴(径 6・長さ 6)と読む', () => {
    const halves = [arcWall(2, 0, 2, { neighbours: [3] }), arcWall(3, 1, 2, { neighbours: [2] })];
    const two = read(halves[0] ?? BORE, halves, [...arcEdges(0, 2), ...arcEdges(1, 2)]);
    expect(typeof two === 'string' || 'code' in two ? two : two.hole).toEqual({ kind: 'clearance', diameter: 6, length: 6 });
    const thirds = [arcWall(2, 0, 3, { neighbours: [3, 4] }), arcWall(3, 1, 3, { neighbours: [2, 4] }), arcWall(4, 2, 3, { neighbours: [2, 3] })];
    const three = read(thirds[0] ?? BORE, thirds, [...arcEdges(0, 3), ...arcEdges(1, 3), ...arcEdges(2, 3)]);
    expect(typeof three === 'string' || 'code' in three ? three : three.hole).toEqual({ kind: 'clearance', diameter: 6, length: 6 });
  });

  it('長穴(軸の違う半円 2 面が平面でつながる)・切り欠き(半円 1 面)・径の違う半円 2 面・軸のずれた半円 2 面は断る', () => {
    const slot = [arcWall(2, 0, 2, { neighbours: [5] }), arcWall(3, 1, 2, { x: 20, neighbours: [6] })];
    expect(read(slot[0] ?? BORE, slot, [...arcEdges(0, 2), ...arcEdges(1, 2, 20)])).toBe('partialCylinder');
    const notch = arcWall(2, 0, 2);
    expect(read(notch, [notch], arcEdges(0, 2))).toBe('partialCylinder');
    const radii = [arcWall(2, 0, 2, { neighbours: [3] }), arcWall(3, 1, 2, { radius: 4, neighbours: [2] })];
    expect(read(radii[0] ?? BORE, radii, [...arcEdges(0, 2), ...arcEdges(1, 2, 10, 4)])).toBe('partialCylinder');
    const shifted = [arcWall(2, 0, 2, { neighbours: [3] }), arcWall(3, 1, 2, { x: 10.5, neighbours: [2] })];
    expect(read(shifted[0] ?? BORE, shifted, [...arcEdges(0, 2), ...arcEdges(1, 2, 10.5)])).toBe('partialCylinder');
  });

  it('面積は全周でも縁の円弧が全周にならない輪(縁の辺の表が無い・弧が半分しか無い)は、閉じていると言えないので断る', () => {
    const halves = [arcWall(2, 0, 2, { neighbours: [3], edges: false }), arcWall(3, 1, 2, { neighbours: [2] })];
    expect(read(halves[0] ?? BORE, halves, [...arcEdges(0, 2), ...arcEdges(1, 2)])).toBe('partialCylinder');
    const quarters = [arcWall(2, 0, 4, { neighbours: [3] }), arcWall(3, 1, 4, { neighbours: [2] })];
    expect(read(quarters[0] ?? BORE, quarters, [...arcEdges(0, 4), ...arcEdges(1, 4)])).toBe('partialCylinder');
  });
});

describe('溝の位置の簡略の印', () => {
  it('行の簡略の印の鍵に溝の位置の対称の簡略(slotPositionSymmetric)がある時だけ、候補に印を付ける(印の文では見分けない)', () => {
    if (ROW === undefined) throw new Error('row');
    const frame = placedFrame('frame');
    const document: AssemblyDocument = { ...createAssemblyDocument('締結'), components: [frame.component] };
    const placements = new Map([['frame', frame.placement]]);
    const flagOf = (row: CatalogItemRow): readonly (boolean | undefined)[] => {
      const family: CatalogFamily = { ...FAMILY, rows: FAMILY.rows.map((candidate) => (candidate.key === row.key ? row : candidate)) };
      const registry: CatalogRegistry = { entries: [], entry: () => undefined, loaded: (id) => (id === FAMILY.id ? family : undefined),
        ensure: () => Promise.resolve() };
      return frameSlotCandidates(document, placements, null, registry).map((candidate) => candidate.slotPositionSimplified);
    };
    expect(flagOf({ ...ROW, simplified: ['溝の位置'], simplifiedKinds: ['slotPositionSymmetric'] })).toEqual([true]);
    expect(flagOf({ ...ROW, simplified: ['溝の位置'] })).toEqual([false]);
    expect(flagOf(ROW)).toEqual([false]);
  });
});
