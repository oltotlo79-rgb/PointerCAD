import { expressionValueFromNumber as value } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import type { HoleEntry } from '../../part/types.js';
import { applyPlacementToPoint } from '../placementMath.js';
import { buildStandardPartFromSource } from '../standard/buildStandardPart.js';
import { PRODUCT_CATALOG_REGISTRY } from '../catalog/registry.js';
import { buildBom } from '../bom.js';
import { entryFixture } from './entryFastening.testSupport.js';
import { commitEntryBoltedJoint, previewEntryBoltedJoint } from './entryBoltedJointCommand.js';
import { commitBoltedJointSet, previewBoltedJointSet } from './boltedJointSetCommand.js';
import { previewBoltedJoint } from './boltedJointCommand.js';
import { planBoltedJoint } from './planBoltedJoint.js';
import { planEntryBoltedJoint } from './planEntryBoltedJoint.js';
import { rigidPlacementOf } from './frames.js';
import { bindHoleSelection } from './bindHoleSelection.js';

const BORE: HoleEntry = { kind: 'counterbore', diameter: value(14), depth: value(8) };
const SINK: HoleEntry = { kind: 'countersink', diameter: value(17.92), angle: value(90) };
const PLAIN = entryFixture();

describe('entry-aware commit and its generated geometry', () => {
  it.each<readonly [HoleEntry, string, number, number]>([
    [BORE, 'socket-head-cap-screw', 8, 35], [SINK, 'countersunk-socket-screw', 4.96, 40],
  ])('places the actual catalog family for %j', async (entry, family, headHeight, length) => {
    const context = entryFixture(entry).context, first = PLAIN.firstPick, second = PLAIN.secondPick, choices = PLAIN.request;
    const before = JSON.stringify(context.document);
    const preview = previewEntryBoltedJoint(context, first, second, choices);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const result = commitEntryBoltedJoint(context, first, second, choices, preview.plan);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(context.document)).toBe(before);
    expect(result.document.components).toHaveLength(4);
    const bolt = result.document.components.find(component => component.source.kind === 'standardPart'
      && component.source.catalog === 'catalogItem');
    if (bolt?.source.kind !== 'standardPart') throw new Error('missing catalog bolt');
    expect(bolt.source.options).toEqual({ family, item: 'M8', length: String(length) });
    await PRODUCT_CATALOG_REGISTRY.ensure([family]);
    const part = buildStandardPartFromSource(bolt.source);
    expect(part).not.toBeNull();
    const shaft = part?.solids.find(solid => solid.kind === 'threadShaft');
    if (shaft?.kind !== 'threadShaft') throw new Error('missing threaded shaft');
    expect(shaft.nominal).toBe('M8');
    expect(shaft.pitch.value).toBe(1.25);
    expect(shaft.length.value).toBe(28);
    const top = applyPlacementToPoint(rigidPlacementOf(bolt.placement), [0, 0, 0]);
    const root = applyPlacementToPoint(rigidPlacementOf(bolt.placement), [0, 0, headHeight]);
    const tip = applyPlacementToPoint(rigidPlacementOf(bolt.placement), [0, 0, entry.kind === 'counterbore' ? headHeight + length : length]);
    expect(top[2]).toBe(-20);
    expect(root[2]).toBeCloseTo(-20 + headHeight, 9);
    expect(tip[2]).toBeCloseTo(entry.kind === 'counterbore' ? 23 : 20, 9);
    if (entry.kind === 'countersink') {
      const coneContact = applyPlacementToPoint(rigidPlacementOf(bolt.placement), [4.5, 0, 4.46]);
      expect(coneContact[2]).toBeCloseTo(-15.54, 9);
      expect(preview.plan.joint.gripLength).toBeCloseTo(12 - coneContact[2], 9);
    }
    const rows = buildBom(result.document, { partKeys: new Map(), bodies: new Map() });
    expect(rows.find(row => row.componentIds.includes(bolt.id))?.quantity).toBe(1);
    expect(result.document.components.every(component => component.rigidGroupId === result.document.components[0]?.rigidGroupId)).toBe(true);
  });
  it('keeps the plain one-pair result byte-for-byte equivalent', () => {
    const request = PLAIN.request;
    const legacy = planBoltedJoint(PLAIN.context.document, request, PLAIN.context.partRevisions);
    const current = planEntryBoltedJoint(PLAIN.context.document, request, PLAIN.context.partRevisions);
    expect(legacy.ok && current.ok).toBe(true);
    if (legacy.ok && current.ok) expect(JSON.stringify(current.plan.joint)).toBe(JSON.stringify(legacy.plan));
  });
  it('requires the new command instead of silently inserting a hex head into a recess', () => {
    expect(previewBoltedJoint(entryFixture(BORE).context, PLAIN.firstPick, PLAIN.secondPick, PLAIN.request))
      .toMatchObject({ ok: false, rejections: [{ code: 'unsupportedHole' }] });
  });
  it('detects a changed entry after preview and returns the same input document', () => {
    const context = entryFixture(BORE).context, choices = PLAIN.request;
    const preview = previewEntryBoltedJoint(context, PLAIN.firstPick, PLAIN.secondPick, choices);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const changed = entryFixture({ kind: 'counterbore', diameter: value(14), depth: value(9) }).context;
    const result = commitEntryBoltedJoint(changed, PLAIN.firstPick, PLAIN.secondPick, choices, preview.plan);
    expect(result).toMatchObject({ ok: false, rejections: [{ code: 'staleSource' }] });
    expect(result.document).toBe(changed.document);
  });
  it('does not infer the counterbore nominal from a clearance table', () => {
    const choices = { ...PLAIN.request };
    delete choices.explicitBolt;
    expect(previewEntryBoltedJoint(entryFixture(BORE).context, PLAIN.firstPick, PLAIN.secondPick, choices))
      .toMatchObject({ ok: false, rejections: [{ code: 'boltSizeUnspecified' }] });
  });
  it('checks washer outside diameter and depth, and rejects countersunk head washers', () => {
    const choices = { ...PLAIN.request, headWashers: ['plainWasher'] as const };
    expect(previewEntryBoltedJoint(entryFixture(BORE).context, PLAIN.firstPick, PLAIN.secondPick, choices))
      .toMatchObject({ ok: false, entryRejections: [{ code: 'counterboreTooSmall' }] });
    expect(previewEntryBoltedJoint(entryFixture(SINK).context, PLAIN.firstPick, PLAIN.secondPick, choices))
      .toMatchObject({ ok: false, rejections: [{ code: 'washerDoesNotFit' }] });
    const fitting = entryFixture({ kind: 'counterbore', diameter: value(20), depth: value(10) }).context;
    expect(previewEntryBoltedJoint(fitting, PLAIN.firstPick, PLAIN.secondPick, choices).ok).toBe(true);
  });
  it('uses the entry seat for blind thread engagement and bottom clearance', () => {
    const request = PLAIN.request;
    const first = { ...request.first, entry: { kind: 'counterbore' as const, diameter: 14, depth: 8, side: 'outer' as const } };
    const second = { ...request.second, hole: { kind: 'blindThreaded' as const, nominal: 'M8', pitch: 1.25,
      usableThreadDepth: 16, drillDepth: 20 } };
    const result = planEntryBoltedJoint(PLAIN.context.document, { ...request, first, second, engagement: 12, blindBottomClearance: 2 }, PLAIN.context.partRevisions);
    expect(result).toMatchObject({ ok: true, plan: { joint: { gripLength: 12, boltLength: 25, penetration: 13, engagedLength: 13 } } });
  });
  it('rejects missing or incompatible current entry geometry without using its saved fingerprint', () => {
    const context = entryFixture(BORE).context;
    const missing = { ...context, resolveFace: (...args: Parameters<typeof context.resolveFace>) => args[1].index === 11
      ? { status: 'missing' as const } : context.resolveFace(...args) };
    expect(bindHoleSelection(missing, PLAIN.firstPick)).toMatchObject({ code: 'threadEntryUnknown' });
    const mismatched = { ...context, partDocument: (component: Parameters<typeof context.partDocument>[0]) => {
      const part = context.partDocument(component);
      return part === null ? null : { ...part, solids: part.solids.map(solid => solid.kind === 'hole'
        ? { ...solid, entry: { kind: 'counterbore' as const, diameter: value(14), depth: value(7) } } : solid) };
    } };
    expect(bindHoleSelection(mismatched, PLAIN.firstPick)).toMatchObject({ code: 'holeFaceMismatch' });
  });
  it('commits four entry holes with one existing-format record for each', () => {
    const context = entryFixture(BORE).context, choices = PLAIN.request;
    const picks = { first: PLAIN.firstPicks, second: PLAIN.secondPicks, choices };
    const preview = previewBoltedJointSet(context, picks);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const result = commitBoltedJointSet(context, picks, preview.plan);
    expect(result.ok).toBe(true);
    expect(result.document.boltedJoints).toHaveLength(4);
    expect(result.document.components.filter(component => component.source.kind === 'standardPart'
      && component.source.catalog === 'catalogItem')).toHaveLength(4);
    expect(result.document.boltedJoints?.every(record => !('headKind' in record) && !('entry' in record))).toBe(true);
  });
});
