/**
 * 締結部品の自動判別(E-07)の検査: 資料の族の 20×20 を一括の配置で L・T・突き合わせに置き、接続に合う板の候補(L 形のブラケット・平板)が、
 * 溝幅の合う行だけ通り、確定すると板・溝用のナット・ボルトと接続の記録が 1 回の文書で足される事。ボルトの呼びの既定は、板の穴の径と
 * 通し穴の径の表から 1 つに決まる時だけ。斜めなど、扱わない形は候補が無い。
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
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import type { FrameLine } from './frameMembers.js';
import { planFrameMembers } from './frameMembers.js';
import { applyJointBracket, jointBracketChoices, loadJointBracketRecords, type JointBracketInputs, type JointBracketRecords } from './frameJointBrackets.js';
import { classifyFrameJoints, placedFrameMembers, type FrameJoint } from './frameJoints.js';

const SERIES = T_SLOT_CATALOG_FAMILIES.s6;
const CHOICES = { nominal: null, nutEntry: '後入れ', nutMaterial: 'steel' };
let records: JointBracketRecords;
let families: JointBracketInputs['families'];

beforeAll(async () => {
  await PRODUCT_CATALOG_REGISTRY.ensure(['t-slot-angle-bracket', 't-slot-flat-plate', 't-slot-nut', 'socket-head-cap-screw', SERIES.id]);
  records = await loadJointBracketRecords();
  const loaded = (id: string): CatalogFamily => {
    const family = PRODUCT_CATALOG_REGISTRY.loaded(id);
    if (family === undefined) throw new Error(id);
    return family;
  };
  families = { angle: loaded('t-slot-angle-bracket'), plate: loaded('t-slot-flat-plate') };
});

/** 線に沿って 20×20 を置いた組立と、表示の配置・部材・接続・溝の候補。 */
function assemble(lines: readonly FrameLine[], corners: 'none' | 'butt'): { readonly document: AssemblyDocument; readonly inputs: (joint: FrameJoint)
  => JointBracketInputs; readonly joints: readonly FrameJoint[] } {
  const row = SERIES.rows.find((candidate) => candidate.key === 's6-20x20');
  const bounds = row === undefined ? null : SERIES.sectionBounds?.(row, { length: '500' }) ?? null;
  if (row === undefined || bounds === null) throw new Error('row');
  const plan = planFrameMembers(lines, { section: bounds, up: [0, 0, 1], startExtension: 0, endExtension: 0, corners });
  if (!plan.ok) throw new Error(plan.reason);
  const placements = new Map<string, RigidPlacement>();
  const components: AssemblyComponent[] = plan.members.map((planned, index) => {
    const id = `m${String(index)}`;
    placements.set(id, planned.placement);
    const [x, y, z] = planned.placement.position;
    return { id, name: id, source: createCatalogItemSource(SERIES, row, { length: String(planned.lengthMm) }), fixed: true, visible: true,
      suppressed: false, placement: { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)],
        rotation: planned.placement.rotation } };
  });
  const document: AssemblyDocument = { ...createAssemblyDocument('接続'), components };
  const members = placedFrameMembers(document, placements);
  const byId = new Map(members.map((member) => [member.componentId, member]));
  const frames = frameSlotCandidates(document, placements);
  return { document, joints: classifyFrameJoints(members), inputs: (joint) => ({ joint, members: byId, frames, records, families, choices: CHOICES,
    nutFamily: T_SLOT_NUT_FAMILY, nutRecords: T_SLOT_NUT_RECORDS, partRevisions: new Map() }) };
}

describe('締結部品の自動判別', () => {
  it('L 字: 当てる部材の内側の角(当たられる面の上に脚が乗る所)の候補だけを作り、通る候補は溝幅 6 の L 形のブラケット。確定すると板・ナット・ボルトと記録が 1 回で足される', () => {
    const built = assemble([{ start: [0, 0, 0], end: [500, 0, 0] }, { start: [500, 0, 0], end: [500, 500, 0] }], 'butt');
    const joint = built.joints[0];
    if (joint === undefined) throw new Error('joint');
    const choices = jointBracketChoices(built.document, built.inputs(joint));
    const passing = choices.filter((choice) => choice.result.ok);
    expect(passing.length).toBeGreaterThan(0);
    expect(new Set(passing.map((choice) => choice.bracket.faces.map((face) => `${face.componentId}:${face.face}`).sort().join('|'))).size).toBe(1);
    for (const choice of passing) {
      const record = records.angles.find((candidate) => candidate.key === choice.bracket.key);
      expect([choice.bracket.familyId, record?.slot, choice.nominal]).toEqual(['t-slot-angle-bracket', 6, 'M5']);
    }
    const first = passing[0];
    if (first === undefined || !first.result.ok) throw new Error('first');
    const holes = first.bracket.holes.length;
    const applied = applyJointBracket(built.document, built.inputs(joint), first);
    if (!applied.ok) throw new Error(JSON.stringify(applied.result));
    expect(applied.document.components).toHaveLength(2 + 1 + 2 * holes);
    expect(applied.document.schemaVersion).toBe(23);
    expect(applied.document.frameJoints?.map((record) => [record.kind, record.bracket.componentId, record.fastenerIds.length]))
      .toEqual([['L', applied.componentIds[0], 2 * holes]]);
  });

  it('T 字: 通す部材の両側(当てる部材の 2 つの面)に内側の角がある', () => {
    const built = assemble([{ start: [0, 0, 0], end: [500, 0, 0] }, { start: [250, 10, 0], end: [250, 500, 0] }], 'none');
    const joint = built.joints.find((candidate) => candidate.kind === 'T');
    if (joint === undefined) throw new Error('T');
    const faces = new Set(jointBracketChoices(built.document, built.inputs(joint)).filter((choice) => choice.result.ok)
      .map((choice) => choice.bracket.faces.map((face) => `${face.componentId}:${face.face}`).sort().join('|')));
    expect(faces.size).toBe(2);
  });

  it('突き合わせ: 同じ直線の 2 本の同じ向きの面に平板を置き、溝幅 6 の平板が通る', () => {
    const built = assemble([{ start: [0, 0, 0], end: [500, 0, 0] }, { start: [500, 0, 0], end: [1000, 0, 0] }], 'none');
    const joint = built.joints.find((candidate) => candidate.kind === 'butt');
    if (joint === undefined) throw new Error('butt');
    const passing = jointBracketChoices(built.document, built.inputs(joint)).filter((choice) => choice.result.ok);
    expect(passing.length).toBeGreaterThan(0);
    expect(new Set(passing.map((choice) => [choice.bracket.familyId, records.plates.find((plate) => plate.key === choice.bracket.key)?.slot].join(':'))))
      .toEqual(new Set(['t-slot-flat-plate:6']));
  });

  it('斜め・並びなど扱わない形の接続は、候補が無い', () => {
    const built = assemble([{ start: [0, 0, 0], end: [500, 0, 0] }, { start: [0, 20, 0], end: [500, 20, 0] }], 'none');
    const joint = built.joints[0];
    if (joint === undefined) throw new Error('joint');
    expect(joint.kind).toBe('parallel');
    expect(jointBracketChoices(built.document, built.inputs(joint))).toEqual([]);
  });
});
