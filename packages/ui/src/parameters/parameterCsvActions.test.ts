import { createEmptyPartDocument, type Parameter, type PartDocument } from '@pointercad/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { createInitialDocumentState } from '../store/initialDocumentState.js';
import { useAppStore } from '../store/useAppStore.js';
import { applyParameterCsvPreview, prepareParameterCsv, type ParameterCsvInputRecord } from './parameterCsvActions.js';

const parameter = (name: string, source: string): Parameter => ({
  name, value: { source, value: 0, display: '0' }, unit: 'mm', description: '',
});
const record = (recordNumber: number, name: string, expression: string): ParameterCsvInputRecord => ({
  recordNumber, name, expression, unit: 'mm', description: `説明${recordNumber}`,
});

beforeEach(() => useAppStore.setState(createInitialDocumentState()));

describe('CSV preview and one atomic commit', () => {
  it('shows all row changes before one apply; Undo restores all parameters', async () => {
    const original: PartDocument = { ...createEmptyPartDocument(), parameters: [parameter('板厚', '3')] };
    useAppStore.getState().applyDocument(original);
    const owner = useAppStore.getState();
    const preview = await prepareParameterCsv(owner.document, owner.documentVersion,
      [record(2, '板厚', '5'), record(3, '穴径', '板厚*2')]);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.changes.map(change => ({ name: change.name, kind: change.kind }))).toEqual([
      { name: '板厚', kind: 'updated' }, { name: '穴径', kind: 'added' },
    ]);
    expect(preview.changes[0]).toMatchObject({ before: { expression: '3', unit: 'mm', description: '' },
      after: { expression: '5', unit: 'mm', description: '説明2' }, usageSiteCount: 0 });
    expect(owner.document.parameters.map(row => row.value.source)).toEqual(['3']);
    let commits = 0;
    expect(applyParameterCsvPreview(preview, useAppStore.getState(), next => {
      commits += 1;
      useAppStore.getState().applyDocument(next);
    })).toBe(true);
    expect(commits).toBe(1);
    expect(applyParameterCsvPreview(preview, owner, () => { commits += 1; })).toBe(false);
    expect(commits).toBe(1);
    expect(useAppStore.getState().document.parameters.map(row => row.value.value)).toEqual([5, 10]);
    useAppStore.getState().undo();
    expect(useAppStore.getState().document.parameters.map(row => row.value.source)).toEqual(['3']);
  });

  it('rejects every bad row, cancellation and stale owner without a document mutation', async () => {
    const owner = useAppStore.getState();
    const invalid = await prepareParameterCsv(owner.document, owner.documentVersion, [
      record(2, 'A', 'B'), record(3, 'B', 'A'), record(4, 'A', '1'),
      record(6, 'bad name', '1'),
    ]);
    expect(invalid.ok).toBe(false);
    if (invalid.ok) return;
    expect(invalid.issues.map(entry => entry.column)).toContain('name');
    const ready = await prepareParameterCsv(owner.document, owner.documentVersion, [record(2, 'A', '1')]);
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;
    let commits = 0;
    expect(applyParameterCsvPreview(ready, { document: owner.document, documentVersion: owner.documentVersion + 1 },
      () => { commits += 1; })).toBe(false);
    expect(applyParameterCsvPreview(ready, { document: { ...owner.document }, documentVersion: owner.documentVersion },
      () => { commits += 1; })).toBe(false);
    expect(commits).toBe(0);
    expect(useAppStore.getState().document).toBe(owner.document);
  });

  it('keeps unchanged rows and a cancelled preview out of Undo history', async () => {
    const original: PartDocument = { ...createEmptyPartDocument(), parameters: [parameter('板厚', '3')] };
    useAppStore.getState().applyDocument(original);
    const owner = useAppStore.getState();
    const cancelled = await prepareParameterCsv(owner.document, owner.documentVersion,
      [record(2, '板厚', '9')]);
    expect(cancelled.ok).toBe(true);
    expect(useAppStore.getState().document).toBe(owner.document);
    expect(useAppStore.getState().documentVersion).toBe(owner.documentVersion);
    const same = await prepareParameterCsv(owner.document, owner.documentVersion,
      [{ ...record(2, '板厚', '3'), description: '' }]);
    expect(same.ok).toBe(true);
    if (!same.ok) return;
    expect(same.changes.map(change => ({ name: change.name, kind: change.kind }))).toEqual([
      { name: '板厚', kind: 'unchanged' },
    ]);
    let commits = 0;
    expect(applyParameterCsvPreview(same, useAppStore.getState(), () => { commits += 1; })).toBe(true);
    expect(commits).toBe(0);
    expect(useAppStore.getState().document).toBe(owner.document);
  });

  it('refuses circular and unknown expressions before any publish', async () => {
    const owner = useAppStore.getState();
    const circular = await prepareParameterCsv(owner.document, owner.documentVersion,
      [record(2, 'A', 'B'), record(3, 'B', 'A')]);
    expect(circular.ok).toBe(false);
    if (!circular.ok) expect(circular.issues.map(entry => entry.recordNumber)).toEqual([2, 3]);
    const unknown = await prepareParameterCsv(owner.document, owner.documentVersion,
      [record(2, 'A', '存在しない名前+1')]);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ recordNumber: 2, column: 'expression' }),
    ]));
    expect(useAppStore.getState().document).toBe(owner.document);
  });

  it('does not reuse a deleted coefficient ID below the persisted serial', async () => {
    const document: PartDocument = { ...createEmptyPartDocument(), mathParameterSerial: 5 };
    const preview = await prepareParameterCsv(document, 1, [{ ...record(2, 'A', '1'), mathId: 'coefficient:5' }]);
    expect(preview).toMatchObject({ ok: false, issues: [{ recordNumber: 2, column: 'mathId' }] });
    const named: PartDocument = { ...document, parameters: [{ ...parameter('A', '1'), mathId: 'coefficient:5' }] };
    const mismatch = await prepareParameterCsv(named, 1, [{ ...record(2, 'A', '1'), mathId: 'coefficient:6' }]);
    expect(mismatch).toMatchObject({ ok: false, issues: [{ recordNumber: 2, column: 'mathId' }] });
  });
});
