/**
 * フレームの締結(J-02 P6b)の検査: ブラケットの通し穴を溝の中心線に照らし、溝用のナットと六角穴付きボルトを選んで置く計画を作る事。
 * 溝幅 6・8・10、穴が溝からずれた時、溝の端の外、ボルトの長さが無い時、L 形のブラケットの 2 つの脚がそれぞれ別のフレームの溝に当たる時。
 * フレームは線に沿って並べる純関数(planFrameMembers)で置き、溝の線は族の溝(sectionSlots)と frameSlotLines から作る。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import { beforeAll, describe, expect, it } from 'vitest';

import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import { T_SLOT_NUT_FAMILY } from '../catalog/families/framePartCatalog.js';
import { T_SLOT_NUT_RECORDS } from '../catalog/families/framePartRows.js';
import { T_SLOT_CATALOG_FAMILIES } from '../catalog/families/tSlotFrameCatalog.js';
import { T_SLOT_FRAME_SERIES_FAMILY } from '../catalog/families/tSlotFrameSeries.js';
import { PRODUCT_CATALOG_REGISTRY } from '../catalog/registry.js';
import { createCatalogItemSource } from '../catalog/source.js';
import type { CatalogFamily, CatalogItemRow } from '../catalog/types.js';
import { planFrameMembers, type FrameLine } from '../frame/frameMembers.js';
import { frameSlotLines } from '../frame/frameSlots.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import type { SubShapeRef } from '../../geometry/subShapeRef.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { applyFrameSlotFastening, planFrameSlotFastening, type FrameSlotCandidate, type FrameSlotFasteningRequest } from './frameSlotFastening.js';
import { componentSourceKey } from './frames.js';
import { entryHeadSpec, type EntryHeadSpec } from './holeEntry.js';
import type { FasteningHoleSelection } from './types.js';

/** 溝の呼びの幅ごとの、資料の族と行・ボルトの呼びとピッチ。 */
const CASES: readonly { readonly slot: number; readonly family: CatalogFamily; readonly rowKey: string; readonly nominal: string;
  readonly pitch: number }[] = [
  { slot: 6, family: T_SLOT_CATALOG_FAMILIES.s6, rowKey: 's6-20x20', nominal: 'M5', pitch: 0.8 },
  { slot: 8, family: T_SLOT_CATALOG_FAMILIES.s8, rowKey: 's8-30x60', nominal: 'M6', pitch: 1 },
  { slot: 10, family: T_SLOT_CATALOG_FAMILIES.s10, rowKey: 's10-40x40', nominal: 'M8', pitch: 1.25 },
];
const REVISIONS: ReadonlyMap<string, string> = new Map([['plate', 'r1']]);

const LENGTHS = [6, 8, 10, 12, 16, 20, 25];

function headFor(nominal: string, pitch: number): EntryHeadSpec {
  const head = entryHeadSpec({ kind: 'counterbore', diameter: 30, depth: 0, side: 'outer' }, nominal, pitch);
  if ('code' in head) throw new Error(head.code);
  return head;
}

/** 線 (0,0,0)-(500,0,0) に、上を +Z にして置いた部材と、その溝の線。 */
function frameOn(family: CatalogFamily, row: CatalogItemRow, line: FrameLine, id: string):
{ readonly component: AssemblyComponent; readonly candidate: FrameSlotCandidate; readonly halfHeight: number } {
  const bounds = family.sectionBounds?.(row, { length: '500' });
  if (bounds === null || bounds === undefined) throw new Error('bounds');
  const plan = planFrameMembers([line], { section: bounds, up: [0, 0, 1], startExtension: 0, endExtension: 0, corners: 'none' });
  const member = plan.ok ? plan.members[0] : undefined;
  const slots = family.sectionSlots?.(row, { length: String(member?.lengthMm ?? 0) });
  if (member === undefined || slots === null || slots === undefined) throw new Error('member');
  const [x, y, z] = member.placement.position;
  const component: AssemblyComponent = { id, name: id, source: createCatalogItemSource(family, row, { length: String(member.lengthMm) }),
    placement: { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)],
      rotation: member.placement.rotation }, fixed: true, visible: true, suppressed: false };
  return { component, candidate: { componentId: id, lines: frameSlotLines(slots, member.placement, member.lengthMm, bounds, []),
    slotWidth: Number(/^s([0-9]+)-/u.exec(row.key)?.[1]) }, halfHeight: (bounds.maxY - bounds.minY) / 2 };
}

