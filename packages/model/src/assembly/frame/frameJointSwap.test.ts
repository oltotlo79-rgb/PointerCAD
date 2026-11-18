/**
 * 結合の入れ替え(E-13)の検査: 資料の族の 20×20 を一括の配置で L に置き、E-07 で留めた接続の板を別の候補へ替えると、記録の id と並びの位置が
 * 保たれ、古い板・ナット・ボルトが消えて新しい物が足され、接合チェックは記録で「留めた」のままである事。記録を外すと部品は残る事。
 * 記録の状態(そのまま・部品が欠けた・部材が無い・接続が見つからない)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import { beforeAll, describe, expect, it } from 'vitest';

import { T_SLOT_NUT_FAMILY } from '../catalog/families/framePartCatalog.js';
import { T_SLOT_NUT_RECORDS } from '../catalog/families/framePartRows.js';
import { T_SLOT_CATALOG_FAMILIES } from '../catalog/families/tSlotFrameCatalog.js';
import { PRODUCT_CATALOG_REGISTRY } from '../catalog/registry.js';
import { createCatalogItemSource } from '../catalog/source.js';
import type { CatalogFamily } from '../catalog/types.js';
import { removeComponent } from '../assemblyEdit.js';
import { createAssemblyDocument } from '../createAssemblyDocument.js';
import { frameSlotCandidates } from '../fastening/frameSlotRequest.js';
import type { RigidPlacement } from '../placementMath.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import { planFrameMembers, type FrameLine } from './frameMembers.js';
import { applyJointBracket, jointBracketChoices, loadJointBracketRecords, type JointBracketInputs, type JointBracketRecords } from './frameJointBrackets.js';
import { checkFrameJoints, slotFastenerParts } from './frameJointCheck.js';
import { detachFrameJointRecord, swapFrameJointBracket } from './frameJointSwap.js';
import { classifyFrameJoints, frameJointRecordStatus, placedFrameMembers, recordedFrameJoint, splitCrossJoints, type FrameJoint } from './frameJoints.js';

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

/** 部品の配置(文書の配置。合致の無い組立なので表示の配置と同じ)。 */
function placementsOf(document: AssemblyDocument): ReadonlyMap<string, RigidPlacement> {
  return new Map(document.components.map((component) => [component.id, { position: [component.placement.position[0].value,
    component.placement.position[1].value, component.placement.position[2].value], rotation: component.placement.rotation }]));
}

/** 文書の今の接続(十字は T 2 つ)と、接続 1 つの入力。 */
function inputsFor(document: AssemblyDocument, joint: FrameJoint, choices = CHOICES): JointBracketInputs {
  const placements = placementsOf(document);
  const members = new Map(placedFrameMembers(document, placements).map((member) => [member.componentId, member]));
  return { joint, members, frames: frameSlotCandidates(document, placements), records, families, choices,
    nutFamily: T_SLOT_NUT_FAMILY, nutRecords: T_SLOT_NUT_RECORDS, partRevisions: new Map() };
}

function jointsOf(document: AssemblyDocument): readonly FrameJoint[] {
  return splitCrossJoints(classifyFrameJoints(placedFrameMembers(document, placementsOf(document))));
}

/** 線に沿って 20×20 を L に置き、接続を E-07 の通る最初の候補で留めた文書。 */
function fastenedL(): { readonly document: AssemblyDocument; readonly recordId: string } {
  const row = SERIES.rows.find((candidate) => candidate.key === 's6-20x20');
  const bounds = row === undefined ? null : SERIES.sectionBounds?.(row, { length: '500' }) ?? null;
  if (row === undefined || bounds === null) throw new Error('row');
  const lines: readonly FrameLine[] = [{ start: [0, 0, 0], end: [500, 0, 0] }, { start: [500, 0, 0], end: [500, 500, 0] }];
  const plan = planFrameMembers(lines, { section: bounds, up: [0, 0, 1], startExtension: 0, endExtension: 0, corners: 'butt' });
  if (!plan.ok) throw new Error(plan.reason);
  const components: AssemblyComponent[] = plan.members.map((planned, index) => {
    const id = `m${String(index)}`;
    const [x, y, z] = planned.placement.position;
    return { id, name: id, source: createCatalogItemSource(SERIES, row, { length: String(planned.lengthMm) }), fixed: true, visible: true,
      suppressed: false, placement: { position: [expressionValueFromNumber(x), expressionValueFromNumber(y), expressionValueFromNumber(z)],
        rotation: planned.placement.rotation } };
  });
  const document: AssemblyDocument = { ...createAssemblyDocument('入れ替え'), components };
  const joint = jointsOf(document)[0];
  if (joint === undefined) throw new Error('joint');
  const first = jointBracketChoices(document, inputsFor(document, joint)).find((choice) => choice.result.ok);
  if (first === undefined) throw new Error('choice');
  const applied = applyJointBracket(document, inputsFor(document, joint), first);
  if (!applied.ok) throw new Error('apply');
  return { document: applied.document, recordId: applied.record.id };
}

