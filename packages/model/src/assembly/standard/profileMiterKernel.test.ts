/**
 * 留めの 45° の端(J-01 包み 5)を実際の形(OCCT)で確かめる: 切り落とす三角柱を引いた体積が、手で解いた値
 * (端 1 つで 断面積 × h。h は短くする向きの断面の半分の幅)に合い、長い側の面は端まで、短い側の面は 2h から始まる事。
 * 留めの無い形は前と同じ(押し出しのまま)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '@pointercad/kernel/testing/occt-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDirectKernelBridge, type SolidBody } from '../../kernelBridge.js';
import { recomputePart } from '../../part/recomputePart.js';
import type { PartDocument } from '../../part/types.js';
import { ALUMINUM_SECTION_FAMILIES } from '../catalog/families/aluminumSections.js';
import { T_SLOT_CATALOG_FAMILIES } from '../catalog/families/tSlotFrameCatalog.js';
import type { FrameSectionBounds } from '../frame/frameMembers.js';
import { buildStandardPartFromSource, createStandardPartSource } from './buildStandardPart.js';
import { buildProfileSection, type ProfileLoops } from './profileExtrusion.js';
import { appendMiterCut, miteredVolume, type ProfileMiterEnd } from './profileMiter.js';
import { ALL_STEEL_PRODUCTS, steelProductOptions } from './steelCatalog.js';
import type { SteelProfilePoint } from './steelSectionProfiles.js';

const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
beforeAll(async () => { await loadOcctForNode(); }, 180_000);
afterAll(() => { bridge.dispose(); });

/** 外形の長方形の断面(線分 4 本)。 */
function rectangle(bounds: FrameSectionBounds): ProfileLoops {
  const corners: readonly SteelProfilePoint[] = [[bounds.minX, bounds.minY], [bounds.maxX, bounds.minY], [bounds.maxX, bounds.maxY],
    [bounds.minX, bounds.maxY]];
  return { segments: corners.map((from, index) => ({ kind: 'line', from, to: corners[(index + 1) % corners.length] ?? from })), holes: [] };
}

function mitered(bounds: FrameSectionBounds, length: number, cuts: readonly ProfileMiterEnd[]): PartDocument {
  let document = buildProfileSection(rectangle(bounds), expressionValueFromNumber(length));
  let targetId = document.solids.at(-1)?.id ?? '';
  for (const cut of cuts) ({ document, targetId } = appendMiterCut(document, targetId, bounds, cut, length));
  return document;
}

async function bodyOf(part: PartDocument): Promise<SolidBody> {
  try {
    const result = await recomputePart(part, bridge);
    expect(result.errors).toEqual([]);
    const body = result.bodies.at(-1);
    if (body === undefined) throw new Error('Missing native body');
    expect(body.isValid).toBe(true);
    return body;
  } finally {
    await bridge.releasePart(part.id);
  }
}

/** 面の上(座標 `axis` が `value`)にある頂点の、z の最小。 */
function minZOn(body: SolidBody, axis: 0 | 1, value: number): number {
  const positions = body.mesh.positions;
  let least = Number.POSITIVE_INFINITY;
  for (let index = 0; index + 2 < positions.length; index += 3) {
    if (Math.abs((positions[index + axis] ?? NaN) - value) <= 1e-4) least = Math.min(least, positions[index + 2] ?? least);
  }
  return least;
}

const SQUARE_20: FrameSectionBounds = { minX: -10, minY: -10, maxX: 10, maxY: 10 };

