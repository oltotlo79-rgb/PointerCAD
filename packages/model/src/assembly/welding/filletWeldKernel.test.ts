import { expressionValueFromNumber } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../../../../kernel/src/occt/loadOcct.node.js';
import { findDensityMaterial } from '../../appearance/densityMaterials.js';
import { createDirectInterferenceKernelBridge, createDirectKernelBridge, type SolidBody, type SolidEdgeEntry, type SolidFaceEntry } from '../../kernelBridge.js';
import { resolveSubShapeReference } from '../../kernelBridge/referenceResolution.js';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature, nextSolidId, nextSolidName } from '../../part/createPartDocument.js';
import { recomputePart } from '../../part/recomputePart.js';
import { resolvePart, type ResolvedPart } from '../../part/resolvePart.js';
import type { PartDocument, PrimitiveShape } from '../../part/types.js';
import { absoluteCoordinate } from '../../sketch/createSketchDocument.js';
import { dotVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import { findComponent } from '../assemblyEdit.js';
import { rigidPlacementOf } from '../fastening/frames.js';
import { assemblyMassProperties, materialOf, type AssemblyMassBody, type MaterialBearingPartDocument } from '../massProperties.js';
import { applyPlacementToDirection, applyPlacementToPoint, type Quaternion, type RigidPlacement } from '../placementMath.js';
import { buildStandardPartFromSource } from '../standard/buildStandardPart.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import { applyFilletWeld } from './applyFilletWeld.js';
import { bindFilletWeldSelection } from './bindWeldSelection.js';
import { teeJoint, WELD_TEST_REVISIONS, weldTestPlacement } from './filletWeld.testSupport.js';
import { planFilletWeld, type WeldBodyLookup } from './planFilletWeld.js';
import type { FilletWeldPlan, FilletWeldPlanResult, FilletWeldRequest, WeldEdgeSelection, WeldFaceSelection, WeldSegmentSpec } from './types.js';

/*
 * 実カーネル(OCCT)で作った立板と底板の面・辺から溶接を計画し、ビードの部品も実カーネルで作り直して、手で求めた
 * 形・体積・配置と比べる。検査用の形(testSupport の手書きのボディ)を使わない。
 */

const bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
beforeAll(async () => { await loadOcctForNode(); }, 180_000);
afterAll(() => { bridge.dispose(); });

type Box = readonly [Vec3, Vec3];
type Tool =
  | { readonly kind: 'box'; readonly box: Box }
  | { readonly kind: 'cylinder'; readonly base: Vec3; readonly radius: number; readonly height: number };

/** 立板(x 0〜100、y 0〜8、z 0〜50)と底板(x 0〜100、y 0〜60、z 0〜10)。立板を (0,26,10) に置くと下の辺が底板の上面に載る。 */
const STANDING: Box = [[0, 0, 0], [100, 8, 50]];
const BASE: Box = [[0, 0, 0], [100, 60, 10]];
/** 長さのそろわない断続の 3 区間(合計 50.25 mm)。脚は底板の上に 6 mm、立板の側面に 8 mm。 */
const SEGMENTS: readonly WeldSegmentSpec[] = [{ start: 5, length: 12.5 }, { start: 25, length: 30 }, { start: 70.25, length: 7.75 }];
/** 手で求めた値: 6 × 8 / 2 × 50.25 = 1206 mm³。 */
const TOTAL_VOLUME = 1206;
/** 組立ごと Z まわり 90° 回す(R(x, y, z) = (−y, x, z))。 */
const QUARTER_TURN_Z: Quaternion = [0, 0, Math.SQRT1_2, Math.SQRT1_2];

/** 回転なしの継手: 立板 (0,26,10)、底板 (0,0,0)。 */
const PLAIN = (): AssemblyDocument => teeJoint(weldTestPlacement([0, 26, 10]), weldTestPlacement([0, 0, 0]));

function center([min, max]: Box): Vec3 {
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}

function boxShape([min, max]: Box): PrimitiveShape {
  return { kind: 'box', sizeX: expressionValueFromNumber(max[0] - min[0]), sizeY: expressionValueFromNumber(max[1] - min[1]),
    sizeZ: expressionValueFromNumber(max[2] - min[2]) };
}

/** 基本形状を 1 つ足す(箱の基準点は中心、円柱は底面の中心、向きは既定の Z)。 */
function addPrimitive(document: PartDocument, at: Vec3, shape: PrimitiveShape): { readonly document: PartDocument; readonly id: string } {
  const feature = { ...createPrimitiveFeature(document, shape.kind, { kind: 'coordinate', value: absoluteCoordinate(at[0], at[1], at[2]) }), shape };
  return { document: appendSolid(document, feature), id: feature.id };
}

/** 箱 [min, max] から道具を順に引いた部品。 */
function platePart(id: string, box: Box, tools: readonly Tool[] = []): PartDocument {
  let { document, id: target } = addPrimitive({ ...createEmptyPartDocument(), id }, center(box), boxShape(box));
  for (const tool of tools) {
    const added = tool.kind === 'box' ? addPrimitive(document, center(tool.box), boxShape(tool.box))
      : addPrimitive(document, tool.base, { kind: 'cylinder', radius: expressionValueFromNumber(tool.radius),
        height: expressionValueFromNumber(tool.height) });
    const subtract = nextSolidId(added.document, 'subtract');
    document = appendSolid(added.document, { id: subtract, name: nextSolidName(added.document, 'subtract'), suppressed: false,
      kind: 'boolean', operation: 'subtract', targetFeatureId: target, toolFeatureId: added.id });
    target = subtract;
  }
  return document;
}

/** 部品を実カーネルで作り直し、ボディを読み終えてから必ず手放す(id は部品ごとに別)。 */
async function withBodies<T>(parts: readonly PartDocument[], read: (bodies: readonly SolidBody[]) => T): Promise<T> {
  try {
    const bodies: SolidBody[] = [];
    for (const part of parts) {
      const result = await recomputePart(part, bridge);
      expect(result.errors, part.id).toEqual([]);
      expect(result.bodies.map((body) => body.isValid), part.id).toEqual([true]);
      bodies.push(...result.bodies);
    }
    return read(bodies);
  } finally {
    for (const part of parts) await bridge.releasePart(part.id);
  }
}

function expectVec(actual: Vec3, expected: Vec3, digits = 9): void {
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index] ?? Number.NaN, digits));
}

