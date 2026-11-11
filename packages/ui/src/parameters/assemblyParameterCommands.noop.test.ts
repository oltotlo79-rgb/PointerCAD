import { expressionValueFromNumber, type ExpressionValue } from '@pointercad/expression';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT, type AssemblyDocument } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitRenameAssemblyParameter, commitReorderAssemblyParameters, commitReplaceAssemblyParameter,
  type AssemblyParameterCommandOutcome } from './assemblyParameterCommands.js';

beforeEach(resetTestStore);
afterEach(resetTestStore);

/** Stored values are deliberately stale (0): a no-op must not re-evaluate them into a new document. */
const stale = (source: string): ExpressionValue => ({ source, value: 0, display: '0' });
function fixture(): AssemblyDocument {
  return { ...createAssemblyDocument('組立'),
    parameters: [{ name: 'a', value: stale('2'), unit: 'mm', description: 'pitch' },
      { name: 'c', value: stale('a * 3'), unit: 'mm', description: '' },
      { name: 't', value: expressionValueFromNumber(30), unit: 'degree', description: '' }],
    components: [{ id: 'component-1', name: '部品A', source: { kind: 'part', partRef: 'part-1' },
      placement: { ...DEFAULT_COMPONENT_PLACEMENT, position: [stale('a'), stale('0'), stale('0')] },
      fixed: false, visible: true, suppressed: false }] };
}
function ok(outcome: AssemblyParameterCommandOutcome): AssemblyDocument {
  if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.message}`);
  return outcome.document;
}
/** Every action that changes no stored data, built from the document's own rows. */
function noOps(document: AssemblyDocument): readonly (readonly [string, AssemblyParameterCommandOutcome])[] {
  const [a, , t] = document.parameters;
  return [
    ['same unit selected again', commitReplaceAssemblyParameter(document, 't', { unit: t.unit })],
    ['identical description', commitReplaceAssemblyParameter(document, 'a', { description: 'pitch' })],
    ['identical expression value (equal fields, new object)', commitReplaceAssemblyParameter(document, 'a',
      { value: { source: a.value.source, value: a.value.value, display: a.value.display } })],
    ['whole identical row', commitReplaceAssemblyParameter(document, 'a', { ...a })],
    ['name in the patch is ignored', commitReplaceAssemblyParameter(document, 'a', { name: 'zzz' })],
    ['empty patch', commitReplaceAssemblyParameter(document, 'c', {})],
    ['rename to the same name', commitRenameAssemblyParameter(document, 'a', 'a')],
    ['same position', commitReorderAssemblyParameters(document, 1, 1)],
    ['out of range', commitReorderAssemblyParameters(document, 0, 3)],
    ['negative', commitReorderAssemblyParameters(document, -1, 0)],
    ['not an integer', commitReorderAssemblyParameters(document, 0.5, 2)],
  ];
}

describe('assembly parameter commands that change no stored data', () => {
  it('return the same document object without re-evaluating stale stored values', () => {
    const document = fixture();
    for (const [label, outcome] of noOps(document)) {
      expect(ok(outcome), label).toBe(document);
    }
    expect(document).toEqual(fixture());
    expect(document.parameters[1]?.value.value).toBe(0);
  });

  it('still apply and re-evaluate every genuine change, leaving the original object unchanged', () => {
    const document = fixture();
    const changes: readonly (readonly [string, AssemblyDocument])[] = [
      ['unit', ok(commitReplaceAssemblyParameter(document, 't', { unit: 'none' }))],
      ['description', ok(commitReplaceAssemblyParameter(document, 'a', { description: 'Pitch' }))],
      ['source', ok(commitReplaceAssemblyParameter(document, 'a', { value: stale('4') }))],
      // Same source, different stored number: the stored contents differ, so this is a change.
      ['stored value', ok(commitReplaceAssemblyParameter(document, 'a', { value: { ...document.parameters[0].value, value: 2, display: '2' } }))],
      ['rename', ok(commitRenameAssemblyParameter(document, 'a', 'b'))],
      ['move', ok(commitReorderAssemblyParameters(document, 0, 2))],
    ];
    for (const [label, changed] of changes) expect(changed, label).not.toBe(document);
    const byLabel = new Map(changes);
    expect(byLabel.get('unit')?.parameters[2]?.unit).toBe('none');
    // A genuine edit re-evaluates dependents and placement formulas with the resolver context.
    const edited = byLabel.get('source');
    expect(edited?.parameters.map(row => [row.name, row.value.source, row.value.value])).toEqual([['a', '4', 4], ['c', 'a * 3', 12],
      ['t', '30', 30]]);
    expect(edited?.components[0]?.placement.position[0].value).toBe(4);
    expect(byLabel.get('rename')?.parameters.map(row => row.name)).toEqual(['b', 'c', 't']);
    expect(byLabel.get('rename')?.components[0]?.placement.position[0].source).toBe('b');
    expect(byLabel.get('move')?.parameters.map(row => row.name)).toEqual(['c', 't', 'a']);
    expect(document).toEqual(fixture());
  });
});

describe('the real assembly history records no step for a no-op', () => {
  it('keeps the Undo stack after openAssembly unchanged, then records exactly one step for a real edit', () => {
    const opened = fixture();
    useAppStore.getState().openAssembly(opened);
    const initial = useAppStore.getState().assemblyUndoStack;
    // The real history exists before any edit.
    expect(initial).not.toBeNull();
    expect(initial?.present.document).toBe(opened);
    expect(initial?.past).toHaveLength(0);

    for (const [label, outcome] of noOps(opened)) {
      useAppStore.getState().applyAssembly(ok(outcome));
      expect(useAppStore.getState().assemblyUndoStack, label).toBe(initial);
    }
    expect(useAppStore.getState().assembly).toBe(opened);
    expect(useAppStore.getState().canUndo).toBe(false);

    const edited = ok(commitReplaceAssemblyParameter(opened, 'a', { value: stale('5') }));
    useAppStore.getState().applyAssembly(edited);
    expect(useAppStore.getState().assemblyUndoStack?.past).toHaveLength(1);
    expect(useAppStore.getState().canUndo).toBe(true);
    // Repeating the same commit on the now current document is a no-op as well (no second step).
    const current = useAppStore.getState().assembly;
    if (current === null) throw new Error('No assembly is open');
    for (const [label, outcome] of [...noOps(current), ['repeated value', commitReplaceAssemblyParameter(current, 'a',
      { value: current.parameters[0].value })] as const]) {
      useAppStore.getState().applyAssembly(ok(outcome));
      expect(useAppStore.getState().assemblyUndoStack?.past, label).toHaveLength(1);
    }
    expect(useAppStore.getState().assembly).toBe(edited);

    useAppStore.getState().undo();
    expect(useAppStore.getState().assembly).toBe(opened);
    expect(useAppStore.getState().canUndo).toBe(false);
    useAppStore.getState().redo();
    expect(useAppStore.getState().assembly).toBe(edited);
  });
});
