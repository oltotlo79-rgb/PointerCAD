import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { createEmptyPartDocument, type PartDocument } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { commitRenameParameter, commitReorderParameters, commitReplaceParameter,
  type ParameterCommandOutcome, type ParameterCommandSuccess } from './parameterCommands.js';

beforeEach(resetTestStore);
afterEach(resetTestStore);

function evaluated(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) throw new Error(`fixture expression does not evaluate: ${source}`);
  return result.value;
}
/** `穴径` depends on `板厚` and is stored stale (0, as a dependent expression cannot be evaluated alone); the
 * commands re-evaluate it only through `applyParameters`, so a stale value left in place proves no re-evaluation ran. */
function fixture(): PartDocument {
  return { ...createEmptyPartDocument(), parameters: [
    { name: '板厚', value: evaluated('3'), unit: 'mm', description: '板の厚み' },
    { name: '穴径', value: { source: '板厚 * 2', value: 0, display: '0' }, unit: 'mm', description: '' },
    { name: '角度', value: evaluated('30'), unit: 'degree', description: '' }] };
}
function ok(outcome: ParameterCommandOutcome): ParameterCommandSuccess {
  if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.message}`);
  return outcome;
}
/** Every command that changes no stored data, built from the document's own rows. */
function noOps(document: PartDocument): readonly (readonly [string, ParameterCommandOutcome])[] {
  const [thickness, , angle] = document.parameters;
  return [
    ['same unit selected again', commitReplaceParameter(document, '角度', { unit: angle.unit })],
    ['identical description', commitReplaceParameter(document, '板厚', { description: thickness.description })],
    ['identical expression value (equal fields, new object)', commitReplaceParameter(document, '板厚',
      { value: { source: thickness.value.source, value: thickness.value.value, display: thickness.value.display } })],
    ['whole identical row', commitReplaceParameter(document, '板厚', { ...thickness })],
    ['name in the patch is ignored', commitReplaceParameter(document, '板厚', { name: '別名' })],
    ['empty patch', commitReplaceParameter(document, '穴径', {})],
    ['rename to the same name', commitRenameParameter(document, '板厚', '板厚')],
    ['same position', commitReorderParameters(document, 1, 1)],
    ['out of range', commitReorderParameters(document, 0, 3)],
    ['negative', commitReorderParameters(document, -1, 0)],
    ['not an integer', commitReorderParameters(document, 0.5, 2)],
  ];
}

describe('part parameter commands that change no stored data', () => {
  it('return the original document object, keep stale values and still report the analysis', () => {
    const document = fixture();
    expect(document.parameters[1]?.value.value).toBe(0);
    for (const [label, outcome] of noOps(document)) {
      const success = ok(outcome);
      expect(success.document, label).toBe(document);
      // The analysis is still computed as before (the panel reads it), without replacing the document.
      expect(success.analysis.variables.get('穴径'), label).toBe(6);
    }
    expect(document).toEqual(fixture());
  });

  it('do not allocate math IDs or advance the serial; a genuine edit does both in its own single step', () => {
    const document: PartDocument = { ...fixture(), mathParameterSerial: 0 };
    expect(document.parameters.every(parameter => parameter.mathId === undefined)).toBe(true);
    for (const [label, outcome] of noOps(document)) expect(ok(outcome).document, label).toBe(document);
    const edited = ok(commitReplaceParameter(document, '板厚', { value: evaluated('4') })).document;
    expect(edited.parameters.every(parameter => parameter.mathId !== undefined)).toBe(true);
    expect(edited.mathParameterSerial).toBe(3);
    expect(document.mathParameterSerial).toBe(0);
    expect(document.parameters.every(parameter => parameter.mathId === undefined)).toBe(true);
  });

  it('still apply and re-evaluate every genuine change, leaving the original object unchanged', () => {
    const document = fixture();
    const changes: readonly (readonly [string, PartDocument])[] = [
      ['unit', ok(commitReplaceParameter(document, '角度', { unit: 'none' })).document],
      ['description', ok(commitReplaceParameter(document, '板厚', { description: '厚み' })).document],
      ['source', ok(commitReplaceParameter(document, '板厚', { value: evaluated('4') })).document],
      // Same source, different stored number: the stored contents differ, so this is a change.
      ['stored value', ok(commitReplaceParameter(document, '穴径', { value: { source: '板厚 * 2', value: 6, display: '6' } })).document],
      ['rename', ok(commitRenameParameter(document, '板厚', '厚さ')).document],
      ['move', ok(commitReorderParameters(document, 0, 2)).document],
    ];
    for (const [label, changed] of changes) expect(changed, label).not.toBe(document);
    const byLabel = new Map(changes);
    expect(byLabel.get('unit')?.parameters[2]?.unit).toBe('none');
    expect(byLabel.get('source')?.parameters.map(row => [row.name, row.value.source, row.value.value]))
      .toEqual([['板厚', '4', 4], ['穴径', '板厚 * 2', 8], ['角度', '30', 30]]);
    expect(byLabel.get('rename')?.parameters.map(row => [row.name, row.value.source]))
      .toEqual([['厚さ', '3'], ['穴径', '厚さ * 2'], ['角度', '30']]);
    expect(byLabel.get('move')?.parameters.map(row => row.name)).toEqual(['穴径', '角度', '板厚']);
    expect(document).toEqual(fixture());
  });
});

describe('the real part history records no step for a no-op', () => {
  it('keeps the Undo stack of the opened document, then records exactly one step for a real edit', () => {
    useAppStore.getState().applyDocument(fixture(), { opensDocument: true });
    const opened = useAppStore.getState().document;
    const initial = useAppStore.getState().undoStack;
    // Preconditions: the opened document is the fixture's table and its fresh history has no step yet.
    expect(useAppStore.getState().assembly).toBeNull();
    expect(opened.parameters.map(row => row.name)).toEqual(['板厚', '穴径', '角度']);
    expect(initial.present).toBe(opened);
    expect(initial.past).toHaveLength(0);
    expect(useAppStore.getState().canUndo).toBe(false);

    for (const [label, outcome] of noOps(opened)) {
      useAppStore.getState().applyDocument(ok(outcome).document);
      expect(useAppStore.getState().undoStack, label).toBe(initial);
      expect(useAppStore.getState().document, label).toBe(opened);
    }
    expect(useAppStore.getState().canUndo).toBe(false);

    useAppStore.getState().applyDocument(ok(commitReplaceParameter(opened, '板厚', { value: evaluated('5') })).document);
    const edited = useAppStore.getState().document;
    expect(edited).not.toBe(opened);
    expect(edited.parameters[1]?.value.value).toBe(10);
    expect(useAppStore.getState().undoStack.past).toHaveLength(1);
    expect(useAppStore.getState().canUndo).toBe(true);
    // The same commit repeated on the now current document, and every no-op, add no second step.
    for (const [label, outcome] of [...noOps(edited), ['repeated value',
      commitReplaceParameter(edited, '板厚', { value: edited.parameters[0].value })] as const]) {
      useAppStore.getState().applyDocument(ok(outcome).document);
      expect(useAppStore.getState().undoStack.past, label).toHaveLength(1);
      expect(useAppStore.getState().document, label).toBe(edited);
    }

    useAppStore.getState().undo();
    expect(useAppStore.getState().document).toBe(opened);
    expect(useAppStore.getState().canUndo).toBe(false);
    useAppStore.getState().redo();
    expect(useAppStore.getState().document).toBe(edited);
  });
});