/** 置いた板(恒等の配置)の、合わせ面(下の面 z = top)の上の通し穴(径 dh、厚さ t)。 */
function plateHole(plate: AssemblyComponent, point: Vec3, diameter: number, thickness: number, into: Vec3 = [0, 0, 1]): FasteningHoleSelection {
  const key = componentSourceKey(plate, REVISIONS);
  if (key === null) throw new Error('key');
  const matingFace: SubShapeRef = { bodyFeatureId: 'plate', index: 0, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1,
    position: point, axis: [-into[0], -into[1], -into[2]], radius: null } };
  return { componentId: plate.id, sourceKey: key, holeFeatureId: 'hole', matingFace,
    hole: { kind: 'clearance', diameter, length: thickness }, axisOrigin: point, axisDirection: into,
    matingFaceNormal: [-into[0], -into[1], -into[2]] };
}

/** 板の部品(恒等の配置。形は使わないので族の平板の行の保存の形だけを持つ)。 */
function plateComponent(id: string): AssemblyComponent {
  return { id, name: id, source: { kind: 'part', partRef: id }, placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true,
    suppressed: false };
}

function request(holes: readonly FasteningHoleSelection[], frames: readonly FrameSlotCandidate[], nominal: string, pitch: number,
  lengths: readonly number[] = LENGTHS): FrameSlotFasteningRequest {
  const head = headFor(nominal, pitch);
  return { holes, frames, bolt: { head, availability: [{ boltRowKey: head.rowKey, lengths, basis: 'globalUnverifiedList', verified: false,
    source: 'test' }] }, nutFamily: T_SLOT_NUT_FAMILY, nutRecords: T_SLOT_NUT_RECORDS, nutEntry: '後入れ', nutMaterial: 'steel',
  partRevisions: REVISIONS };
}

/** 1 つの行の dims に鍵を足した溝用のナットの族(族の行の表が付ける holeOffset・slotPartHeightUnknown の代わり)。 */
function withNutDims(key: string, extra: Readonly<Record<string, number>>): CatalogFamily {
  return { ...T_SLOT_NUT_FAMILY, rows: T_SLOT_NUT_FAMILY.rows.map((row) => (row.key === key ? { ...row, dims: { ...row.dims, ...extra } } : row)) };
}

beforeAll(async () => {
  await PRODUCT_CATALOG_REGISTRY.ensure(['socket-head-cap-screw', 't-slot-nut', ...CASES.map((item) => item.family.id)]);
});

