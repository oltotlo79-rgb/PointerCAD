import { describe, expect, it } from 'vitest';

import { addComponent, createComponentFor, findComponent, moveComponent, replaceComponent } from '../assemblyEdit.js';
import { componentSourceKey, placementFingerprint } from '../fastening/frames.js';
import type { AssemblyComponent, AssemblyDocument } from '../types.js';
import { applyFilletWeld } from './applyFilletWeld.js';
import { plainTee, TEE_BODIES, teeRequest, WELD_TEST_REVISIONS, weldTestPlacement } from './filletWeld.testSupport.js';
import { planFilletWeld, planFilletWeldEdit, weldSegmentsOf, type FilletWeldEditRequest } from './planFilletWeld.js';

/**
 * Regression for replacement beads that inherited the IDs of the beads they replaced: the edit removes the old beads
 * first and the current-max allocator then handed out the same IDs again. A replacement must never reuse an ID that
 * existed in the edited (pre-edit) document, whatever the number of new segments.
 *
 * joinRigidGroup rebuilds the rows of the joined group by object spread, so unaffected rows are compared by value
 * (toStrictEqual), never by object identity; the pre-edit document itself must stay byte-for-byte unchanged.
 */
function welded(): AssemblyDocument {
  const before = plainTee();
  const planned = planFilletWeld(before, teeRequest(), WELD_TEST_REVISIONS, TEE_BODIES);
  if (!planned.ok) throw new Error(JSON.stringify(planned.rejections));
  const applied = applyFilletWeld(before, planned.plan, WELD_TEST_REVISIONS);
  if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
  return applied.document;
}

function edit(document: AssemblyDocument, request: FilletWeldEditRequest): { readonly document: AssemblyDocument; readonly ids: readonly string[] } {
  const snapshot = JSON.stringify(document);
  const planned = planFilletWeldEdit(document, request, WELD_TEST_REVISIONS, TEE_BODIES);
  if (!planned.ok) throw new Error(JSON.stringify(planned.rejections));
  const applied = applyFilletWeld(document, planned.plan, WELD_TEST_REVISIONS);
  if (!applied.ok) throw new Error(JSON.stringify(applied.rejections));
  // The edited document is a new value; the input document is never mutated.
  expect(JSON.stringify(document)).toBe(snapshot);
  return { document: applied.document, ids: applied.componentIds };
}

function component(document: AssemblyDocument, id: string): AssemblyComponent {
  const found = findComponent(document, id);
  if (found === undefined) throw new Error(`missing ${id}`);
  return found;
}

const base = { weldId: 'weld-1', legOnSecond: 5, legOnFirst: 5, materialId: 'steel' } as const;

function expectFreshReplacement(before: AssemblyDocument, after: { readonly document: AssemblyDocument; readonly ids: readonly string[] },
  segments: number): void {
  const preEdit = before.components.map((row) => row.id);
  const oldBeads = (weldSegmentsOf(before).get('weld-1') ?? []).map((row) => row.id);
  // Every new bead ID is unique and absent from the whole pre-edit document.
  expect(after.ids).toHaveLength(segments);
  expect(new Set(after.ids).size).toBe(segments);
  expect(after.ids.filter((id) => preEdit.includes(id))).toEqual([]);
  // The saved weld group is exactly the new beads; no old bead row survives.
  expect((weldSegmentsOf(after.document).get('weld-1') ?? []).map((row) => row.id)).toEqual([...after.ids]);
  expect(after.document.components.filter((row) => oldBeads.includes(row.id))).toEqual([]);
  expect(after.document.components).toHaveLength(before.components.length - oldBeads.length + segments);
  // Unique IDs across the whole edited document; every unaffected pre-edit row keeps all of its values.
  const ids = after.document.components.map((row) => row.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const row of before.components.filter((item) => !oldBeads.includes(item.id))) {
    expect(component(after.document, row.id)).toStrictEqual(row);
  }
}

