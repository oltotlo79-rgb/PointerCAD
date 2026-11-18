/**
 * 伸縮(E-13)の検査: 資料の族の 20×20 を一括の配置で L に置き、E-07 で留めた組立を、面の向こうを動かす形で伸ばすと、面をまたぐ平行な部材が
 * 伸び、向こうの部材と板・ナット・ボルトが一緒に動き、記録の接続がそのままで接合チェックは記録で「留めた」のままである事。始点が向こうの部材は
 * 位置も動く事。断る理由(量が 0・面をまたぐ部材でない部品・平行でない部材・縮め過ぎ・合致に指されている)。
 * 部材の外接箱は置いた部材の箱から作り、部材でない部品は箱を渡さない(配置の原点の 1 点で分ける)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import { beforeAll, describe, expect, it } from 'vitest';

import { T_SLOT_NUT_FAMILY } from '../catalog/families/framePartCatalog.js';
import { T_SLOT_NUT_RECORDS } from '../catalog/families/framePartRows.js';
import { T_SLOT_CATALOG_FAMILIES } from '../catalog/families/tSlotFrameCatalog.js';
import { PRODUCT_CATALOG_REGISTRY } from '../catalog/registry.js';
import { createCatalogItemSource } from '../catalog/source.js';
import type { CatalogFamily } from '../catalog/types.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import { frameSlotCandidates } from '../fastening/frameSlotRequest.js';
import type { RigidPlacement } from '../placementMath.js';
import type { AssemblyComponent, AssemblyDocument, MateTarget } from '../types.js';
import type { Vec3 } from '../../sketch/vec3.js';
import { planFrameMembers, type FrameLine } from './frameMembers.js';
import { applyJointBracket, jointBracketChoices, loadJointBracketRecords, type JointBracketInputs } from './frameJointBrackets.js';
import { checkFrameJoints, slotFastenerParts, type PartBox } from './frameJointCheck.js';
import { classifyFrameJoints, frameJointRecordStatus, placedFrameMembers, splitCrossJoints, type PlacedFrameMember } from './frameJoints.js';
import { planMemberStretch } from './memberStretch.js';

const SERIES = T_SLOT_CATALOG_FAMILIES.s6;
let inputsBase: Omit<JointBracketInputs, 'joint' | 'members' | 'frames'>;

beforeAll(async () => {
  await PRODUCT_CATALOG_REGISTRY.ensure(['t-slot-angle-bracket', 't-slot-flat-plate', 't-slot-nut', 'socket-head-cap-screw', SERIES.id]);
  const loaded = (id: string): CatalogFamily => {
    const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
    if (family === undefined) throw new Error(id);
    return family;
  };
  inputsBase = { records: await loadJointBracketRecords(), families: { angle: loaded('t-slot-angle-bracket'), plate: loaded('t-slot-flat-plate') },
    choices: { nominal: null, nutEntry: '後入れ', nutMaterial: 'steel' }, nutFamily: T_SLOT_NUT_FAMILY, nutRecords: T_SLOT_NUT_RECORDS,
    partRevisions: new Map() };
});

function placementsOf(document: AssemblyDocument): ReadonlyMap<string, RigidPlacement> {
  return new Map(document.components.map((component) => [component.id, { position: [component.placement.position[0].value,
    component.placement.position[1].value, component.placement.position[2].value], rotation: component.placement.rotation }]));
}

/** 線に沿って 20×20 を置いた文書(角の扱いは突き当て)。 */
function placed(lines: readonly FrameLine[]): AssemblyDocument {
  const row = SERIES.rows.find((candidate) => candidate.key === 's6-20x20');
  const bounds = row === undefined ? null : SERIES.sectionBounds?.(row, { length: '500' }) ?? null;
  if (row === undefined || bounds === null) throw new Error('row');
  const plan = planFrameMembers(lines, { section: bounds, up: [0, 0, 1], startExtension: 0, endExtension: 0, corners: 'butt' });
  if (!plan.ok) throw new Error(plan.reason);
  const components: AssemblyComponent[] = plan.members.map((planned, index) => {
    const id = `m${String(index)}`;
    const [x, y, z] = planned.placement.position;
    return { id, name: id, source: createCatalogItemSource(SERIES, row, { length: String(planned.lengthMm) }), fixed: true, visible: true,
      suppressed: false, placement: { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)],
        rotation: planned.placement.rotation } };
  });
  return { ...createAssemblyDocument('伸縮'), components };
}

/** L に置いて、接続を E-07 の通る最初の候補で留めた文書。 */
function fastenedL(): AssemblyDocument {
  const document = placed([{ start: [0, 0, 0], end: [500, 0, 0] }, { start: [500, 0, 0], end: [500, 500, 0] }]);
  const placements = placementsOf(document);
  const members = placedFrameMembers(document, placements);
  const joint = splitCrossJoints(classifyFrameJoints(members))[0];
  if (joint === undefined) throw new Error('joint');
  const inputs: JointBracketInputs = { ...inputsBase, joint, members: new Map(members.map((member) => [member.componentId, member])),
    frames: frameSlotCandidates(document, placements) };
  const choice = jointBracketChoices(document, inputs).find((candidate) => candidate.result.ok);
  if (choice === undefined) throw new Error('choice');
  const applied = applyJointBracket(document, inputs, choice);
  if (!applied.ok) throw new Error('apply');
  return applied.document;
}

