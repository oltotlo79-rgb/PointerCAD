import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAssemblyDocument, type AssemblyDocument } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { AssemblyPropertyPanel } from '../assembly/AssemblyPropertyPanel.js';
import { applyDisplayUnit, fieldValueText } from '../sketch/numericInput.js';
import { assemblyParameterSource, commitAssemblyParameterEdit } from './AssemblyParameterPanel.js';
import { commitReplaceAssemblyParameter, type AssemblyParameterCommandOutcome } from './assemblyParameterCommands.js';

const withGap = (document: AssemblyDocument, source: string): AssemblyDocument => ({
  ...document,
  parameters: [{ name: 'gap', value: { source, value: Number.parseFloat(source), display: source }, unit: 'mm', description: '' }],
});

let opened: AssemblyDocument;
beforeEach(() => {
  resetTestStore();
  opened = withGap(createAssemblyDocument('parameter assembly'), '5');
  useAppStore.getState().openAssembly(opened);
  useAppStore.setState({ selection: [] });
  vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
});
afterEach(() => {
  vi.restoreAllMocks();
  resetTestStore();
});

/** A command that changes only the parameter source, built from the document it is given. */
const setGap = (source: string) => (current: AssemblyDocument): AssemblyParameterCommandOutcome =>
  ({ ok: true, document: withGap(current, source) });

describe('assembly parameter commit route', () => {
  it('commits through applyAssembly onto the current assembly and is undone/redone by the assembly history', () => {
    const result = commitAssemblyParameterEdit(opened, setGap('7'), useAppStore.getState().documentVersion);
    expect(result).toEqual({ kind: 'applied' });
    const edited = useAppStore.getState().assembly;
    expect(edited).not.toBe(opened);
    expect(edited?.id).toBe(opened.id);
    expect(edited?.parameters[0].value.source).toBe('7');
    expect(useAppStore.getState().canUndo).toBe(true);
    useAppStore.getState().undoAssembly();
    expect(useAppStore.getState().assembly).toBe(opened);
    useAppStore.getState().redoAssembly();
    expect(useAppStore.getState().assembly).toBe(edited);
  });

  it('refuses a commit captured from an older revision, leaving the later edit and its history intact', () => {
    const later = withGap(opened, '9');
    useAppStore.getState().applyAssembly(later);
    const before = useAppStore.getState();
    const command = vi.fn(setGap('7'));
    expect(commitAssemblyParameterEdit(opened, command, useAppStore.getState().documentVersion)).toEqual({ kind: 'stale' });
    expect(command).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toBe(before);
    expect(useAppStore.getState().assembly).toBe(later);
  });

  it('shows a rejection without changing the document or adding an undo step', () => {
    const before = useAppStore.getState();
    const rejected = (): AssemblyParameterCommandOutcome => ({ ok: false, reason: 'empty', message: t('parameter.error.empty') });
    expect(commitAssemblyParameterEdit(opened, rejected, useAppStore.getState().documentVersion)).toEqual({ kind: 'rejected', message: t('parameter.error.empty') });
    expect(useAppStore.getState()).toBe(before);
    expect(useAppStore.getState().canUndo).toBe(false);
  });

  it('does not add a second undo step when the same edit is committed again (Enter then blur)', () => {
    commitAssemblyParameterEdit(opened, setGap('7'), useAppStore.getState().documentVersion);
    const afterFirst = useAppStore.getState();
    const edited = afterFirst.assembly;
    if (edited === null) throw new Error('Current assembly required');
    const pastLength = afterFirst.assemblyUndoStack?.past.length;
    expect(commitAssemblyParameterEdit(edited, (current) => ({ ok: true, document: current }), useAppStore.getState().documentVersion)).toEqual({ kind: 'applied' });
    expect(useAppStore.getState().assemblyUndoStack?.past.length).toBe(pastLength);
    expect(useAppStore.getState().assembly).toBe(edited);
  });

  it('refuses when no assembly is open', () => {
    resetTestStore();
    expect(commitAssemblyParameterEdit(opened, setGap('7'), useAppStore.getState().documentVersion)).toEqual({ kind: 'stale' });
  });
});

