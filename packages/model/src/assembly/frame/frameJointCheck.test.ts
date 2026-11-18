/**
 * 接合チェック(E-09)の検査: 接続ごとの留め方(記録・溝の締結・剛体のまとまり・片側だけ・留めていない)と、どこにも留められていない部材、
 * 上限を超えた時に調べない事(手で起動した時は調べる)。溝の締結は、今のフレームの溝への締結の計画で置いたナットとボルトから、
 * 位置で判定する(置く処理の向きの決まりと、判定の決まりが合っている事を確かめる)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import { beforeAll, describe, expect, it } from 'vitest';

import { T_SLOT_NUT_FAMILY } from '../catalog/families/framePartCatalog.js';
import { T_SLOT_NUT_RECORDS } from '../catalog/families/framePartRows.js';
import { T_SLOT_CATALOG_FAMILIES } from '../catalog/families/tSlotFrameCatalog.js';
import { PRODUCT_CATALOG_REGISTRY } from '../catalog/registry.js';
import { createCatalogItemSource } from '../catalog/source.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import { applyFrameSlotFastening, planFrameSlotFastening, type FrameSlotCandidate } from '../fastening/frameSlotFastening.js';
import { componentSourceKey, rigidPlacementOf } from '../fastening/frames.js';
import { entryHeadSpec } from '../fastening/holeEntry.js';
import type { FasteningHoleSelection } from '../fastening/types.js';
import type { RigidPlacement } from '../placementMath.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import { planFrameMembers } from './frameMembers.js';
import { checkFrameJoints, slotFastenerParts, type PartBox } from './frameJointCheck.js';
import { classifyFrameJoints, placedFrameMembers, type FrameJoint, type PlacedFrameMember } from './frameJoints.js';

type FrameJointCheckInput = Parameters<typeof checkFrameJoints>[0];

function part(id: string, rigidGroupId?: string): AssemblyComponent {
  return { id, name: id, source: { kind: 'part', partRef: id }, placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true,
    suppressed: false, ...(rigidGroupId === undefined ? {} : { rigidGroupId }) };
}

/** 溝の無い 20×20 の部材(判定は接続と記録だけを見るので、形は使わない)。 */
function bare(id: string): PlacedFrameMember {
  return { componentId: id, start: [0, 0, 0], end: [100, 0, 0], xAxis: [0, 1, 0], yAxis: [0, 0, 1],
    bounds: { minX: -10, maxX: 10, minY: -10, maxY: 10 }, slotLines: [], slotSpec: null };
}

function joint(kind: FrameJoint['kind'], ids: readonly string[]): FrameJoint {
  const members = ids.map((componentId, index): FrameJoint['members'][number] =>
    ({ componentId, part: index === 0 && kind !== 'L' ? 'side' : 'start', face: index === 0 && kind !== 'L' ? 'top' : null }));
  return { id: `${kind}:${ids.join('|')}`, kind, members, point: [0, 0, 0] };
}

function input(components: readonly AssemblyComponent[], joints: readonly FrameJoint[], extra: Partial<AssemblyDocument> = {}):
FrameJointCheckInput {
  const document: AssemblyDocument = { ...createAssemblyDocument('接合'), components: [...components], ...extra };
  const memberIds = [...new Set(joints.flatMap((item) => item.members.map((member) => member.componentId)))];
  return { document, members: memberIds.map(bare), joints, fasteners: [], partBoxes: new Map() };
}

function fastenings(check: ReturnType<typeof checkFrameJoints>): readonly unknown[] {
  return check.ok ? [check.statuses.map((status) => status.fastening), check.unfastenedMembers] : [check.reason];
}

describe('接合チェック(記録・まとまり・片側)', () => {
  const ab = joint('L', ['a', 'b']);

  it('何の記録も無い接続は留めていない。2 本とも、どこにも留められていない部材', () => {
    expect(fastenings(checkFrameJoints(input([part('a'), part('b')], [ab])))).toEqual([['none'], ['a', 'b']]);
  });

  it('溶接・締結の記録で 2 本が直接つながるか、ブラケット(部材でない部品)を挟んでつながると、記録で留めた', () => {
    const weld: Partial<AssemblyDocument> = { jointOccurrenceConnections: [{ kind: 'weld', firstPath: ['a'], secondPath: ['b'], componentIds: [] }] };
    expect(fastenings(checkFrameJoints(input([part('a'), part('b')], [ab], weld)))).toEqual([['recorded'], []]);
    const viaBracket: Partial<AssemblyDocument> = { jointOccurrenceConnections: [
      { kind: 'bolt', firstPath: ['a'], secondPath: ['c'], componentIds: [] }, { kind: 'bolt', firstPath: ['c'], secondPath: ['b'], componentIds: [] }] };
    expect(fastenings(checkFrameJoints(input([part('a'), part('b'), part('c')], [ab], viaBracket)))).toEqual([['recorded'], []]);
  });

  it('剛体のまとまりは別の印。合致だけでは留めていない', () => {
    expect(fastenings(checkFrameJoints(input([part('a', 'g1'), part('b', 'g1')], [ab])))).toEqual([['rigidGroup'], []]);
  });

  it('十字で、通す部材と当てる 1 本だけを留めた時は片側だけ。留めていない 1 本は、どこにも留められていない部材', () => {
    const cross = joint('cross', ['a', 'b', 'c']);
    const bolt: Partial<AssemblyDocument> = { jointOccurrenceConnections: [{ kind: 'bolt', firstPath: ['a'], secondPath: ['b'], componentIds: [] }] };
    expect(fastenings(checkFrameJoints(input([part('a'), part('b'), part('c')], [cross], bolt)))).toEqual([['oneSided'], ['c']]);
  });

  it('部材が上限(2,000 本)を超えると調べずに理由を返し、手で起動した時は調べる', () => {
    const many = input([part('a'), part('b')], [ab]);
    const members = Array.from({ length: 2_001 }, (_, index) => bare(`m${String(index)}`));
    expect(checkFrameJoints({ ...many, members })).toEqual({ ok: false, reason: 'tooManyMembers', count: 2_001, limit: 2_000 });
    expect(checkFrameJoints({ ...many, members, force: true }).ok).toBe(true);
  });
});