describe('fillet weld edit allocates replacement bead IDs that never reuse a pre-edit ID', () => {
  it('three beads with the highest IDs replaced by one: the new bead is component-6, not component-3', () => {
    const before = welded();
    expect((weldSegmentsOf(before).get('weld-1') ?? []).map((row) => row.id)).toEqual(['component-3', 'component-4', 'component-5']);
    const after = edit(before, { ...base, segments: [{ start: 0, length: 100 }] });
    expectFreshReplacement(before, after, 1);
    expect(after.ids).toEqual(['component-6']);
  });

  it('three beads replaced by four keeps allocating past every reserved and newly added ID', () => {
    const before = welded();
    const after = edit(before, { ...base, segments: [{ start: 0, length: 20 }, { start: 25, length: 20 }, { start: 50, length: 20 },
      { start: 75, length: 25 }] });
    expectFreshReplacement(before, after, 4);
    expect(after.ids).toEqual(['component-6', 'component-7', 'component-8', 'component-9']);
  });

  it('an unrelated higher component keeps its values and the replacement starts above it', () => {
    const source = welded();
    const withExtra = addComponent(source, createComponentFor(source, { kind: 'part', partRef: 'standing' },
      { placement: weldTestPlacement([300, 0, 0]) }));
    expect(withExtra.components.map((row) => row.id)).toContain('component-6');
    const after = edit(withExtra, { ...base, segments: [{ start: 0, length: 40 }, { start: 60, length: 40 }] });
    expectFreshReplacement(withExtra, after, 2);
    expect(after.ids).toEqual(['component-7', 'component-8']);
  });

  it('a plan made before the base plate was replaced at a new placement is refused with the input unchanged', () => {
    const before = welded();
    const planned = planFilletWeldEdit(before, { ...base, segments: [{ start: 0, length: 100 }] }, WELD_TEST_REVISIONS, TEE_BODIES);
    if (!planned.ok) throw new Error(JSON.stringify(planned.rejections));
    const plate = component(before, 'component-2');
    const changed = replaceComponent(before, 'component-2', { ...plate, placement: weldTestPlacement([0, 0, 1]) });
    // The fingerprint the plan was made against really changed before the plan is applied.
    expect(placementFingerprint(component(changed, 'component-2').placement)).not.toBe(placementFingerprint(plate.placement));
    const snapshot = JSON.stringify(changed);
    const refused = applyFilletWeld(changed, planned.plan, WELD_TEST_REVISIONS);
    expect(refused.ok ? [] : refused.rejections.map((rejection) => rejection.code)).toEqual(['staleSource']);
    expect(refused.document).toBe(changed);
    expect(JSON.stringify(changed)).toBe(snapshot);
  });

  it('a plan made against older part revisions is refused when the current revision differs', () => {
    const before = welded();
    const planned = planFilletWeldEdit(before, { ...base, segments: [{ start: 0, length: 100 }] }, WELD_TEST_REVISIONS, TEE_BODIES);
    if (!planned.ok) throw new Error(JSON.stringify(planned.rejections));
    const revised = new Map([['standing', 'rev-s2'], ['base', 'rev-b']]);
    const standing = component(before, 'component-1');
    expect(componentSourceKey(standing, revised)).not.toBe(componentSourceKey(standing, WELD_TEST_REVISIONS));
    const refused = applyFilletWeld(before, planned.plan, revised);
    expect(refused.ok ? [] : refused.rejections.map((rejection) => rejection.code)).toEqual(['staleSource']);
    expect(refused.document).toBe(before);
  });

  it('moving the base plate of a fixed welded group is itself refused, so it cannot make a plan stale', () => {
    const before = welded();
    expect(component(before, 'component-1').fixed).toBe(true);
    expect(component(before, 'component-2').rigidGroupId).toBe(component(before, 'component-1').rigidGroupId);
    expect(moveComponent(before, 'component-2', weldTestPlacement([0, 0, 1]))).toBe(before);
  });

  it('applying the same edit plan twice to the same document gives equal results (pure reapply, not store history)', () => {
    const before = welded();
    const snapshot = JSON.stringify(before);
    const planned = planFilletWeldEdit(before, { ...base, segments: [{ start: 0, length: 100 }] }, WELD_TEST_REVISIONS, TEE_BODIES);
    if (!planned.ok) throw new Error(JSON.stringify(planned.rejections));
    const first = applyFilletWeld(before, planned.plan, WELD_TEST_REVISIONS);
    const again = applyFilletWeld(before, planned.plan, WELD_TEST_REVISIONS);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(again).toEqual(first);
  });
});