describe('留めの 45° の端の形', () => {
  it('留めの無い形は押し出しのまま(20×20×100 = 40000)', async () => {
    const body = await bodyOf(mitered(SQUARE_20, 100, []));
    expect(body.volume).toBeCloseTo(40_000, 6);
  }, 120_000);

  it('始点を +X の側で切ると 400 × 10 だけ減り(36000)、+X の面は z = 20 から、-X の面は z = 0 から始まる', async () => {
    const body = await bodyOf(mitered(SQUARE_20, 100, [{ end: 'start', side: 'x+' }]));
    expect(body.volume).toBeCloseTo(36_000, 6);
    expect(minZOn(body, 0, 10)).toBeCloseTo(20, 4);
    expect(minZOn(body, 0, -10)).toBeCloseTo(0, 4);
  }, 120_000);

  it('両端(始点 +X、終点 -Y)を切ると 2 × 4000 だけ減る(32000)', async () => {
    const body = await bodyOf(mitered(SQUARE_20, 100, [{ end: 'start', side: 'x+' }, { end: 'end', side: 'y-' }]));
    expect(body.volume).toBeCloseTo(32_000, 6);
  }, 120_000);

  it('外形の中心に対して偏った断面(L 形、面積 175)でも、台本の体積の式(1 次のモーメントで切り落とす量を数える)が実際の形に合う', async () => {
    const corners: readonly SteelProfilePoint[] = [[0, 0], [20, 0], [20, 5], [5, 5], [5, 20], [0, 20]];
    const profile: ProfileLoops = { segments: corners.map((from, index) => ({ kind: 'line', from,
      to: corners[(index + 1) % corners.length] ?? from })), holes: [] };
    const bounds: FrameSectionBounds = { minX: 0, minY: 0, maxX: 20, maxY: 20 };
    const cuts: readonly ProfileMiterEnd[] = [{ end: 'start', side: 'x+' }, { end: 'end', side: 'y-' }];
    let document = buildProfileSection(profile, expressionValueFromNumber(100));
    let targetId = document.solids.at(-1)?.id ?? '';
    for (const cut of cuts) ({ document, targetId } = appendMiterCut(document, targetId, bounds, cut, 100));
    const body = await bodyOf(document);
    // 手で解いた値: ∫x dA = 20·5·10 + 5·15·2.5 = 1187.5(∫y dA も同じ)。始点 +X: 175·10 + (1187.5 − 10·175) = 1187.5。
    // 終点 -Y: 175·10 − (1187.5 − 10·175) = 2312.5。17500 − 1187.5 − 2312.5 = 14000。
    expect(miteredVolume(profile, 175, bounds, cuts, 100)).toBeCloseTo(14_000, 9);
    expect(body.volume).toBeCloseTo(14_000, 6);
  }, 120_000);

  it('円弧を含む断面(半径 10 の円、中心 (0, 0))でも台本の体積の式が実際の形に合う(+X の始点で π·100·10 だけ減る)', async () => {
    const profile: ProfileLoops = { segments: [
      { kind: 'arc', from: [10, 0], to: [-10, 0], center: [0, 0], radius: 10, startAngle: 0, endAngle: Math.PI },
      { kind: 'arc', from: [-10, 0], to: [10, 0], center: [0, 0], radius: 10, startAngle: Math.PI, endAngle: 2 * Math.PI },
    ], holes: [] };
    const bounds: FrameSectionBounds = { minX: -10, minY: -10, maxX: 10, maxY: 10 };
    const cuts: readonly ProfileMiterEnd[] = [{ end: 'start', side: 'x+' }];
    const area = 100 * Math.PI;
    let document = buildProfileSection(profile, expressionValueFromNumber(100));
    let targetId = document.solids.at(-1)?.id ?? '';
    for (const cut of cuts) ({ document, targetId } = appendMiterCut(document, targetId, bounds, cut, 100));
    const body = await bodyOf(document);
    expect(miteredVolume(profile, area, bounds, cuts, 100)).toBeCloseTo(area * 90, 9);
    expect(body.volume).toBeCloseTo(area * 90, 4);
  }, 120_000);

  it('資料の族の片側だけ溝の断面(溝幅 8 30×30 1 面溝)を両端で留めにした部品も、台本の体積が実際の形に合う', async () => {
    const family = T_SLOT_CATALOG_FAMILIES.s8;
    const row = family.rows.find((candidate) => candidate.key === 's8-30x30-l');
    if (row === undefined) throw new Error('row');
    for (const values of [{ length: '300', startMiter: 'x+', endMiter: 'y-' }, { length: '300', startMiter: 'y+', endMiter: 'x-' }]) {
      const part = family.build(row, values);
      const expected = family.nominalVolume(row, values);
      if (part === null || expected === null) throw new Error('part');
      const body = await bodyOf(part);
      expect(Math.abs(body.volume - expected) / expected).toBeLessThan(1e-6);
    }
  }, 120_000);

  it('アルミの形材の山形・溝形(図心が外形の中心から外れる)を留めにした部品も、台本の体積(切る面の位置と量)が実際の形に合う', async () => {
    for (const [family, key] of [[ALUMINUM_SECTION_FAMILIES.angle, 'an-15x20x2'], [ALUMINUM_SECTION_FAMILIES.channel, 'ch-40x20x2']] as const) {
      const row = family.rows.find((candidate) => candidate.key === key);
      if (row === undefined) throw new Error(key);
      for (const values of [{ length: '300', startMiter: 'x+', endMiter: 'y-' }, { length: '300', startMiter: 'y+', endMiter: 'x-' }]) {
        const part = family.build(row, values);
        const expected = family.nominalVolume(row, values);
        if (part === null || expected === null) throw new Error('part');
        expect(Math.abs((await bodyOf(part)).volume - expected) / expected).toBeLessThan(1e-6);
      }
    }
  }, 120_000);

  it('鋼材(J-01 包み 6)の平鋼 50×6 の両端(幅の向き、h = 25)と丸鋼の始点(h = 半径)を留めにした部品の体積が、手で解いた値に合う', async () => {
    const flat = ALL_STEEL_PRODUCTS.find((row) => row.key === 'SS400:flatBar:FB 50×6');
    const round = ALL_STEEL_PRODUCTS.find((row) => row.catalog === 'roundBar' && row.dimensions?.diameter !== undefined);
    const diameter = round?.dimensions?.diameter;
    if (flat === undefined || round === undefined || diameter === undefined) throw new Error('steel rows');
    const flatPart = buildStandardPartFromSource(createStandardPartSource(flat.catalog, flat.size,
      { ...steelProductOptions(flat), length: '300', startMiter: 'x+', endMiter: 'x+' }));
    if (flatPart === null) throw new Error('flat part');
    // 300 × 300 − 2 × 300 × 25 = 75000。
    expect((await bodyOf(flatPart)).volume).toBeCloseTo(75_000, 4);
    const roundPart = buildStandardPartFromSource(createStandardPartSource(round.catalog, round.size,
      { ...steelProductOptions(round), length: '300', startMiter: 'y+' }));
    if (roundPart === null) throw new Error('round part');
    const area = Math.PI * (diameter / 2) ** 2;
    expect((await bodyOf(roundPart)).volume / (area * (300 - diameter / 2))).toBeCloseTo(1, 6);
  }, 120_000);

  it('原点が角にある断面(50×6、+Y の側で h = 3)でも、切る面は外形の中心で決まる(300 × 200 − 300 × 3 = 59100)', async () => {
    const body = await bodyOf(mitered({ minX: 0, minY: 0, maxX: 50, maxY: 6 }, 200, [{ end: 'start', side: 'y+' }]));
    expect(body.volume).toBeCloseTo(59_100, 6);
    expect(minZOn(body, 1, 6)).toBeCloseTo(6, 4);
    expect(minZOn(body, 1, 0)).toBeCloseTo(0, 4);
  }, 120_000);
});
