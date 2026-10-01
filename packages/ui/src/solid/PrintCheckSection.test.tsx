import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PrintabilityReport } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/t.js';
import { resetTestStore, bodyFor } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import { DEFAULT_PRINT_CHECK_DRAFT, type PartInspector } from './printCheckCommands.js';
import { PrintCheckSection } from './PrintCheckSection.js';

function reportOf(thickness = 0.8, angle = 45, cancelled = false): PrintabilityReport {
  return { triangleCount: 1, thinTriangles: new Uint8Array(1), overhangTriangles: new Uint8Array(1),
    openEdgeTriangles: new Uint8Array(1), cancelled,
    summary: { triangleCount: 1, degenerateCount: 0, inspectedTriangleCount: 1, thinCount: 0, overhangCount: 0,
      openEdgeCount: 0, openEdgeTriangleCount: 0, watertight: true, minThicknessFoundMm: 25.4,
      minThicknessMm: thickness, overhangAngleDeg: angle, cellSizeMm: 1.6 } };
}

function render(): string {
  const snapshot = vi.spyOn(React, 'useSyncExternalStore').mockImplementation((_subscribe, getSnapshot) => getSnapshot());
  try { return renderToStaticMarkup(createElement(PrintCheckSection)); }
  finally { snapshot.mockRestore(); }
}

beforeEach(() => {
  resetTestStore();
  useAppStore.setState({ printCheckDraft: DEFAULT_PRINT_CHECK_DRAFT, printCheckRequest: null });
});
afterEach(() => { vi.restoreAllMocks(); resetTestStore(); useAppStore.setState({ printCheckDraft: DEFAULT_PRINT_CHECK_DRAFT }); });

describe('FIX-02 print check panel and store', () => {
  it('offers the initial criteria and a check action before the first result', () => {
    const markup = render();
    expect(markup).toContain('value="0.8"');
    expect(markup).toContain('value="45"');
    expect(markup).toContain(t('propertyPanel.printCheckRun'));
    expect(markup).toContain(t('propertyPanel.printCheckNotYet'));
    expect(markup).not.toContain('disabled=""');
  });
  it('keeps both full labels associated with their inputs and messages in the inset fields', () => {
    const markup = render();
    expect(markup).toContain('class="pcad-section__fields"');
    const labels = [...markup.matchAll(/<label class="pcad-field__label" for="([^"]+)">([^<]+)<\/label>/gu)];
    expect(labels.map(label => label[2])).toEqual([
      t('propertyPanel.printCheckThicknessInput'), t('propertyPanel.printCheckAngleInput'),
    ]);
    expect(new Set(labels.map(label => label[1])).size).toBe(2);
    for (const label of labels) {
      expect(markup).toContain(`<input id="${label[1]}"`);
      expect(markup).toContain(`aria-describedby="${label[1]}-message`);
      expect(markup).toContain(`<p id="${label[1]}-message"`);
    }
  });
  it('shows field errors and refuses to start from either the panel or the store', () => {
    useAppStore.getState().setPrintCheckDraft({ ...DEFAULT_PRINT_CHECK_DRAFT, minThicknessSource: '0', overhangAngleSource: '91' });
    const inspector = vi.fn<PartInspector>(() => Promise.resolve({ kind: 'inspected', report: reportOf() }));
    useAppStore.setState({ bodies: [bodyFor('box')], partInspector: inspector });
    const markup = render();
    expect(markup.match(/aria-invalid="true"/g)).toHaveLength(2);
    expect(markup).toContain(t('propertyPanel.printCheckThicknessPositive'));
    expect(markup).toContain(t('propertyPanel.printCheckAngleRange'));
    expect(markup).toContain('disabled=""');
    useAppStore.getState().inspectPrintability();
    expect(inspector).not.toHaveBeenCalled();
    expect(useAppStore.getState().isInspectingPrint).toBe(false);
  });
  it('keeps the criteria used for a cancelled result distinct from edits for the next check', () => {
    useAppStore.getState().setPrintability(reportOf(0.8, 45, true));
    useAppStore.getState().setPrintCheckDraft({ ...DEFAULT_PRINT_CHECK_DRAFT, minThicknessSource: '1/2', overhangAngleSource: '30+30' });
    const markup = render();
    expect(markup).toContain(t('propertyPanel.printCheckCancelled'));
    expect(markup).toContain(`>${t('propertyPanel.printCheckUsedThickness')}</dt><dd class="pcad-properties__value">0.8 mm</dd>`);
    expect(markup).toContain(`>${t('propertyPanel.printCheckUsedAngle')}</dt><dd class="pcad-properties__value">45 ${t('measure.unit.degree')}</dd>`);
    expect(markup).toContain('value="1/2"');
    expect(markup).toContain(t('propertyPanel.printCheckAgain'));
  });
  it('passes edited criteria, supports partial cancellation and leaves the document unchanged', async () => {
    let release = (): void => undefined;
    const inspector = vi.fn<PartInspector>((_document, _bodies, cancel, criteria) => new Promise(resolve => {
      release = () => resolve({ kind: 'inspected', report: reportOf(criteria?.minThicknessMm, criteria?.overhangAngleDeg, cancel?.()) });
    }));
    useAppStore.setState({ bodies: [bodyFor('box')], partInspector: inspector });
    useAppStore.getState().setPrintCheckDraft({ ...DEFAULT_PRINT_CHECK_DRAFT, minThicknessSource: '1/2', overhangAngleSource: '30+30' });
    const before = useAppStore.getState();
    before.inspectPrintability();
    expect(inspector.mock.calls[0][3]).toEqual({ minThicknessMm: 0.5, overhangAngleDeg: 60 });
    expect(render()).toContain(t('propertyPanel.printCheckCancel'));
    useAppStore.getState().inspectPrintability();
    expect(inspector).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => { expect(useAppStore.getState().isInspectingPrint).toBe(false); });
    expect(useAppStore.getState().printability?.cancelled).toBe(true);
    expect(useAppStore.getState().printability?.summary.minThicknessMm).toBe(0.5);
    expect(useAppStore.getState().document).toBe(before.document);
    expect(useAppStore.getState().undoStack).toBe(before.undoStack);
    useAppStore.getState().setDisplaySettings({ ...before.displaySettings, lengthUnit: 'inch' });
    expect(render()).toContain('1.000 in');
  });
  it('does not restore a closed result when the pending inspection returns', async () => {
    let release = (): void => undefined;
    useAppStore.setState({ bodies: [bodyFor('box')], partInspector: () => new Promise(resolve => {
      release = () => resolve({ kind: 'inspected', report: reportOf() });
    }) });
    useAppStore.getState().inspectPrintability();
    useAppStore.getState().setPrintability(null);
    release();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(useAppStore.getState().printability).toBeNull();
    expect(useAppStore.getState().printabilityOffsets).toBeNull();
    expect(useAppStore.getState().isInspectingPrint).toBe(false);
  });
});