/** 接合チェックの留め方(部材でない部品の箱は使わない。記録だけで判定する)。 */
function fastenings(document: AssemblyDocument): readonly string[] {
  const placements = placementsOf(document);
  const members = placedFrameMembers(document, placements);
  const check = checkFrameJoints({ document, members, joints: classifyFrameJoints(members), fasteners: slotFastenerParts(document, placements),
    partBoxes: new Map() });
  return check.ok ? check.statuses.map((status) => status.fastening) : [check.reason];
}

describe('結合の入れ替え', () => {
  it('別の候補へ替えると、記録の id と並びが保たれ、古い板・ナット・ボルトが消えて新しい物が足され、接合チェックは記録で留めたまま', () => {
    const { document, recordId } = fastenedL();
    const before = document.frameJoints?.find((record) => record.id === recordId);
    if (before === undefined) throw new Error('record');
    const detached = detachFrameJointRecord(document, recordId, true);
    const joint = recordedFrameJoint(before, jointsOf(detached));
    if (joint === null) throw new Error('joint');
    const currentKey = optionsOf(document, before.bracket.componentId).item;
    const other = jointBracketChoices(detached, inputsFor(detached, joint)).find((choice) => choice.result.ok
      && (choice.bracket.key !== currentKey || choice.bracket.orientation !== before.bracket.orientation));
    if (other === undefined) throw new Error('other');
    const swapped = swapFrameJointBracket(document, recordId, inputsFor(detached, joint), other);
    if (!swapped.ok) throw new Error(JSON.stringify(swapped));
    expect(swapped.document.frameJoints?.map((record) => record.id)).toEqual([recordId]);
    // 消した部品の id は新しい部品に使い直されるので、id ではなく数で見る(部材 2 本 + 新しい板 1 + 新しいナット・ボルト)。
    const ids = new Set(swapped.document.components.map((component) => component.id));
    expect(swapped.document.components).toHaveLength(2 + 1 + swapped.record.fastenerIds.length);
    expect([swapped.record.bracket.componentId, ...swapped.record.fastenerIds].every((id) => ids.has(id))).toBe(true);
    expect([optionsOf(swapped.document, swapped.record.bracket.componentId).item, swapped.record.bracket.orientation])
      .toEqual([other.bracket.key, other.bracket.orientation]);
    expect(fastenings(swapped.document)).toEqual(['recorded']);
  });

  it('記録の無い id は断り、記録を外す(部品を残す)と記録だけが消え、部品の数は変わらない', () => {
    const { document, recordId } = fastenedL();
    const joint = jointsOf(document)[0];
    if (joint === undefined) throw new Error('joint');
    const choice = jointBracketChoices(document, inputsFor(document, joint))[0];
    if (choice === undefined) throw new Error('choice');
    expect(swapFrameJointBracket(document, 'no-such-record', inputsFor(document, joint), choice)).toEqual({ ok: false, reason: 'noRecord' });
    const kept = detachFrameJointRecord(document, recordId, false);
    expect([kept.frameJoints, kept.components.length]).toEqual([[], document.components.length]);
  });
});

/** 部品の保存の形の欄(族の部品だけ)。 */
function optionsOf(document: AssemblyDocument, componentId: string): Readonly<Record<string, string>> {
  const source = document.components.find((component) => component.id === componentId)?.source;
  return source?.kind === 'standardPart' ? source.options : {};
}

describe('接続の記録の状態', () => {
  it('そのまま・ナットが 1 つ欠けた・部材が無い・部材が動いて接続が見つからない', () => {
    const { document, recordId } = fastenedL();
    const record = document.frameJoints?.find((candidate) => candidate.id === recordId);
    const fastener = record?.fastenerIds[0];
    if (record === undefined || fastener === undefined) throw new Error('record');
    expect(frameJointRecordStatus(document, record, jointsOf(document))).toBe('ok');
    const lost = removeComponent(document, fastener);
    expect(frameJointRecordStatus(lost, record, jointsOf(lost))).toBe('missingParts');
    const noMember = removeComponent(document, 'm1');
    expect(frameJointRecordStatus(noMember, record, jointsOf(noMember))).toBe('missingMember');
    const moved: AssemblyDocument = { ...document, components: document.components.map((component) => (component.id !== 'm1' ? component
      : { ...component, placement: { ...component.placement, position: [expressionValueFromNumber(component.placement.position[0].value + 50),
        component.placement.position[1], component.placement.position[2]] } })) };
    expect(frameJointRecordStatus(moved, record, jointsOf(moved))).toBe('jointChanged');
    expect(fastenings(moved)).toEqual([]);
  });
});