describe('接合チェック(記録の無い溝の締結を位置で判定)', () => {
  const family = T_SLOT_CATALOG_FAMILIES.s6;
  beforeAll(async () => { await PRODUCT_CATALOG_REGISTRY.ensure(['socket-head-cap-screw', 't-slot-nut', family.id]); });

  it('板を 1 本目のフレームの溝に今の計画で留め、板と 2 本目を記録でつなぐと、L は溝の締結で留めた。板の箱が無ければ留めていない', () => {
    const row = family.rows.find((candidate) => candidate.key === 's6-20x20');
    const bounds = row === undefined ? null : family.sectionBounds?.(row, { length: '500' }) ?? null;
    if (row === undefined || bounds === null) throw new Error('row');
    const plan = planFrameMembers([{ start: [0, 0, 0], end: [500, 0, 0] }, { start: [500, 0, 0], end: [500, 500, 0] }],
      { section: bounds, up: [0, 0, 1], startExtension: 0, endExtension: 0, corners: 'butt' });
    if (!plan.ok) throw new Error(plan.reason);
    const frames: AssemblyComponent[] = plan.members.map((planned, index) => {
      const [x, y, z] = planned.placement.position;
      return { id: `m${String(index)}`, name: `m${String(index)}`, source: createCatalogItemSource(family, row, { length: String(planned.lengthMm) }),
        fixed: true, visible: true, suppressed: false,
        placement: { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)], rotation: planned.placement.rotation } };
    });
    const plate = part('plate');
    const revisions = new Map([['plate', 'r1']]);
    const base: AssemblyDocument = { ...createAssemblyDocument('接合'), components: [...frames, plate] };
    const placementsOf = (document: AssemblyDocument): ReadonlyMap<string, RigidPlacement> =>
      new Map(document.components.map((component) => [component.id, rigidPlacementOf(component.placement)]));
    const members = placedFrameMembers(base, placementsOf(base));
    const first = members.find((member) => member.componentId === 'm0');
    if (first === undefined) throw new Error('m0');
    // 板の合わせ面(下の面)を 1 本目の上の面(z = 10)に置いた厚さ 4・径 6 の通し穴(x = 100 の溝の上)。
    const key = componentSourceKey(plate, revisions);
    if (key === null) throw new Error('key');
    const matingFace: SubShapeRef = { bodyFeatureId: 'plate', index: 0, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1,
      position: [100, 0, 10], axis: [0, 0, -1], radius: null } };
    const hole: FasteningHoleSelection = { componentId: 'plate', sourceKey: key, holeFeatureId: 'hole', matingFace,
      hole: { kind: 'clearance', diameter: 6, length: 4 }, axisOrigin: [100, 0, 10], axisDirection: [0, 0, 1], matingFaceNormal: [0, 0, -1] };
    const head = entryHeadSpec({ kind: 'counterbore', diameter: 30, depth: 0, side: 'outer' }, 'M5', 0.8);
    if ('code' in head) throw new Error(head.code);
    const candidate: FrameSlotCandidate = { componentId: 'm0', lines: first.slotLines, slotWidth: 6 };
    const planned = planFrameSlotFastening(base, { holes: [hole], frames: [candidate], bolt: { head, availability: [{ boltRowKey: head.rowKey,
      lengths: [6, 8, 10, 12, 16], basis: 'globalUnverifiedList', verified: false, source: 'test' }] }, nutFamily: T_SLOT_NUT_FAMILY,
    nutRecords: T_SLOT_NUT_RECORDS, nutEntry: '後入れ', nutMaterial: 'steel', partRevisions: revisions });
    if (!planned.ok) throw new Error(JSON.stringify(planned.failures));
    const fastened = applyFrameSlotFastening(base, planned.entries).document;
    const placements = placementsOf(fastened);
    const joints = classifyFrameJoints(placedFrameMembers(fastened, placements));
    expect(joints.map((item) => item.kind)).toEqual(['L']);
    const linked: AssemblyDocument = { ...fastened, jointOccurrenceConnections: [{ kind: 'bolt', firstPath: ['plate'], secondPath: ['m1'],
      componentIds: [] }] };
    const plateBox: PartBox = { min: [90, -10, 10], max: [110, 10, 14] };
    const check = (document: AssemblyDocument, boxes: ReadonlyMap<string, PartBox>): readonly unknown[] => fastenings(checkFrameJoints({
      document, members: placedFrameMembers(document, placements), joints, fasteners: slotFastenerParts(document, placements), partBoxes: boxes }));
    expect(slotFastenerParts(linked, placements).map((item) => item.kind).sort()).toEqual(['bolt', 'nut']);
    expect(check(linked, new Map([['plate', plateBox]]))).toEqual([['slot'], []]);
    expect(check(linked, new Map())).toEqual([['none'], ['m0', 'm1']]);
  });
});