/** 実カーネルの平面の面のうち、重心が条件に合うただ 1 つ。 */
function planeFace(body: SolidBody, at: (centroid: Vec3) => boolean): SolidFaceEntry {
  const found = body.faces.filter((face) => face.surfaceKind === 'plane' && at(face.centroid));
  const [face] = found;
  if (found.length !== 1 || face === undefined) throw new Error(`plane faces found: ${String(found.length)}`);
  return face;
}

function faceSelection(componentId: string, partRef: string, body: SolidBody, face: SolidFaceEntry): WeldFaceSelection {
  if (face.axis === null) throw new Error('plane face without a normal');
  return {
    componentId, sourceKey: `part:${partRef}@${WELD_TEST_REVISIONS.get(partRef) ?? ''}`,
    face: { bodyFeatureId: body.featureId, index: face.index, fingerprint: {
      kind: 'face', surfaceKind: 'plane', area: face.area, position: face.centroid, axis: face.axis, radius: null } },
    centroid: face.centroid, normal: face.axis,
  };
}

function edgeSelection(body: SolidBody, edge: SolidEdgeEntry): WeldEdgeSelection {
  if (edge.curveKind !== 'line' || edge.axis === null) throw new Error('not a straight edge');
  return {
    edge: { bodyFeatureId: body.featureId, index: edge.index, fingerprint: {
      kind: 'edge', curveKind: 'line', length: edge.length, position: edge.midpoint, axis: edge.axis, radius: null } },
    midpoint: edge.midpoint, direction: edge.axis, length: edge.length,
  };
}

/**
 * 実カーネルの面と辺から選ぶ: 立板の側面 y=8、その下の辺 (0,8,0)〜(100,8,0)、底板の上面 z=10。面の向き
 * (`SolidFaceEntry.axis`)が外向きの法線であることもここで確かめる。
 */
function realRequest(standing: SolidBody, base: SolidBody): FilletWeldRequest {
  const side = planeFace(standing, (centroid) => Math.abs(centroid[1] - 8) <= 1e-6);
  const top = planeFace(base, (centroid) => Math.abs(centroid[2] - 10) <= 1e-6);
  expectVec(side.axis ?? [Number.NaN, Number.NaN, Number.NaN], [0, 1, 0], 12);
  expectVec(top.axis ?? [Number.NaN, Number.NaN, Number.NaN], [0, 0, 1], 12);
  const lines = standing.edges.filter((edge) => edge.curveKind === 'line'
    && Math.hypot(edge.midpoint[0] - 50, edge.midpoint[1] - 8, edge.midpoint[2]) <= 1e-6);
  const [line] = lines;
  if (lines.length !== 1 || line === undefined) throw new Error(`weld edges found: ${String(lines.length)}`);
  expect(line.length).toBeCloseTo(100, 9);
  return {
    first: faceSelection('component-1', 'standing', standing, side), second: faceSelection('component-2', 'base', base, top),
    edge: edgeSelection(standing, line), legOnSecond: 6, legOnFirst: 8, segments: SEGMENTS, materialId: 'aluminum',
  };
}

function lookup(standing: SolidBody, base: SolidBody): WeldBodyLookup {
  return (component) => {
    if (component.source.kind !== 'part') return null;
    if (component.source.partRef === 'standing') return [standing];
    return component.source.partRef === 'base' ? [base] : null;
  };
}

interface RealPlan {
  readonly result: FilletWeldPlanResult;
  /** 実カーネルの立板・底板の体積。 */
  readonly volumes: readonly [number, number];
}

/** 立板と底板(道具で削る)を実カーネルで作り、その面と辺の選択で計画する。 */
async function planReal(document: AssemblyDocument, base: Box = BASE, tools: readonly Tool[] = []): Promise<RealPlan> {
  const parts = [platePart('weld-kernel-standing', STANDING), platePart('weld-kernel-base', base, tools)];
  return withBodies<RealPlan>(parts, ([standing, plate]) => {
    if (standing === undefined || plate === undefined) throw new Error('plate bodies missing');
    return { result: planFilletWeld(document, realRequest(standing, plate), WELD_TEST_REVISIONS, lookup(standing, plate)),
      volumes: [standing.volume, plate.volume] };
  });
}

function planned(real: RealPlan): FilletWeldPlan {
  if (!real.result.ok) throw new Error(JSON.stringify(real.result.rejections));
  return real.result.plan;
}

interface RealBead {
  readonly component: AssemblyComponent;
  readonly part: PartDocument;
  readonly volume: number;
  /** 組立の座標での表示の頂点(局所の座標系の原点を足し、ビードの配置を当てた後)。 */
  readonly world: readonly Vec3[];
}