describe('フレームの締結の計画', () => {
  it.each(CASES)('溝幅 $slot: 上の面の溝の上の穴に、溝幅と呼びの合う後入れの溝用のナットとボルトを選び、ナットは肩の裏に置く', (item) => {
    const row = item.family.rows.find((candidate) => candidate.key === item.rowKey);
    if (row === undefined) throw new Error(item.rowKey);
    const frame = frameOn(item.family, row, { start: [0, 0, 0], end: [500, 0, 0] }, 'frame');
    const document: AssemblyDocument = { ...createAssemblyDocument('締結'), components: [frame.component] };
    const plate = plateComponent('plate');
    const top = frame.halfHeight;
    const result = planFrameSlotFastening({ ...document, components: [frame.component, plate] },
      request([plateHole(plate, [100, 0, top], 6, 4)], [frame.candidate], item.nominal, item.pitch));
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    const entry = result.entries[0];
    expect([entry?.frameComponentId, entry?.face, entry?.nutDepthSimplified]).toEqual(['frame', 'top', true]);
    expect(entry?.nut.source.kind === 'standardPart' ? entry.nut.source.options.item : null).toMatch(new RegExp(`^s${item.slot}-${item.nominal.toLowerCase()}-post-steel$`, 'u'));
    expect(entry?.bolt.source.kind === 'standardPart' ? entry.bolt.source.options.length : null).toBe(String(entry?.bolt.length));
    const applied = applyFrameSlotFastening({ ...document, components: [frame.component, plate] }, result.entries);
    expect(applied.componentIds).toHaveLength(2);
    expect(applied.document.components).toHaveLength(4);
  });

  it('穴が溝の中心線から (口の幅 − 径)/2 を超えてずれると、ずれた量つきで断り、何も置かない', () => {
    const item = CASES[0];
    const row = item.family.rows.find((candidate) => candidate.key === item.rowKey);
    if (row === undefined) throw new Error('row');
    const frame = frameOn(item.family, row, { start: [0, 0, 0], end: [500, 0, 0] }, 'frame');
    const plate = plateComponent('plate');
    const document: AssemblyDocument = { ...createAssemblyDocument('締結'), components: [frame.component, plate] };
    const result = planFrameSlotFastening(document, request([plateHole(plate, [100, 0, frame.halfHeight], 6, 4),
      plateHole(plate, [200, 3, frame.halfHeight], 6, 4)], [frame.candidate], item.nominal, item.pitch));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map((failure) => [failure.holeIndex, failure.code])).toEqual([[1, 'offSlot']]);
    expect(result.failures[0]?.detail.offsetMm).toBeCloseTo(3, 9);
  });

  it('溝の端の外(ナットの長さが溝の線の端からはみ出す所)と、ボルトの長さの候補が合わない時は断る', () => {
    const item = CASES[0];
    const row = item.family.rows.find((candidate) => candidate.key === item.rowKey);
    if (row === undefined) throw new Error('row');
    const frame = frameOn(item.family, row, { start: [0, 0, 0], end: [500, 0, 0] }, 'frame');
    const plate = plateComponent('plate');
    const document: AssemblyDocument = { ...createAssemblyDocument('締結'), components: [frame.component, plate] };
    const edge = planFrameSlotFastening(document, request([plateHole(plate, [2, 0, frame.halfHeight], 6, 4)], [frame.candidate],
      item.nominal, item.pitch));
    expect(edge.ok ? null : edge.failures.map((failure) => failure.code)).toEqual(['outsideSlotEnd']);
    const noLength = planFrameSlotFastening(document, request([plateHole(plate, [100, 0, frame.halfHeight], 6, 4)], [frame.candidate],
      item.nominal, item.pitch, [100]));
    expect(noLength.ok ? null : noLength.failures.map((failure) => failure.code)).toEqual(['noBoltLength']);
    const offFace = planFrameSlotFastening(document, request([plateHole(plate, [100, 0, frame.halfHeight + 5], 6, 4)], [frame.candidate],
      item.nominal, item.pitch));
    expect(offFace.ok ? null : offFace.failures.map((failure) => failure.code)).toEqual(['notOnSlotFace']);
  });

  it('L 形のブラケットの 2 つの脚(寝た脚は下のフレームの上の面、立つ脚は横のフレームの側の面)の穴が、それぞれ別のフレームの溝に当たる', () => {
    const item = CASES[0];
    const row = item.family.rows.find((candidate) => candidate.key === item.rowKey);
    if (row === undefined) throw new Error('row');
    const below = frameOn(item.family, row, { start: [0, 0, 0], end: [500, 0, 0] }, 'below');
    // 横のフレーム: 線 (0, 40, 0)-(0, 40, 500) の縦の部材。側の面(-Y の面)は y = 30。
    const side = frameOn(item.family, row, { start: [0, 40, 0], end: [0, 40, 500] }, 'side');
    const plate = plateComponent('plate');
    const document: AssemblyDocument = { ...createAssemblyDocument('締結'), components: [below.component, side.component, plate] };
    const holes = [plateHole(plate, [100, 0, below.halfHeight], 6, 4), plateHole(plate, [0, 30, 100], 6, 4, [0, -1, 0])];
    const result = planFrameSlotFastening(document, request(holes, [below.candidate, side.candidate], item.nominal, item.pitch));
    if (!result.ok) throw new Error(JSON.stringify(result.failures));
    expect(result.entries.map((entry) => entry.frameComponentId)).toEqual(['below', 'side']);
  });

  it('ナットの行の dims.holeOffset: 穴の軸をボルトの軸に合わせて置き(中央でない分だけずらす)、溝の端の判定も穴の位置から測る', () => {
    const item = CASES[0];
    const row = item.family.rows.find((candidate) => candidate.key === item.rowKey);
    if (row === undefined) throw new Error('row');
    const frame = frameOn(item.family, row, { start: [0, 0, 0], end: [500, 0, 0] }, 'frame');
    const plate = plateComponent('plate');
    const document: AssemblyDocument = { ...createAssemblyDocument('締結'), components: [frame.component, plate] };
    const nutKey = 's6-m5-post-steel', holeOffset = 2;
    const nutRow = T_SLOT_NUT_FAMILY.rows.find((candidate) => candidate.key === nutKey);
    const length = nutRow?.dims.length ?? NaN;
    // 中央の穴なら溝の始めから length / 2 の内に置けない位置(端から holeOffset + 1)を使うので、中央の行より長い事を前提に確かめる。
    expect(length / 2).toBeGreaterThan(holeOffset + 1);
    const offsetFamily = withNutDims(nutKey, { holeOffset });
    const centered = planFrameSlotFastening(document, request([plateHole(plate, [100, 0, frame.halfHeight], 6, 4)], [frame.candidate],
      item.nominal, item.pitch));
    const shifted = planFrameSlotFastening(document, { ...request([plateHole(plate, [100, 0, frame.halfHeight], 6, 4)], [frame.candidate],
      item.nominal, item.pitch), nutFamily: offsetFamily });
    if (!centered.ok || !shifted.ok) throw new Error('plan');
    expect(centered.entries[0]?.nut.placement.position[0].value).toBeCloseTo(100, 9);
    expect(shifted.entries[0]?.nut.placement.position[0].value).toBeCloseTo(100 - (holeOffset - length / 2), 9);
    const nearStart = [plateHole(plate, [holeOffset + 1, 0, frame.halfHeight], 6, 4)];
    expect(planFrameSlotFastening(document, { ...request(nearStart, [frame.candidate], item.nominal, item.pitch), nutFamily: offsetFamily }).ok)
      .toBe(true);
    const nearStartCentered = planFrameSlotFastening(document, request(nearStart, [frame.candidate], item.nominal, item.pitch));
    expect(nearStartCentered.ok ? null : nearStartCentered.failures.map((failure) => failure.code)).toEqual(['outsideSlotEnd']);
  });

  it('dims.slotPartHeightUnknown = 1 の行(溝に入る所の高さが資料に無い)は、深さとボルトの長さに使わず、選べない理由を返す', () => {
    const item = CASES[0];
    const row = item.family.rows.find((candidate) => candidate.key === item.rowKey);
    if (row === undefined) throw new Error('row');
    const frame = frameOn(item.family, row, { start: [0, 0, 0], end: [500, 0, 0] }, 'frame');
    const plate = plateComponent('plate');
    const document: AssemblyDocument = { ...createAssemblyDocument('締結'), components: [frame.component, plate] };
    const result = planFrameSlotFastening(document, { ...request([plateHole(plate, [100, 0, frame.halfHeight], 6, 4)], [frame.candidate],
      item.nominal, item.pitch), nutFamily: withNutDims('s6-m5-post-steel', { slotPartHeightUnknown: 1 }) });
    expect(result.ok ? null : result.failures.map((failure) => [failure.code, failure.detail])).toEqual([
      ['slotPartHeightUnknown', { nut: T_SLOT_NUT_FAMILY.rows.find((row) => row.key === 's6-m5-post-steel')?.size ?? '' }]]);
  });

  it('使う系列の族(溝幅 6 20×20)でも、穴の無い計画は作らない', () => {
    const document = createAssemblyDocument('締結');
    const row = T_SLOT_FRAME_SERIES_FAMILY.rows[0];
    expect(row).toBeDefined();
    expect(planFrameSlotFastening(document, request([], [], 'M5', 0.8))).toEqual({ ok: false, failures: [] });
  });
});

