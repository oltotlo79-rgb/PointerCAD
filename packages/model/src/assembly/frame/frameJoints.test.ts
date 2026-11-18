/**
 * 部材の接続の見分け(E-07・E-09 の土台)の検査: L・T・十字・突き合わせ・交差・並び・斜めを、手で置いた 20×20 の部材で見分ける事、
 * 離れが許容差(0.01 mm)を超えると接続にしない事、id が部品の並びに依らない事。資料の族の部材を一括の配置(突き当て)で L に置くと、
 * 組立から作った部材(placedFrameMembers)で L が 1 つ見つかり、部材が溝の線と溝の呼びの幅を持つ事。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import { beforeAll, describe, expect, it } from 'vitest';

import { T_SLOT_CATALOG_FAMILIES } from '../catalog/families/tSlotFrameCatalog.js';
import { PRODUCT_CATALOG_REGISTRY } from '../catalog/registry.js';
import { createCatalogItemSource } from '../catalog/source.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import type { RigidPlacement } from '../placementMath.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import { crossVec3, dotVec3, normalizeVec3, scaleVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import { planFrameMembers } from './frameMembers.js';
import { classifyFrameJoints, placedFrameMembers, type FrameJoint, type PlacedFrameMember } from './frameJoints.js';

/** 軸 start→end、断面の上(局所 +Y)を `up` に向けた size × size の部材(断面の中心が軸の上)。 */
function member(id: string, start: Vec3, end: Vec3, up: Vec3 = [0, 0, 1], size = 20): PlacedFrameMember {
  const z = normalizeVec3(subVec3(end, start));
  const y = normalizeVec3(subVec3(up, scaleVec3(z, dotVec3(up, z))));
  return { componentId: id, start, end, xAxis: crossVec3(y, z), yAxis: y,
    bounds: { minX: -size / 2, maxX: size / 2, minY: -size / 2, maxY: size / 2 }, slotLines: [], slotSpec: null };
}

/** 接続の形と、部材ごとの [id, 当たる所, 面]。 */
function shape(joints: readonly FrameJoint[]): readonly unknown[] {
  return joints.map((joint) => [joint.kind, joint.members.map((item) => [item.componentId, item.part, item.face])]);
}

/** 軸 +X の部材 a(x 0〜480。箱は y・z が ±10)。 */
const A = member('a', [0, 0, 0], [480, 0, 0]);

describe('部材の接続の見分け', () => {
  it('L: a の終点の端の面が b の側の面に当たり、b の始点が a の外の面とそろう(どちらも端)', () => {
    const b = member('b', [490, -10, 0], [490, 500, 0]);
    expect(shape(classifyFrameJoints([A, b]))).toEqual([['L', [['a', 'end', null], ['b', 'start', null]]]]);
    expect(classifyFrameJoints([b, A]).map((joint) => joint.id)).toEqual(classifyFrameJoints([A, b]).map((joint) => joint.id));
  });

  it('T: b の始点の端が a の途中の側の面(局所 +X = 世界 +Y の面)に当たる。反対の面にも当たる c があれば十字にまとめる', () => {
    const b = member('b', [240, 10, 0], [240, 500, 0]);
    expect(shape(classifyFrameJoints([A, b]))).toEqual([['T', [['a', 'side', 'right'], ['b', 'start', null]]]]);
    const c = member('c', [240, -10, 0], [240, -500, 0]);
    expect(shape(classifyFrameJoints([A, b, c]))).toEqual([['cross', [['a', 'side', 'right'], ['b', 'start', null], ['c', 'start', null]]]]);
  });

  it('突き合わせ: 同じ直線の上で端どうしが当たる。軸がずれて端どうしが横に当たる時は並び', () => {
    expect(shape(classifyFrameJoints([A, member('b', [480, 0, 0], [980, 0, 0])]))).toEqual([['butt', [['a', 'end', null], ['b', 'start', null]]]]);
    expect(classifyFrameJoints([A, member('b', [470, 20, 0], [980, 20, 0])]).map((joint) => joint.kind)).toEqual(['parallel']);
  });

  it('交差(途中どうし・直交。上に重ねる)・並び(平行で横に接する)・斜め(直交でも平行でもない)', () => {
    expect(shape(classifyFrameJoints([A, member('b', [240, -250, 20], [240, 250, 20])])))
      .toEqual([['crossing', [['a', 'side', 'top'], ['b', 'side', 'bottom']]]]);
    expect(shape(classifyFrameJoints([A, member('b', [0, 20, 0], [480, 20, 0])])))
      .toEqual([['parallel', [['a', 'side', 'right'], ['b', 'side', 'left']]]]);
    const slant = 300 / Math.SQRT2;
    expect(classifyFrameJoints([A, member('b', [485, 0, 0], [485 + slant, slant, 0])]).map((joint) => joint.kind)).toEqual(['angled']);
  });

  it('離れが許容差(0.01 mm)以内なら接続、超えると接続にしない', () => {
    expect(classifyFrameJoints([A, member('b', [240, 10.005, 0], [240, 500, 0])]).map((joint) => joint.kind)).toEqual(['T']);
    expect(classifyFrameJoints([A, member('b', [240, 10.02, 0], [240, 500, 0])])).toEqual([]);
  });
});

describe('組立の部材から作る', () => {
  const family = T_SLOT_CATALOG_FAMILIES.s6;
  beforeAll(async () => { await PRODUCT_CATALOG_REGISTRY.ensure([family.id]); });

  it('資料の族の 20×20 を一括の配置(突き当て)で L に置くと、L が 1 つ見つかり、部材は溝の線を持つ', () => {
    const row = family.rows.find((candidate) => candidate.key === 's6-20x20');
    const bounds = row === undefined ? null : family.sectionBounds?.(row, { length: '500' }) ?? null;
    if (row === undefined || bounds === null) throw new Error('row');
    const plan = planFrameMembers([{ start: [0, 0, 0], end: [500, 0, 0] }, { start: [500, 0, 0], end: [500, 500, 0] }],
      { section: bounds, up: [0, 0, 1], startExtension: 0, endExtension: 0, corners: 'butt' });
    if (!plan.ok) throw new Error(plan.reason);
    const placements = new Map<string, RigidPlacement>();
    const components: AssemblyComponent[] = plan.members.map((planned, index) => {
      const id = `m${String(index)}`;
      placements.set(id, planned.placement);
      const [x, y, z] = planned.placement.position;
      return { id, name: id, source: createCatalogItemSource(family, row, { length: String(planned.lengthMm) }), fixed: true, visible: true,
        suppressed: false, placement: { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)],
          rotation: planned.placement.rotation } };
    });
    const document: AssemblyDocument = { ...createAssemblyDocument('接続'), components };
    const members = placedFrameMembers(document, placements);
    expect(members.map((item) => [item.componentId, item.slotLines.length > 0, item.slotSpec])).toEqual([
      ['m0', true, { width: 6, positionSimplified: false }], ['m1', true, { width: 6, positionSimplified: false }]]);
    expect(classifyFrameJoints(members).map((joint) => joint.kind)).toEqual(['L']);
  });
});