/** 足したビードを、保存した台本から部品に組み直して実カーネルで作る。 */
async function realBeads(document: AssemblyDocument, ids: readonly string[]): Promise<readonly RealBead[]> {
  const entries = ids.map((id, index) => {
    const component = findComponent(document, id);
    const source = component?.source;
    if (component === undefined || source?.kind !== 'standardPart') throw new Error(`bead ${id} missing`);
    const part = buildStandardPartFromSource(source);
    if (part === null) throw new Error(`bead ${id} did not build`);
    return { component, part: { ...part, id: `weld-kernel-bead-${String(index)}` } };
  });
  return withBodies(entries.map((entry) => entry.part), (bodies) => entries.map((entry, index) => {
    const body = bodies[index];
    if (body === undefined) throw new Error('bead body missing');
    const placement: RigidPlacement = rigidPlacementOf(entry.component.placement);
    const origin = body.coordinateFrame?.origin ?? [0, 0, 0];
    const positions = body.mesh.positions;
    const world: Vec3[] = [];
    for (let offset = 0; offset + 2 < positions.length; offset += 3) {
      world.push(applyPlacementToPoint(placement,
        [origin[0] + positions[offset], origin[1] + positions[offset + 1], origin[2] + positions[offset + 2]]));
    }
    return { ...entry, volume: body.volume, world };
  }));
}

interface ExpectedFrame {
  readonly origin: Vec3;
  readonly xAxis: Vec3;
  readonly yAxis: Vec3;
  readonly zAxis: Vec3;
}

/**
 * ビードの頂点を手で求めた溶接線の座標(u: 脚 6 の向き、v: 脚 8 の向き、w: 線に沿う)で読み、どれも区間の
 * 三角柱 u ≥ 0、v ≥ 0、u/6 + v/8 ≤ 1、始点 ≤ w ≤ 終点 に入り、端の値に届くことを確かめる(表示の Float32 の誤差まで)。
 */
function expectPrism(world: readonly Vec3[], frame: ExpectedFrame, segment: WeldSegmentSpec): void {
  const local = world.map((point) => {
    const offset = subVec3(point, frame.origin);
    return [dotVec3(offset, frame.xAxis), dotVec3(offset, frame.yAxis), dotVec3(offset, frame.zAxis)] as const;
  });
  const tolerance = 1e-4;
  expect(local.length).toBeGreaterThan(0);
  for (const [u, v, w] of local) {
    expect(u).toBeGreaterThanOrEqual(-tolerance);
    expect(v).toBeGreaterThanOrEqual(-tolerance);
    expect(u / 6 + v / 8).toBeLessThanOrEqual(1 + tolerance);
    expect(w).toBeGreaterThanOrEqual(segment.start - tolerance);
    expect(w).toBeLessThanOrEqual(segment.start + segment.length + tolerance);
  }
  const extremes = (axis: 0 | 1 | 2): readonly [number, number] => {
    const values = local.map((point) => point[axis]);
    return [Math.min(...values), Math.max(...values)];
  };
  const [uLow, uHigh] = extremes(0), [vLow, vHigh] = extremes(1), [wLow, wHigh] = extremes(2);
  for (const [actual, expected] of [[uLow, 0], [uHigh, 6], [vLow, 0], [vHigh, 8], [wLow, segment.start],
    [wHigh, segment.start + segment.length]] as const) expect(actual).toBeCloseTo(expected, 4);
}

/** 計画して足し、ビードを実カーネルで作って、手で求めた座標系・形・体積と比べる。 */
async function expectRealWeld(document: AssemblyDocument, frame: ExpectedFrame): Promise<{ readonly real: RealPlan; readonly after: AssemblyDocument; readonly beads: readonly RealBead[] }> {
  const real = await planReal(document);
  const plan = planned(real);
  expectVec(plan.frame.origin, frame.origin);
  expectVec(plan.frame.xAxis, frame.xAxis);
  expectVec(plan.frame.yAxis, frame.yAxis);
  expectVec(plan.frame.zAxis, frame.zAxis);
  expect(plan.contactLength).toBeCloseTo(100, 9);
  expect(plan.nominalVolume).toBe(TOTAL_VOLUME);
  // 3 区間 × 2 面。境界が内側に無い実際の面で覆い切る(表示の Float32 の誤差まで 1)。
  expect(plan.contact.map((entry) => [entry.segment, entry.side])).toEqual(
    [[0, 'first'], [1, 'first'], [2, 'first'], [0, 'second'], [1, 'second'], [2, 'second']]);
  for (const entry of plan.contact) expect(entry.coveredRatio).toBeCloseTo(1, 5);
  const applied = applyFilletWeld(document, plan, WELD_TEST_REVISIONS);
  if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
  const beads = await realBeads(applied.document, applied.componentIds);
  expect(beads).toHaveLength(SEGMENTS.length);
  beads.forEach((bead, index) => {
    const segment = SEGMENTS[index];
    if (segment === undefined) throw new Error('segment missing');
    // 実カーネルの体積 = 三角形 6 × 8 / 2 × 区間の長さ(公称体積の関数を使わずに手で書く)。
    const expected = 24 * segment.length;
    expect(Math.abs(bead.volume - expected) / expected).toBeLessThan(1e-8);
    expectPrism(bead.world, frame, segment);
  });
  const total = beads.reduce((sum, bead) => sum + bead.volume, 0);
  expect(Math.abs(total - TOTAL_VOLUME) / TOTAL_VOLUME).toBeLessThan(1e-8);
  return { real, after: applied.document, beads };
}

