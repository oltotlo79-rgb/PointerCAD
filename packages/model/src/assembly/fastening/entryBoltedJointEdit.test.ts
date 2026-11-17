import { createHash } from 'node:crypto';
import { expressionValueFromNumber as value } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import type { HoleEntry } from '../../part/types.js';
import type { AssemblyDocument } from '../types.js';
import { entryFixture } from './entryFastening.testSupport.js';
import { previewEntryBoltedJoint, commitEntryBoltedJoint } from './entryBoltedJointCommand.js';
import { previewBoltedJointEdit, commitBoltedJointEdit, withBoltedJointRecord, boltedJointUserChoices } from './boltedJointEdit.js';

const BORE: HoleEntry = { kind: 'counterbore', diameter: value(14), depth: value(8) };
const SINK: HoleEntry = { kind: 'countersink', diameter: value(17.92), angle: value(90) };

function fastened(entry?: HoleEntry) {
  const fixture = entryFixture(entry);
  const { context, firstPick, secondPick, request } = fixture;
  const preview = previewEntryBoltedJoint(context, firstPick, secondPick, request);
  if (!preview.ok) throw new Error(JSON.stringify(preview));
  const applied = commitEntryBoltedJoint(context, firstPick, secondPick, request, preview.plan);
  if (!applied.ok) throw new Error(JSON.stringify(applied));
  const document = withBoltedJointRecord(applied.document, firstPick, secondPick, request, applied.componentIds);
  return { context: { ...context, document }, choices: boltedJointUserChoices(request),
    catalog: { lengthAvailability: request.lengthAvailability }, componentIds: applied.componentIds };
}

function replaceFamily(document: AssemblyDocument, family: string): AssemblyDocument {
  return { ...document, components: document.components.map(component => component.source.kind === 'standardPart'
    && component.source.catalog === 'catalogItem' ? { ...component, source: { ...component.source,
      options: { ...component.source.options, family } } } : component) };
}

describe('editing entry bolts through the recorded joint', () => {
  it.each([BORE, SINK])('edits %j, replaces hardware, preserves plates and saves no derived entry fields', entry => {
    const { context, choices, catalog, componentIds } = fastened(entry);
    const before = JSON.stringify(context.document);
    const changed = { ...choices, minimumProtrusion: 5 };
    const preview = previewBoltedJointEdit(context, 'bolted-joint-1', changed, catalog);
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    expect(preview.plan.alignment.movedComponentIds).toEqual([]);
    const result = commitBoltedJointEdit(context, 'bolted-joint-1', changed, catalog, preview.plan);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(JSON.stringify(context.document)).toBe(before);
    expect(result.document.components.slice(0, 2)).toEqual(context.document.components.slice(0, 2));
    expect(result.document.components.some(component => componentIds.includes(component.id))).toBe(false);
    expect(result.document.components).toHaveLength(4);
    const bolt = result.document.components.find(component => component.source.kind === 'standardPart'
      && component.source.catalog === 'catalogItem');
    expect(bolt?.source).toMatchObject({ options: { family: entry.kind === 'counterbore'
      ? 'socket-head-cap-screw' : 'countersunk-socket-screw', item: 'M8', length: entry.kind === 'counterbore' ? '40' : '45' } });
    expect(Object.keys(result.record)).toEqual(['id', 'first', 'second', 'choices', 'componentIds']);
    expect(result.record.choices).toEqual(changed);
    const roundTrip = JSON.parse(JSON.stringify(result.document)) as AssemblyDocument;
    expect(previewBoltedJointEdit({ ...context, document: roundTrip }, result.record.id, choices, catalog).ok).toBe(true);
  });

  it.each([
    [BORE, { kind: 'counterbore', diameter: value(12), depth: value(8) }, 'counterboreTooSmall'],
    [SINK, { kind: 'countersink', diameter: value(18), angle: value(90) }, 'countersinkMismatch'],
  ] as const)('returns the entry rejection for an incompatible current head seat (%s)', (entry, changed, code) => {
    const saved = fastened(entry);
    const preview = previewBoltedJointEdit(saved.context, 'bolted-joint-1', saved.choices, saved.catalog);
    const context = { ...entryFixture(changed).context, document: saved.context.document };
    const rejected = previewBoltedJointEdit(context, 'bolted-joint-1', saved.choices, saved.catalog);
    expect(rejected).toMatchObject({ ok: false, reason: 'planRejected', rejections: [], entryRejections: [{ code }] });
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    const result = commitBoltedJointEdit(context, 'bolted-joint-1', saved.choices, saved.catalog, preview.plan);
    expect(result).toMatchObject({ ok: false, reason: 'planRejected', rejections: [], entryRejections: [{ code }] });
    expect(result.document).toBe(context.document);
  });

  it.each(['deep-groove-ball-bearing', 'countersunk-socket-screw'])('rejects an unrelated or wrong-entry family %s', family => {
    const saved = fastened(BORE);
    const context = { ...saved.context, document: replaceFamily(saved.context.document, family) };
    expect(previewBoltedJointEdit(context, 'bolted-joint-1', saved.choices, saved.catalog))
      .toEqual({ ok: false, reason: 'jointPartsChanged', rejections: [] });
  });

  it('rejects a changed recess even when it still fits and chooses the same bolt', () => {
    const saved = fastened(BORE);
    const preview = previewBoltedJointEdit(saved.context, 'bolted-joint-1', saved.choices, saved.catalog);
    expect(preview.ok).toBe(true);
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    const context = { ...entryFixture({ ...BORE, diameter: value(15) }).context, document: saved.context.document };
    const result = commitBoltedJointEdit(context, 'bolted-joint-1', saved.choices, saved.catalog, preview.plan);
    expect(result).toMatchObject({ ok: false, reason: 'planRejected', rejections: [{ code: 'staleSource' }] });
    expect(result.document).toBe(context.document);
  });

  it('keeps the complete legacy preview and commit JSON identical to the pre-change baseline', () => {
    const saved = fastened();
    const choices = { ...saved.choices, nutWashers: ['plainWasher'] as const };
    const preview = previewBoltedJointEdit(saved.context, 'bolted-joint-1', choices, saved.catalog);
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    const committed = commitBoltedJointEdit(saved.context, 'bolted-joint-1', choices, saved.catalog, preview.plan);
    expect(committed.ok).toBe(true);
    const rejected = previewBoltedJointEdit(saved.context, 'bolted-joint-1', { ...choices, minimumProtrusion: -1 }, saved.catalog);
    const digest = createHash('sha256').update(JSON.stringify({ preview, committed, rejected })).digest('hex');
    // Captured from the unchanged implementation in RUN 20261117-180516.
    expect(digest).toBe('944f59d0dbb4a7ceaaef78f2da42eaa023a61aa7c79f4e874449cfb6e633ba89');
  });
});
