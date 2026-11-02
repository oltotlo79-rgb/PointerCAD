import { exactExpressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { circularWeldFixture as fixture, nextCircularWeldContext as nextContext } from './circularWeld.testSupport.js';
import { appendCircularFilletWeldPick, circularDraftIntervals, circularFilletWeldPickKind, commitCircularFilletWeldDraft,
  createCircularFilletWeldDraft, editCircularFilletWeldDraft, previewCircularFilletWeldDraft, restoreCircularFilletWeldDraft,
  type CircularFilletWeldDraft } from './circularFilletWeldDraft.js';

function fields(draft: CircularFilletWeldDraft, values: Parameters<typeof editCircularFilletWeldDraft>[1], epoch: string): CircularFilletWeldDraft {
  const next = editCircularFilletWeldDraft(draft, values, epoch); if (next === null) throw new Error('edit refused'); return next;
}
function ready(f: Awaited<ReturnType<typeof fixture>>): CircularFilletWeldDraft {
  let d = createCircularFilletWeldDraft(f.context.inputs.document, 'ui-circular', 'initial');
  for (const [i, pick] of [f.choices.plane, f.choices.edge, f.choices.cylinder].entries()) {
    const next = appendCircularFilletWeldPick(d, pick, 'pick-' + String(i)); if (next === null) throw new Error('pick refused'); d = next;
  }
  return fields(d, { radialLeg: '3', normalLeg: '4', radialDirection: 1, normalDirection: 1, materialId: 'stainless', lengths: '10' }, 'values');
}
describe('circular weld draft boundaries', () => {
  it('maps independent mm lengths and gap from nonzero start in both orientations', async () => {
    const f = await fixture(), base = ready(f), value = exactExpressionValueFromNumber(10 * Math.PI / 4).source;
    const d = fields(base, { mode: 'intermittent', lengths: value + ',' + value, gaps: value }, 'segments');
    for (const orientation of [1, -1] as const) {
      const evidence = { ...f.evidence, parameterRange: [Math.PI / 2, 5 * Math.PI / 4] as const, orientation };
      const rows = circularDraftIntervals(d, evidence); expect(rows).toHaveLength(2);
      if (rows === null) throw new Error('segments missing');
      const expected = orientation === 1 ? [[Math.PI / 2, 3 * Math.PI / 4], [Math.PI, 5 * Math.PI / 4]]
        : [[5 * Math.PI / 4, Math.PI], [3 * Math.PI / 4, Math.PI / 2]];
      rows.forEach((r, i) => { expect(r.fromParameter).toBeCloseTo(expected[i][0], 13); expect(r.toParameter).toBeCloseTo(expected[i][1], 13); });
    }
  });
  it('supports empty continuous length as the remaining full circumference', async () => {
    const f = await fixture(), d = fields(ready(f), { lengths: '' }, 'full');
    const rows = circularDraftIntervals(d, f.evidence); expect(rows).toHaveLength(1);
    expect(rows?.[0].fromParameter).toBe(0); expect(rows?.[0].toParameter).toBe(2 * Math.PI);
  });
  it('accepts 1 and 64 unique beads and rejects 65, invalid gaps, repeated IDs and bad expressions', async () => {
    const f = await fixture(), base = ready(f), small = exactExpressionValueFromNumber(10 * 2 * Math.PI / 128).source;
    const list = (n: number): string => Array.from({ length: n }, () => small).join(',');
    const d = fields(base, { mode: 'intermittent', lengths: list(64), gaps: list(63) }, 'sixty-four');
    expect(circularDraftIntervals(base, f.evidence)).toHaveLength(1); expect(circularDraftIntervals(d, f.evidence)).toHaveLength(64);
    expect(circularDraftIntervals(fields(d, { lengths: list(65), gaps: list(64) }, 'sixty-five'), f.evidence)).toBeNull();
    expect(circularDraftIntervals(fields(d, { gaps: list(62) }, 'bad-gap'), f.evidence)).toBeNull();
    expect(circularDraftIntervals({ ...d, beadIds: ['duplicate', 'duplicate'] }, f.evidence)).toBeNull();
    expect(circularDraftIntervals(fields(base, { lengths: '1/0' }, 'not-finite'), f.evidence)).toBeNull();
  });
  it('does not invent legs or material and rejects an inner leg touching the axis', async () => {
    const f = await fixture(), d = ready(f);
    expect(previewCircularFilletWeldDraft(f.context, fields(d, { radialLeg: '' }, 'empty-leg'))).toEqual({ ok: false, reason: 'dimension' });
    expect(previewCircularFilletWeldDraft(f.context, fields(d, { materialId: '' }, 'empty-material'))).toEqual({ ok: false, reason: 'material' });
    expect(previewCircularFilletWeldDraft(f.context, fields(d, { radialDirection: -1, radialLeg: '10' }, 'axis'))).toEqual({ ok: false, reason: 'dimension' });
    expect(previewCircularFilletWeldDraft(f.context, fields(d, { normalLeg: '1/0' }, 'not-finite'))).toEqual({ ok: false, reason: 'dimension' });
  });
  it('retains an epoch on unchanged edit, requires a fresh epoch on change, and preserves bead IDs', async () => {
    const f = await fixture(), d = ready(f), rows = circularDraftIntervals(d, f.evidence);
    expect(editCircularFilletWeldDraft(d, { radialLeg: '3' }, 'unused')).toBe(d);
    expect(editCircularFilletWeldDraft(d, { radialLeg: '4' }, d.draftEpoch)).toBeNull();
    const changed = fields(d, { radialLeg: '4' }, 'new'); expect(changed.draftEpoch).toBe('new');
    expect(circularDraftIntervals(changed, f.evidence)?.map(x => x.beadId)).toEqual(rows?.map(x => x.beadId));
  });
  it('enforces pick kinds and rejects a plane and cylinder from the same occurrence', async () => {
    const f = await fixture(); let d = createCircularFilletWeldDraft(f.context.inputs.document, 'weld', 'a');
    expect(circularFilletWeldPickKind(d)).toBe('plane'); expect(appendCircularFilletWeldPick(d, f.choices.edge, 'b')).toBeNull();
    const first = appendCircularFilletWeldPick(d, f.choices.plane, 'b'); if (first === null) throw new Error('plane'); d = first;
    expect(circularFilletWeldPickKind(d)).toBe('edge'); const second = appendCircularFilletWeldPick(d, f.choices.edge, 'c');
    if (second === null) throw new Error('edge'); d = second;
    expect(appendCircularFilletWeldPick(d, { ...f.choices.cylinder, path: f.choices.plane.path }, 'd')).toBeNull();
  });
  it('plans current world geometry, drops stale view and refuses edits after preview without changing document', async () => {
    const f = await fixture(true), d = ready(f), p = previewCircularFilletWeldDraft(f.context, d);
    if (!p.ok) throw new Error(p.reason);
    expect(p.plan.beads[0].placement.position.map(x => x.value)).toEqual([11, 13, 17]);
    expect(p.request.edge.path).toEqual(f.choices.edge.path);
    const changed = fields(d, { radialLeg: '4' }, 'changed');
    const rejected = commitCircularFilletWeldDraft(f.context, changed, p);
    expect(rejected.ok).toBe(false); expect(rejected.document).toBe(f.context.inputs.document);
    const stale = { ...f.context, inputs: { ...f.context.inputs } };
    expect(previewCircularFilletWeldDraft(stale, d)).toEqual({ ok: false, reason: 'stale' });
    const changedDocument = { ...f.context.inputs.document };
    expect(previewCircularFilletWeldDraft(nextContext(f.context, changedDocument), d)).toEqual({ ok: false, reason: 'stale' });
    Reflect.set(f.context.inputs.document, 'name', 'changed in place');
    expect(previewCircularFilletWeldDraft(f.context, d)).toEqual({ ok: false, reason: 'stale' });
  });
  it('restores saved beads without current picks or an implicit recommit', async () => {
    const f = await fixture(), d = fields(ready(f), { mode: 'intermittent', lengths: '10,10', gaps: '5' }, 'two-beads');
    const p = previewCircularFilletWeldDraft(f.context, d);
    if (!p.ok) throw new Error(p.reason);
    const result = commitCircularFilletWeldDraft(f.context, d, p); if (!result.ok) throw new Error(result.reason);
    const restored = restoreCircularFilletWeldDraft(result.document, d.weldId, 'restore-epoch');
    expect(restored?.picks).toEqual([]); expect(restored?.beadIds).toEqual(p.request.intervals.map(r => r.beadId));
    expect(restored?.savedSources).toHaveLength(p.request.intervals.length);
    if (restored === null) throw new Error('restore failed');
    expect(previewCircularFilletWeldDraft(nextContext(f.context, result.document), restored)).toEqual({ ok: false, reason: 'picks' });
    const bead = result.document.components.find(c => c.source.kind === 'standardPart' && c.source.options.weldCircular !== undefined);
    if (bead?.source.kind !== 'standardPart') throw new Error('saved bead missing');
    const malformed = { ...bead, source: { ...bead.source, options: { weldCircular: '{}' } } };
    const document = { ...result.document, components: result.document.components.map(c => c.id === bead.id ? malformed : c) };
    expect(restoreCircularFilletWeldDraft(document, d.weldId, 'bad')).toBeNull();
  });
});