describe('実カーネルの立板と底板にすみ肉溶接のビードを足す', () => {
  it('実際の面と辺から計画し、長さのそろわない 3 区間のビードは手で求めた三角柱で、体積の合計は Σ長さ × 6 × 8 / 2。'
    + '質量は利用者が選んだ材質(アルミニウム)で数え、溶加材の材質・強度の欄を作らない', async () => {
    const { real, after, beads } = await expectRealWeld(PLAIN(),
      { origin: [0, 34, 10], xAxis: [0, 1, 0], yAxis: [0, 0, 1], zAxis: [1, 0, 0] });
    expect(findDensityMaterial('aluminum')?.density).toBe(2.68);
    const partKeys = new Map<string, string>();
    const bodies = new Map<string, readonly AssemblyMassBody[]>();
    const placements = new Map<string, RigidPlacement>();
    const documents = new Map<string, MaterialBearingPartDocument>();
    const [standingVolume, baseVolume] = real.volumes;
    expect(Math.abs(standingVolume - 40000) / 40000).toBeLessThan(1e-8);
    expect(Math.abs(baseVolume - 60000) / 60000).toBeLessThan(1e-8);
    const volumes = new Map<string, number>([['component-1', standingVolume], ['component-2', baseVolume]]);
    for (const bead of beads) {
      // 部品文書は材質を持たないので、インスタンスに書いた利用者の材質が使われる(既定の鋼に落ちない)。
      expect(materialOf(bead.component, bead.part)).toBe('aluminum');
      expect(bead.component.source.kind === 'standardPart' ? Object.keys(bead.component.source.options).sort() : null)
        .toEqual(['contactLength', 'length', 'weldId', 'weldParts', 'weldSegment', 'weldStation']);
      volumes.set(bead.component.id, bead.volume);
      documents.set(bead.component.id, bead.part);
    }
    for (const item of after.components) {
      partKeys.set(item.id, item.id);
      bodies.set(item.id, [{ volume: volumes.get(item.id) ?? Number.NaN, centroid: [0, 0, 0] }]);
      placements.set(item.id, rigidPlacementOf(item.placement));
    }
    const mass = assemblyMassProperties(after, { partKeys, bodies, documents }, placements);
    expect(mass.partial).toBe(false);
    // 板は材質の指定なし(鋼 7.85): 100000 mm³ × 7.85e-3 = 785 g。ビード 1206 mm³ × 2.68e-3 = 3.23208 g。
    // 桁は上の体積の相対 1e-8 から(785 g × 1e-8 ≈ 8e-6 g < 5e-5 g)。
    expect(mass.mass).toBeCloseTo(788.23208, 4);
  });

  it('組立ごと Z まわり 90° 回して (5,−7,3) ずらした継手でも、座標系・配置・形は同じ回転とずれだけ動く', async () => {
    // 立板の位置 R(0,26,10) + (5,−7,3) = (−21,−7,13)、底板は (5,−7,3)。溶接線の原点 R(0,34,10) + (5,−7,3) = (−29,−7,13)。
    await expectRealWeld(teeJoint(weldTestPlacement([-21, -7, 13], QUARTER_TURN_Z), weldTestPlacement([5, -7, 3], QUARTER_TURN_Z)),
      { origin: [-29, -7, 13], xAxis: [-1, 0, 0], yAxis: [0, 0, 1], zAxis: [0, 1, 0] });
  });
});

function refusals(real: RealPlan): unknown[] {
  return real.result.ok ? [] : real.result.rejections.map((rejection) =>
    [rejection.code, rejection.detail.segment, rejection.detail.side, rejection.detail.reason]);
}

describe('実カーネルの形で当たりの無い所のビードを断る', () => {
  it.each([
    // 底板が x 50 で終わる: 区間 1(x 25〜55)の足元を上面の端が横切り、区間 2(x 70.25〜78)の下に面が無い。
    { label: 'off the base edge', base: [[0, 0, 0], [50, 60, 10]] as Box, tools: [] as readonly Tool[],
      expected: [['contactBoundaryCrossed', 1, 'second', 'lineCrosses'], ['contactNotCovered', 2, 'second', 'notCovered']] },
    // 底板が y 37 まで: 脚 6 mm の足元(y 34〜40)を全区間で上面の端が横切る。
    { label: 'narrow base', base: [[0, 0, 0], [100, 37, 10]] as Box, tools: [] as readonly Tool[],
      expected: [0, 1, 2].map((segment) => ['contactBoundaryCrossed', segment, 'second', 'lineCrosses']) },
    // 区間 1 の足元に四角い貫通穴(x 35〜45、y 35〜38)。
    { label: 'rectangular hole', base: BASE, tools: [{ kind: 'box', box: [[35, 35, -5], [45, 38, 15]] }] as readonly Tool[],
      expected: [['contactBoundaryCrossed', 1, 'second', 'lineCrosses']] },
    // 区間 0 の足元に丸い貫通穴(中心 (11,37)、半径 1.5): 円の辺の中心と半径で判定する。
    { label: 'circular hole', base: BASE, tools: [{ kind: 'cylinder', base: [11, 37, -10], radius: 1.5, height: 40 }] as readonly Tool[],
      expected: [['contactBoundaryCrossed', 0, 'second', 'circleCrosses']] },
  ])('$label', async ({ base, tools, expected }) => {
    expect(refusals(await planReal(PLAIN(), base, tools))).toEqual(expected);
  });

  it('区間の間(x 19〜23)の穴はどの足元にも掛からないので断らない', async () => {
    const plan = planned(await planReal(PLAIN(), BASE, [{ kind: 'box', box: [[19, 35, -5], [23, 38, 15]] }]));
    expect(plan.contact).toHaveLength(6);
    for (const entry of plan.contact) expect(entry.coveredRatio).toBeCloseTo(1, 5);
  });

  it('底板が 1 mm 下にあって辺と上面の間に隙間があれば、辺が 2 つ目の面に無いとして断る', async () => {
    const real = await planReal(teeJoint(weldTestPlacement([0, 26, 10]), weldTestPlacement([0, 0, -1])));
    expect(real.result.ok ? [] : real.result.rejections.map((rejection) => rejection.code)).toEqual(['edgeNotOnSecondFace']);
    expect(real.result.ok ? null : real.result.rejections[0]?.detail.distance).toBeCloseTo(1, 9);
  });
});