/** 置いた部材の世界の外接箱(向きつきの箱の 8 隅を囲む)。 */
function memberBox(member: PlacedFrameMember): PartBox {
  const { minX, maxX, minY, maxY } = member.bounds;
  const corners = [member.start, member.end].flatMap((end) => [minX, maxX].flatMap((x) => [minY, maxY].map((y): Vec3 => [
    end[0] + member.xAxis[0] * x + member.yAxis[0] * y, end[1] + member.xAxis[1] * x + member.yAxis[1] * y,
    end[2] + member.xAxis[2] * x + member.yAxis[2] * y])));
  const pick = (axis: 0 | 1 | 2, choose: (...values: number[]) => number): number => choose(...corners.map((corner) => corner[axis]));
  return { min: [pick(0, Math.min), pick(1, Math.min), pick(2, Math.min)], max: [pick(0, Math.max), pick(1, Math.max), pick(2, Math.max)] };
}

function boxesOf(document: AssemblyDocument): ReadonlyMap<string, PartBox> {
  return new Map(placedFrameMembers(document, placementsOf(document)).map((member) => [member.componentId, memberBox(member)]));
}

function lengthOf(document: AssemblyDocument, componentId: string): string | undefined {
  const source = document.components.find((component) => component.id === componentId)?.source;
  return source?.kind === 'standardPart' ? source.options.length : undefined;
}

function xOf(document: AssemblyDocument, componentId: string): number | undefined {
  return document.components.find((component) => component.id === componentId)?.placement.position[0].value;
}

describe('伸縮', () => {
  it('+X の面 250 で 100 伸ばすと、下の部材が伸び、立つ部材と板・ナット・ボルトが +100 動き、記録はそのままで接合チェックは記録で留めたまま', () => {
    const document = fastenedL();
    const record = document.frameJoints?.[0];
    if (record === undefined) throw new Error('record');
    const plan = planMemberStretch(document, { direction: '+x', plane: 250, amount: 100 }, boxesOf(document));
    if (!plan.ok) throw new Error(JSON.stringify(plan));
    expect(plan.stretched.map((member) => member.componentId)).toEqual(['m0']);
    expect(Number(lengthOf(plan.document, 'm0'))).toBe(Number(lengthOf(document, 'm0')) + 100);
    for (const id of ['m1', record.bracket.componentId, ...record.fastenerIds]) {
      expect(plan.moved).toContain(id);
      expect((xOf(plan.document, id) ?? Number.NaN) - (xOf(document, id) ?? Number.NaN)).toBeCloseTo(100, 6);
    }
    expect(plan.document.frameJoints).toEqual(document.frameJoints);
    const placements = placementsOf(plan.document);
    const members = placedFrameMembers(plan.document, placements);
    const joints = classifyFrameJoints(members);
    expect(frameJointRecordStatus(plan.document, record, splitCrossJoints(joints))).toBe('ok');
    const check = checkFrameJoints({ document: plan.document, members, joints, fasteners: slotFastenerParts(plan.document, placements), partBoxes: new Map() });
    expect(check.ok ? check.statuses.map((status) => status.fastening) : check.reason).toEqual(['recorded']);
  });

  it('始点が向こうの部材(終点 → 始点が +X)は、長さと一緒に位置も動く。縮める時は面の向こうの部分より縮めない', () => {
    const document = placed([{ start: [500, 0, 0], end: [0, 0, 0] }]);
    const before = xOf(document, 'm0') ?? Number.NaN;
    const plan = planMemberStretch(document, { direction: '+x', plane: 250, amount: 100 }, boxesOf(document));
    if (!plan.ok) throw new Error(JSON.stringify(plan));
    expect([lengthOf(plan.document, 'm0'), (xOf(plan.document, 'm0') ?? Number.NaN) - before]).toEqual(['600', 100]);
    expect(planMemberStretch(document, { direction: '+x', plane: 250, amount: -260 }, boxesOf(document)))
      .toEqual({ ok: false, reason: 'invalidLength', componentIds: ['m0'], count: 1 });
    const shrunk = planMemberStretch(document, { direction: '+x', plane: 250, amount: -100 }, boxesOf(document));
    expect(shrunk.ok ? lengthOf(shrunk.document, 'm0') : shrunk.reason).toBe('400');
  });

  it('量が 0・面をまたぐ部材でない部品・平行でない部材・合致に指されている部品は、何も変えずに理由と数', () => {
    const document = fastenedL();
    const boxes = boxesOf(document);
    expect(planMemberStretch(document, { direction: '+x', plane: 250, amount: 0 }, boxes)).toMatchObject({ ok: false, reason: 'noAmount' });
    expect(planMemberStretch(document, { direction: '+y', plane: 0, amount: 50 }, boxes))
      .toMatchObject({ ok: false, reason: 'notParallel', componentIds: ['m0'] });
    const bracket = document.frameJoints?.[0]?.bracket.componentId ?? '';
    const across = new Map([...boxes, [bracket, { min: [400, -50, -50], max: [600, 50, 50] }]]);
    expect(planMemberStretch(document, { direction: '+x', plane: 500, amount: 50 }, across))
      .toMatchObject({ ok: false, reason: 'straddling', componentIds: [bracket] });
    const target = (componentId: string): MateTarget => ({ kind: 'origin', componentId, element: 'xy' });
    const mated: AssemblyDocument = { ...document, mates: [
      { id: 'mate-1', name: 'mate-1', kind: 'coincident', a: target('m1'), b: target('m0'), flipped: false, suppressed: false }] };
    expect(planMemberStretch(mated, { direction: '+x', plane: 250, amount: 100 }, boxes)).toEqual({ ok: false, reason: 'referenced', componentIds: [], count: 1 });
  });
});
