import { createAssemblyDocument, type AssemblyDocument } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { commitAssemblyParameterEdit } from './AssemblyParameterPanel.js';
import type { AssemblyParameterCommandOutcome } from './assemblyParameterCommands.js';

/*
 * The panel's draft is owned by (document, documentVersion); the commit route must use the same pair. The actual
 * store restores the identical document object on Undo/Redo (applyHistory) and openAssembly accepts any object,
 * while only those routes bump documentVersion (applyAssembly does not). A handler captured at an older revision
 * therefore cannot be told apart by identity alone. These cases fail against an identity-only commit route.
 */
const withGap = (document: AssemblyDocument, source: string): AssemblyDocument => ({
  ...document,
  parameters: [{ name: 'gap', value: { source, value: Number.parseFloat(source), display: source }, unit: 'mm', description: '' }],
});
const setGap = (source: string) => (current: AssemblyDocument): AssemblyParameterCommandOutcome =>
  ({ ok: true, document: withGap(current, source) });

let opened: AssemblyDocument;
beforeEach(() => {
  resetTestStore();
  opened = withGap(createAssemblyDocument('revision assembly'), '5');
  useAppStore.getState().openAssembly(opened);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetTestStore();
});

describe('assembly parameter commit revision', () => {
  it('refuses a commit captured before Undo brought back the identical document object', () => {
    const captured = useAppStore.getState().documentVersion;
    useAppStore.getState().applyAssembly(withGap(opened, '9'));
    expect(useAppStore.getState().documentVersion).toBe(captured);
    useAppStore.getState().undoAssembly();
    const back = useAppStore.getState();
    expect(back.assembly).toBe(opened);
    expect(back.documentVersion).not.toBe(captured);
    const command = vi.fn(setGap('7'));
    expect(commitAssemblyParameterEdit(opened, command, captured)).toEqual({ kind: 'stale' });
    expect(command).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toBe(back);
    expect(back.assemblyUndoStack?.future).toHaveLength(1);
    expect(back.assembly?.parameters[0]?.value.source).toBe('5');
  });

  it('refuses a commit captured before the same document object was opened again', () => {
    const captured = useAppStore.getState().documentVersion;
    useAppStore.getState().openAssembly(opened);
    const reopened = useAppStore.getState();
    expect(reopened.assembly).toBe(opened);
    const command = vi.fn(setGap('7'));
    expect(commitAssemblyParameterEdit(opened, command, captured)).toEqual({ kind: 'stale' });
    expect(command).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toBe(reopened);
    expect(reopened.canUndo).toBe(false);
  });

  it('still applies at the current revision, and Enter then blur adds one undo step only', () => {
    const version = useAppStore.getState().documentVersion;
    expect(commitAssemblyParameterEdit(opened, setGap('7'), version)).toEqual({ kind: 'applied' });
    const edited = useAppStore.getState().assembly;
    if (edited === null) throw new Error('Current assembly required');
    expect(edited.parameters[0]?.value.source).toBe('7');
    expect(useAppStore.getState().documentVersion).toBe(version);
    const past = useAppStore.getState().assemblyUndoStack?.past.length;
    expect(commitAssemblyParameterEdit(edited, (current) => ({ ok: true, document: current }), version)).toEqual({ kind: 'applied' });
    expect(useAppStore.getState().assemblyUndoStack?.past.length).toBe(past);
    useAppStore.getState().undoAssembly();
    expect(useAppStore.getState().assembly).toBe(opened);
    expect(useAppStore.getState().canUndo).toBe(false);
  });
});