/*
 * 直角でない当たり(実カーネル)。立板(部品 x 0〜100、y 0〜8、z 0〜50)を溶接する面 y=0 の下の辺を軸に X まわりに
 * φ 回して (0,0,10) に置き、底板(x 0〜100、y −40〜0、z 0〜10)の上面の端 y=0 に当てる。内角 θ = acos(sin φ):
 * φ = 70° → 20°、30° → 60°、−30° → 120°、−70° → 160°。座標系 x = (0,−1,0)、y = (0,0,1)、z = (−1,0,0)、原点 (100,0,10)。
 * 断面は (0,0)・(6,0)・(8 cos θ, 8 sin θ)、面積 24 sin θ(60°・120° は 12√3)、体積 = 面積 × 区間の長さ。
 * 立板の反対の角(部品 y=8)は φ < 0 で z < 10 へ下がるが y > 0 の側なので、y ≤ 0 の底板とは重ならない。
 */
const OBLIQUE_BASE: Box = [[0, -40, 0], [100, 0, 10]];
const OBLIQUE_FRAME: ExpectedFrame = { origin: [100, 0, 10], xAxis: [0, -1, 0], yAxis: [0, 0, 1], zAxis: [-1, 0, 0] };

function obliqueTee(tiltDegrees: number): AssemblyDocument {
  const half = tiltDegrees * Math.PI / 360;
  return teeJoint(weldTestPlacement([0, 0, 10], [Math.sin(half), 0, 0, Math.cos(half)]), weldTestPlacement([0, 0, 0]));
}

/** 実カーネルの面と辺から選ぶ: 立板の面 y=0(外向き (0,−1,0))、その下の辺 (0,0,0)〜(100,0,0)、底板の上面 z=10。 */
function obliqueRequest(standing: SolidBody, base: SolidBody): FilletWeldRequest {
  const side = planeFace(standing, (centroid) => Math.abs(centroid[1]) <= 1e-6 && Math.abs(centroid[2] - 25) <= 1e-6);
  const top = planeFace(base, (centroid) => Math.abs(centroid[2] - 10) <= 1e-6);
  expectVec(side.axis ?? [Number.NaN, Number.NaN, Number.NaN], [0, -1, 0], 12);
  expectVec(top.axis ?? [Number.NaN, Number.NaN, Number.NaN], [0, 0, 1], 12);
  const lines = standing.edges.filter((edge) => edge.curveKind === 'line'
    && Math.hypot(edge.midpoint[0] - 50, edge.midpoint[1], edge.midpoint[2]) <= 1e-6);
  const [line] = lines;
  if (lines.length !== 1 || line === undefined) throw new Error(`weld edges found: ${String(lines.length)}`);
  return {
    first: faceSelection('component-1', 'standing', standing, side), second: faceSelection('component-2', 'base', base, top),
    edge: edgeSelection(standing, line), legOnSecond: 6, legOnFirst: 8, segments: SEGMENTS, materialId: 'aluminum',
  };
}

async function planOblique(document: AssemblyDocument): Promise<FilletWeldPlanResult> {
  const parts = [platePart('weld-kernel-oblique-standing', STANDING), platePart('weld-kernel-oblique-base', OBLIQUE_BASE)];
  return withBodies<FilletWeldPlanResult>(parts, ([standing, plate]) => {
    if (standing === undefined || plate === undefined) throw new Error('plate bodies missing');
    return planFilletWeld(document, obliqueRequest(standing, plate), WELD_TEST_REVISIONS, lookup(standing, plate));
  });
}

/** 点 p(溶接線の座標の u・v)が三角形 a・b・c の中(辺の上を含む、表示の Float32 の誤差まで)か。 */
function insideTriangle(p: readonly [number, number], a: readonly [number, number], b: readonly [number, number],
  c: readonly [number, number], tolerance: number): boolean {
  const side = (o: readonly [number, number], q: readonly [number, number]): number => {
    const length = Math.hypot(q[0] - o[0], q[1] - o[1]);
    return ((q[0] - o[0]) * (p[1] - o[1]) - (q[1] - o[1]) * (p[0] - o[0])) / length;
  };
  const signs = [side(a, b), side(b, c), side(c, a)];
  return signs.every((value) => value >= -tolerance) || signs.every((value) => value <= tolerance);
}

