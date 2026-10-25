import { describe, expect, it } from 'vitest';
import { editFatigueSession } from './fatigueSession.js';
import { fatigueEntryIsSavedWithPiecewise, restoreSavedFatigueEntry } from './fatiguePiecewiseSession.js';
import { fatigueSolidSavedEntry, selectFatigueSolidElement } from './fatigueSolidSession.js';
import { analyticalSolid, solidDraft } from './fatigueSolid.testSupport.js';

describe('native solid fatigue selection/session contract', () => {
  it('roundtrips exact source, element, signed factors and repeats without restoring any result', async () => {
    const source = await analyticalSolid('part');
    const session = solidDraft(source), checked = fatigueSolidSavedEntry(session, [], 'part');
    if (!checked.ok || checked.entry.kind !== 'fatigue-solid-proportional') throw new Error('Invalid fixture');
    expect(checked.entry.definition.loadFactors).toEqual([0, 1, 0, -1]);
    expect(checked.entry.definition.source).toEqual(source.result.source);
    expect(checked.entry.definition.inputSha256).toBe(source.result.inputSha256);
    const restored = restoreSavedFatigueEntry('part', checked.entry);
    expect(restored.analyzed).toBeNull();
    expect(restored.solidAnalyzed).toBeNull();
    expect(fatigueEntryIsSavedWithPiecewise(restored, [], checked.entry)).toBe(true);
    expect(() => restoreSavedFatigueEntry('other', checked.entry)).toThrow();
    const custom = { ...checked.entry, definition: { ...checked.entry.definition, curve: { ...checked.entry.definition.curve, id: 'custom-curve' },
      sequence: 'repeated-periodic' as const, repeats: 7, loadFactors: [0, -0.125, 1, 0.0015] } };
    expect(fatigueEntryIsSavedWithPiecewise(restoreSavedFatigueEntry('part', custom), [], custom)).toBe(true);
    const changed = editFatigueSession(restored, { kind: 'history-stress', index: 0, source: '0,-1,1' });
    expect(fatigueEntryIsSavedWithPiecewise(changed, [], checked.entry)).toBe(false);
  });
  it('keeps the persistent part identity separate from the session owner when selecting, saving and restoring', async () => {
    const source = await analyticalSolid('persistent-part');
    const session = solidDraft(source, 'session-tab');
    expect(session.ownerId).toBe('session-tab');
    const checked = fatigueSolidSavedEntry(session, [], 'persistent-part');
    if (!checked.ok || checked.entry.kind !== 'fatigue-solid-proportional') throw new Error('Invalid distinct-ID fixture');
    expect(checked.entry.definition.source.documentId).toBe('persistent-part');
    const restored = restoreSavedFatigueEntry('session-tab', checked.entry, 'persistent-part');
    expect(restored.ownerId).toBe('session-tab');
    expect(restored.solidAnalyzed).toBeNull();
    expect(fatigueEntryIsSavedWithPiecewise(restored, [], checked.entry)).toBe(true);
    expect(selectFatigueSolidElement(session, source, 0, 'foreign-part')).toBe(session);
    expect(fatigueSolidSavedEntry(session, [], 'foreign-part').ok).toBe(false);
    expect(() => restoreSavedFatigueEntry('session-tab', checked.entry, 'foreign-part')).toThrow();
  });
  it('does not manufacture a selection for another owner/out-of-range element or silently drop additional histories', async () => {
    const source = await analyticalSolid('part'), session = solidDraft(source);
    for (const index of [-1, 1, 0.5, Number.NaN]) expect(selectFatigueSolidElement(session, source, index)).toBe(session);
    expect(selectFatigueSolidElement({ ...session, ownerId: 'other' }, source, 0).draft.solid).toEqual(session.draft.solid);
    const extra = editFatigueSession(session, { kind: 'history-add' });
    expect(fatigueSolidSavedEntry(extra, [], 'part')).toMatchObject({ ok: false, key: 'fatigue.error.solidOneHistory' });
    expect(fatigueSolidSavedEntry(session, [], 'other').ok).toBe(false);
  });
});