describe('assembly parameter table in the actual property panel', () => {
  it('is reachable with no selected component and shows the translated fields for the current rows', () => {
    const before = useAppStore.getState();
    const html = renderToStaticMarkup(createElement(AssemblyPropertyPanel));
    expect(before.selection).toEqual([]);
    expect(html).toContain(t('propertyPanel.empty'));
    expect(html).toContain('data-testid="assembly-parameters"');
    for (const key of ['propertyPanel.tabParameters', 'parameterPanel.nameLabel', 'parameterPanel.sourceLabel',
      'parameterPanel.unitLabel', 'parameterPanel.descriptionLabel', 'parameterPanel.addTooltip'] as const) {
      expect(html).toContain(t(key));
    }
    expect(html).toContain(`aria-label="${t('parameterPanel.nameLabel')} gap"`);
    expect(html).toContain('value="gap"');
    expect(html).toContain(t('assembly.bom.title'));
    expect(useAppStore.getState()).toBe(before);
  });

  it('shows the empty-table guidance for an assembly without parameters', () => {
    useAppStore.getState().openAssembly(createAssemblyDocument('empty parameters'));
    useAppStore.setState({ selection: [] });
    const html = renderToStaticMarkup(createElement(AssemblyPropertyPanel));
    expect(html).toContain(t('parameterPanel.empty'));
    expect(html).toContain(t('parameterPanel.addTooltip'));
  });
});

describe('assembly parameter length display unit (the part table helpers and the selected lengthUnit)', () => {
  const inch = (): void => {
    const state = useAppStore.getState();
    useAppStore.setState({ displaySettings: { ...state.displaySettings, lengthUnit: 'inch' } });
  };

  it('stores a unitless entry on a mm row in inch mode exactly as the part table does and evaluates it in inches', () => {
    inch();
    const source = assemblyParameterSource('mm', '2', 'inch');
    expect(source).toBe(applyDisplayUnit('2', 'mm', 'inch'));
    expect(source).not.toBe('2');
    const version = useAppStore.getState().documentVersion;
    expect(commitAssemblyParameterEdit(opened, (doc) => commitReplaceAssemblyParameter(doc, 'gap',
      { value: { source, value: 5, display: '5' } }), version)).toEqual({ kind: 'applied' });
    const stored = useAppStore.getState().assembly?.parameters[0];
    expect(stored?.value.source).toBe(source);
    expect(stored?.value.value).toBeCloseTo(2 * 25.4, 9);
  });

  it('leaves degree and unitless entries, and mm mode, unchanged', () => {
    expect(assemblyParameterSource('degree', '30', 'inch')).toBe('30');
    expect(assemblyParameterSource('none', '3', 'inch')).toBe('3');
    expect(assemblyParameterSource('mm', '2', 'mm')).toBe(applyDisplayUnit('2', 'mm', 'mm'));
  });

  it('shows a mm row with the part table inch text and a degree row unchanged', () => {
    inch();
    const withAngle: AssemblyDocument = { ...opened, parameters: [...opened.parameters,
      { name: 'tilt', value: { source: '30', value: 30, display: '30' }, unit: 'degree', description: '' }] };
    useAppStore.getState().openAssembly(withAngle);
    useAppStore.setState({ selection: [] });
    const html = renderToStaticMarkup(createElement(AssemblyPropertyPanel));
    expect(html).toContain(`= ${fieldValueText('mm', { value: 5, display: '5' }, 'inch')}`);
    expect(html).not.toContain(`= 5 ${t('numericInput.unit.mm')}`);
    expect(html).toContain(`= 30 ${t('numericInput.unit.degree')}`);
  });
});