describe('実カーネルの立板と底板の直角でない当たりにビードを足す', () => {
  it.each([[70, 20], [30, 60], [-30, 120], [-70, 160]] as const)('立板を %s° 傾けた内角 %s° の当たりで、実際のビードは手で求めた斜めの三角柱で体積は 24 sin θ × 長さ', async (tilt, angle) => {
    const document = obliqueTee(tilt);
    const result = await planOblique(document);
    if (!result.ok) throw new Error(JSON.stringify(result.rejections));
    const plan = result.plan;
    expect(plan.interiorAngle?.degrees).toBeCloseTo(angle, 9);
    expectVec(plan.frame.origin, OBLIQUE_FRAME.origin);
    expectVec(plan.frame.xAxis, OBLIQUE_FRAME.xAxis);
    expectVec(plan.frame.yAxis, OBLIQUE_FRAME.yAxis);
    expectVec(plan.frame.zAxis, OBLIQUE_FRAME.zAxis);
    for (const entry of plan.contact) expect(entry.coveredRatio).toBeCloseTo(1, 5);
    const area = 24 * Math.sin(angle * Math.PI / 180);
    expect(plan.nominalVolume).toBeCloseTo(area * 50.25, 9);
    if (angle === 60 || angle === 120) expect(area).toBeCloseTo(12 * Math.sqrt(3), 12);
    const applied = applyFilletWeld(document, plan, WELD_TEST_REVISIONS);
    if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
    const beads = await realBeads(applied.document, applied.componentIds);
    const tip: readonly [number, number] = [8 * Math.cos(angle * Math.PI / 180), 8 * Math.sin(angle * Math.PI / 180)];
    beads.forEach((bead, index) => {
      const segment = SEGMENTS[index];
      if (segment === undefined) throw new Error('segment missing');
      expect(Math.abs(bead.volume - area * segment.length) / (area * segment.length)).toBeLessThan(1e-8);
      const local = bead.world.map((point) => {
        const offset = subVec3(point, OBLIQUE_FRAME.origin);
        return [dotVec3(offset, OBLIQUE_FRAME.xAxis), dotVec3(offset, OBLIQUE_FRAME.yAxis), dotVec3(offset, OBLIQUE_FRAME.zAxis)] as const;
      });
      for (const [u, v, w] of local) {
        expect(insideTriangle([u, v], [0, 0], [6, 0], tip, 1e-4)).toBe(true);
        expect(w).toBeGreaterThanOrEqual(segment.start - 1e-4);
        expect(w).toBeLessThanOrEqual(segment.start + segment.length + 1e-4);
      }
      const us = local.map((point) => point[0]), vs = local.map((point) => point[1]);
      expect(Math.min(...us)).toBeCloseTo(Math.min(0, tip[0]), 4);
      // 20° は 1 つ目の脚の先(8 cos 20° ≈ 7.52)が 2 つ目の脚の先(6)より x の遠くにある。
      expect(Math.max(...us)).toBeCloseTo(Math.max(6, tip[0]), 4);
      expect(Math.max(...vs)).toBeCloseTo(tip[1], 4);
      expect(Math.min(...vs)).toBeCloseTo(0, 4);
    });
  });

  it('内角 0.5°(脚 6・8 mm の下限 asin 0.016 ≈ 0.917° より平行に近い)の当たりは実際の面でも断り、範囲を添える', async () => {
    const result = await planOblique(obliqueTee(89.5));
    expect(result.ok ? [] : result.rejections.map((rejection) => rejection.code)).toEqual(['unsupportedJointAngle']);
    const detail = result.ok ? null : result.rejections[0]?.detail;
    expect(detail?.angleDegrees).toBeCloseTo(0.5, 6);
    expect(detail?.minimumDegrees).toBeCloseTo(Math.asin(0.016) * 180 / Math.PI, 12);
  });
});

describe('real exterior cylinder to radial plate weld', () => {
  it.each([false, true])('uses native trim/identity and exact arc beads with no positive material interference (placed=%s)', async (placed) => {
    const native = createDirectInterferenceKernelBridge(createKernelApi(loadOcctForNode));
    const documents: PartDocument[] = [];
    const parts = new Map<string, ResolvedPart>();
    const bodies = new Map<string, readonly SolidBody[]>();
    async function compute(part: PartDocument): Promise<SolidBody> {
      documents.push(part);
      let resolved = resolvePart(part);
      const result = await recomputePart(part, native, { partId: part.id, onResolved(value) { resolved = value; } });
      expect(result.errors, part.id).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      const body = result.bodies[0];
      if (body === undefined) throw new Error('Missing native body');
      expect(body.isValid).toBe(true);
      parts.set(part.id, resolved); bodies.set(part.id, result.bodies);
      return body;
    }
    try {
      const standingPart = platePart('curved-weld-standing', [[-8, 10, 0], [0, 20, 100]]);
      const cylinderPart = addPrimitive({ ...createEmptyPartDocument(), id: 'curved-weld-cylinder' }, [0, 0, 0], {
        kind: 'cylinder', radius: expressionValueFromNumber(10), height: expressionValueFromNumber(100),
      }).document;
      const standing = await compute(standingPart), cylinder = await compute(cylinderPart);
      const plane = planeFace(standing, point => Math.abs(point[0]) < 1e-6);
      const [side, ...extra] = cylinder.faces.filter(face => face.surfaceKind === 'cylinder');
      if (side === undefined || extra.length !== 0) throw new Error('Cylinder face not unique');
      expect(side.cylinderExterior).toBe(true);
      expect(side.cylinderSpan).not.toBeNull();
      const [edge, ...otherEdges] = standing.edges.filter(candidate => candidate.curveKind === 'line'
        && Math.hypot(candidate.midpoint[0], candidate.midpoint[1] - 10, candidate.midpoint[2] - 50) < 1e-6);
      if (edge === undefined || otherEdges.length !== 0) throw new Error('Root edge not unique');
      const placement = placed ? weldTestPlacement([7, -2, 5], [Math.SQRT1_2, 0, 0, Math.SQRT1_2])
        : weldTestPlacement([0, 0, 0]);
      const document = teeJoint(placement, placement);
      const secondRef = { bodyFeatureId: cylinder.featureId, index: side.index, fingerprint: {
        kind: 'face' as const, surfaceKind: 'cylinder' as const, area: side.area, position: side.centroid, axis: side.axis, radius: side.radius,
      } };
      const selection = bindFilletWeldSelection(document, {
        first: { componentId: 'component-1', ref: faceSelection('component-1', 'standing', standing, plane).face },
        edge: { componentId: 'component-1', ref: edgeSelection(standing, edge).edge },
        second: { componentId: 'component-2', ref: secondRef },
      }, (component, reference) => {
        const result = resolveSubShapeReference(component.id === 'component-1' ? standing : cylinder, reference);
        return result.status === 'matched' ? result.match.geometry : null;
      }, WELD_TEST_REVISIONS);
      if (!selection.ok) throw new Error(JSON.stringify(selection.rejections));
      const result = planFilletWeld(document, { first: selection.first, second: selection.second, edge: selection.edge,
        legOnSecond: 2, legOnFirst: 3, segments: SEGMENTS, materialId: 'aluminum' }, WELD_TEST_REVISIONS, lookup(standing, cylinder));
      if (!result.ok) throw new Error(JSON.stringify(result.rejections));
      const framePlacement = rigidPlacementOf(placement);
      expectVec(result.plan.frame.origin, applyPlacementToPoint(framePlacement, [0, 10, 0]));
      expectVec(result.plan.frame.xAxis, applyPlacementToDirection(framePlacement, [1, 0, 0]));
      expectVec(result.plan.frame.yAxis, applyPlacementToDirection(framePlacement, [0, 1, 0]));
      // Sector subtraction with R=10, arc=2, radial leg=3; independent of the production helper.
      const expectedArea = (30 * Math.sin(0.2) - 100 * (0.2 - Math.sin(0.2))) / 2;
      expect(result.plan.nominalVolume).toBeCloseTo(expectedArea * 50.25, 9);
      const applied = applyFilletWeld(document, result.plan, WELD_TEST_REVISIONS);
      if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
      const partKeys = new Map([['component-1', standingPart.id], ['component-2', cylinderPart.id]]);
      const placements = new Map(applied.document.components.map(component => [component.id, rigidPlacementOf(component.placement)]));
      for (const [index, id] of applied.componentIds.entries()) {
        const component = applied.document.components.find(item => item.id === id);
        if (component?.source.kind !== 'standardPart') throw new Error('Missing weld source');
        const generated = buildStandardPartFromSource(component.source);
        if (generated === null) throw new Error('Weld source refused');
        const part = { ...generated, id: `curved-weld-bead-${String(index)}` };
        const body = await compute(part);
        partKeys.set(id, part.id);
        const expectedVolume = expectedArea * SEGMENTS[index].length;
        expect(Math.abs(body.volume - expectedVolume) / expectedVolume).toBeLessThan(1e-8);
      }
      const pairs = applied.componentIds.flatMap(id => [[id, 'component-1'], [id, 'component-2']] as const);
      const intersection = await native.checkInterference({ requestId: 'curved-weld-material-intersection',
        components: applied.document.components, resolved: { parts, partKeys, placements, errors: [] }, bodies, placements }, { pairs });
      expect(intersection).toMatchObject({ kind: 'checked', failure: null, failures: [], pendingPairCount: 0,
        skippedPairCount: 0, checkedPairCount: 6, pairs: [] });
    } finally {
      try { for (const part of documents) await native.releasePart(part.id); }
      finally { native.dispose(); }
    }
  });
});

describe('real inner cylinder to radial plate weld', () => {
  it.each([false, true])('uses the actual clipped plate and cavity through public binding, then checks both mother volumes (placed=%s)', async (placed) => {
    const native = createDirectInterferenceKernelBridge(createKernelApi(loadOcctForNode));
    const documents: PartDocument[] = [];
    const parts = new Map<string, ResolvedPart>();
    const bodies = new Map<string, readonly SolidBody[]>();
    async function compute(part: PartDocument): Promise<SolidBody> {
      documents.push(part);
      let resolved = resolvePart(part);
      const result = await recomputePart(part, native, { partId: part.id, onResolved(value) { resolved = value; } });
      expect(result.errors, part.id).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      const body = result.bodies[0];
      if (body === undefined) throw new Error('Missing native body');
      expect(body.isValid).toBe(true);
      parts.set(part.id, resolved); bodies.set(part.id, result.bodies);
      return body;
    }
    try {
      const innerShape: PrimitiveShape = { kind: 'cylinder', radius: expressionValueFromNumber(10), height: expressionValueFromNumber(100) };
      const rawPlate = platePart('inner-weld-standing', [[-2, -10, 0], [0, -4, 100]]);
      const plateTarget = rawPlate.solids[0];
      if (plateTarget === undefined) throw new Error('Missing plate feature');
      const clip = addPrimitive(rawPlate, [0, 0, 0], innerShape);
      const standingPart = appendSolid(clip.document, { id: nextSolidId(clip.document, 'intersect'),
        name: nextSolidName(clip.document, 'intersect'), suppressed: false, kind: 'boolean', operation: 'intersect',
        targetFeatureId: plateTarget.id, toolFeatureId: clip.id });
      const outer = addPrimitive({ ...createEmptyPartDocument(), id: 'inner-weld-cylinder' }, [0, 0, 0], {
        kind: 'cylinder', radius: expressionValueFromNumber(14), height: expressionValueFromNumber(100),
      });
      const hole = addPrimitive(outer.document, [0, 0, 0], innerShape);
      const cylinderPart = appendSolid(hole.document, { id: nextSolidId(hole.document, 'subtract'),
        name: nextSolidName(hole.document, 'subtract'), suppressed: false, kind: 'boolean', operation: 'subtract',
        targetFeatureId: outer.id, toolFeatureId: hole.id });
      const standing = await compute(standingPart), cylinder = await compute(cylinderPart);
      const plane = planeFace(standing, point => Math.abs(point[0]) < 1e-6);
      const [side, ...extra] = cylinder.faces.filter(face => face.surfaceKind === 'cylinder' && face.radius !== null && Math.abs(face.radius - 10) < 1e-6);
      if (side === undefined || extra.length !== 0) throw new Error('Cylinder face not unique');
      expect(side.cylinderExterior).toBe(false);
      expect(Math.abs(cylinder.volume - 9600 * Math.PI) / (9600 * Math.PI)).toBeLessThan(1e-8);
      expect(side.cylinderSpan).not.toBeNull();
      const [edge, ...otherEdges] = standing.edges.filter(candidate => candidate.curveKind === 'line'
        && Math.hypot(candidate.midpoint[0], candidate.midpoint[1] + 10, candidate.midpoint[2] - 50) < 1e-6);
      if (edge === undefined || otherEdges.length !== 0) throw new Error('Root edge not unique');
      const placement = placed ? weldTestPlacement([7, -2, 5], [Math.SQRT1_2, 0, 0, Math.SQRT1_2])
        : weldTestPlacement([0, 0, 0]);
      const document = teeJoint(placement, placement);
      const secondRef = { bodyFeatureId: cylinder.featureId, index: side.index, fingerprint: {
        kind: 'face' as const, surfaceKind: 'cylinder' as const, area: side.area, position: side.centroid, axis: side.axis, radius: side.radius,
      } };
      const selection = bindFilletWeldSelection(document, {
        first: { componentId: 'component-1', ref: faceSelection('component-1', 'standing', standing, plane).face },
        edge: { componentId: 'component-1', ref: edgeSelection(standing, edge).edge },
        second: { componentId: 'component-2', ref: secondRef },
      }, (component, reference) => {
        const result = resolveSubShapeReference(component.id === 'component-1' ? standing : cylinder, reference);
        return result.status === 'matched' ? result.match.geometry : null;
      }, WELD_TEST_REVISIONS);
      if (!selection.ok) throw new Error(JSON.stringify(selection.rejections));
      const segments = [{ start: 5, length: 25 }];
      const result = planFilletWeld(document, { first: selection.first, second: selection.second, edge: selection.edge,
        legOnSecond: 2, legOnFirst: 3, segments, materialId: 'aluminum' }, WELD_TEST_REVISIONS, lookup(standing, cylinder));
      if (!result.ok) throw new Error(JSON.stringify(result.rejections));
      const framePlacement = rigidPlacementOf(placement);
      expectVec(result.plan.frame.origin, applyPlacementToPoint(framePlacement, [0, -10, 0]));
      expectVec(result.plan.frame.xAxis, applyPlacementToDirection(framePlacement, [1, 0, 0]));
      expectVec(result.plan.frame.yAxis, applyPlacementToDirection(framePlacement, [0, 1, 0]));
      // Inner sector addition, derived independently from the actual circle and two straight sides.
      const expectedArea = (30 * Math.sin(0.2) + 100 * (0.2 - Math.sin(0.2))) / 2;
      expect(result.plan.nominalVolume).toBeCloseTo(expectedArea * 25, 9);
      expect(result.plan.cylindricalSide).toBe('interior');
      const tooDeep = planFilletWeld(document, { first: selection.first, second: selection.second, edge: selection.edge,
        legOnSecond: 2, legOnFirst: 20, segments, materialId: 'aluminum' }, WELD_TEST_REVISIONS, lookup(standing, cylinder));
      expect(tooDeep.ok ? [] : tooDeep.rejections.map(item => item.code)).toEqual(['degenerateCrossSection']);
      const applied = applyFilletWeld(document, result.plan, WELD_TEST_REVISIONS);
      if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
      const partKeys = new Map([['component-1', standingPart.id], ['component-2', cylinderPart.id]]);
      const placements = new Map(applied.document.components.map(component => [component.id, rigidPlacementOf(component.placement)]));
      for (const [index, id] of applied.componentIds.entries()) {
        const component = applied.document.components.find(item => item.id === id);
        if (component?.source.kind !== 'standardPart') throw new Error('Missing weld source');
        const generated = buildStandardPartFromSource(component.source);
        if (generated === null) throw new Error('Weld source refused');
        const part = { ...generated, id: `inner-weld-bead-${String(index)}` };
        const body = await compute(part);
        partKeys.set(id, part.id);
        const expectedVolume = expectedArea * segments[index].length;
        expect(Math.abs(body.volume - expectedVolume) / expectedVolume).toBeLessThan(1e-8);
      }
      const pairs = applied.componentIds.flatMap(id => [[id, 'component-1'], [id, 'component-2']] as const);
      const intersection = await native.checkInterference({ requestId: 'inner-weld-material-intersection',
        components: applied.document.components, resolved: { parts, partKeys, placements, errors: [] }, bodies, placements }, { pairs });
      expect(intersection).toMatchObject({ kind: 'checked', failure: null, failures: [], pendingPairCount: 0,
        skippedPairCount: 0, checkedPairCount: 2, pairs: [] });
    } finally {
      try { for (const part of documents) await native.releasePart(part.id); }
      finally { native.dispose(); }
    }
  });
});
